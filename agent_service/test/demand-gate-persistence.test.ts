import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("persisted deterministic demand gate", () => {
  it("fails closed when a caller submits a stale full-score lead as send eligible", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-demand-gate-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "stale-demand-gate",
      market: "Test",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const leadId = db.upsertLead({
      campaignId,
      company: "Legacy Scored Buyer",
      domain: "legacy-score.invalid",
      website: "https://legacy-score.invalid",
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
      demandEvidenceQualified: false,
      demandPolicyVersion: "legacy-llm-score",
      demandStage: "RECENT_PROCUREMENT",
      demandEvidence: [],
      sendEligible: true,
      eligibilityReasons: [],
    });

    expect(db.getLead(leadId)).toMatchObject({
      total_score: 100,
      send_eligible: 0,
      demand_evidence_qualified: 0,
      demand_policy_version: "legacy-llm-score",
    });
    db.transitionLead(leadId, "VERIFYING", "test", "verify stale import");
    expect(() => db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "attempt bypass"))
      .toThrow("current deterministic demand evidence gate");
    expect(db.listReviewLeads()).toHaveLength(0);
    db.close();
  });
});
