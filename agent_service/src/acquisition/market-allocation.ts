import { z } from "zod";

const DateTimeSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CountrySchema = z.string().regex(/^[A-Z]{2}$/);
const PublicSourceSchema = z.string().url().refine((value) => new URL(value).protocol === "https:", {
  message: "market evidence source must use HTTPS",
});

export const MarketEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  country: CountrySchema,
  period: z.string().trim().min(4).max(50),
  hsRevision: z.string().trim().min(1).max(50),
  metric: z.enum([
    "INDUSTRY_SCALE",
    "IMPORT_DEPENDENCY",
    "REGULATORY_DRIVER",
    "BUYER_ECOSYSTEM",
    "CONTACT_AVAILABILITY",
    "LOGISTICS_FEASIBILITY",
    "CERTIFICATION_BARRIER",
    "COMPETITION",
    "PROVIDER_COST",
    "HISTORICAL_INQUIRY",
    "HISTORICAL_WIN",
  ]),
  value: z.number().finite().nullable(),
  unit: z.string().trim().min(1).max(50),
  sourceUrl: PublicSourceSchema,
  authority: z.enum(["GOVERNMENT", "REGULATOR", "CUSTOMS", "TRADE_BODY", "INTERNAL_OUTCOME"]),
  retrievedAt: DateTimeSchema,
  contentHash: Sha256Schema,
  confidence: z.number().min(0).max(1),
  license: z.enum(["PUBLIC_DOMAIN", "OPEN_LICENSE", "INTERNAL_AUTHORIZED", "UNKNOWN", "RESTRICTED"]),
  humanReview: z.enum(["APPROVED", "PENDING", "REJECTED"]),
  expiresAt: DateTimeSchema,
}).strict();

export type MarketEvidence = z.infer<typeof MarketEvidenceSchema>;

export const HsCodeCandidateSchema = z.object({
  id: z.string().trim().min(1).max(200),
  country: CountrySchema,
  productFamily: z.string().trim().min(1).max(200),
  hsRevision: z.string().trim().min(1).max(50),
  code: z.string().regex(/^\d{4,10}$/),
  status: z.enum(["CANDIDATE", "HUMAN_CONFIRMED", "REJECTED", "STALE"]),
  proposedBy: z.string().trim().min(1).max(200),
  confirmedBy: z.string().trim().min(1).max(200).nullable(),
  confirmedAt: DateTimeSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "HUMAN_CONFIRMED") {
    if (!value.confirmedBy || !value.confirmedAt) {
      context.addIssue({ code: "custom", path: ["confirmedBy"], message: "human confirmation is required" });
    }
    if (value.confirmedBy && /^(?:agent|model|llm|system)(?:$|[:_-])/i.test(value.confirmedBy)) {
      context.addIssue({ code: "custom", path: ["confirmedBy"], message: "an agent cannot confirm an HS code" });
    }
  } else if (value.confirmedBy || value.confirmedAt) {
    context.addIssue({ code: "custom", path: ["confirmedBy"], message: "confirmation fields require HUMAN_CONFIRMED" });
  }
});

export const MarketPlayPerformanceSchema = z.object({
  playId: z.string().trim().min(1).max(200),
  country: CountrySchema,
  buyerArchetype: z.string().trim().min(1).max(200),
  application: z.string().trim().min(1).max(200),
  offerId: z.string().trim().min(1).max(200),
  evidenceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  shadowAccounts: z.number().int().nonnegative(),
  researchHours: z.number().nonnegative(),
  qualifiedAccounts: z.number().int().nonnegative(),
  validContacts: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  positiveReplies: z.number().int().nonnegative(),
  inquiries: z.number().int().nonnegative(),
  quotes: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  revenueMinor: z.number().int().nonnegative(),
  grossMarginMinor: z.number().int(),
  costMinor: z.number().int().nonnegative(),
  measurementDays: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.validContacts > value.qualifiedAccounts) {
    context.addIssue({ code: "custom", path: ["validContacts"], message: "VALID cannot exceed qualified accounts" });
  }
  if (value.positiveReplies > value.delivered || value.inquiries > value.delivered) {
    context.addIssue({ code: "custom", path: ["delivered"], message: "reply/inquiry cannot exceed delivered" });
  }
  if (value.quotes > value.inquiries || value.wins > value.quotes) {
    context.addIssue({ code: "custom", path: ["quotes"], message: "commercial outcomes are inconsistent" });
  }
});

export type MarketPlayPerformance = z.infer<typeof MarketPlayPerformanceSchema>;

export const MarketAllocationInputSchema = z.object({
  asOf: DateTimeSchema,
  totalResearchUnits: z.number().int().positive().max(1_000_000),
  explorationShare: z.number().min(0.2).max(0.5).default(0.2),
  maxPlayShare: z.number().min(0.2).max(0.5).default(0.5),
  minimumMatureDelivered: z.number().int().min(100).default(100),
  minimumMatureDays: z.number().int().min(14).default(14),
  evidence: z.array(MarketEvidenceSchema).max(10_000),
  plays: z.array(MarketPlayPerformanceSchema).min(1).max(1_000),
}).strict();

export interface MarketAllocationRow {
  playId: string;
  country: string;
  evidenceStatus: "CURRENT_APPROVED" | "MISSING_OR_BLOCKED";
  mature: boolean;
  score: number | null;
  recommendation: "EXPLORE" | "HOLD_EVIDENCE" | "HOLD" | "INCREASE" | "REDUCE_REVIEW";
  recommendedUnits: number;
  recommendedShare: number;
  reasons: string[];
}

export interface MarketAllocationPlan {
  policyVersion: "market-allocation-v1";
  totalResearchUnits: number;
  explorationUnits: number;
  explorationShare: number;
  unallocatedUnits: number;
  rows: MarketAllocationRow[];
  applied: false;
  requiresHumanApproval: true;
  automaticKills: 0;
}

function eligibleEvidence(evidence: MarketEvidence, asOfMs: number): boolean {
  return evidence.value !== null &&
    evidence.humanReview === "APPROVED" &&
    evidence.license !== "UNKNOWN" &&
    evidence.license !== "RESTRICTED" &&
    Date.parse(evidence.retrievedAt) <= asOfMs &&
    Date.parse(evidence.expiresAt) >= asOfMs;
}

function rawOutcomeScore(play: MarketPlayPerformance): number {
  const hours = Math.max(1, play.researchHours);
  const delivered = Math.max(1, play.delivered);
  const valid = Math.max(1, play.validContacts);
  const qualifiedPerHour = play.qualifiedAccounts / hours;
  const validPerHour = play.validContacts / hours;
  const positiveRate = play.positiveReplies / delivered;
  const inquiryRate = play.inquiries / delivered;
  const quoteRate = play.quotes / delivered;
  const winRate = play.wins / delivered;
  const marginPerUnit = play.grossMarginMinor / Math.max(1, play.delivered);
  const costPerValid = play.costMinor / valid;
  return Math.max(0,
    qualifiedPerHour * 1.5 +
    validPerHour * 2 +
    positiveRate * 20 +
    inquiryRate * 40 +
    quoteRate * 60 +
    winRate * 100 +
    Math.max(0, marginPerUnit) / 100_000 -
    costPerValid / 100_000,
  );
}

function cappedShares(scores: number[], explorationShare: number, maxShare: number): number[] {
  const count = scores.length;
  if (count === 0) return [];
  const explorationPerPlay = explorationShare / count;
  const positiveTotal = scores.reduce((sum, score) => sum + Math.max(0, score), 0);
  const exploitation = scores.map((score) =>
    (1 - explorationShare) * (positiveTotal > 0 ? Math.max(0, score) / positiveTotal : 1 / count),
  );
  const shares = exploitation.map((value) => value + explorationPerPlay);
  const capped = new Set<number>();
  for (let round = 0; round < count; round += 1) {
    let excess = 0;
    for (let index = 0; index < shares.length; index += 1) {
      if (!capped.has(index) && (shares[index] ?? 0) > maxShare) {
        excess += (shares[index] ?? 0) - maxShare;
        shares[index] = maxShare;
        capped.add(index);
      }
    }
    if (excess <= 1e-12) break;
    const receivers = shares.map((_, index) => index).filter((index) => !capped.has(index));
    if (receivers.length === 0) break;
    const receiverWeight = receivers.reduce((sum, index) => sum + Math.max(0, scores[index] ?? 0), 0);
    for (const index of receivers) {
      const weight = receiverWeight > 0 ? Math.max(0, scores[index] ?? 0) / receiverWeight : 1 / receivers.length;
      shares[index] = (shares[index] ?? 0) + excess * weight;
    }
  }
  const total = shares.reduce((sum, share) => sum + share, 0);
  return total > 1 + 1e-9 ? shares.map((share) => share / total) : shares;
}

function integerUnits(shares: number[], total: number): number[] {
  const exact = shares.map((share) => share * total);
  const units = exact.map(Math.floor);
  const target = Math.round(total * shares.reduce((sum, value) => sum + value, 0));
  let remainder = target - units.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const item of order) {
    if (remainder <= 0) break;
    units[item.index] = (units[item.index] ?? 0) + 1;
    remainder -= 1;
  }
  return units;
}

export function buildMarketAllocationPlan(rawInput: unknown): MarketAllocationPlan {
  const input = MarketAllocationInputSchema.parse(rawInput);
  const asOfMs = Date.parse(input.asOf);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const eligible = input.plays.map((play) => play.evidenceIds.some((id) => {
    const evidence = evidenceById.get(id);
    return evidence?.country === play.country && eligibleEvidence(evidence, asOfMs);
  }));
  const rawScores = input.plays.map((play, index) => eligible[index] ? rawOutcomeScore(play) : 0);
  const eligibleIndexes = eligible.map((value, index) => value ? index : -1).filter((index) => index >= 0);
  const eligibleScores = eligibleIndexes.map((index) => rawScores[index] ?? 0);
  const eligibleShares = cappedShares(eligibleScores, input.explorationShare, input.maxPlayShare);
  const shares = input.plays.map(() => 0);
  eligibleIndexes.forEach((index, offset) => { shares[index] = eligibleShares[offset] ?? 0; });
  const units = integerUnits(shares, input.totalResearchUnits);
  const eligibleScoreValues = rawScores.filter((_, index) => eligible[index]);
  const portfolioBenchmark = eligibleScoreValues.length > 0
    ? eligibleScoreValues.reduce((sum, value) => sum + value, 0) / eligibleScoreValues.length
    : 0;
  const rows = input.plays.map((play, index): MarketAllocationRow => {
    const mature = play.delivered >= input.minimumMatureDelivered && play.measurementDays >= input.minimumMatureDays;
    const hasEvidence = eligible[index] ?? false;
    const score = hasEvidence ? Number((rawScores[index] ?? 0).toFixed(6)) : null;
    let recommendation: MarketAllocationRow["recommendation"] = "EXPLORE";
    const reasons: string[] = [];
    if (!hasEvidence) {
      recommendation = "HOLD_EVIDENCE";
      reasons.push("NO_CURRENT_APPROVED_LICENSED_MARKET_EVIDENCE");
    } else if (!mature) {
      recommendation = "EXPLORE";
      reasons.push("SMALL_SAMPLE_EXPLORATION_PRESERVED");
    } else if ((score ?? 0) > portfolioBenchmark) {
      recommendation = "INCREASE";
      reasons.push("MATURE_OUTCOME_SCORE_ABOVE_PORTFOLIO_BENCHMARK");
    } else if ((score ?? 0) < portfolioBenchmark) {
      recommendation = "REDUCE_REVIEW";
      reasons.push("MATURE_OUTCOME_SCORE_BELOW_PORTFOLIO_BENCHMARK_REQUIRES_HUMAN_REVIEW");
    } else {
      recommendation = "HOLD";
      reasons.push("MATURE_OUTCOME_SCORE_AT_PORTFOLIO_BENCHMARK");
    }
    reasons.push("ALLOCATION_NOT_APPLIED_REQUIRES_HUMAN_APPROVAL");
    return {
      playId: play.playId,
      country: play.country,
      evidenceStatus: hasEvidence ? "CURRENT_APPROVED" : "MISSING_OR_BLOCKED",
      mature,
      score,
      recommendation,
      recommendedUnits: units[index] ?? 0,
      recommendedShare: Number((shares[index] ?? 0).toFixed(6)),
      reasons,
    };
  });
  return {
    policyVersion: "market-allocation-v1",
    totalResearchUnits: input.totalResearchUnits,
    explorationUnits: Math.ceil(input.totalResearchUnits * input.explorationShare),
    explorationShare: input.explorationShare,
    unallocatedUnits: input.totalResearchUnits - units.reduce((sum, value) => sum + value, 0),
    rows,
    applied: false,
    requiresHumanApproval: true,
    automaticKills: 0,
  };
}
