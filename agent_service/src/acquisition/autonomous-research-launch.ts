import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentDatabase } from "../db.js";
import {
  CAMPAIGN_BRIEF_SCHEMA_VERSION,
  CampaignBriefSchema,
  type CampaignBrief,
} from "./campaign-brief.js";

const IdSchema = z.string().trim().min(1).max(160);
const TextSchema = z.string().trim().min(1).max(2_000);

const ResearchLaunchSpecSchema = z.object({
  launchKey: IdSchema,
  actionId: IdSchema,
  campaign: z.object({
    name: TextSchema.max(300),
    market: TextSchema.max(120),
    product: TextSchema.max(300),
    buyerType: TextSchema.max(200),
    targetCount: z.number().int().positive().max(100_000),
  }).strict(),
  brief: CampaignBriefSchema,
  authorization: z.object({
    actor: IdSchema,
    source: TextSchema.max(300),
    reason: TextSchema,
  }).strict(),
  jobContext: z.object({
    trigger: z.literal("DAILY_SCHEDULE"),
    playId: IdSchema,
    playVersionId: IdSchema,
    allocationId: IdSchema,
  }).strict().optional(),
  replyChatId: z.string().trim().max(200).optional().default(""),
}).strict().superRefine((spec, context) => {
  const equal = (left: string, right: string): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();
  if (!equal(spec.campaign.market, spec.brief.market)) {
    context.addIssue({ code: "custom", path: ["campaign", "market"], message: "must match brief.market" });
  }
  if (!equal(spec.campaign.product, spec.brief.productFamily)) {
    context.addIssue({ code: "custom", path: ["campaign", "product"], message: "must match brief.productFamily" });
  }
  if (spec.campaign.targetCount !== spec.brief.targetCount) {
    context.addIssue({ code: "custom", path: ["campaign", "targetCount"], message: "must match brief.targetCount" });
  }
  if (!spec.brief.buyerTypes.some((buyerType) => equal(buyerType, spec.campaign.buyerType))) {
    context.addIssue({ code: "custom", path: ["campaign", "buyerType"], message: "must be included in brief.buyerTypes" });
  }
  if (spec.brief.transport !== "NONE") {
    context.addIssue({ code: "custom", path: ["brief", "transport"], message: "research-only launch requires NONE" });
  }
  const providers = spec.brief.providerBudget.allowedProviders.map((value) => value.toLowerCase()).sort();
  if (providers.join(",") !== "local-public-web,searxng") {
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget", "allowedProviders"],
      message: "research-only launch permits exactly local-public-web and searxng",
    });
  }
  if (spec.brief.providerBudget.mode !== "CAPPED" || spec.brief.providerBudget.maxUnits <= 0) {
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget"],
      message: "research-only launch requires a positive capped query/page budget",
    });
  }
  if (spec.brief.providerBudget.maxAmountUsd !== 0) {
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget", "maxAmountUsd"],
      message: "research-only local providers must have a zero USD cap",
    });
  }
});

export type AutonomousResearchLaunchSpec = z.infer<typeof ResearchLaunchSpecSchema>;

export interface AutonomousResearchLaunchResult {
  status: "RESEARCH_LAUNCHED";
  ids: {
    campaignId: string;
    briefId: string;
    versionId: string;
    shadowApprovalId: string;
    providerBudgetApprovalId: string;
    jobId: string;
  };
  externalSendAuthorized: false;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseAutonomousResearchLaunchSpec(input: unknown): AutonomousResearchLaunchSpec {
  const parsed = ResearchLaunchSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid autonomous research launch spec: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$root"}: ${issue.message}`)
      .sort()
      .join("; ")}`);
  }
  return parsed.data;
}

function normalizedBrief(spec: AutonomousResearchLaunchSpec): CampaignBrief {
  return CampaignBriefSchema.parse({
    ...spec.brief,
    schemaVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
    id: `autonomous-research:${spec.launchKey.toLowerCase()}`,
    version: 1,
  });
}

export function launchAutonomousResearch(
  db: AgentDatabase,
  input: unknown,
): AutonomousResearchLaunchResult {
  const spec = parseAutonomousResearchLaunchSpec(input);
  const migration = db.getMigrationStatus();
  if (migration.currentVersion !== migration.latestVersion) {
    throw new Error("launch-autonomous-research requires the current database schema");
  }
  const settingKey = `autonomous_research_launch:${spec.launchKey.toLowerCase()}`;
  const specHash = canonicalHash(spec);
  const prior = db.getSetting(settingKey);
  if (prior) {
    const decoded = JSON.parse(prior) as { specHash: string; result: AutonomousResearchLaunchResult };
    if (decoded.specHash !== specHash) throw new Error("Autonomous research launch key was reused with different material");
    return decoded.result;
  }

  return db.runInTransaction(() => {
    const brief = normalizedBrief(spec);
    const campaignId = db.createCampaign({
      name: spec.campaign.name,
      market: spec.campaign.market,
      product: spec.campaign.product,
      buyerType: spec.campaign.buyerType,
      targetCount: spec.campaign.targetCount,
      createdBy: spec.authorization.actor,
      dailyLimit: 1,
      hourlyLimit: 1,
      followupDays: [],
    });
    const saved = db.saveCampaignDraft({
      briefKey: `autonomous-research:${spec.launchKey.toLowerCase()}`,
      brief,
      parserVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
      createdBy: spec.authorization.actor,
    });
    const authorization = {
      actor: spec.authorization.actor,
      actorType: "HUMAN" as const,
      roles: ["SALES_MANAGER" as const],
    };
    const approvalBase = {
      briefId: saved.briefId,
      versionId: saved.versionId,
      authorizationSource: spec.authorization.source,
      reason: spec.authorization.reason,
    };
    const shadow = db.saveCampaignScopedApproval({
      ...approvalBase,
      scope: "SHADOW_PLAN",
      actionId: `${spec.actionId}:shadow-plan`,
    }, authorization);
    const providerBudget = db.saveCampaignScopedApproval({
      ...approvalBase,
      scope: "PROVIDER_BUDGET",
      actionId: `${spec.actionId}:provider-budget`,
      budgetHash: canonicalHash({
        providerBudget: brief.providerBudget,
        llmBudget: brief.llmBudget,
      }),
    }, authorization);
    db.bindProviderCampaign({
      campaignId,
      briefId: saved.briefId,
      versionId: saved.versionId,
      briefHash: saved.briefHash,
      createdBy: spec.authorization.actor,
    });
    for (const required of [
      { providerKey: "searxng", operation: "EVIDENCE_SEARCH" },
      { providerKey: "local-public-web", operation: "WEBSITE_CRAWL" },
    ]) {
      const context = db.getAuthorizedProviderCampaignContext(campaignId, required.providerKey, { chargeable: false });
      const capabilities = JSON.parse(String(context.capabilities_json)) as unknown;
      if (!Array.isArray(capabilities) || !capabilities.includes(required.operation)) {
        throw new Error(`${required.providerKey} does not authorize ${required.operation}`);
      }
    }
    db.setSetting("outbound_paused", "true");
    const jobId = db.enqueueJob("DISCOVER_CAMPAIGN", {
      campaignId,
      briefId: saved.briefId,
      versionId: saved.versionId,
      briefHash: saved.briefHash,
      launchKey: spec.launchKey,
      provider: { providerKey: "SEARXNG", operation: "EVIDENCE_SEARCH" },
      createdBy: spec.authorization.actor,
      replyChatId: spec.replyChatId,
      researchOnly: true,
      maximumSequenceIndex: 0,
      ...(spec.jobContext ? {
        scheduled: true,
        trigger: spec.jobContext.trigger,
        playId: spec.jobContext.playId,
        playVersionId: spec.jobContext.playVersionId,
        allocationId: spec.jobContext.allocationId,
      } : {}),
    }, undefined, {
      dedupeKey: `autonomous-research:${spec.launchKey.toLowerCase()}:discover`,
      lane: "RESEARCH",
      priority: 20,
    });
    db.setCampaignStatus(campaignId, "QUEUED");
    const result: AutonomousResearchLaunchResult = {
      status: "RESEARCH_LAUNCHED",
      ids: {
        campaignId,
        briefId: saved.briefId,
        versionId: saved.versionId,
        shadowApprovalId: shadow.id,
        providerBudgetApprovalId: providerBudget.id,
        jobId,
      },
      externalSendAuthorized: false,
    };
    if (!db.setSettingIfAbsent(settingKey, canonicalJson({ specHash, result }))) {
      throw new Error("Autonomous research launch key was concurrently reserved");
    }
    return result;
  });
}

export function readAutonomousResearchLaunchSpec(filePathInput: string): AutonomousResearchLaunchSpec {
  const filePath = path.resolve(filePathInput.trim());
  if (path.extname(filePath).toLowerCase() !== ".json") throw new Error("Research launch spec must be a .json file");
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size > 1_000_000) throw new Error("Research launch spec must be a file no larger than 1 MB");
  return parseAutonomousResearchLaunchSpec(JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as unknown);
}

export function parseAutonomousResearchLaunchCliArgs(args: readonly string[]): { specPath: string; confirmed: true } {
  const confirmed = args.includes("--confirm-research");
  if (!confirmed) throw new Error("launch-autonomous-research requires explicit --confirm-research");
  const filtered = args.filter((argument) => argument !== "--confirm-research");
  const specIndex = filtered.indexOf("--spec");
  const specPath = specIndex >= 0 ? filtered[specIndex + 1] : filtered.find((argument) => !argument.startsWith("--"));
  if (!specPath) throw new Error("launch-autonomous-research requires one JSON spec file");
  const allowed = specIndex >= 0 ? ["--spec", specPath] : [specPath];
  if (filtered.some((argument) => !allowed.includes(argument))) throw new Error("Unknown autonomous research launch option");
  return { specPath, confirmed: true };
}
