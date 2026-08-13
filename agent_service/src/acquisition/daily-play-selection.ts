import { z } from "zod";

export const DAILY_PLAY_SELECTION_POLICY_VERSION = "daily-play-selection-v1" as const;

export const RESEARCH_ELIGIBLE_PLAY_STATUSES = [
  "SHADOW",
  "APPROVED",
  "READY_TO_STAGE",
  "STAGED_PAUSED",
  "ACTIVE",
] as const;

const DateTimeSchema = z.string().datetime({ offset: true });
const IdSchema = z.string().trim().min(1).max(200);

export const DailyPlaySelectionCandidateSchema = z.object({
  playId: IdSchema,
  playVersionId: IdSchema,
  playVersionNumber: z.number().int().positive(),
  isLatestPlayVersion: z.boolean(),
  playStatus: z.enum([
    "DRAFT",
    "EVIDENCE_REVIEW",
    "SHADOW",
    "APPROVED",
    "READY_TO_STAGE",
    "STAGED_PAUSED",
    "ACTIVE",
    "PAUSED",
    "STOPPED",
    "KILLED",
  ]),
  template: z.object({
    market: z.string().trim().min(1).max(200),
    product: z.string().trim().min(1).max(200),
    buyerType: z.string().trim().min(1).max(200),
    application: z.string().trim().min(1).max(200),
    offer: z.string().trim().min(1).max(200),
    roleFamily: z.string().trim().min(1).max(200),
    qualificationTrack: z.enum(["ACTIVE_INTENT", "ICP_FIT", "WATCHLIST"]),
    channel: z.enum(["EMAIL", "WHATSAPP", "LINKEDIN", "MULTI_CHANNEL"]),
  }).strict(),
  hasApprovedCurrentMarketEvidence: z.boolean(),
  allocation: z.object({
    id: IdSchema,
    createdAt: DateTimeSchema,
    policyVersion: IdSchema,
    recommendedUnits: z.number().int().nonnegative(),
    recommendedShare: z.number().min(0).max(1),
    recommendation: z.enum([
      "EXPLORE",
      "HOLD_EVIDENCE",
      "HOLD",
      "INCREASE",
      "REDUCE_REVIEW",
    ]),
    applied: z.boolean(),
    requiresHumanApproval: z.boolean(),
  }).strict(),
  performance: z.object({
    priorDailySelections: z.number().int().nonnegative(),
    researchedAccounts: z.number().int().nonnegative(),
    researchHours: z.number().nonnegative(),
    qualifiedAccounts: z.number().int().nonnegative(),
    validContacts: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    positiveReplies: z.number().int().nonnegative(),
    inquiries: z.number().int().nonnegative(),
    quotes: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    grossMarginMinor: z.number().int(),
    costMinor: z.number().int().nonnegative(),
    measurementDays: z.number().int().nonnegative(),
  }).strict().superRefine((value, context) => {
    if (value.qualifiedAccounts > value.researchedAccounts) {
      context.addIssue({
        code: "custom",
        path: ["researchedAccounts"],
        message: "qualified accounts cannot exceed researched accounts",
      });
    }
    if (value.positiveReplies > value.delivered || value.inquiries > value.delivered) {
      context.addIssue({
        code: "custom",
        path: ["delivered"],
        message: "positive replies and inquiries cannot exceed delivered messages",
      });
    }
    if (value.quotes > value.inquiries || value.wins > value.quotes) {
      context.addIssue({
        code: "custom",
        path: ["quotes"],
        message: "quote and win outcomes are inconsistent",
      });
    }
  }),
}).strict();

export type DailyPlaySelectionCandidate = z.infer<typeof DailyPlaySelectionCandidateSchema>;

const DailyPlaySelectionInputSchema = z.object({
  asOf: DateTimeSchema,
  explorationShare: z.number().min(0.2).max(0.5).default(0.2),
  acceptedAllocationPolicyVersions: z.array(IdSchema).min(1).max(20).default(["market-allocation-v1"]),
  candidates: z.array(z.unknown()).max(10_000),
}).strict();

export type DailyPlaySelectionInput = z.input<typeof DailyPlaySelectionInputSchema>;

export type DailyPlayExclusionReason =
  | "INVALID_CANDIDATE"
  | "AMBIGUOUS_LATEST_ALLOCATION"
  | "FUTURE_ALLOCATION"
  | "UNSUPPORTED_ALLOCATION_POLICY"
  | "PLAY_VERSION_NOT_LATEST"
  | "PLAY_NOT_APPROVED_FOR_RESEARCH"
  | "MARKET_EVIDENCE_NOT_APPROVED_CURRENT"
  | "ALLOCATION_INVARIANT_VIOLATION"
  | "ALLOCATION_HAS_NO_RESEARCH_SHARE"
  | "ALLOCATION_HELD_FOR_EVIDENCE";

export interface DailyPlaySelectionExclusion {
  playId: string | null;
  allocationId: string | null;
  reasons: DailyPlayExclusionReason[];
}

export interface DailyPlaySelectionWeight {
  playId: string;
  playVersionId: string;
  allocationId: string;
  allocationShare: number;
  historicalOutcomeScore: number;
  outcomeConfidence: number;
  exploitationShare: number;
  explorationFloorShare: number;
  finalShare: number;
  priorDailySelections: number;
  selectionDeficit: number;
}

export interface DailyPlaySelectionSafety {
  scope: "RESEARCH_ONLY";
  outboundAuthorized: false;
  playStatusChanged: false;
  allocationApplied: false;
  allocationStillRequiresHumanApproval: true;
}

interface DailyPlaySelectionBase {
  policyVersion: typeof DAILY_PLAY_SELECTION_POLICY_VERSION;
  asOf: string | null;
  explorationShare: number | null;
  exclusions: DailyPlaySelectionExclusion[];
  safety: DailyPlaySelectionSafety;
}

export interface DailyPlaySelectionBlocked extends DailyPlaySelectionBase {
  status: "BLOCKED";
  blocker: "INVALID_SELECTION_INPUT" | "NO_ALLOCATION_CANDIDATES" | "NO_ELIGIBLE_LATEST_ALLOCATION";
  weights: [];
}

export interface DailyPlaySelectionSelected extends DailyPlaySelectionBase {
  status: "SELECTED";
  selected: {
    playId: string;
    playVersionId: string;
    playVersionNumber: number;
    playStatus: DailyPlaySelectionCandidate["playStatus"];
    template: DailyPlaySelectionCandidate["template"];
    allocationId: string;
    allocationCreatedAt: string;
    allocationPolicyVersion: string;
    allocationRecommendation: DailyPlaySelectionCandidate["allocation"]["recommendation"];
    allocationApplied: false;
    requiresHumanApproval: true;
  };
  weights: DailyPlaySelectionWeight[];
}

export type DailyPlaySelectionDecision = DailyPlaySelectionBlocked | DailyPlaySelectionSelected;

const safety: DailyPlaySelectionSafety = {
  scope: "RESEARCH_ONLY",
  outboundAuthorized: false,
  playStatusChanged: false,
  allocationApplied: false,
  allocationStillRequiresHumanApproval: true,
};

function rounded(value: number): number {
  return Number(value.toFixed(9));
}

function rawString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rawIdentity(value: unknown): { playId: string | null; allocationId: string | null } {
  const candidate = rawRecord(value);
  const allocation = rawRecord(candidate?.allocation);
  return {
    playId: rawString(candidate?.playId),
    allocationId: rawString(allocation?.id),
  };
}

function rawCreatedAt(value: unknown): number | null {
  const candidate = rawRecord(value);
  const allocation = rawRecord(candidate?.allocation);
  const createdAt = rawString(allocation?.createdAt);
  if (!createdAt) return null;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function historicalOutcomeScore(performance: DailyPlaySelectionCandidate["performance"]): number {
  const hours = Math.max(1, performance.researchHours);
  const delivered = Math.max(1, performance.delivered);
  const valid = Math.max(1, performance.validContacts);
  const researchProductivity = performance.qualifiedAccounts / hours * 1.5
    + performance.validContacts / hours * 2;
  const commercialYield = performance.positiveReplies / delivered * 20
    + performance.inquiries / delivered * 40
    + performance.quotes / delivered * 60
    + performance.wins / delivered * 100;
  const marginPerDelivered = Math.max(0, performance.grossMarginMinor) / delivered / 100_000;
  const costPerValid = performance.costMinor / valid / 100_000;
  return Math.max(0, researchProductivity + commercialYield + marginPerDelivered - costPerValid);
}

function outcomeConfidence(performance: DailyPlaySelectionCandidate["performance"]): number {
  const shadowConfidence = Math.min(0.35, performance.researchedAccounts / 30 * 0.35);
  const deliveredConfidence = Math.min(
    1,
    performance.delivered / 100,
    performance.measurementDays / 14,
  );
  return Math.max(shadowConfidence, deliveredConfidence);
}

function latestCandidateRows(
  rawCandidates: readonly unknown[],
): { candidates: DailyPlaySelectionCandidate[]; exclusions: DailyPlaySelectionExclusion[] } {
  const groups = new Map<string, unknown[]>();
  const exclusions: DailyPlaySelectionExclusion[] = [];
  for (const rawCandidate of rawCandidates) {
    const identity = rawIdentity(rawCandidate);
    if (!identity.playId) {
      exclusions.push({ ...identity, reasons: ["INVALID_CANDIDATE"] });
      continue;
    }
    const rows = groups.get(identity.playId) ?? [];
    rows.push(rawCandidate);
    groups.set(identity.playId, rows);
  }

  const candidates: DailyPlaySelectionCandidate[] = [];
  for (const [playId, rows] of groups) {
    const datedRows = rows.map((row) => ({ row, createdAt: rawCreatedAt(row) }));
    if (datedRows.some((item) => item.createdAt === null)) {
      exclusions.push({ playId, allocationId: null, reasons: ["INVALID_CANDIDATE"] });
      continue;
    }
    const latestMs = Math.max(...datedRows.map((item) => item.createdAt ?? Number.NEGATIVE_INFINITY));
    const latestRows = datedRows.filter((item) => item.createdAt === latestMs).map((item) => item.row);
    const allocationIds = new Set(latestRows.map((row) => rawIdentity(row).allocationId));
    if (allocationIds.size !== 1 || allocationIds.has(null)) {
      exclusions.push({ playId, allocationId: null, reasons: ["AMBIGUOUS_LATEST_ALLOCATION"] });
      continue;
    }
    const parsed = DailyPlaySelectionCandidateSchema.safeParse(latestRows[0]);
    if (!parsed.success) {
      exclusions.push({
        playId,
        allocationId: rawIdentity(latestRows[0]).allocationId,
        reasons: ["INVALID_CANDIDATE"],
      });
      continue;
    }
    candidates.push(parsed.data);
  }
  return { candidates, exclusions };
}

function eligibleCandidates(
  candidates: readonly DailyPlaySelectionCandidate[],
  asOfMs: number,
  acceptedPolicyVersions: ReadonlySet<string>,
): { candidates: DailyPlaySelectionCandidate[]; exclusions: DailyPlaySelectionExclusion[] } {
  const eligible: DailyPlaySelectionCandidate[] = [];
  const exclusions: DailyPlaySelectionExclusion[] = [];
  for (const candidate of candidates) {
    const reasons: DailyPlayExclusionReason[] = [];
    if (Date.parse(candidate.allocation.createdAt) > asOfMs) reasons.push("FUTURE_ALLOCATION");
    if (!acceptedPolicyVersions.has(candidate.allocation.policyVersion)) {
      reasons.push("UNSUPPORTED_ALLOCATION_POLICY");
    }
    if (!candidate.isLatestPlayVersion) reasons.push("PLAY_VERSION_NOT_LATEST");
    if (!(RESEARCH_ELIGIBLE_PLAY_STATUSES as readonly string[]).includes(candidate.playStatus)) {
      reasons.push("PLAY_NOT_APPROVED_FOR_RESEARCH");
    }
    if (!candidate.hasApprovedCurrentMarketEvidence) {
      reasons.push("MARKET_EVIDENCE_NOT_APPROVED_CURRENT");
    }
    if (candidate.allocation.applied || !candidate.allocation.requiresHumanApproval) {
      reasons.push("ALLOCATION_INVARIANT_VIOLATION");
    }
    if (candidate.allocation.recommendedUnits <= 0 || candidate.allocation.recommendedShare <= 0) {
      reasons.push("ALLOCATION_HAS_NO_RESEARCH_SHARE");
    }
    if (candidate.allocation.recommendation === "HOLD_EVIDENCE") {
      reasons.push("ALLOCATION_HELD_FOR_EVIDENCE");
    }
    if (reasons.length > 0) {
      exclusions.push({
        playId: candidate.playId,
        allocationId: candidate.allocation.id,
        reasons,
      });
    } else {
      eligible.push(candidate);
    }
  }
  return { candidates: eligible, exclusions };
}

function selectionWeights(
  candidates: readonly DailyPlaySelectionCandidate[],
  explorationShare: number,
): DailyPlaySelectionWeight[] {
  const allocationTotal = candidates.reduce(
    (sum, candidate) => sum + candidate.allocation.recommendedShare,
    0,
  );
  const allocationShares = candidates.map((candidate) =>
    allocationTotal > 0 ? candidate.allocation.recommendedShare / allocationTotal : 1 / candidates.length,
  );
  const outcomeScores = candidates.map((candidate) => historicalOutcomeScore(candidate.performance));
  const compressedOutcomeScores = outcomeScores.map((score) => Math.log1p(score));
  const outcomeTotal = compressedOutcomeScores.reduce((sum, score) => sum + score, 0);
  const outcomeShares = compressedOutcomeScores.map((score, index) =>
    outcomeTotal > 0 ? score / outcomeTotal : allocationShares[index] ?? 0,
  );
  const blended = candidates.map((candidate, index) => {
    // Shadow results influence ranking gradually; a 100-delivered/14-day cohort can fully
    // influence it. This prevents one early reply from overwhelming the allocation plan.
    const confidence = outcomeConfidence(candidate.performance);
    const allocationShare = allocationShares[index] ?? 0;
    const outcomeShare = outcomeShares[index] ?? allocationShare;
    return allocationShare * (1 - confidence) + outcomeShare * confidence;
  });
  const blendedTotal = blended.reduce((sum, value) => sum + value, 0);
  const exploitationShares = blended.map((value) =>
    blendedTotal > 0 ? value / blendedTotal : 1 / candidates.length,
  );
  const explorationFloorShare = explorationShare / candidates.length;
  const totalPriorSelections = candidates.reduce(
    (sum, candidate) => sum + candidate.performance.priorDailySelections,
    0,
  );

  return candidates.map((candidate, index) => {
    // Every eligible play keeps an equal slice of the explicit exploration budget.
    const finalShare = explorationFloorShare
      + (1 - explorationShare) * (exploitationShares[index] ?? 0);
    return {
      playId: candidate.playId,
      playVersionId: candidate.playVersionId,
      allocationId: candidate.allocation.id,
      allocationShare: rounded(allocationShares[index] ?? 0),
      historicalOutcomeScore: rounded(outcomeScores[index] ?? 0),
      outcomeConfidence: rounded(outcomeConfidence(candidate.performance)),
      exploitationShare: rounded(exploitationShares[index] ?? 0),
      explorationFloorShare: rounded(explorationFloorShare),
      finalShare: rounded(finalShare),
      priorDailySelections: candidate.performance.priorDailySelections,
      selectionDeficit: rounded(
        (totalPriorSelections + 1) * finalShare - candidate.performance.priorDailySelections,
      ),
    };
  }).sort((left, right) => left.playId.localeCompare(right.playId));
}

/**
 * Selects a play for today's research only. The returned allocation remains an
 * immutable, unapplied suggestion and grants no outbound or activation authority.
 */
export function selectDailyResearchPlay(rawInput: unknown): DailyPlaySelectionDecision {
  const parsedInput = DailyPlaySelectionInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      status: "BLOCKED",
      blocker: "INVALID_SELECTION_INPUT",
      policyVersion: DAILY_PLAY_SELECTION_POLICY_VERSION,
      asOf: null,
      explorationShare: null,
      exclusions: [],
      weights: [],
      safety,
    };
  }
  const input = parsedInput.data;
  if (input.candidates.length === 0) {
    return {
      status: "BLOCKED",
      blocker: "NO_ALLOCATION_CANDIDATES",
      policyVersion: DAILY_PLAY_SELECTION_POLICY_VERSION,
      asOf: input.asOf,
      explorationShare: input.explorationShare,
      exclusions: [],
      weights: [],
      safety,
    };
  }

  const latest = latestCandidateRows(input.candidates);
  const eligible = eligibleCandidates(
    latest.candidates,
    Date.parse(input.asOf),
    new Set(input.acceptedAllocationPolicyVersions),
  );
  const exclusions = [...latest.exclusions, ...eligible.exclusions]
    .sort((left, right) => (left.playId ?? "").localeCompare(right.playId ?? ""));
  if (eligible.candidates.length === 0) {
    return {
      status: "BLOCKED",
      blocker: "NO_ELIGIBLE_LATEST_ALLOCATION",
      policyVersion: DAILY_PLAY_SELECTION_POLICY_VERSION,
      asOf: input.asOf,
      explorationShare: input.explorationShare,
      exclusions,
      weights: [],
      safety,
    };
  }

  const weights = selectionWeights(eligible.candidates, input.explorationShare);
  // Deficit scheduling converges on the calculated shares without random selection or
  // starving a newly eligible exploration play.
  const selectedWeight = [...weights].sort((left, right) =>
    right.selectionDeficit - left.selectionDeficit
    || right.finalShare - left.finalShare
    || left.playId.localeCompare(right.playId),
  )[0];
  const selected = eligible.candidates.find((candidate) => candidate.playId === selectedWeight?.playId);
  if (!selected || selected.allocation.applied || !selected.allocation.requiresHumanApproval) {
    return {
      status: "BLOCKED",
      blocker: "NO_ELIGIBLE_LATEST_ALLOCATION",
      policyVersion: DAILY_PLAY_SELECTION_POLICY_VERSION,
      asOf: input.asOf,
      explorationShare: input.explorationShare,
      exclusions,
      weights: [],
      safety,
    };
  }
  return {
    status: "SELECTED",
    policyVersion: DAILY_PLAY_SELECTION_POLICY_VERSION,
    asOf: input.asOf,
    explorationShare: input.explorationShare,
    exclusions,
    selected: {
      playId: selected.playId,
      playVersionId: selected.playVersionId,
      playVersionNumber: selected.playVersionNumber,
      playStatus: selected.playStatus,
      template: selected.template,
      allocationId: selected.allocation.id,
      allocationCreatedAt: selected.allocation.createdAt,
      allocationPolicyVersion: selected.allocation.policyVersion,
      allocationRecommendation: selected.allocation.recommendation,
      allocationApplied: false,
      requiresHumanApproval: true,
    },
    weights,
    safety,
  };
}
