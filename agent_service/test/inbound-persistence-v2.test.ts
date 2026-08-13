import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";
import type { InboundClassification } from "../src/types.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-persistence-v2-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function notifier(): InquiryNotifier & { notifyQuarantinedIntake: ReturnType<typeof vi.fn> } {
  return {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
    notifyQuarantinedIntake: vi.fn(async () => undefined),
  };
}

function classification(
  value: InboundClassification["classification"],
  options: Partial<InboundClassification> = {},
): InboundClassification {
  const takeover = ["P1_INQUIRY", "P2_INTEREST", "REFERRAL"].includes(value);
  return {
    classification: value,
    confidence: options.confidence ?? 0.99,
    reason: options.reason ?? `fixture ${value}`,
    shouldNotify: options.shouldNotify ?? (takeover || value === "WRONG_PERSON"),
    shouldTakeover: options.shouldTakeover ?? takeover,
    shouldStopAutomation: options.shouldStopAutomation ?? !["AUTO_REPLY", "SPAM", "UNKNOWN"].includes(value),
  };
}

function matchedFixture(db: AgentDatabase, suffix: string): {
  leadId: string;
  contactId: string;
  campaignId: string;
  email: string;
} {
  const campaignId = db.createCampaign({
    name: `inbound-v2-${suffix}`,
    market: "Malaysia",
    product: "sample products",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Matched Buyer ${suffix}`,
    domain: `${suffix}.example`,
    website: `https://${suffix}.example`,
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
    lastActivityAt: "2026-07-20T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const email = `buyer@${suffix}.example`;
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${suffix}`,
    title: "Procurement Manager",
    email,
    sourceUrl: `https://${suffix}.example/team`,
    employmentVerifiedAt: "2026-07-20T00:00:00.000Z",
    emailStatus: "VALID",
    emailRisk: "fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  db.db.prepare("UPDATE leads SET status='CONTACTED' WHERE id=?").run(leadId);
  return { leadId, contactId, campaignId, email };
}

describe("WO-09/18 persisted inbound routing", () => {
  it("quarantines an unmatched high-intent message without creating a lead or opportunity", async () => {
    const db = database();
    const alerts = notifier();
    const processor = new InboundProcessor(loadConfig({}), db, alerts);
    const decision = classification("P1_INQUIRY");

    const result = await processor.process({
      channel: "email",
      providerId: "unmatched-rfq-1",
      fromAddress: "new-buyer@example.com",
      toAddress: "sales@supplier.example",
      subject: "RFQ",
      bodyText: "Please quote 2 units for 12 units and confirm MOQ.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    }, decision);

    expect(result).toMatchObject({ ignored: false, quarantined: true, leadId: null });
    expect(db.getInquiryIntake(result.intakeId)).toMatchObject({
      intake_status: "QUARANTINED",
      classification: "P1_INQUIRY",
    });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({
      inquiryIntakes: 1,
      quarantinedIntakes: 1,
      opportunities: 0,
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM leads").get()).toEqual({ count: 0 });
    expect(alerts.notifyQuarantinedIntake).toHaveBeenCalledOnce();
    db.close();
  });

  it("stops a negative reply without writing permanent DNC", async () => {
    const db = database();
    const fixture = matchedFixture(db, "negative");
    const processor = new InboundProcessor(loadConfig({}), db, notifier());
    const decision = classification("NEGATIVE", { shouldNotify: false, shouldTakeover: false });

    await processor.process({
      channel: "email",
      providerId: "negative-1",
      fromAddress: fixture.email,
      subject: "Re: introduction",
      bodyText: "Not interested at this time.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    }, decision);

    expect(db.hasDncMatch([{ type: "email", value: fixture.email }])).toBe(false);
    expect(db.getLead(fixture.leadId)).toMatchObject({ status: "REPLIED", human_takeover: 0 });
    db.close();
  });

  it("turns WRONG_PERSON into a contact-research task without DNC", async () => {
    const db = database();
    const fixture = matchedFixture(db, "wrong-person");
    const processor = new InboundProcessor(loadConfig({}), db, notifier());
    const decision = classification("WRONG_PERSON", { shouldTakeover: false });

    await processor.process({
      channel: "email",
      providerId: "wrong-person-1",
      fromAddress: fixture.email,
      subject: "Re: sample application",
      bodyText: "I am not responsible for this category. Please contact our engineering team.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    }, decision);

    expect(db.hasDncMatch([{ type: "email", value: fixture.email }])).toBe(false);
    expect(db.db.prepare("SELECT task_type, source_signal FROM sales_tasks").get()).toEqual({
      task_type: "CONTACT_RESEARCH",
      source_signal: "WRONG_PERSON",
    });
    db.close();
  });

  it("links P1 to the exact outbound and creates one opportunity/task on replay", async () => {
    const db = database();
    const fixture = matchedFixture(db, "exact-reply");
    const firstId = db.createOutboundMessage({
      campaignId: fixture.campaignId,
      leadId: fixture.leadId,
      contactId: fixture.contactId,
      channel: "email",
      destination: fixture.email,
      subject: "First message",
      body: "First",
      sequenceIndex: 0,
      status: "SCHEDULED",
    });
    const latestId = db.createOutboundMessage({
      campaignId: fixture.campaignId,
      leadId: fixture.leadId,
      contactId: fixture.contactId,
      channel: "email",
      destination: fixture.email,
      subject: "Later message",
      body: "Later",
      sequenceIndex: 1,
      status: "SCHEDULED",
    });
    db.db.prepare(
      `UPDATE outbound_messages SET status='SENT', sent_at=?, provider_message_id=? WHERE id=?`,
    ).run("2026-07-19T00:00:00.000Z", "<exact-first@example.invalid>", firstId);
    db.db.prepare(
      `UPDATE outbound_messages SET status='SENT', sent_at=?, provider_message_id=? WHERE id=?`,
    ).run("2026-07-20T00:00:00.000Z", "<latest@example.invalid>", latestId);
    const alerts = notifier();
    const processor = new InboundProcessor(loadConfig({}), db, alerts);
    const decision = classification("P1_INQUIRY");
    const input = {
      channel: "email" as const,
      providerId: "exact-p1-1",
      threadId: "<exact-first@example.invalid>",
      fromAddress: fixture.email,
      subject: "RFQ",
      bodyText: "Please quote 2 units for 12 units and confirm MOQ.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    };

    const first = await processor.process(input, decision);
    const replay = await processor.process(input, decision);

    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(firstId))
      .toEqual({ status: "REPLIED" });
    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(latestId))
      .toEqual({ status: "SENT" });
    expect(first.opportunityId).toBeTruthy();
    expect(replay).toMatchObject({ inserted: false, opportunityId: null });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({
      inquiryIntakes: 1,
      opportunities: 1,
      openSalesTasks: 1,
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM inquiry_facts").get()).toMatchObject({ count: 5 });
    expect(alerts.notifyInquiry).toHaveBeenCalledOnce();
    db.close();
  });

  it("commits a durable P1 notification outbox entry with the opportunity", async () => {
    const db = database();
    const fixture = matchedFixture(db, "durable-alert");
    const config = loadConfig({});
    const feishu = new FeishuIntegration(config, db);
    const processor = new InboundProcessor(config, db, feishu);
    const decision = classification("P1_INQUIRY");

    await processor.process({
      channel: "email",
      providerId: "durable-alert-1",
      fromAddress: fixture.email,
      subject: "RFQ",
      bodyText: "Please quote 2 units and confirm MOQ.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    }, decision);

    expect(db.getAcquisitionFoundationSummary()).toMatchObject({ opportunities: 1, openSalesTasks: 1 });
    expect(db.listPendingNotifications()).toEqual([
      expect.objectContaining({
        event_type: "INQUIRY_ALERT",
        destination: "__configured_alert_destination__",
        status: "PENDING",
      }),
    ]);
    db.close();
  });

  it("rolls back opportunity routing if durable notification staging fails", async () => {
    const db = database();
    const fixture = matchedFixture(db, "alert-rollback");
    const broken = notifier();
    broken.stageInquiryNotification = () => { throw new Error("injected outbox failure"); };
    const processor = new InboundProcessor(loadConfig({}), db, broken);
    const decision = classification("P1_INQUIRY");

    await expect(processor.process({
      channel: "email",
      providerId: "alert-rollback-1",
      fromAddress: fixture.email,
      subject: "RFQ",
      bodyText: "Please quote 2 units and confirm MOQ.",
      receivedAt: "2026-07-20T02:00:00.000Z",
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
    }, decision)).rejects.toThrow("injected outbox failure");

    expect(db.getInquiryIntake(
      String((db.db.prepare("SELECT id FROM inquiry_intakes").get() as { id: string }).id),
    )).toMatchObject({ intake_status: "MATCHED" });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({ opportunities: 0, openSalesTasks: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM inbound_messages").get()).toEqual({ count: 0 });
    expect(db.getLead(fixture.leadId)).toMatchObject({ status: "CONTACTED", human_takeover: 0 });
    db.close();
  });
});
