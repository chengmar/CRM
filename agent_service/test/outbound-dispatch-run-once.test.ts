import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { recordImapPollSuccess } from "../src/inbound/email-health.js";
import { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { markEmailChannelSelfTestPassed } from "../src/outreach/email-channel.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];
const smtp = vi.hoisted(() => ({
  close: vi.fn(),
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async () => ({ messageId: "<sent-by-test@provider.invalid>" })),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => smtp),
  },
}));

beforeEach(() => {
  smtp.close.mockClear();
  smtp.verify.mockClear();
  smtp.sendMail.mockReset();
  smtp.sendMail.mockResolvedValue({ messageId: "<sent-by-test@provider.invalid>" });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function productionConfig(): AgentConfig {
  return loadConfig({
    AGENT_MODE: "production",
    OUTBOUND_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
    OUTREACH_APPROVAL_REQUIRED: "true",
    EMAIL_OUTREACH_ENABLED: "true",
    EMAIL_INBOUND_ENABLED: "true",
    AUTO_FOLLOWUP_ENABLED: "false",
    EMAIL_FROM_ADDRESS: "sales@sender.example",
    EMAIL_FROM_NAME: "Example Export Sales",
    EMAIL_REPLY_TO: "sales@sender.example",
    SMTP_HOST: "smtp.sender.example",
    SMTP_PORT: "465",
    SMTP_USER: "sales@sender.example",
    SMTP_PASSWORD: "test-only",
    IMAP_HOST: "imap.sender.example",
    IMAP_PORT: "993",
    IMAP_USER: "sales@sender.example",
    IMAP_PASSWORD: "test-only",
    EMAIL_DOMAIN_AUTH_VERIFIED: "true",
    EMAIL_WARMUP_COMPLETE: "true",
    EMAIL_DAILY_LIMIT: "50",
    EMAIL_HOURLY_LIMIT: "20",
    EMAIL_MIN_INTERVAL_SECONDS: "0",
    EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
    COMPANY_POSTAL_ADDRESS: "10 Example Road, Example Region, Example Province, China",
    FEISHU_BOT_ENABLED: "true",
    FEISHU_APP_ID: "test-app",
    FEISHU_APP_SECRET: "test-only",
    FEISHU_ALERT_OPEN_IDS: "ou_test",
  });
}

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-dispatch-run-once-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  markEmailChannelSelfTestPassed(productionConfig(), db, "test");
  recordImapPollSuccess(productionConfig(), db);
  db.setSetting("outbound_paused", "false");
  return db;
}

function createApprovedMessage(db: AgentDatabase, suffix: string, scheduledAt = new Date().toISOString()): {
  leadId: string;
  messageId: string;
  destination: string;
} {
  const domain = `${suffix}.buyer.example`;
  const destination = `buyer@${domain}`;
  const campaignId = db.createCampaign({
    name: `dispatch-${suffix}`,
    market: "Malaysia",
    product: "sample products",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 50,
    hourlyLimit: 20,
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
  db.addLeadSource(
    leadId,
    `https://${domain}`,
    "official_website",
    new Date().toISOString(),
    "Active official company website",
  );
  db.addLeadSource(
    leadId,
    `https://trade-show.example/${suffix}`,
    "trade_show",
    new Date().toISOString(),
    "Recent exhibitor listing",
  );
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "ready");
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
    scheduledAt,
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "reviewer", db.getSequenceReviewHash(leadId));
  return { leadId, messageId, destination };
}

function outboundRow(db: AgentDatabase, messageId: string): {
  status: string;
  attempts: number;
  provider_message_id: string | null;
  failure_reason: string | null;
} {
  return db.db.prepare(
    `SELECT status, attempts, provider_message_id, failure_reason
     FROM outbound_messages WHERE id=?`,
  ).get(messageId) as {
    status: string;
    attempts: number;
    provider_message_id: string | null;
    failure_reason: string | null;
  };
}

describe("OutboundDispatcher.runOnce production path", () => {
  it("claims an approved email, submits it through SMTP, and persists SENT", async () => {
    const db = database();
    const prepared = createApprovedMessage(db, "success");
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce();

      expect(result).toEqual({ sent: 1, blocked: 0, failed: 0, unknown: 0 });
      expect(smtp.sendMail).toHaveBeenCalledOnce();
      expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: prepared.destination,
        subject: "sample application project support",
        text: expect.stringContaining("Reply unsubscribe to opt out."),
        headers: expect.objectContaining({ "X-CRM-Agent-Message-Id": prepared.messageId }),
      }));
      expect(outboundRow(db, prepared.messageId)).toEqual({
        status: "SENT",
        attempts: 1,
        provider_message_id: "<sent-by-test@provider.invalid>",
        failure_reason: null,
      });
    } finally {
      dispatcher.close();
      db.close();
    }
  });

  it("reconsiders a policy-blocked message after the global pause is lifted", async () => {
    const db = database();
    const prepared = createApprovedMessage(db, "pause-resume");
    db.setSetting("outbound_paused", "true");
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      await expect(dispatcher.runOnce(1)).resolves.toEqual({
        sent: 0,
        blocked: 1,
        failed: 0,
        unknown: 0,
      });
      expect(outboundRow(db, prepared.messageId)).toMatchObject({
        status: "APPROVED",
        attempts: 0,
        failure_reason: expect.stringMatching(/^POLICY_BLOCKED_V1:/),
      });
      expect(smtp.sendMail).not.toHaveBeenCalled();

      db.setSetting("outbound_paused", "false");
      await expect(dispatcher.runOnce(1)).resolves.toEqual({
        sent: 1,
        blocked: 0,
        failed: 0,
        unknown: 0,
      });
      expect(smtp.sendMail).toHaveBeenCalledOnce();
      expect(outboundRow(db, prepared.messageId)).toEqual({
        status: "SENT",
        attempts: 1,
        provider_message_id: "<sent-by-test@provider.invalid>",
        failure_reason: null,
      });
    } finally {
      dispatcher.close();
      db.close();
    }
  });

  it("skips twenty older policy-blocked rows and sends the later eligible message once", async () => {
    const db = database();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const blocked = Array.from({ length: 20 }, (_, index) => {
      const prepared = createApprovedMessage(
        db,
        `starved-blocked-${index}`,
        new Date(base + index * 1_000).toISOString(),
      );
      db.addDnc("email", prepared.destination, "fixture policy block", "test");
      return prepared;
    });
    const eligible = createApprovedMessage(
      db,
      "starved-eligible",
      new Date(base + 20_000).toISOString(),
    );
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce(1);

      expect(result).toEqual({ sent: 1, blocked: 20, failed: 0, unknown: 0 });
      expect(smtp.sendMail).toHaveBeenCalledOnce();
      expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: eligible.destination }));
      expect(outboundRow(db, eligible.messageId)).toMatchObject({ status: "SENT", attempts: 1 });
      for (const message of blocked) {
        expect(outboundRow(db, message.messageId)).toMatchObject({
          status: "APPROVED",
          attempts: 0,
          failure_reason: expect.stringMatching(/^POLICY_BLOCKED_V1:/),
        });
      }
      expect(db.getOutboundPolicyBlockSummary()).toMatchObject({
        blockedMessages: 20,
        topReasons: [{ reason: "destination matches do-not-contact list", count: 20 }],
      });

      const replay = await dispatcher.runOnce(1);
      expect(replay).toEqual({ sent: 0, blocked: 20, failed: 0, unknown: 0 });
      expect(smtp.sendMail).toHaveBeenCalledOnce();
    } finally {
      dispatcher.close();
      db.close();
    }
  });

  it("bounds each scan and advances its durable cursor through a blocked backlog", async () => {
    const db = database();
    const base = Date.parse("2026-01-02T00:00:00.000Z");
    const messages = Array.from({ length: 105 }, (_, index) => createApprovedMessage(
      db,
      `bounded-${index}`,
      new Date(base + index * 1_000).toISOString(),
    ));
    db.setSetting("outbound_paused", "true");
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce(1);

      expect(result).toEqual({ sent: 0, blocked: 100, failed: 0, unknown: 0 });
      expect(smtp.sendMail).not.toHaveBeenCalled();
      expect(db.getOutboundPolicyBlockSummary().blockedMessages).toBe(100);
      const persisted = messages.filter((message) =>
        outboundRow(db, message.messageId).failure_reason?.startsWith("POLICY_BLOCKED_V1:"));
      expect(persisted).toHaveLength(100);
      expect(JSON.parse(db.getSetting("outbound_dispatch_scan_cursor_v1") ?? "null")).toMatchObject({
        dueAt: expect.any(String),
        sequenceIndex: 0,
        messageId: expect.any(String),
      });
    } finally {
      dispatcher.close();
      db.close();
    }
  }, 30_000);

  it("quarantines an ambiguous SMTP exception instead of automatically retrying", async () => {
    const db = database();
    const prepared = createApprovedMessage(db, "smtp-failure");
    smtp.sendMail.mockRejectedValueOnce(new Error("SMTP rejected fixture"));
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce();

      expect(result).toEqual({ sent: 0, blocked: 0, failed: 0, unknown: 1 });
      expect(smtp.sendMail).toHaveBeenCalledOnce();
      expect(outboundRow(db, prepared.messageId)).toMatchObject({
        status: "UNKNOWN_RECONCILIATION_REQUIRED",
        attempts: 1,
        provider_message_id: expect.stringMatching(/^<crm-[a-f0-9]{32}@sender\.example>$/),
        failure_reason: expect.stringContaining("SMTP rejected fixture"),
      });
      expect(db.getSetting("outbound_paused")).toBe("true");
    } finally {
      dispatcher.close();
      db.close();
    }
  });

  it("keeps an explicit SMTP rejection retryable without classifying it as unknown", async () => {
    const db = database();
    const prepared = createApprovedMessage(db, "smtp-rejected");
    smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("550 rejected fixture"), {
      code: "EENVELOPE",
      responseCode: 550,
    }));
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce();

      expect(result).toEqual({ sent: 0, blocked: 0, failed: 1, unknown: 0 });
      expect(outboundRow(db, prepared.messageId)).toMatchObject({
        status: "FAILED",
        attempts: 1,
        provider_message_id: expect.stringMatching(/^<crm-[a-f0-9]{32}@sender\.example>$/),
        failure_reason: expect.stringContaining("550 rejected fixture"),
      });
      expect(db.getSetting("outbound_paused")).toBe("false");
    } finally {
      dispatcher.close();
      db.close();
    }
  });

  it.each([
    {
      name: "global pause",
      arrange: (db: AgentDatabase, prepared: ReturnType<typeof createApprovedMessage>) => {
        db.setSetting("outbound_paused", "true");
        return { status: "APPROVED", blocked: 1 };
      },
    },
    {
      name: "do-not-contact match",
      arrange: (db: AgentDatabase, prepared: ReturnType<typeof createApprovedMessage>) => {
        db.addDnc("email", prepared.destination, "fixture opt out", "test");
        return { status: "APPROVED", blocked: 1 };
      },
    },
    {
      name: "reply stop",
      arrange: (db: AgentDatabase, prepared: ReturnType<typeof createApprovedMessage>) => {
        db.stopAutomationForReply(prepared.leadId, "inbound", "fixture reply");
        return { status: "CANCELLED", blocked: 0 };
      },
    },
  ])("does not call SMTP when $name is active", async ({ arrange }) => {
    const db = database();
    const prepared = createApprovedMessage(db, `blocked-${Math.random().toString(16).slice(2)}`);
    const expected = arrange(db, prepared);
    const dispatcher = new OutboundDispatcher(productionConfig(), db);
    try {
      const result = await dispatcher.runOnce();

    expect(result).toEqual({ sent: 0, blocked: expected.blocked, failed: 0, unknown: 0 });
      expect(smtp.sendMail).not.toHaveBeenCalled();
      expect(outboundRow(db, prepared.messageId).status).toBe(expected.status);
    } finally {
      dispatcher.close();
      db.close();
    }
  });
});
