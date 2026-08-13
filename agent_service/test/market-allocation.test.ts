import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HsCodeCandidateSchema,
  buildMarketAllocationPlan,
} from "../src/acquisition/market-allocation.js";
import { runMarketAllocationShadow } from "../src/acquisition/market-shadow.js";

function evidence(id: string, country: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    country,
    period: "2025",
    hsRevision: "HS2022",
    metric: "BUYER_ECOSYSTEM",
    value: 10,
    unit: "index",
    sourceUrl: `https://fixture.invalid/${id}`,
    authority: "GOVERNMENT",
    retrievedAt: "2026-07-19T00:00:00.000Z",
    contentHash: createHash("sha256").update(id).digest("hex"),
    confidence: 0.9,
    license: "PUBLIC_DOMAIN",
    humanReview: "APPROVED",
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function play(id: string, country: string, evidenceId: string, overrides: Record<string, unknown> = {}) {
  return {
    playId: id,
    country,
    buyerArchetype: "SYSTEM_INTEGRATOR_EPC",
    application: "sample application",
    offerId: "rfq-checklist",
    evidenceIds: [evidenceId],
    shadowAccounts: 30,
    researchHours: 10,
    qualifiedAccounts: 10,
    validContacts: 5,
    delivered: 0,
    positiveReplies: 0,
    inquiries: 0,
    quotes: 0,
    wins: 0,
    revenueMinor: 0,
    grossMarginMinor: 0,
    costMinor: 100_000,
    measurementDays: 0,
    ...overrides,
  };
}

describe("WO-17 market allocation policy", () => {
  it("rejects model-confirmed HS codes", () => {
    expect(() => HsCodeCandidateSchema.parse({
      id: "hs-1",
      country: "MY",
      productFamily: "sample components",
      hsRevision: "HS2022",
      code: "842139",
      status: "HUMAN_CONFIRMED",
      proposedBy: "llm:fixture",
      confirmedBy: "agent:market",
      confirmedAt: "2026-07-20T00:00:00.000Z",
    })).toThrow(/agent cannot confirm/i);
  });

  it("blocks unknown-license evidence from allocation", () => {
    const plan = buildMarketAllocationPlan({
      asOf: "2026-07-20T00:00:00.000Z",
      totalResearchUnits: 100,
      explorationShare: 0.2,
      maxPlayShare: 0.5,
      evidence: [evidence("e-my", "MY", { license: "UNKNOWN" })],
      plays: [play("p-my", "MY", "e-my")],
    });
    expect(plan.rows[0]).toMatchObject({
      evidenceStatus: "MISSING_OR_BLOCKED",
      recommendation: "HOLD_EVIDENCE",
      recommendedUnits: 0,
    });
  });

  it("preserves exploration, caps concentration and never auto-kills small samples", () => {
    const countries = ["MY", "VN", "PH", "ID", "MX"];
    const plan = buildMarketAllocationPlan({
      asOf: "2026-07-20T00:00:00.000Z",
      totalResearchUnits: 100,
      explorationShare: 0.2,
      maxPlayShare: 0.5,
      evidence: countries.map((country) => evidence(`e-${country}`, country)),
      plays: countries.map((country, index) => play(`p-${country}`, country, `e-${country}`, {
        qualifiedAccounts: index === 0 ? 30 : 3,
        validContacts: index === 0 ? 20 : 1,
      })),
    });
    expect(plan.explorationUnits).toBeGreaterThanOrEqual(20);
    expect(plan.rows.reduce((sum, row) => sum + row.recommendedUnits, 0)).toBe(100);
    expect(Math.max(...plan.rows.map((row) => row.recommendedShare))).toBeLessThanOrEqual(0.5);
    expect(plan.rows.every((row) => row.recommendation === "EXPLORE")).toBe(true);
    expect(plan).toMatchObject({ applied: false, requiresHumanApproval: true, automaticKills: 0 });
  });

  it("only recommends mature changes and still requires human review", () => {
    const plan = buildMarketAllocationPlan({
      asOf: "2026-07-20T00:00:00.000Z",
      totalResearchUnits: 100,
      evidence: [evidence("e-my", "MY"), evidence("e-vn", "VN")],
      plays: [
        play("p-my", "MY", "e-my", {
          delivered: 100,
          positiveReplies: 20,
          inquiries: 10,
          quotes: 5,
          wins: 2,
          measurementDays: 14,
        }),
        play("p-vn", "VN", "e-vn", {
          delivered: 100,
          positiveReplies: 1,
          inquiries: 1,
          quotes: 0,
          wins: 0,
          measurementDays: 14,
        }),
      ],
    });
    expect(plan.rows.find((row) => row.playId === "p-my")?.recommendation).toBe("INCREASE");
    expect(plan.rows.find((row) => row.playId === "p-vn")?.recommendation).toBe("REDUCE_REVIEW");
    expect(plan.applied).toBe(false);
  });

  it("produces a five-market synthetic HOLD report with no external actions", () => {
    const report = runMarketAllocationShadow();
    expect(report).toMatchObject({
      markets: 5,
      shadowAccountsPerPlay: 30,
      verdict: "HOLD",
      safety: { networkCalls: 0, paidDataCalls: 0, campaignActivations: 0, externalWrites: 0 },
    });
    expect(report.topThreePlayIds).toHaveLength(3);
    expect(report.plan.rows.every((row) => row.recommendation === "EXPLORE")).toBe(true);
  });
});
