import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const databases: AgentDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(): { db: AgentDatabase; campaignId: string; leadId: string } {
  const db = new AgentDatabase(":memory:");
  databases.push(db);
  const campaignId = db.createCampaign({
    name: "Async guard runtime fixture",
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 1,
    hourlyLimit: 1,
    followupDays: [3],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: "Runtime Guard Company",
    domain: "runtime-guard.example",
    website: "https://runtime-guard.example/",
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
    lastActivityAt: "2026-07-20T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ sourceUrl: "https://runtime-guard.example/rfq" }],
    sendEligible: false,
    eligibilityReasons: ["named contact missing"],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "prepare async guard fixture");
  db.transitionLead(leadId, "ENRICHING", "test", "prepare async guard fixture");
  return { db, campaignId, leadId };
}

function guardOptions(campaignId: string) {
  return {
    campaignId,
    allowedStatuses: ["ENRICHING"] as const,
  };
}

describe("lead automation guard async runtime", () => {
  it("allows database writes while the synchronous guard callback is active", () => {
    const { db, campaignId, leadId } = fixture();

    const result = db.withLeadAutomationGuard(
      leadId,
      guardOptions(campaignId),
      () => db.addDnc("domain", "synchronous.example", "fixture", "test"),
    );

    expect(result.applied).toBe(true);
    expect(db.hasDncMatch([{ type: "domain", value: "synchronous.example" }])).toBe(true);
  });

  it("rolls back sync writes and blocks a returned Promise continuation using AgentDatabase", async () => {
    const { db, campaignId, leadId } = fixture();
    let continuation!: Promise<void>;

    expect(() => db.withLeadAutomationGuard(
      leadId,
      guardOptions(campaignId),
      (() => {
        db.addLeadSource(
          leadId,
          "https://runtime-guard.example/rolled-back",
          "official_website",
          null,
          "must roll back",
        );
        continuation = Promise.resolve().then(() => {
          db.addDnc("domain", "escaped-method.example", "fixture", "test");
        });
        return continuation;
      }) as never,
    )).toThrow("must be synchronous");

    await expect(continuation).rejects.toThrow("Expired lead automation guard context");
    expect(db.countLeadSources(leadId)).toBe(0);
    expect(db.hasDncMatch([{ type: "domain", value: "escaped-method.example" }])).toBe(false);
  });

  it("blocks a returned Promise continuation using a statement prepared before the guard", async () => {
    const { db, campaignId, leadId } = fixture();
    const insert = db.db.prepare(
      `INSERT INTO dnc(id, value_type, value, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let continuation!: Promise<void>;

    expect(() => db.withLeadAutomationGuard(
      leadId,
      guardOptions(campaignId),
      (() => {
        continuation = Promise.resolve().then(() => {
          insert.run(
            "dnc_escaped_statement",
            "domain",
            "escaped-statement.example",
            "fixture",
            "test",
            "2026-07-20T00:00:00.000Z",
          );
        });
        return continuation;
      }) as never,
    )).toThrow("must be synchronous");

    await expect(continuation).rejects.toThrow("Expired lead automation guard context");
    expect(db.hasDncMatch([{ type: "domain", value: "escaped-statement.example" }])).toBe(false);
  });

  it("blocks fire-and-forget Promise work after a synchronous callback commits", async () => {
    const { db, campaignId, leadId } = fixture();
    let continuation!: Promise<void>;

    const result = db.withLeadAutomationGuard(leadId, guardOptions(campaignId), () => {
      continuation = Promise.resolve().then(() => {
        db.addDnc("domain", "fire-and-forget.example", "fixture", "test");
      });
      return "committed";
    });

    expect(result).toEqual({ applied: true, value: "committed" });
    await expect(continuation).rejects.toThrow("Expired lead automation guard context");
    expect(db.hasDncMatch([{ type: "domain", value: "fire-and-forget.example" }])).toBe(false);
  });
});
