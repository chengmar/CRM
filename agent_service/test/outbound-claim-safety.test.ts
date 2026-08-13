import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import {
  imapClaimPolicy,
  initializeImapRuntimeHealth,
  recordImapPollSuccess,
} from "../src/inbound/email-health.js";
import type { AgentLlm } from "../src/llm.js";
import { MessageBuilder } from "../src/outreach/message-builder.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-outbound-claim-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  db.setSetting("outbound_paused", "false");
  return db;
}

function approvedMessage(db: AgentDatabase, suffix: string): {
  campaignId: string;
  leadId: string;
  contactId: string;
  messageId: string;
  destination: string;
} {
  const campaignId = db.createCampaign({
    name: `claim-${suffix}`,
    market: "Test",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 10,
    hourlyLimit: 10,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Buyer ${suffix}`,
    domain: `${suffix}.example.invalid`,
    website: `https://${suffix}.example.invalid`,
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
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://${suffix}.example.invalid/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "ready");
  const destination = `${suffix}@example.invalid`;
  const contactId = db.upsertContact({
    leadId,
    name: `Named Buyer ${suffix}`,
    title: "Procurement Manager",
    email: destination,
    sourceUrl: `https://${suffix}.example.invalid/team`,
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "fixture",
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
    subject: "Fixture",
    body: "Fixture",
    sequenceIndex: 0,
    scheduledAt: new Date().toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "reviewer", db.getSequenceReviewHash(leadId));
  return { campaignId, leadId, contactId, messageId, destination };
}

describe("atomic outbound claim safety", () => {
  it("rejects cross-lead contacts in the builder, database API, trigger, due query and claim", async () => {
    const db = database();
    const first = approvedMessage(db, "first-owner");
    const second = approvedMessage(db, "second-owner");
    const llm = { isConfigured: () => false } as unknown as AgentLlm;
    const builder = new MessageBuilder(loadConfig({}), db, llm);

    await expect(builder.buildEmailSequence(first.leadId, second.contactId)).rejects.toThrow(
      "Contact does not belong to the requested lead",
    );
    expect(() => db.createOutboundMessage({
      campaignId: first.campaignId,
      leadId: first.leadId,
      contactId: second.contactId,
      channel: "email",
      destination: second.destination,
      subject: "Wrong owner",
      body: "Wrong owner",
      sequenceIndex: 1,
    })).toThrow("Outbound contact does not belong to the lead");
    expect(() => db.db.prepare("UPDATE outbound_messages SET contact_id=? WHERE id=?")
      .run(second.contactId, first.messageId)).toThrow("outbound recipient ownership mismatch");

    db.db.exec("DROP TRIGGER trg_outbound_recipient_integrity_update");
    db.db.prepare(
      "UPDATE outbound_messages SET campaign_id=?, contact_id=?, destination=? WHERE id=?",
    ).run(second.campaignId, second.contactId, second.destination, first.messageId);
    expect(db.getDueMessages(20).some((message) => message.id === first.messageId)).toBe(false);
    expect(() => db.claimMessageForSending(first.messageId)).toThrow("contact belongs to another lead");
    db.close();
  });

  it("rechecks DNC, contact validity, approval and global pause inside the claim transaction", () => {
    const db = database();
    const dnc = approvedMessage(db, "dnc-race");
    const invalid = approvedMessage(db, "invalid-race");
    const approval = approvedMessage(db, "approval-race");
    const paused = approvedMessage(db, "pause-race");

    db.addDnc("email", dnc.destination, "race fixture", "test");
    db.markContactEmailInvalid(invalid.contactId, "race fixture");
    db.db.prepare("UPDATE outbound_messages SET approved_by=NULL, approved_at=NULL WHERE id=?")
      .run(approval.messageId);
    expect(() => db.claimMessageForSending(dnc.messageId)).toThrow("do-not-contact match");
    expect(() => db.claimMessageForSending(invalid.messageId)).toThrow("email status is INVALID");
    expect(() => db.claimMessageForSending(approval.messageId)).toThrow("sequence approval is missing");

    db.setSetting("outbound_paused", "true");
    expect(() => db.claimMessageForSending(paused.messageId)).toThrow("global outbound pause is active");
    db.close();
  });

  it("counts an in-flight SENDING message as an atomic rate-limit reservation", () => {
    const db = database();
    const first = approvedMessage(db, "reservation-first");
    const second = approvedMessage(db, "reservation-second");
    const policy = { globalHourlyLimit: 1, globalDailyLimit: 1 };

    expect(db.claimMessageForSending(first.messageId, policy)).toMatchObject({ status: "SENDING" });
    expect(() => db.claimMessageForSending(second.messageId, policy)).toThrow("global hourly limit reached");
    db.close();
  });

  it("rechecks IMAP runtime freshness inside the atomic claim transaction", () => {
    const db = database();
    const prepared = approvedMessage(db, "imap-claim-race");
    const config = loadConfig({
      EMAIL_INBOUND_ENABLED: "true",
      EMAIL_POLL_SECONDS: "15",
      IMAP_HEALTH_STALE_SECONDS: "45",
    });
    const started = new Date();
    initializeImapRuntimeHealth(config, db, started);
    recordImapPollSuccess(config, db, new Date(started.getTime() + 1_000));
    db.setSetting("outbound_paused", "false");

    expect(() => db.claimMessageForSending(prepared.messageId, {
      ...imapClaimPolicy(config),
      now: new Date(started.getTime() + 47_000),
    })).toThrow("IMAP runtime reply monitoring is not healthy");
    expect(db.listOutboundMessagesForLead(prepared.leadId)[0]).toMatchObject({ status: "APPROVED" });

    recordImapPollSuccess(config, db, new Date(started.getTime() + 48_000));
    expect(db.claimMessageForSending(prepared.messageId, {
      ...imapClaimPolicy(config),
      now: new Date(started.getTime() + 49_000),
    })).toMatchObject({ status: "SENDING" });
    db.close();
  });
});
