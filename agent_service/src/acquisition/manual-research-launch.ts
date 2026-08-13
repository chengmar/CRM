import type { AgentDatabase } from "../db.js";
import { CampaignBriefDraftSchema, type CampaignBrief } from "./campaign-brief.js";
import {
  launchAutonomousResearch,
  type AutonomousResearchLaunchResult,
} from "./autonomous-research-launch.js";
import {
  selectDailyResearchPlay,
  type DailyPlaySelectionCandidate,
} from "./daily-play-selection.js";

const MANUAL_RESEARCH_PLAY_STATUSES = new Set([
  "APPROVED",
  "READY_TO_STAGE",
  "STAGED_PAUSED",
  "ACTIVE",
]);

const RESEARCH_CHANNELS = new Set(["EMAIL", "MULTI_CHANNEL"]);
const MATCH_STOP_WORDS = new Set([
  "and",
  "company",
  "equipment",
  "industrial",
  "industry",
  "system",
  "the",
]);

export type ManualResearchLaunchBlocker =
  | "STALE_DRAFT"
  | "INCOMPLETE_DRAFT"
  | "NO_APPROVED_TEMPLATE"
  | "TEMPLATE_CHANGED"
  | "RESEARCH_AUTHORITY_VIOLATION";

export class ManualResearchLaunchError extends Error {
  constructor(
    readonly blocker: ManualResearchLaunchBlocker,
    message: string,
  ) {
    super(message);
    this.name = "ManualResearchLaunchError";
  }
}

export interface ManualResearchLaunchInput {
  briefId: string;
  versionId: string;
  briefHash: string;
  clickedBy: string;
  replyChatId: string;
  maxProviderUnits: number;
  now?: Date;
}

export interface ManualResearchLaunchResult {
  launch: AutonomousResearchLaunchResult;
  playId: string;
  playVersionId: string;
  allocationId: string;
  reused: boolean;
  externalSendAuthorized: false;
}

function normalizedTokens(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !MATCH_STOP_WORDS.has(token)));
}

function overlap(left: string, right: string): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  let count = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) count += 1;
  }
  return count;
}

function compatibleCandidates(
  candidates: DailyPlaySelectionCandidate[],
  product: string,
  buyerType: string,
): DailyPlaySelectionCandidate[] {
  const approved = candidates.filter((candidate) =>
    MANUAL_RESEARCH_PLAY_STATUSES.has(candidate.playStatus) &&
    RESEARCH_CHANNELS.has(candidate.template.channel));
  const matched = approved.filter((candidate) =>
    overlap(candidate.template.product, product) > 0 ||
    overlap(candidate.template.buyerType, buyerType) > 0);
  if (matched.length > 0) return matched;
  return new Set(approved.map((candidate) => candidate.playId)).size === 1 ? approved : [];
}

function assertExactDraft(
  db: AgentDatabase,
  input: Pick<ManualResearchLaunchInput, "briefId" | "versionId" | "briefHash">,
): {
  market: string;
  product: string;
  buyerType: string;
  targetCount: number;
  createdBy: string;
} {
  const current = db.getCurrentCampaignBrief(input.briefId);
  if (!current || current.current_version_id !== input.versionId || current.brief_hash !== input.briefHash) {
    throw new ManualResearchLaunchError(
      "STALE_DRAFT",
      "Campaign Brief changed after the Feishu card was created",
    );
  }
  let rawBrief: unknown;
  try {
    rawBrief = JSON.parse(String(current.brief_json));
  } catch {
    throw new ManualResearchLaunchError("INCOMPLETE_DRAFT", "Campaign Brief JSON is invalid");
  }
  const draft = CampaignBriefDraftSchema.safeParse(rawBrief);
  const buyerType = draft.success ? draft.data.buyerTypes?.[0]?.trim() : "";
  if (!draft.success || !draft.data.market?.trim() || !draft.data.productFamily?.trim() ||
    !buyerType || !draft.data.targetCount) {
    throw new ManualResearchLaunchError(
      "INCOMPLETE_DRAFT",
      "Campaign Brief must include market, product, buyer type, and target count",
    );
  }
  return {
    market: draft.data.market.trim(),
    product: draft.data.productFamily.trim(),
    buyerType,
    targetCount: draft.data.targetCount,
    createdBy: String(current.version_created_by ?? "feishu_operator").trim() || "feishu_operator",
  };
}

function buildResearchBrief(
  input: ReturnType<typeof assertExactDraft>,
  selected: DailyPlaySelectionCandidate,
  maxProviderUnits: number,
): CampaignBrief {
  const qualificationTrack = selected.template.qualificationTrack === "ACTIVE_INTENT"
    ? "ACTIVE_INTENT"
    : "HIGH_ICP_FIT";
  return {
    schemaVersion: "campaign-brief-v2",
    id: `manual-research:${selected.playId}`,
    version: 1,
    market: input.market,
    productFamily: input.product,
    buyerTypes: [input.buyerType],
    industries: [selected.template.application],
    roleFamilies: [selected.template.roleFamily],
    qualificationTracks: [qualificationTrack],
    requiredSignals: qualificationTrack === "ACTIVE_INTENT"
      ? [`Current public project, procurement, replacement, or expansion signal for ${selected.template.application}`]
      : [`Public company and application evidence for ${selected.template.application}`],
    exclusions: [],
    targetMetric: "ACCOUNTS_RESEARCHED",
    targetCount: input.targetCount,
    providerBudget: {
      mode: "CAPPED",
      allowedProviders: ["searxng", "local-public-web"],
      unit: "REQUESTS",
      maxUnits: Math.max(1, Math.trunc(maxProviderUnits)),
      maxAmountUsd: 0,
      requiresSeparateApproval: true,
    },
    llmBudget: {
      mode: "CAPPED",
      allowedProviders: ["openai"],
      unit: "TOKENS",
      maxUnits: Math.max(50_000, input.targetCount * 20_000),
      maxAmountUsd: 0,
      requiresSeparateApproval: true,
    },
    offerIds: [`play-offer:${selected.playId}`],
    transport: "NONE",
    deadline: null,
    hypothesis: `The approved ${selected.template.offer} play can identify relevant ${input.buyerType} accounts in ${input.market}.`,
  };
}

function assertTemplateStillExecutable(
  db: AgentDatabase,
  selected: DailyPlaySelectionCandidate,
): void {
  const row = db.db.prepare(
    `SELECT play.status, version.version_number,
            (SELECT max(latest.version_number) FROM play_versions latest WHERE latest.play_id=play.id) AS latest_version,
            allocation.applied, allocation.requires_human_approval
     FROM plays play
     JOIN play_versions version ON version.id=? AND version.play_id=play.id
     JOIN play_allocations allocation ON allocation.id=? AND allocation.play_id=play.id
     WHERE play.id=?`,
  ).get(selected.playVersionId, selected.allocation.id, selected.playId) as Record<string, unknown> | undefined;
  if (!row || !MANUAL_RESEARCH_PLAY_STATUSES.has(String(row.status)) ||
    Number(row.version_number) !== Number(row.latest_version) ||
    Number(row.applied) !== 0 || Number(row.requires_human_approval) !== 1) {
    throw new ManualResearchLaunchError(
      "TEMPLATE_CHANGED",
      "Approved research template changed before launch",
    );
  }
}

export function launchManualResearchFromApprovedTemplate(
  db: AgentDatabase,
  input: ManualResearchLaunchInput,
): ManualResearchLaunchResult {
  const draft = assertExactDraft(db, input);
  const now = input.now ?? new Date();
  const asOf = now.toISOString();
  const candidates = compatibleCandidates(
    db.listDailyResearchPlayCandidates(asOf, { market: draft.market }),
    draft.product,
    draft.buyerType,
  );
  const decision = selectDailyResearchPlay({ asOf, candidates });
  if (decision.status !== "SELECTED") {
    throw new ManualResearchLaunchError(
      "NO_APPROVED_TEMPLATE",
      "No approved, current-evidence, allocation-backed research template matches this request",
    );
  }
  const selected = candidates.find((candidate) =>
    candidate.playId === decision.selected.playId &&
    candidate.playVersionId === decision.selected.playVersionId &&
    candidate.allocation.id === decision.selected.allocationId);
  if (!selected) {
    throw new ManualResearchLaunchError("TEMPLATE_CHANGED", "Selected research template is unavailable");
  }
  const brief = buildResearchBrief(draft, selected, input.maxProviderUnits);
  const launchKey = `feishu-research:${input.briefId}:${input.versionId}`;
  const reused = db.getSetting(`autonomous_research_launch:${launchKey.toLowerCase()}`) !== null;

  return db.runInTransaction(() => {
    assertExactDraft(db, input);
    assertTemplateStillExecutable(db, selected);
    const launch = launchAutonomousResearch(db, {
      launchKey,
      actionId: `${launchKey}:approved-template`,
      campaign: {
        name: `feishu-${draft.market}-${selected.playId}`,
        market: draft.market,
        product: draft.product,
        buyerType: draft.buyerType,
        targetCount: draft.targetCount,
      },
      brief,
      authorization: {
        actor: draft.createdBy,
        source: "EXPLICIT_FEISHU_RESEARCH_ACTION",
        reason: "Start research-only campaign from the exact signed Feishu draft and approved play template",
      },
      replyChatId: input.replyChatId,
    });
    db.linkCampaignToPlayVersion(
      launch.ids.campaignId,
      selected.playVersionId,
      input.clickedBy,
      true,
    );
    const authority = db.db.prepare(
      `SELECT
         (SELECT count(*) FROM campaign_send_authorizations WHERE campaign_id=?) AS send_authorizations,
         (SELECT count(*) FROM campaign_approvals WHERE brief_id=? AND scope='EXTERNAL_SEND') AS external_approvals,
         (SELECT count(*) FROM outbound_messages WHERE campaign_id=?) AS outbound_messages`,
    ).get(launch.ids.campaignId, launch.ids.briefId, launch.ids.campaignId) as {
      send_authorizations: number;
      external_approvals: number;
      outbound_messages: number;
    };
    if (launch.externalSendAuthorized !== false || Number(authority.send_authorizations) !== 0 ||
      Number(authority.external_approvals) !== 0 || Number(authority.outbound_messages) !== 0) {
      throw new ManualResearchLaunchError(
        "RESEARCH_AUTHORITY_VIOLATION",
        "Research-only launch unexpectedly acquired outbound authority",
      );
    }
    db.setSetting("outbound_paused", "true");
    db.recordEvent("campaign", launch.ids.campaignId, "FEISHU_RESEARCH_ONLY_LAUNCHED", input.clickedBy, {
      sourceBriefId: input.briefId,
      sourceVersionId: input.versionId,
      sourceBriefHash: input.briefHash,
      playId: selected.playId,
      playVersionId: selected.playVersionId,
      allocationId: selected.allocation.id,
      allocationApplied: false,
      externalSendAuthorized: false,
      reused,
    });
    return {
      launch,
      playId: selected.playId,
      playVersionId: selected.playVersionId,
      allocationId: selected.allocation.id,
      reused,
      externalSendAuthorized: false,
    };
  });
}
