import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-enrichment-fairness-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function createCampaign(db: AgentDatabase): string {
  return db.createCampaign({
    name: "enrichment fairness",
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 60,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
}

function createEnrichingLead(db: AgentDatabase, campaignId: string, index: number): string {
  const leadId = db.upsertLead({
    campaignId,
    company: `Fair Company ${index}`,
    domain: `fair-${index}.invalid`,
    website: `https://fair-${index}.invalid`,
    country: "Vietnam",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 0,
    channelScore: 0,
    totalScore: 75,
    grade: "SILVER",
    lastActivityAt: "2026-07-19T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://fair-${index}.invalid/rfq` }],
    sendEligible: false,
    eligibilityReasons: ["named contact missing"],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "company research complete");
  db.transitionLead(leadId, "ENRICHING", "test", "named contact missing");
  return leadId;
}

describe("persistent contact enrichment rounds", () => {
  it("finishes pass 1 for all 39 leads before any lead enters pass 2", () => {
    const db = new AgentDatabase(databasePath());
    const campaignId = createCampaign(db);
    const allLeadIds = Array.from({ length: 39 }, (_, index) =>
      createEnrichingLead(db, campaignId, index),
    );
    const now = "2026-07-19T01:00:00.000Z";
    const nextDay = "2026-07-20T01:00:00.000Z";

    const firstBatch = db.listEnrichingLeads(campaignId, 25, now);
    expect(firstBatch).toHaveLength(25);
    expect(new Set(firstBatch.map((lead) => lead.enrichment_attempts))).toEqual(new Set([0]));
    for (const lead of firstBatch) {
      expect(db.completeEnrichmentAttempt(String(lead.id), 0, nextDay)).toBe(true);
    }

    const secondBatch = db.listEnrichingLeads(campaignId, 25, now);
    expect(secondBatch).toHaveLength(14);
    expect(secondBatch.every((lead) => Number(lead.enrichment_attempts) === 0)).toBe(true);
    expect(secondBatch.some((lead) => firstBatch.some((first) => first.id === lead.id))).toBe(false);
    expect(new Set([...firstBatch, ...secondBatch].map((lead) => String(lead.id)))).toEqual(
      new Set(allLeadIds),
    );
    for (const lead of secondBatch) {
      expect(db.completeEnrichmentAttempt(String(lead.id), 0, nextDay)).toBe(true);
    }

    expect(db.listEnrichingLeads(campaignId, 25, now)).toEqual([]);
    expect(db.getEnrichmentQueueState(campaignId, now)).toEqual({
      currentPass: 2,
      remainingInPass: 39,
      remainingEligible: 39,
      nextRunAt: nextDay,
    });
    const passTwo = db.listEnrichingLeads(campaignId, 25, nextDay);
    expect(passTwo).toHaveLength(25);
    expect(passTwo.every((lead) => Number(lead.enrichment_attempts) === 1)).toBe(true);
    db.close();
  });

  it("persists completed passes across restart and caps each lead at three attempts", () => {
    const file = databasePath();
    let db = new AgentDatabase(file);
    const campaignId = createCampaign(db);
    const leadId = createEnrichingLead(db, campaignId, 1);
    const passTwoAt = "2026-07-20T01:00:00.000Z";
    const passThreeAt = "2026-07-21T01:00:00.000Z";

    expect(db.completeEnrichmentAttempt(leadId, 0, passTwoAt)).toBe(true);
    db.close();
    db = new AgentDatabase(file);

    expect(db.completeEnrichmentAttempt(leadId, 0, passTwoAt)).toBe(false);
    expect(db.listEnrichingLeads(campaignId, 1, "2026-07-19T12:00:00.000Z")).toEqual([]);
    expect(db.listEnrichingLeads(campaignId, 1, passTwoAt)).toEqual([
      expect.objectContaining({ id: leadId, enrichment_attempts: 1 }),
    ]);
    expect(db.completeEnrichmentAttempt(leadId, 1, passThreeAt)).toBe(true);
    expect(db.completeEnrichmentAttempt(leadId, 2, "2026-07-22T01:00:00.000Z")).toBe(true);

    expect(db.getLead(leadId)).toMatchObject({
      status: "ENRICHMENT_EXHAUSTED",
      enrichment_attempts: 3,
      enrichment_next_at: null,
    });
    expect(db.listEnrichingLeads(campaignId, 1, "2030-01-01T00:00:00.000Z")).toEqual([]);
    expect(db.getEnrichmentQueueState(campaignId, "2030-01-01T00:00:00.000Z")).toEqual({
      currentPass: null,
      remainingInPass: 0,
      remainingEligible: 0,
      nextRunAt: null,
    });
    db.transitionLead(leadId, "ENRICHING", "test", "start a new enrichment cycle");
    expect(db.getLead(leadId)).toMatchObject({
      status: "ENRICHING",
      enrichment_attempts: 0,
      enrichment_next_at: null,
    });
    expect(db.listEnrichingLeads(campaignId, 1, "2030-01-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({ id: leadId, enrichment_attempts: 0 }),
    ]);
    db.close();
  });
});
