import { describe, expect, it } from "vitest";
import {
  selectDailyResearchPlay,
  type DailyPlaySelectionCandidate,
} from "../src/acquisition/daily-play-selection.js";

const AS_OF = "2026-07-22T00:00:00.000Z";

type CandidateOverrides = Omit<Partial<DailyPlaySelectionCandidate>, "allocation" | "performance"> & {
  allocation?: Partial<DailyPlaySelectionCandidate["allocation"]>;
  performance?: Partial<DailyPlaySelectionCandidate["performance"]>;
};

function candidate(
  playId: string,
  overrides: CandidateOverrides = {},
): DailyPlaySelectionCandidate {
  const allocation: DailyPlaySelectionCandidate["allocation"] = {
    id: `${playId}-allocation-2`,
    createdAt: "2026-07-21T00:00:00.000Z",
    policyVersion: "market-allocation-v1",
    recommendedUnits: 20,
    recommendedShare: 0.5,
    recommendation: "EXPLORE",
    applied: false,
    requiresHumanApproval: true,
    ...overrides.allocation,
  };
  const performance: DailyPlaySelectionCandidate["performance"] = {
    priorDailySelections: 0,
    researchedAccounts: 30,
    researchHours: 10,
    qualifiedAccounts: 10,
    validContacts: 5,
    delivered: 0,
    positiveReplies: 0,
    inquiries: 0,
    quotes: 0,
    wins: 0,
    grossMarginMinor: 0,
    costMinor: 100_000,
    measurementDays: 0,
    ...overrides.performance,
  };
  return {
    playId,
    playVersionId: `${playId}-version-2`,
    playVersionNumber: 2,
    isLatestPlayVersion: true,
    playStatus: "SHADOW",
    template: {
      market: "MY",
      product: "sample components",
      buyerType: "SYSTEM_INTEGRATOR_EPC",
      application: "sample application",
      offer: "rfq-readiness-checklist",
      roleFamily: "ENGINEERING_PROCUREMENT",
      qualificationTrack: "ICP_FIT",
      channel: "EMAIL",
    },
    hasApprovedCurrentMarketEvidence: true,
    ...overrides,
    allocation,
    performance,
  };
}

function select(candidates: unknown[], explorationShare = 0.2) {
  return selectDailyResearchPlay({ asOf: AS_OF, explorationShare, candidates });
}

describe("daily play selection", () => {
  it("uses only the latest allocation for each play and never falls back to an older eligible suggestion", () => {
    const older = candidate("play-my", {
      allocation: {
        id: "allocation-old",
        createdAt: "2026-07-20T00:00:00.000Z",
        recommendedUnits: 50,
        recommendedShare: 1,
      },
    });
    const latestHeld = candidate("play-my", {
      allocation: {
        id: "allocation-latest",
        createdAt: "2026-07-21T00:00:00.000Z",
        recommendedUnits: 0,
        recommendedShare: 0,
        recommendation: "HOLD_EVIDENCE",
      },
      hasApprovedCurrentMarketEvidence: false,
    });

    const decision = select([older, latestHeld]);

    expect(decision).toMatchObject({
      status: "BLOCKED",
      blocker: "NO_ELIGIBLE_LATEST_ALLOCATION",
      exclusions: [{
        playId: "play-my",
        allocationId: "allocation-latest",
        reasons: expect.arrayContaining([
          "MARKET_EVIDENCE_NOT_APPROVED_CURRENT",
          "ALLOCATION_HAS_NO_RESEARCH_SHARE",
          "ALLOCATION_HELD_FOR_EVIDENCE",
        ]),
      }],
    });
  });

  it("fails closed when there is no approved allocation-backed research play", () => {
    const decision = select([
      candidate("play-draft", { playStatus: "DRAFT" }),
      candidate("play-paused", { playStatus: "PAUSED" }),
      candidate("play-stale-version", { isLatestPlayVersion: false }),
    ]);

    expect(decision).toMatchObject({
      status: "BLOCKED",
      blocker: "NO_ELIGIBLE_LATEST_ALLOCATION",
      weights: [],
      safety: {
        scope: "RESEARCH_ONLY",
        outboundAuthorized: false,
        playStatusChanged: false,
        allocationApplied: false,
        allocationStillRequiresHumanApproval: true,
      },
    });
  });

  it("combines allocation share with real funnel outcomes", () => {
    const strong = candidate("play-strong", {
      allocation: { recommendedShare: 0.5 },
      performance: {
        researchedAccounts: 100,
        qualifiedAccounts: 60,
        validContacts: 40,
        delivered: 100,
        positiveReplies: 15,
        inquiries: 8,
        quotes: 4,
        wins: 2,
        grossMarginMinor: 5_000_000,
        costMinor: 300_000,
        measurementDays: 20,
      },
    });
    const weak = candidate("play-weak", {
      allocation: { recommendedShare: 0.5 },
      performance: {
        researchedAccounts: 100,
        qualifiedAccounts: 10,
        validContacts: 5,
        delivered: 100,
        positiveReplies: 1,
        inquiries: 0,
        quotes: 0,
        wins: 0,
        grossMarginMinor: 0,
        costMinor: 500_000,
        measurementDays: 20,
      },
    });

    const decision = select([strong, weak]);

    expect(decision.status).toBe("SELECTED");
    if (decision.status !== "SELECTED") return;
    expect(decision.selected.playId).toBe("play-strong");
    const strongWeight = decision.weights.find((row) => row.playId === "play-strong")!;
    const weakWeight = decision.weights.find((row) => row.playId === "play-weak")!;
    expect(strongWeight.historicalOutcomeScore).toBeGreaterThan(weakWeight.historicalOutcomeScore);
    expect(strongWeight.finalShare).toBeGreaterThan(weakWeight.finalShare);
  });

  it("uses the latest allocation shares when historical outcomes are otherwise equal", () => {
    const preferred = candidate("play-preferred", {
      allocation: { recommendedShare: 0.7, recommendedUnits: 70 },
    });
    const explore = candidate("play-explore", {
      allocation: { recommendedShare: 0.3, recommendedUnits: 30 },
    });

    const decision = select([preferred, explore]);

    expect(decision.status).toBe("SELECTED");
    if (decision.status !== "SELECTED") return;
    expect(decision.selected.playId).toBe("play-preferred");
    expect(decision.weights.find((row) => row.playId === "play-preferred")?.finalShare)
      .toBeGreaterThan(decision.weights.find((row) => row.playId === "play-explore")?.finalShare ?? 0);
  });

  it("keeps the configured exploration floor and gives an under-selected play its turn", () => {
    const candidates = [
      candidate("play-a", {
        allocation: { recommendedShare: 0.8 },
        performance: { priorDailySelections: 8 },
      }),
      candidate("play-b", {
        allocation: { recommendedShare: 0.1 },
        performance: { priorDailySelections: 1 },
      }),
      candidate("play-c", {
        allocation: { recommendedShare: 0.1 },
        performance: { priorDailySelections: 0 },
      }),
    ];

    const decision = select(candidates, 0.3);

    expect(decision.status).toBe("SELECTED");
    if (decision.status !== "SELECTED") return;
    expect(decision.weights.every((row) => row.explorationFloorShare === 0.1)).toBe(true);
    expect(decision.weights.reduce((sum, row) => sum + row.finalShare, 0)).toBeCloseTo(1, 8);
    expect(decision.selected.playId).toBe("play-c");
  });

  it("returns research-only authority without applying an allocation or authorizing outbound", () => {
    const decision = select([candidate("play-my", { playStatus: "ACTIVE" })]);

    expect(decision).toMatchObject({
      status: "SELECTED",
      selected: {
        playId: "play-my",
        template: {
          market: "MY",
          product: "sample components",
          buyerType: "SYSTEM_INTEGRATOR_EPC",
          qualificationTrack: "ICP_FIT",
        },
        allocationApplied: false,
        requiresHumanApproval: true,
      },
      safety: {
        scope: "RESEARCH_ONLY",
        outboundAuthorized: false,
        playStatusChanged: false,
        allocationApplied: false,
        allocationStillRequiresHumanApproval: true,
      },
    });
  });

  it("rejects future, ambiguous and invariant-breaking latest allocations", () => {
    const future = candidate("play-future", {
      allocation: { createdAt: "2026-07-23T00:00:00.000Z" },
    });
    const ambiguousLeft = candidate("play-ambiguous", {
      allocation: { id: "allocation-left" },
    });
    const ambiguousRight = candidate("play-ambiguous", {
      allocation: { id: "allocation-right" },
    });
    const applied = candidate("play-applied", {
      allocation: { applied: true },
    });

    const decision = select([future, ambiguousLeft, ambiguousRight, applied]);

    expect(decision).toMatchObject({ status: "BLOCKED", blocker: "NO_ELIGIBLE_LATEST_ALLOCATION" });
    expect(decision.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ playId: "play-future", reasons: ["FUTURE_ALLOCATION"] }),
      expect.objectContaining({ playId: "play-ambiguous", reasons: ["AMBIGUOUS_LATEST_ALLOCATION"] }),
      expect.objectContaining({ playId: "play-applied", reasons: ["ALLOCATION_INVARIANT_VIOLATION"] }),
    ]));
  });
});
