import { createHash } from "node:crypto";
import type { AgentDatabase } from "../db.js";
import type { CampaignBrief } from "./campaign-brief.js";
import {
  launchAutonomousResearch,
  type AutonomousResearchLaunchResult,
} from "./autonomous-research-launch.js";
import {
  selectDailyResearchPlay,
  type DailyPlaySelectionCandidate,
  type DailyPlaySelectionDecision,
  type DailyPlaySelectionSelected,
} from "./daily-play-selection.js";

const MACHINE_AUTHORIZATION_ACTORS = new Set([
  "daily_scheduler",
  "scheduler",
  "system",
  "worker",
]);

export type ScheduledResearchLaunchBlocker =
  | "INVALID_INPUT"
  | "HUMAN_ENABLE_AUTHORIZATION_MISSING"
  | "SELECTION_CHANGED"
  | "RESEARCH_AUTHORITY_VIOLATION";

export class ScheduledResearchLaunchError extends Error {
  constructor(
    readonly blocker: ScheduledResearchLaunchBlocker,
    message: string,
  ) {
    super(message);
    this.name = "ScheduledResearchLaunchError";
  }
}

export interface ScheduledDailyResearchSelectionInput {
  asOf: string;
  allowedMarkets: readonly string[];
  explorationShare?: number;
  acceptedAllocationPolicyVersions?: string[];
}

export interface ScheduledResearchLaunchInput {
  runKey: string;
  date: string;
  selection: DailyPlaySelectionSelected;
  allowedMarkets: readonly string[];
  acceptedAllocationPolicyVersions?: string[];
  targetCount: number;
  maxProviderUnits: number;
  replyChatId: string;
}

export interface ScheduledResearchLaunchResult {
  launch: AutonomousResearchLaunchResult;
  market: string;
  playId: string;
  playVersionId: string;
  allocationId: string;
  selectionPolicyVersion: string;
  authorizationEventId: string;
  authorizationActor: string;
  externalSendAuthorized: false;
}

interface DailyResearchAuthorizationEvent {
  id: string;
  event_type: "DAILY_RESEARCH_ENABLED" | "DAILY_RESEARCH_DISABLED";
  actor: string;
  created_at: string;
}

function normalizedAllowedMarkets(markets: readonly string[]): string[] {
  return [...new Set(markets.map((market) => market.trim()).filter(Boolean))];
}

function candidateKey(candidate: DailyPlaySelectionCandidate): string {
  return `${candidate.playId}\u0000${candidate.allocation.id}`;
}

/**
 * DAILY_RESEARCH_MARKETS is an allow-list. Allocation weights and the exploration
 * floor still decide which eligible play inside that boundary runs today.
 */
export function selectScheduledDailyResearchPlay(
  db: AgentDatabase,
  input: ScheduledDailyResearchSelectionInput,
): DailyPlaySelectionDecision {
  const markets = normalizedAllowedMarkets(input.allowedMarkets);
  const candidates = new Map<string, DailyPlaySelectionCandidate>();
  const rows = markets.includes("*")
    ? db.listDailyResearchPlayCandidates(input.asOf)
    : markets.flatMap((market) => db.listDailyResearchPlayCandidates(input.asOf, { market }));
  for (const candidate of rows) candidates.set(candidateKey(candidate), candidate);
  return selectDailyResearchPlay({
    asOf: input.asOf,
    explorationShare: input.explorationShare,
    acceptedAllocationPolicyVersions: input.acceptedAllocationPolicyVersions,
    candidates: [...candidates.values()],
  });
}

function assertLaunchInput(input: ScheduledResearchLaunchInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    input.runKey !== `daily_research_run:${input.date}` ||
    !Number.isSafeInteger(input.targetCount) || input.targetCount <= 0 || input.targetCount > 100_000 ||
    !Number.isSafeInteger(input.maxProviderUnits) || input.maxProviderUnits <= 0 ||
    input.replyChatId.trim().length > 200 ||
    normalizedAllowedMarkets(input.allowedMarkets).length === 0 ||
    input.selection.status !== "SELECTED" || input.selection.safety.scope !== "RESEARCH_ONLY" ||
    input.selection.safety.outboundAuthorized || input.selection.safety.allocationApplied ||
    input.selection.selected.allocationApplied || !input.selection.selected.requiresHumanApproval ||
    !input.selection.asOf || !Number.isFinite(Date.parse(input.selection.asOf))) {
    throw new ScheduledResearchLaunchError(
      "INVALID_INPUT",
      "Scheduled research launch requires an exact daily key, bounded research budget, and research-only selection",
    );
  }
}

function latestHumanEnableAuthorization(db: AgentDatabase): DailyResearchAuthorizationEvent {
  if (db.getSetting("daily_research_enabled") !== "true") {
    throw new ScheduledResearchLaunchError(
      "HUMAN_ENABLE_AUTHORIZATION_MISSING",
      "Daily research is not explicitly enabled in persisted settings",
    );
  }
  const event = db.db.prepare(
    `SELECT id, event_type, actor, created_at
     FROM events
     WHERE entity_type='system' AND entity_id='daily_research'
       AND event_type IN ('DAILY_RESEARCH_ENABLED','DAILY_RESEARCH_DISABLED')
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get() as DailyResearchAuthorizationEvent | undefined;
  const actor = event?.actor.trim() ?? "";
  if (!event || event.event_type !== "DAILY_RESEARCH_ENABLED" || !actor ||
    MACHINE_AUTHORIZATION_ACTORS.has(actor.toLowerCase())) {
    throw new ScheduledResearchLaunchError(
      "HUMAN_ENABLE_AUTHORIZATION_MISSING",
      "Scheduled research requires the latest persisted enable action to come from a human operator",
    );
  }
  return { ...event, actor };
}

function sameSelection(
  expected: DailyPlaySelectionSelected,
  current: DailyPlaySelectionDecision,
): current is DailyPlaySelectionSelected {
  return current.status === "SELECTED" &&
    current.policyVersion === expected.policyVersion &&
    current.selected.playId === expected.selected.playId &&
    current.selected.playVersionId === expected.selected.playVersionId &&
    current.selected.playVersionNumber === expected.selected.playVersionNumber &&
    current.selected.allocationId === expected.selected.allocationId &&
    current.selected.allocationCreatedAt === expected.selected.allocationCreatedAt &&
    current.selected.allocationPolicyVersion === expected.selected.allocationPolicyVersion;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function buildResearchBrief(
  selection: DailyPlaySelectionSelected,
  targetCount: number,
  maxProviderUnits: number,
): CampaignBrief {
  const selected = selection.selected;
  const qualificationTrack = selected.template.qualificationTrack === "ACTIVE_INTENT"
    ? "ACTIVE_INTENT"
    : "HIGH_ICP_FIT";
  const requiredSignal = qualificationTrack === "ACTIVE_INTENT"
    ? `Current public project, procurement, replacement, or expansion evidence for ${selected.template.application}`
    : `Public company, application, and role evidence for ${selected.template.application}`;
  return {
    schemaVersion: "campaign-brief-v2",
    id: stableId("daily-research", `${selected.playId}:${selected.playVersionId}`),
    version: 1,
    market: selected.template.market,
    productFamily: selected.template.product,
    buyerTypes: [selected.template.buyerType],
    industries: [selected.template.application],
    roleFamilies: [selected.template.roleFamily],
    qualificationTracks: [qualificationTrack],
    requiredSignals: [requiredSignal],
    exclusions: [],
    targetMetric: "ACCOUNTS_RESEARCHED",
    targetCount,
    providerBudget: {
      mode: "CAPPED",
      allowedProviders: ["searxng", "local-public-web"],
      unit: "REQUESTS",
      maxUnits: maxProviderUnits,
      maxAmountUsd: 0,
      requiresSeparateApproval: true,
    },
    llmBudget: {
      mode: "CAPPED",
      allowedProviders: ["openai"],
      unit: "TOKENS",
      maxUnits: Math.max(50_000, targetCount * 20_000),
      maxAmountUsd: 0,
      requiresSeparateApproval: true,
    },
    offerIds: [stableId("play-offer", selected.playId)],
    transport: "NONE",
    deadline: null,
    hypothesis: `The approved ${selected.template.offer} play can identify relevant ${selected.template.buyerType} accounts in ${selected.template.market}.`,
  };
}

export function launchScheduledDailyResearch(
  db: AgentDatabase,
  input: ScheduledResearchLaunchInput,
): ScheduledResearchLaunchResult | null {
  assertLaunchInput(input);
  return db.runInTransaction(() => {
    if (!db.setSettingIfAbsent(input.runKey, "RESERVED")) return null;
    const authorization = latestHumanEnableAuthorization(db);
    const current = selectScheduledDailyResearchPlay(db, {
      asOf: input.selection.asOf!,
      allowedMarkets: input.allowedMarkets,
      explorationShare: input.selection.explorationShare ?? undefined,
      acceptedAllocationPolicyVersions: input.acceptedAllocationPolicyVersions,
    });
    if (!sameSelection(input.selection, current)) {
      throw new ScheduledResearchLaunchError(
        "SELECTION_CHANGED",
        "Daily research play, version, allocation, evidence, or weighted selection changed before launch",
      );
    }

    const selected = current.selected;
    const launchKey = `daily-research:${input.date}`;
    const launch = launchAutonomousResearch(db, {
      launchKey,
      actionId: `${launchKey}:${authorization.id}`,
      campaign: {
        name: `daily-${selected.template.market}-${input.date}`,
        market: selected.template.market,
        product: selected.template.product,
        buyerType: selected.template.buyerType,
        targetCount: input.targetCount,
      },
      brief: buildResearchBrief(current, input.targetCount, input.maxProviderUnits),
      authorization: {
        actor: authorization.actor,
        source: `DAILY_RESEARCH_ENABLED_EVENT:${authorization.id}`,
        reason: "Run the bounded daily public-information research authorized by the latest human enable action",
      },
      jobContext: {
        trigger: "DAILY_SCHEDULE",
        playId: selected.playId,
        playVersionId: selected.playVersionId,
        allocationId: selected.allocationId,
      },
      replyChatId: input.replyChatId,
    });
    db.linkCampaignToPlayVersion(
      launch.ids.campaignId,
      selected.playVersionId,
      "daily_scheduler",
      true,
    );

    const authority = db.db.prepare(
      `SELECT
         (SELECT count(*) FROM campaign_send_authorizations WHERE campaign_id=?) AS send_authorizations,
         (SELECT count(*) FROM campaign_approvals WHERE brief_id=? AND scope='EXTERNAL_SEND') AS external_approvals,
         (SELECT count(*) FROM outbound_messages WHERE campaign_id=?) AS outbound_messages,
         (SELECT count(*) FROM campaign_provider_bindings
          WHERE campaign_id=? AND brief_id=? AND version_id=?) AS provider_bindings,
         (SELECT count(*) FROM campaign_approvals
          WHERE brief_id=? AND version_id=? AND scope IN ('SHADOW_PLAN','PROVIDER_BUDGET')) AS research_approvals`,
    ).get(
      launch.ids.campaignId,
      launch.ids.briefId,
      launch.ids.campaignId,
      launch.ids.campaignId,
      launch.ids.briefId,
      launch.ids.versionId,
      launch.ids.briefId,
      launch.ids.versionId,
    ) as {
      send_authorizations: number;
      external_approvals: number;
      outbound_messages: number;
      provider_bindings: number;
      research_approvals: number;
    };
    const allocation = db.db.prepare(
      `SELECT applied, requires_human_approval FROM play_allocations
       WHERE id=? AND play_id=?`,
    ).get(selected.allocationId, selected.playId) as {
      applied: number;
      requires_human_approval: number;
    } | undefined;
    if (launch.externalSendAuthorized !== false || Number(authority.send_authorizations) !== 0 ||
      Number(authority.external_approvals) !== 0 || Number(authority.outbound_messages) !== 0 ||
      Number(authority.provider_bindings) !== 1 || Number(authority.research_approvals) !== 2 ||
      !allocation || Number(allocation.applied) !== 0 || Number(allocation.requires_human_approval) !== 1) {
      throw new ScheduledResearchLaunchError(
        "RESEARCH_AUTHORITY_VIOLATION",
        "Scheduled research launch did not preserve its exact research-only authority boundary",
      );
    }

    db.setSetting(input.runKey, launch.ids.campaignId);
    db.recordEvent("system", "daily_research", "DAILY_RESEARCH_RESERVED", "daily_scheduler", {
      campaignId: launch.ids.campaignId,
      briefId: launch.ids.briefId,
      versionId: launch.ids.versionId,
      briefHash: String(db.db.prepare("SELECT brief_hash FROM campaign_versions WHERE id=?")
        .get(launch.ids.versionId)?.brief_hash ?? ""),
      jobId: launch.ids.jobId,
      market: selected.template.market,
      runKey: input.runKey,
      playId: selected.playId,
      playVersionId: selected.playVersionId,
      allocationId: selected.allocationId,
      allocationApplied: false,
      selectionPolicyVersion: current.policyVersion,
      selectionExplorationShare: current.explorationShare,
      authorizationEventId: authorization.id,
      authorizationActor: authorization.actor,
      researchOnly: true,
      outboundAuthorized: false,
    });
    return {
      launch,
      market: selected.template.market,
      playId: selected.playId,
      playVersionId: selected.playVersionId,
      allocationId: selected.allocationId,
      selectionPolicyVersion: current.policyVersion,
      authorizationEventId: authorization.id,
      authorizationActor: authorization.actor,
      externalSendAuthorized: false,
    };
  });
}
