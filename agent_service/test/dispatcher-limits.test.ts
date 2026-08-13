import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { recordImapPollSuccess } from "../src/inbound/email-health.js";
import { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { markEmailChannelSelfTestPassed } from "../src/outreach/email-channel.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

function createApprovedEmail(
  db: AgentDatabase,
  campaignId: string,
  suffix: string,
): { leadId: string; contactId: string; messageId: string; destination: string } {
  const destination = `buyer-${suffix}@limit-${suffix}.invalid`;
  const leadId = db.upsertLead({
    campaignId,
    company: `Limit Test ${suffix}`,
    domain: `limit-${suffix}.invalid`,
    website: `https://limit-${suffix}.invalid`,
    country: "Test",
    buyerType: "integrator",
    product: "sample components",
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
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "quality gate");
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${suffix}`,
    title: "Procurement Manager",
    email: destination,
    sourceUrl: `https://limit-${suffix}.invalid/team`,
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "test",
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
    subject: "Test",
    body: "Test",
    sequenceIndex: 0,
    scheduledAt: new Date().toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "reviewer", db.getSequenceReviewHash(leadId));
  return { leadId, contactId, messageId, destination };
}

describe("outbound dispatcher limits", () => {
  it("blocks planning and auto-pauses when IMAP runtime health becomes stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-imap-plan-gate-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "imap-plan-gate",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 10,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const prepared = createApprovedEmail(db, campaignId, "imap-plan-gate");
    const config = loadConfig({
      AGENT_MODE: "production",
      OUTBOUND_ENABLED: "true",
      REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
      OUTREACH_APPROVAL_REQUIRED: "true",
      EMAIL_OUTREACH_ENABLED: "true",
      EMAIL_INBOUND_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sender@manufacturer.example",
      EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
      COMPANY_POSTAL_ADDRESS: "Verified company postal address",
      EMAIL_DOMAIN_AUTH_VERIFIED: "true",
      SMTP_HOST: "smtp.manufacturer.example",
      SMTP_USER: "sender@manufacturer.example",
      SMTP_PASSWORD: "test-password",
      IMAP_HOST: "imap.manufacturer.example",
      IMAP_USER: "sender@manufacturer.example",
      IMAP_PASSWORD: "test-password",
      IMAP_HEALTH_STALE_SECONDS: "45",
      EMAIL_POLL_SECONDS: "15",
      FEISHU_BOT_ENABLED: "true",
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "test-only",
      FEISHU_ALERT_OPEN_IDS: "ou_test",
    });
    markEmailChannelSelfTestPassed(config, db, "test");
    recordImapPollSuccess(config, db);
    db.setSetting("outbound_paused", "false");
    const dispatcher = new OutboundDispatcher(config, db);

    expect(dispatcher.plan(10).find((item) => item.messageId === prepared.messageId)?.blockers)
      .not.toContain("IMAP runtime reply monitoring is not healthy (STALE)");
    db.setSettings({
      imap_monitor_started_at: "2020-01-01T00:00:00.000Z",
      imap_last_poll_success_at: "2020-01-01T00:00:01.000Z",
      imap_consecutive_failures: "0",
      imap_runtime_health_state: "HEALTHY",
      outbound_paused: "false",
    });

    expect(dispatcher.plan(10).find((item) => item.messageId === prepared.messageId)?.blockers)
      .toContain("IMAP runtime reply monitoring is not healthy (STALE)");
    expect(db.getSetting("outbound_paused")).toBe("true");
    dispatcher.close();
    db.close();
  });

  it("uses an adaptive enterprise ramp instead of blocking every message until warm-up is complete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-enterprise-ramp-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "enterprise-ramp",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 500,
      hourlyLimit: 100,
      followupDays: [3, 7, 14],
    });
    const prepared = createApprovedEmail(db, campaignId, "enterprise-ramp");
    const config = loadConfig({
      AGENT_MODE: "production",
      OUTBOUND_ENABLED: "true",
      REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
      OUTREACH_APPROVAL_REQUIRED: "true",
      EMAIL_OUTREACH_ENABLED: "true",
      EMAIL_INBOUND_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sender@manufacturer.example",
      EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
      COMPANY_POSTAL_ADDRESS: "Verified company postal address",
      EMAIL_DOMAIN_AUTH_VERIFIED: "true",
      EMAIL_WARMUP_COMPLETE: "false",
      SMTP_HOST: "smtp.manufacturer.example",
      SMTP_USER: "sender@manufacturer.example",
      SMTP_PASSWORD: "test-password",
      IMAP_HOST: "imap.manufacturer.example",
      IMAP_USER: "sender@manufacturer.example",
      IMAP_PASSWORD: "test-password",
      FEISHU_BOT_ENABLED: "true",
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "test-only",
      FEISHU_ALERT_OPEN_IDS: "ou_test",
      EMAIL_DAILY_LIMIT: "500",
      EMAIL_HOURLY_LIMIT: "100",
      EMAIL_MIN_INTERVAL_SECONDS: "30",
    });

    const item = new OutboundDispatcher(config, db).plan(10)
      .find((candidate) => candidate.messageId === prepared.messageId);
    expect(item).toBeDefined();
    expect(item?.blockers).not.toContain("sender domain warm-up is not complete");
    expect(item?.blockers).not.toContain("hourly email limit reached (2)");
    expect(item?.blockers).not.toContain("daily email limit reached (10)");
    db.close();
  });

  it("blocks every enterprise send when the SMTP/IMAP configuration has not passed the current self-test", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-email-self-test-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "email-self-test",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 10,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const prepared = createApprovedEmail(db, campaignId, "email-self-test");
    const baseConfig = loadConfig({
      AGENT_MODE: "production",
      OUTBOUND_ENABLED: "true",
      REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
      OUTREACH_APPROVAL_REQUIRED: "true",
      EMAIL_OUTREACH_ENABLED: "true",
      EMAIL_INBOUND_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sender@manufacturer.example",
      EMAIL_REPLY_TO: "sender@manufacturer.example",
      EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
      COMPANY_POSTAL_ADDRESS: "Verified company postal address",
      EMAIL_DOMAIN_AUTH_VERIFIED: "true",
      SMTP_HOST: "smtp.manufacturer.example",
      SMTP_USER: "sender@manufacturer.example",
      SMTP_PASSWORD: "test-password",
      IMAP_HOST: "imap.manufacturer.example",
      IMAP_USER: "sender@manufacturer.example",
      IMAP_PASSWORD: "test-password",
      FEISHU_BOT_ENABLED: "true",
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "test-only",
      FEISHU_ALERT_OPEN_IDS: "ou_test",
    });
    markEmailChannelSelfTestPassed(baseConfig, db, "test");
    db.setSetting("outbound_paused", "false");

    const changedConfig = { ...baseConfig, SMTP_HOST: "smtp2.manufacturer.example" };
    const item = new OutboundDispatcher(changedConfig, db).plan(10)
      .find((candidate) => candidate.messageId === prepared.messageId);

    expect(item?.blockers).toContain("enterprise SMTP/IMAP send-receive self-test has not passed");
    expect(db.getSetting("outbound_paused")).toBe("true");
    db.close();
  });

  it("blocks a due message when hourly, daily, or DNC gates are reached", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-dispatch-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "limit-test",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 2,
      createdBy: "test",
      dailyLimit: 1,
      hourlyLimit: 1,
      followupDays: [3, 7, 14],
    });
    const first = createApprovedEmail(db, campaignId, "first");
    const second = createApprovedEmail(db, campaignId, "second");
    db.setSetting("outbound_paused", "false");
    db.markMessageSending(first.messageId);
    db.markMessageSent(first.messageId, "<first@example.invalid>");

    const config = loadConfig({
      AGENT_MODE: "production",
      OUTBOUND_ENABLED: "true",
      REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
      OUTREACH_APPROVAL_REQUIRED: "true",
      EMAIL_OUTREACH_ENABLED: "true",
      AUTO_FOLLOWUP_ENABLED: "true",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USER: "sender@example.invalid",
      SMTP_PASSWORD: "test-password",
      EMAIL_FROM_ADDRESS: "sender@example.invalid",
      EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
      EMAIL_HOURLY_LIMIT: "1",
      EMAIL_DAILY_LIMIT: "1",
    });
    const dispatcher = new OutboundDispatcher(config, db);
    let plan = dispatcher.plan(10);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.messageId).toBe(second.messageId);
    expect(plan[0]?.blockers).toContain("hourly email limit reached (1)");
    expect(plan[0]?.blockers).toContain("daily email limit reached (1)");

    db.addDnc("email", second.destination, "test", "test");
    plan = dispatcher.plan(10);
    expect(plan[0]?.blockers).toContain("destination matches do-not-contact list");
    db.close();
  });

  it("never resurrects a message cancelled by an inbound reply", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-dispatch-race-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "reply-race",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 1,
      hourlyLimit: 1,
      followupDays: [3, 7, 14],
    });
    const prepared = createApprovedEmail(db, campaignId, "reply-race");
    expect(db.getDueMessages(10)).toHaveLength(1);

    db.stopAutomationForReply(prepared.leadId, "inbound", "customer replied");
    expect(() => db.markMessageSending(prepared.messageId)).toThrow("Message is not claimable");
    expect(db.markMessageFailed(prepared.messageId, "stale dispatcher snapshot")).toBe(false);

    expect(db.listOutboundMessagesForLead(prepared.leadId)).toEqual([
      expect.objectContaining({ id: prepared.messageId, status: "CANCELLED" }),
    ]);
    expect(db.getDueMessages(10)).toHaveLength(0);
    db.close();
  });

  it("rechecks the deterministic demand gate when a planned message is atomically claimed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-demand-race-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "demand-race",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const prepared = createApprovedEmail(db, campaignId, "demand-race");
    const dispatcher = new OutboundDispatcher(loadConfig({}), db);

    expect(dispatcher.plan(10)[0]?.blockers).not.toContain(
      "current deterministic demand evidence gate is not satisfied",
    );
    db.db.prepare("UPDATE leads SET demand_policy_version='stale-policy' WHERE id=?")
      .run(prepared.leadId);
    expect(dispatcher.plan(10)[0]?.blockers).toContain(
      "current deterministic demand evidence gate is not satisfied",
    );
    expect(() => db.markMessageSending(prepared.messageId)).toThrow("Message is not claimable");
    db.close();
  });
});
