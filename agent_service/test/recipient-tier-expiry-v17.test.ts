import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function target(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-tier-expiry-v17-"));
  directories.push(directory);
  return path.join(directory, "agent.db");
}

function seedLead(db: AgentDatabase, suffix: string, employmentVerifiedAt: string) {
  const domain = `${suffix}.buyer.example`;
  const campaignId = db.createCampaign({
    name: `Recipient expiry ${suffix}`,
    market: "Malaysia",
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Recipient Expiry ${suffix}`,
    domain,
    website: `https://${domain}`,
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: employmentVerifiedAt,
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "CURRENT_PROJECT",
    demandEvidence: [],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "ready");
  const email = `person@${domain}`;
  const contactId = db.upsertContact({
    leadId,
    name: "Morgan Lee",
    title: "Engineering Manager",
    email,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt,
    emailStatus: "VALID",
    emailRisk: "fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  return { campaignId, leadId, contactId, email };
}

describe("recipient tier employment expiry v17", () => {
  it("downgrades a legacy tier A contact when migration runs after employment evidence expired", () => {
    const file = target();
    const initialized = new AgentDatabase(file);
    const seeded = seedLead(initialized, "migration", new Date().toISOString());
    initialized.close();

    const legacy = new DatabaseSync(file);
    legacy.prepare(
      `UPDATE contacts SET employment_verified_at='2020-01-01T00:00:00.000Z', recipient_tier='A'
       WHERE id=?`,
    ).run(seeded.contactId);
    legacy.exec(`
      DROP TRIGGER IF EXISTS trg_v17_campaign_message_recipient_tier_insert;
      DROP TABLE IF EXISTS imap_message_failures;
      DELETE FROM schema_migrations WHERE version IN (17, 18);
      PRAGMA user_version=16;
    `);
    legacy.close();

    const migrated = new AgentDatabase(file);
    try {
      expect(LATEST_SCHEMA_VERSION).toBe(19);
      expect(migrated.db.prepare(
        "SELECT recipient_tier, recipient_evidence_hash FROM contacts WHERE id=?",
      ).get(seeded.contactId)).toEqual({ recipient_tier: "C", recipient_evidence_hash: null });
      const trigger = migrated.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_v17_campaign_message_recipient_tier_insert'",
      ).get() as { sql: string };
      expect(trigger.sql).toContain("julianday(c.employment_verified_at) BETWEEN julianday(NEW.created_at)-90");
    } finally {
      migrated.close();
    }
  });

  it("rechecks the 90-day employment TTL inside the atomic send claim", () => {
    const db = new AgentDatabase(target());
    try {
      const now = new Date("2026-07-21T12:00:00.000Z");
      const seeded = seedLead(db, "claim", now.toISOString());
      const messageId = db.createOutboundMessage({
        campaignId: seeded.campaignId,
        leadId: seeded.leadId,
        contactId: seeded.contactId,
        channel: "email",
        destination: seeded.email,
        subject: "Fixture",
        body: "Fixture",
        sequenceIndex: 0,
        status: "PENDING_APPROVAL",
      });
      db.approveLeadSequence(seeded.leadId, "reviewer", db.getSequenceReviewHash(seeded.leadId));
      db.setSetting("outbound_paused", "false");
      const expired = new Date(now.getTime() - 91 * 86_400_000).toISOString();
      db.db.prepare("UPDATE contacts SET employment_verified_at=?, recipient_tier='A' WHERE id=?")
        .run(expired, seeded.contactId);

      expect(() => db.claimMessageForSending(messageId, { now })).toThrow(/90-day policy TTL/);
      expect(db.db.prepare("SELECT status, attempts FROM outbound_messages WHERE id=?").get(messageId))
        .toEqual({ status: "APPROVED", attempts: 0 });
    } finally {
      db.close();
    }
  });
});
