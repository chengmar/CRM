import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
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

describe("human takeover", () => {
  it("cancels every unsent follow-up atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-test-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "test",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 3,
      hourlyLimit: 1,
      followupDays: [3, 7, 14],
    });
    const leadId = db.upsertLead({
      campaignId,
      company: "Test Company",
      domain: "test.invalid",
      website: "https://test.invalid",
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
    db.transitionLead(leadId, "VERIFYING", "test", "test");
    db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "test");
    const contactId = db.upsertContact({
      leadId,
      name: "Buyer",
      title: "Procurement Manager",
      email: "buyer@test.invalid",
      sourceUrl: "https://test.invalid",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "test",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    db.createOutboundMessage({
      campaignId,
      leadId,
      contactId,
      channel: "email",
      destination: "buyer@test.invalid",
      subject: "First",
      body: "First",
      sequenceIndex: 0,
      status: "PENDING_APPROVAL",
    });
    db.createOutboundMessage({
      campaignId,
      leadId,
      contactId,
      channel: "email",
      destination: "buyer@test.invalid",
      subject: "Follow-up",
      body: "Follow-up",
      sequenceIndex: 1,
      status: "PENDING_APPROVAL",
    });
    const staleReviewHash = db.getSequenceReviewHash(leadId);
    db.db
      .prepare("UPDATE outbound_messages SET body='changed after review' WHERE lead_id=? AND sequence_index=1")
      .run(leadId);
    expect(() => db.approveLeadSequence(leadId, "test", staleReviewHash)).toThrow(
      "Outbound sequence changed after review",
    );
    expect(db.listReviewLeads()).toHaveLength(1);
    db.db.prepare("UPDATE leads SET demand_policy_version='stale-policy' WHERE id=?").run(leadId);
    expect(db.listReviewLeads()).toHaveLength(0);
    expect(() => db.approveLeadSequence(leadId, "test", db.getSequenceReviewHash(leadId))).toThrow(
      "current deterministic demand evidence gate",
    );
    db.db.prepare("UPDATE leads SET demand_policy_version=? WHERE id=?")
      .run(DEMAND_POLICY_VERSION, leadId);
    db.approveLeadSequence(leadId, "test", db.getSequenceReviewHash(leadId));
    db.setHumanTakeover(leadId, "test", "inquiry");
    expect(db.getLead(leadId)?.status).toBe("HUMAN_TAKEOVER");
    expect(db.listOutboundMessagesForLead(leadId).every((message) => message.status === "CANCELLED")).toBe(true);
    db.close();
  });
});
