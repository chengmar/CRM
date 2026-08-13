import { createHash } from "node:crypto";
import { buildMarketAllocationPlan, type MarketAllocationPlan } from "./market-allocation.js";

export interface MarketAllocationShadowReport {
  fixtureSet: "market-allocation-shadow-v1";
  markets: number;
  shadowAccountsPerPlay: 30;
  topThreePlayIds: string[];
  plan: MarketAllocationPlan;
  safety: { networkCalls: 0; paidDataCalls: 0; campaignActivations: 0; externalWrites: 0 };
  verdict: "HOLD";
  reason: string;
}

export function runMarketAllocationShadow(): MarketAllocationShadowReport {
  const countries = ["MY", "VN", "PH", "ID", "MX"];
  const evidence = countries.map((country, index) => ({
    id: `market-evidence-${country}`,
    country,
    period: "2025",
    hsRevision: "HS2022",
    metric: "BUYER_ECOSYSTEM" as const,
    value: 50 + index * 10,
    unit: "synthetic-index",
    sourceUrl: `https://fixture.invalid/market/${country.toLowerCase()}`,
    authority: "GOVERNMENT" as const,
    retrievedAt: "2026-07-19T00:00:00.000Z",
    contentHash: createHash("sha256").update(`market-${country}`).digest("hex"),
    confidence: 0.9,
    license: "PUBLIC_DOMAIN" as const,
    humanReview: "APPROVED" as const,
    expiresAt: "2027-07-19T00:00:00.000Z",
  }));
  const plays = countries.map((country, index) => ({
    playId: `play-${country.toLowerCase()}-sample-product`,
    country,
    buyerArchetype: "SYSTEM_INTEGRATOR_EPC",
    application: "sample use case",
    offerId: "rfq-checklist",
    evidenceIds: [`market-evidence-${country}`],
    shadowAccounts: 30,
    researchHours: 10,
    qualifiedAccounts: 10 + index,
    validContacts: 4 + index,
    delivered: 0,
    positiveReplies: 0,
    inquiries: 0,
    quotes: 0,
    wins: 0,
    revenueMinor: 0,
    grossMarginMinor: 0,
    costMinor: 100_000 + index * 10_000,
    measurementDays: 0,
  }));
  const plan = buildMarketAllocationPlan({
    asOf: "2026-07-20T00:00:00.000Z",
    totalResearchUnits: 100,
    explorationShare: 0.2,
    maxPlayShare: 0.5,
    minimumMatureDelivered: 100,
    minimumMatureDays: 14,
    evidence,
    plays,
  });
  const topThreePlayIds = [...plan.rows]
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .slice(0, 3)
    .map((row) => row.playId);
  return {
    fixtureSet: "market-allocation-shadow-v1",
    markets: countries.length,
    shadowAccountsPerPlay: 30,
    topThreePlayIds,
    plan,
    safety: { networkCalls: 0, paidDataCalls: 0, campaignActivations: 0, externalWrites: 0 },
    verdict: "HOLD",
    reason: "Synthetic evidence packs and 30-account shadows cannot authorize live allocation or market claims.",
  };
}
