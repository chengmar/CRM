import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CommandService } from "../src/commands/service.js";
import { AgentDatabase } from "../src/db.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-reconciliation-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function outboundFixture(db: AgentDatabase, suffix: string): {
  leadId: string;
  contactId: string;
  messageId: string;
  destination: string;
  submissionReference: string;
} {
  const domain = `${suffix}.buyer.example`;
  const destination = `buyer@${domain}`;
  const campaignId = db.createCampaign({
    name: `reconciliation-${suffix}`,
    market: "Malaysia",
    product: "sample products",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 10,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Buyer ${suffix}`,
    domain,
    website: `https://${domain}`,
    country: "Malaysia",
    buyerType: "integrator",
    product: "sample products",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{
      stage: "RECENT_PROCUREMENT",
      sourceUrl: `https://${domain}/procurement-notice`,
    }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const contactId = db.upsertContact({
    leadId,
    name: `Named Buyer ${suffix}`,
    title: "Procurement Manager",
    email: destination,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "test fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  const messageId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination,
    subject: "sample application project support",
    body: "Could we discuss your current sample application requirements?",
    sequenceIndex: 0,
    scheduledAt: new Date().toISOString(),
    status: "SCHEDULED",
  });
  const submissionReference = `<crm-${suffix}@sender.example>`;
  db.db.prepare(
    `UPDATE outbound_messages
     SET status='SENDING', attempts=1, approved_by='fixture', approved_at=?, updated_at=?
     WHERE id=?`,
  ).run(new Date().toISOString(), "2026-07-22T00:00:00.000Z", messageId);
  db.prepareMessageSubmissionReference(messageId, submissionReference);
  db.db.prepare("UPDATE outbound_messages SET updated_at=? WHERE id=?")
    .run("2026-07-22T00:00:00.000Z", messageId);
  db.setSetting("outbound_paused", "false");
  return { leadId, contactId, messageId, destination, submissionReference };
}

function row(db: AgentDatabase, messageId: string): Record<string, unknown> {
  return db.db.prepare(
    `SELECT status, sent_at, provider_message_id, thread_id, failure_reason
     FROM outbound_messages WHERE id=?`,
  ).get(messageId) as Record<string, unknown>;
}

function notifier(): InquiryNotifier & { notifyHardBounce: ReturnType<typeof vi.fn> } {
  return {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
    notifyHardBounce: vi.fn(async () => undefined),
  };
}

describe("outbound delivery reconciliation", () => {
  it("quarantines stale SENDING once, pauses outbound, and never presents it for automatic resend", () => {
    const db = database();
    try {
      const fixture = outboundFixture(db, "stale");

      const first = db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");
      const second = db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");

      expect(first).toEqual([expect.objectContaining({ id: fixture.messageId })]);
      expect(second).toEqual([]);
      expect(row(db, fixture.messageId)).toMatchObject({
        status: "UNKNOWN_RECONCILIATION_REQUIRED",
        provider_message_id: fixture.submissionReference,
      });
      expect(db.getSetting("outbound_paused")).toBe("true");
      expect(db.getDueMessages(100).map((message) => message.id)).not.toContain(fixture.messageId);
      expect(db.listUnknownDeliveryReconciliations()).toEqual([
        expect.objectContaining({ id: fixture.messageId, company: "Buyer stale" }),
      ]);
      const events = db.db.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE entity_id=? AND event_type='MESSAGE_DELIVERY_UNKNOWN_REQUIRES_RECONCILIATION'`,
      ).get(fixture.messageId) as { count: number };
      expect(events.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("supports idempotent human confirmation for both sent and not-sent outcomes", () => {
    const db = database();
    try {
      const sent = outboundFixture(db, "confirmed-sent");
      const retry = outboundFixture(db, "confirmed-retry");
      db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");

      expect(db.resolveUnknownDelivery(sent.messageId, "CONFIRMED_SENT", "operator"))
        .toEqual({ changed: true, status: "SENT" });
      expect(db.resolveUnknownDelivery(sent.messageId, "CONFIRMED_SENT", "operator"))
        .toEqual({ changed: false, status: "SENT" });
      expect(row(db, sent.messageId)).toMatchObject({
        status: "SENT",
        provider_message_id: sent.submissionReference,
        failure_reason: null,
      });

      expect(db.resolveUnknownDelivery(retry.messageId, "CONFIRMED_NOT_SENT_REQUEUE", "operator"))
        .toEqual({ changed: true, status: "APPROVED" });
      expect(db.resolveUnknownDelivery(retry.messageId, "CONFIRMED_NOT_SENT_REQUEUE", "operator"))
        .toEqual({ changed: false, status: "APPROVED" });
      expect(row(db, retry.messageId)).toMatchObject({
        status: "APPROVED",
        sent_at: null,
        provider_message_id: null,
        thread_id: null,
        failure_reason: null,
      });
      expect(db.getSetting("outbound_paused")).toBe("true");
    } finally {
      db.close();
    }
  });

  it("wires the signed Feishu action to idempotent reconciliation without resuming outbound", async () => {
    const db = database();
    try {
      const fixture = outboundFixture(db, "feishu-action");
      db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");
      const service = new CommandService(
        loadConfig({
          FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ "authorized-operator": ["SALES_MANAGER"] }),
        }),
        db,
        { isConfigured: () => false } as unknown as AgentLlm,
        {} as OutboundDispatcher,
      );
      const input = {
        action: {
          intent: "reconcile_unknown_delivery",
          messageId: fixture.messageId,
          resolution: "CONFIRMED_NOT_SENT_REQUEUE",
        },
        senderId: "authorized-operator",
        chatId: "sales-chat",
        messageId: "signed-card-action",
      };

      expect(await service.handleAction(input)).toContain("未发送并重新排队");
      expect(await service.handleAction(input)).toContain("当前状态：APPROVED");
      expect(db.getSetting("outbound_paused")).toBe("true");
    } finally {
      db.close();
    }
  });

  it("durably stages exactly one Feishu alert even when the channel is offline", () => {
    const db = database();
    try {
      const fixture = outboundFixture(db, "durable-alert");
      const [unknown] = db.quarantineStaleSendingMessages(
        "2026-07-22T00:01:00.000Z",
        "watchdog",
      );
      const feishu = new FeishuIntegration(loadConfig({}), db);

      expect(feishu.stageDeliveryReconciliation({ message: unknown! })).toBe(true);
      expect(feishu.stageDeliveryReconciliation({ message: unknown! })).toBe(false);
      expect(db.listPendingNotifications(100)).toEqual([
        expect.objectContaining({
          event_type: "EMAIL_DELIVERY_RECONCILIATION_REQUIRED",
          status: "PENDING",
        }),
      ]);
      expect(row(db, fixture.messageId)).toMatchObject({
        status: "UNKNOWN_RECONCILIATION_REQUIRED",
      });
    } finally {
      db.close();
    }
  });

  it("stages one alert per delivery attempt and alerts again after a not-sent requeue", () => {
    const db = database();
    try {
      const fixture = outboundFixture(db, "durable-alert-retry");
      const [firstEpisode] = db.quarantineStaleSendingMessages(
        "2026-07-22T00:01:00.000Z",
        "watchdog",
      );
      const feishu = new FeishuIntegration(loadConfig({}), db);

      expect(firstEpisode).toMatchObject({ id: fixture.messageId, attempts: 1 });
      expect(feishu.stageDeliveryReconciliation({ message: firstEpisode! })).toBe(true);
      expect(feishu.stageDeliveryReconciliation({ message: firstEpisode! })).toBe(false);

      expect(db.resolveUnknownDelivery(
        fixture.messageId,
        "CONFIRMED_NOT_SENT_REQUEUE",
        "operator",
      )).toEqual({ changed: true, status: "APPROVED" });
      db.transitionLead(fixture.leadId, "VERIFYING", "test", "prepare retry fixture");
      db.transitionLead(fixture.leadId, "READY_FOR_REVIEW", "test", "retry remains eligible");
      db.transitionLead(fixture.leadId, "APPROVED", "test", "retry approved");
      db.setSetting("outbound_paused", "false");
      const claimed = db.claimMessageForSending(fixture.messageId);
      expect(claimed).toMatchObject({ attempts: 2, status: "SENDING" });
      db.prepareMessageSubmissionReference(
        fixture.messageId,
        "<crm-durable-alert-retry-2@sender.example>",
      );
      expect(db.markMessageDeliveryUnknown(
        fixture.messageId,
        "SMTP connection closed before the second acknowledgement",
        "dispatcher",
      )).toBe(true);

      const [secondEpisode] = db.listUnknownDeliveryReconciliations();
      expect(secondEpisode).toMatchObject({ id: fixture.messageId, attempts: 2 });
      expect(feishu.stageDeliveryReconciliation({ message: secondEpisode! })).toBe(true);
      expect(feishu.stageDeliveryReconciliation({ message: secondEpisode! })).toBe(false);

      const notifications = db.listPendingNotifications(100);
      expect(notifications).toHaveLength(2);
      const attempts = notifications
        .map((notification) => JSON.parse(String(notification.payload_json)).message.attempts)
        .sort();
      expect(attempts).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it("refuses the Feishu resume command while any delivery remains unresolved", async () => {
    const db = database();
    try {
      outboundFixture(db, "resume-blocked");
      db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");
      const service = new CommandService(
        loadConfig({
          FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ "authorized-operator": ["SALES_MANAGER"] }),
        }),
        db,
        { isConfigured: () => false } as unknown as AgentLlm,
        {} as OutboundDispatcher,
      );

      const result = await service.handleText({
        text: "恢复系统",
        senderId: "authorized-operator",
        chatId: "sales-chat",
        messageId: "resume-command",
      });

      expect(result).toContain("投递结果不确定");
      expect(db.getSetting("outbound_paused")).toBe("true");
    } finally {
      db.close();
    }
  });

  it.each([
    ["REPLIED" as const, "P2_INTEREST" as const, "Please send specifications and pricing"],
    ["BOUNCED" as const, "BOUNCE" as const, "550 5.1.1 mailbox does not exist"],
  ])("automatically reconciles an unknown delivery to %s from inbound Message-ID", async (
    expectedStatus,
    classification,
    bodyText,
  ) => {
    const db = database();
    try {
      const fixture = outboundFixture(db, `inbound-${expectedStatus.toLowerCase()}`);
      db.quarantineStaleSendingMessages("2026-07-22T00:01:00.000Z", "watchdog");
      const alerts = notifier();
      const processor = new InboundProcessor(
        loadConfig({ EMAIL_FROM_ADDRESS: "sales@sender.example" }),
        db,
        alerts,
      );
      const inbound = {
        providerId: `provider-${expectedStatus.toLowerCase()}`,
        channel: "email" as const,
        threadId: fixture.submissionReference,
        fromAddress: fixture.destination,
        toAddress: "sales@sender.example",
        subject: "Re: sample application project support",
        bodyText,
        receivedAt: new Date().toISOString(),
        rawHeaders: { inReplyTo: fixture.submissionReference },
      };
      const prepared = processor.prepare(inbound);

      await processor.process(inbound, {
        classification,
        confidence: 0.99,
        reason: "test fixture",
        shouldStopAutomation: true,
        shouldTakeover: classification === "P2_INTEREST",
      }, prepared);

      expect(row(db, fixture.messageId)).toMatchObject({ status: expectedStatus });
      expect(db.listUnknownDeliveryReconciliations()).toEqual([]);
      if (expectedStatus === "BOUNCED") expect(alerts.notifyHardBounce).toHaveBeenCalledOnce();
      else expect(alerts.notifyHardBounce).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("keeps an ultra-fast reply terminal when SMTP success returns afterward", async () => {
    const db = database();
    try {
      const fixture = outboundFixture(db, "reply-during-send");
      const alerts = notifier();
      const processor = new InboundProcessor(
        loadConfig({ EMAIL_FROM_ADDRESS: "sales@sender.example" }),
        db,
        alerts,
      );
      const inbound = {
        providerId: "provider-reply-during-send",
        channel: "email" as const,
        threadId: fixture.submissionReference,
        fromAddress: fixture.destination,
        toAddress: "sales@sender.example",
        subject: "Re: sample application project support",
        bodyText: "Please send specifications and pricing",
        receivedAt: new Date().toISOString(),
        rawHeaders: { inReplyTo: fixture.submissionReference },
      };
      const prepared = processor.prepare(inbound);

      await processor.process(inbound, {
        classification: "P2_INTEREST",
        confidence: 0.99,
        reason: "test fixture",
        shouldStopAutomation: true,
        shouldTakeover: true,
      }, prepared);
      expect(row(db, fixture.messageId)).toMatchObject({ status: "REPLIED" });

      db.markMessageSent(fixture.messageId, fixture.submissionReference);
      expect(row(db, fixture.messageId)).toMatchObject({
        status: "REPLIED",
        provider_message_id: fixture.submissionReference,
        failure_reason: null,
      });
    } finally {
      db.close();
    }
  });
});
