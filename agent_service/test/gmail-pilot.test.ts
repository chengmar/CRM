import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import { recordImapPollSuccess } from "../src/inbound/email-health.js";
import type { AgentLlm } from "../src/llm.js";
import { MessageBuilder } from "../src/outreach/message-builder.js";
import { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { emailDraftPolicyBlockers } from "../src/outreach/email-policy.js";
import {
  activateGmailPilot,
  ensureGmailPilotState,
  markGmailPilotSelfTestPassed,
} from "../src/outreach/gmail-pilot.js";
import { DEMAND_POLICY_VERSION, type InboundClassification } from "../src/types.js";

const tempDirs: string[] = [];
const smtp = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async () => ({ messageId: "<gmail-self-test@example.com>" })),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => smtp),
  },
}));

beforeEach(() => {
  smtp.verify.mockClear();
  smtp.sendMail.mockClear();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

function testBusinessDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-gmail-brief-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "input_brief.yaml"),
    [
      "company:",
      "  legal_name_en: Example Manufacturing Co., Ltd.",
      "  website: https://example.com",
      "product:",
      "  name_en: Sample Product",
      "  models_or_specs:",
      "    - configurable unit",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function pilotConfig(overrides: NodeJS.ProcessEnv = {}): AgentConfig {
  const pilotAddress = ["pilot.sender", "gmail.com"].join("@");
  return loadConfig({
    AGENT_MODE: "production",
    OUTBOUND_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
    OUTREACH_APPROVAL_REQUIRED: "true",
    CONSUMER_EMAIL_PILOT_ENABLED: "true",
    EMAIL_OUTREACH_ENABLED: "true",
    EMAIL_INBOUND_ENABLED: "true",
    AUTO_FOLLOWUP_ENABLED: "false",
    EMAIL_FROM_ADDRESS: pilotAddress,
    SMTP_HOST: "smtp.gmail.com",
    SMTP_USER: pilotAddress,
    SMTP_PASSWORD: "test-only",
    IMAP_HOST: "imap.gmail.com",
    IMAP_USER: pilotAddress,
    IMAP_PASSWORD: "test-only",
    EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
    COMPANY_POSTAL_ADDRESS: "Company postal address",
    EMAIL_DAILY_LIMIT: "50",
    EMAIL_HOURLY_LIMIT: "20",
    EMAIL_MIN_INTERVAL_SECONDS: "120",
    BUSINESS_DATA_DIR: testBusinessDataDir(),
    FEISHU_BOT_ENABLED: "true",
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "test-only",
    FEISHU_ALERT_OPEN_IDS: "ou_test",
    ...overrides,
  });
}

function database(config?: AgentConfig): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-gmail-pilot-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  db.setSetting("outbound_paused", "true");
  if (config) {
    ensureGmailPilotState(config, db);
    markGmailPilotSelfTestPassed(config, db, "test", "<self-test@example.com>");
    activateGmailPilot(config, db, "test");
    recordImapPollSuccess(config, db);
  }
  return db;
}

function createApprovedPilotMessage(
  db: AgentDatabase,
  suffix: string,
  options: { sequenceIndex?: number; emailRisk?: string; score?: number } = {},
): { leadId: string; contactId: string; messageId: string } {
  const domain = `pilot-${suffix}.example.com`;
  const email = `sales@${domain}`;
  const campaignId = db.createCampaign({
    name: `gmail-pilot-${suffix}`,
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 50,
    hourlyLimit: 20,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Pilot Buyer ${suffix}`,
    domain,
    website: `https://${domain}`,
    country: "Vietnam",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: options.score ?? 95,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.addLeadSource(
    leadId,
    `https://${domain}`,
    "official_website",
    new Date().toISOString(),
    "active company website",
  );
  db.addLeadSource(
    leadId,
    `https://expo.example.org/pilot-${suffix}`,
    "trade_show",
    new Date().toISOString(),
    "recent exhibitor listing",
  );
  const contactSourceUrl = `https://${domain}/contact`;
  const officialMailboxText = `Sales enquiries: ${email}`;
  db.addLeadSource(leadId, contactSourceUrl, "official_website", new Date().toISOString(), officialMailboxText);
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "ready");
  const contactId = db.upsertContact({
    leadId,
    name: `Pilot Buyer ${suffix} team`,
    title: "Company mailbox",
    email,
    sourceUrl: contactSourceUrl,
    employmentVerifiedAt: null,
    emailStatus: "RISKY",
    emailRisk: options.emailRisk ?? "MX valid; deep mailbox verification not configured",
    roleAddress: true,
    disposableAddress: false,
    catchAll: false,
    officialMailboxEvidence: {
      sourceUrl: contactSourceUrl,
      exactText: officialMailboxText,
      observedAt: new Date().toISOString(),
    },
  });
  const messageId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination: email,
    subject: "Pilot test",
    body: "Pilot test",
    sequenceIndex: options.sequenceIndex ?? 0,
    scheduledAt: new Date().toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "reviewer", db.getSequenceReviewHash(leadId));
  return { leadId, contactId, messageId };
}

describe("Gmail pilot policy", () => {
  it("allows reviewed MX-verified first emails and applies adaptive initial pacing", () => {
    const config = pilotConfig();
    const db = database(config);
    const first = createApprovedPilotMessage(db, "first");
    const dispatcher = new OutboundDispatcher(config, db);

    expect(dispatcher.plan(10)[0]).toMatchObject({ messageId: first.messageId, allowed: true, blockers: [] });
    db.claimMessageForSending(first.messageId, {
      allowRiskyEmail: true,
      requireGmailPilotActivation: true,
    });
    db.markMessageSent(first.messageId, "<pilot-first@example.com>");

    const second = createApprovedPilotMessage(db, "second");
    expect(dispatcher.plan(10).find((item) => item.messageId === second.messageId)?.blockers).toContain(
      "adaptive deliverability spacing is active (initial_reputation_check)",
    );

    for (const suffix of ["third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"]) {
      const item = createApprovedPilotMessage(db, suffix);
      db.claimMessageForSending(item.messageId, {
        allowRiskyEmail: true,
        requireGmailPilotActivation: true,
      });
      db.markMessageSent(item.messageId, `<pilot-${suffix}@example.com>`);
    }
    const capped = createApprovedPilotMessage(db, "capped");
    expect(dispatcher.plan(20).find((item) => item.messageId === capped.messageId)?.blockers).toContain(
      "hourly email limit reached (8)",
    );
    db.close();
  });

  it("blocks follow-ups, scores below 90, and RISKY addresses without MX evidence", () => {
    const config = pilotConfig();
    const db = database(config);
    const followup = createApprovedPilotMessage(db, "followup", { sequenceIndex: 1 });
    const lowScore = createApprovedPilotMessage(db, "low-score", { score: 89 });
    const noMx = createApprovedPilotMessage(db, "no-mx", { emailRisk: "imported without verification" });
    const plan = new OutboundDispatcher(config, db).plan(10);

    expect(plan.find((item) => item.messageId === followup.messageId)?.blockers).toContain(
      "Gmail pilot only permits the manually approved first email",
    );
    expect(plan.find((item) => item.messageId === lowScore.messageId)?.blockers).toContain(
      "Gmail pilot requires a lead score of at least 90",
    );
    expect(plan.find((item) => item.messageId === noMx.messageId)?.blockers).toContain(
      "RISKY email has no stored MX verification evidence",
    );
    db.close();
  });

  it("builds only the first message in Gmail pilot mode", async () => {
    const config = pilotConfig();
    const db = database(config);
    const prepared = createApprovedPilotMessage(db, "builder-seed");
    db.db.prepare("DELETE FROM outbound_messages WHERE lead_id=?").run(prepared.leadId);
    db.db.prepare("UPDATE leads SET status='READY_FOR_REVIEW' WHERE id=?").run(prepared.leadId);
    const disabledLlm = { isConfigured: () => false } as unknown as AgentLlm;
    const builder = new MessageBuilder(config, db, disabledLlm);

    const ids = await builder.buildEmailSequence(prepared.leadId, prepared.contactId);
    expect(ids).toHaveLength(1);
    expect(db.listOutboundMessagesForLead(prepared.leadId)).toEqual([
      expect.objectContaining({ status: "DRAFT" }),
    ]);
    db.close();
  });

  it("automatically pauses all outbound after the first hard bounce", async () => {
    const config = pilotConfig();
    const db = database(config);
    const prepared = createApprovedPilotMessage(db, "bounce");
    db.claimMessageForSending(prepared.messageId, {
      allowRiskyEmail: true,
      requireGmailPilotActivation: true,
    });
    db.markMessageSent(prepared.messageId, "<pilot-bounce@example.com>");
    const notifySafetyPause = vi.fn(async () => undefined);
    const notifier: InquiryNotifier = {
      notifyInquiry: vi.fn(async () => undefined),
      notifyReply: vi.fn(async () => undefined),
      notifySafetyPause,
    };
    const processor = new InboundProcessor(config, db, notifier);
    const classification: InboundClassification = {
      classification: "BOUNCE",
      confidence: 0.99,
      reason: "delivery failure pattern",
      shouldNotify: false,
      shouldTakeover: false,
      shouldStopAutomation: true,
    };

    await processor.process(
      {
        channel: "email",
        providerId: "bounce-test-1",
        threadId: "<pilot-bounce@example.com>",
        fromAddress: "mailer-daemon@example.com",
        toAddress: ["pilot.sender", "gmail.com"].join("@"),
        subject: "Delivery Status Notification (Failure)",
        bodyText: "550 mailbox does not exist",
        receivedAt: new Date().toISOString(),
        classification: "BOUNCE",
        confidence: 0.99,
        reason: "delivery failure pattern",
      },
      classification,
    );

    expect(db.getSetting("outbound_paused")).toBe("true");
    expect(notifySafetyPause).toHaveBeenCalledOnce();
    db.close();
  });

  it("does not treat a WhatsApp delivery failure as an email hard bounce", async () => {
    const config = pilotConfig();
    const db = database(config);
    const prepared = createApprovedPilotMessage(db, "whatsapp-failure");
    const notifySafetyPause = vi.fn(async () => undefined);
    const notifier: InquiryNotifier = {
      notifyInquiry: vi.fn(async () => undefined),
      notifyReply: vi.fn(async () => undefined),
      notifySafetyPause,
    };
    const processor = new InboundProcessor(config, db, notifier);
    const classification: InboundClassification = {
      classification: "BOUNCE",
      confidence: 0.99,
      reason: "WhatsApp delivery failed: rate limited",
      shouldNotify: false,
      shouldTakeover: false,
      shouldStopAutomation: true,
    };

    await processor.process(
      {
        channel: "whatsapp",
        providerId: "whatsapp-failure-1",
        fromAddress: "60123456789",
        subject: "WhatsApp delivery failure",
        bodyText: classification.reason,
        receivedAt: new Date().toISOString(),
        classification: "BOUNCE",
        confidence: classification.confidence,
        reason: classification.reason,
        leadId: prepared.leadId,
        contactId: prepared.contactId,
      },
      classification,
    );

    expect(db.getSetting("outbound_paused")).toBe("false");
    expect(db.getContact(prepared.contactId)).toMatchObject({ email_status: "RISKY" });
    expect(db.listOutboundMessagesForLead(prepared.leadId)).toEqual([
      expect.objectContaining({ id: prepared.messageId, status: "APPROVED" }),
    ]);
    expect(db.getMetrics()).toMatchObject({ bounces: 0, whatsappDeliveryFailures: 1 });
    expect(notifySafetyPause).not.toHaveBeenCalled();
    db.close();
  });

  it("rolls back a partial inbound failure and safely replays the same provider message", async () => {
    const config = pilotConfig();
    const db = database(config);
    const prepared = createApprovedPilotMessage(db, "inbound-retry");
    const notifier: InquiryNotifier = {
      notifyInquiry: vi.fn(async () => undefined),
      notifyReply: vi.fn(async () => undefined),
      notifySafetyPause: vi.fn(async () => undefined),
    };
    const processor = new InboundProcessor(config, db, notifier);
    const classification: InboundClassification = {
      classification: "P1_INQUIRY",
      confidence: 0.99,
      reason: "quotation request",
      shouldNotify: true,
      shouldTakeover: true,
      shouldStopAutomation: true,
    };
    const input = {
      channel: "email" as const,
      providerId: "inbound-retry-1",
      fromAddress: "buyer-inbound-retry@example.com",
      subject: "Quotation",
      bodyText: "Please quote",
      receivedAt: new Date().toISOString(),
      classification: "P1_INQUIRY" as const,
      confidence: classification.confidence,
      reason: classification.reason,
      leadId: prepared.leadId,
      contactId: prepared.contactId,
    };
    const takeover = vi.spyOn(db, "setHumanTakeover")
      .mockImplementationOnce(() => { throw new Error("injected takeover failure"); });

    await expect(processor.process(input, classification)).rejects.toThrow("injected takeover failure");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get()).toEqual({ count: 0 });
    expect(db.getLead(prepared.leadId)).toMatchObject({ status: "APPROVED", human_takeover: 0 });
    expect(db.listSourceMetrics().every((row) => row.replies === 0 && row.inquiries === 0)).toBe(true);

    takeover.mockRestore();
    await expect(processor.process(input, classification)).resolves.toMatchObject({
      inserted: true,
      leadId: prepared.leadId,
    });
    expect(db.getLead(prepared.leadId)).toMatchObject({ status: "HUMAN_TAKEOVER", human_takeover: 1 });
    expect(db.listSourceMetrics().every((row) => row.replies === 1 && row.inquiries === 1)).toBe(true);
    expect(notifier.notifyInquiry).toHaveBeenCalledOnce();
    db.close();
  });

  it("keeps consumer mailboxes blocked when the explicit pilot flag is off", () => {
    const db = database();
    const config = pilotConfig({ CONSUMER_EMAIL_PILOT_ENABLED: "false" });
    const prepared = createApprovedPilotMessage(db, "disabled");
    const item = new OutboundDispatcher(config, db).plan(10).find((entry) => entry.messageId === prepared.messageId);
    expect(item?.blockers).toContain("consumer mailbox is not allowed for production outreach");
    db.close();
  });

  it("keeps all customer messages blocked until the Gmail pilot is explicitly activated", () => {
    const config = pilotConfig();
    const db = database();
    ensureGmailPilotState(config, db);
    db.setSetting("outbound_paused", "false");
    const prepared = createApprovedPilotMessage(db, "not-activated");

    const item = new OutboundDispatcher(config, db)
      .plan(10)
      .find((entry) => entry.messageId === prepared.messageId);

    expect(item?.blockers).toContain("Gmail pilot has not been explicitly activated");
    db.close();
  });

  it("sends the Gmail self-test only to the configured sender and does not activate outreach", async () => {
    const config = pilotConfig();
    const db = database();
    const dispatcher = new OutboundDispatcher(config, db);

    const result = await dispatcher.testGmailPilot("tester");

    expect(result.sent).toBe(true);
    expect(smtp.verify).toHaveBeenCalledOnce();
    expect(smtp.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: config.EMAIL_FROM_ADDRESS,
        subject: expect.stringContaining("Gmail 试运行自测成功"),
      }),
    );
    expect(ensureGmailPilotState(config, db)).toMatchObject({
      selfTestPassed: true,
      activated: false,
    });
    expect(db.getSetting("outbound_paused")).toBe("true");
    db.close();
  });

  it("revokes a previous activation when the protected Gmail configuration changes", () => {
    const config = pilotConfig();
    const db = database(config);
    expect(ensureGmailPilotState(config, db).activated).toBe(true);

    const changedConfig = pilotConfig({ SMTP_PASSWORD: "changed-test-password" });
    expect(ensureGmailPilotState(changedConfig, db)).toMatchObject({
      selfTestPassed: false,
      activated: false,
    });
    expect(db.getSetting("outbound_paused")).toBe("true");
    db.close();
  });

  it("requires a named, currently verified contact before drafting", () => {
    const blockers = emailDraftPolicyBlockers(
      pilotConfig(),
      { total_score: 95 },
      {
        name: "",
        title: "",
        email_status: "RISKY",
        email_risk: "MX valid; deep mailbox verification not configured",
        source_url: "",
      },
    );
    expect(blockers).toContain("named contact is missing");
    expect(blockers).toContain("current job title is missing");
    expect(blockers).toContain("current employment verification is missing");
    expect(blockers).toContain("contact evidence URL is missing");
  });
});
