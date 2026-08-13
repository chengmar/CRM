import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CAMPAIGN_BRIEF_SCHEMA_VERSION,
  CampaignBriefSchema,
  type CampaignBrief,
} from "./campaign-brief.js";
import {
  SellerKnowledgeDocumentSchema,
  SellerKnowledgeStore,
  assessSellerReadiness,
  deterministicSellerContentHash,
  type SellerKnowledgeDocument,
} from "./seller-knowledge.js";
import { AgentDatabase } from "../db.js";

const TextSchema = z.string().trim().min(1).max(2_000);
const IdentifierSchema = z.string().trim().min(1).max(160);
const IsoDateTimeSchema = z.string().trim().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);

const CampaignLaunchSchema = z.object({
  name: TextSchema.max(300),
  market: TextSchema.max(120),
  product: TextSchema.max(300),
  buyerType: TextSchema.max(200),
  targetCount: z.number().int().positive().max(100_000),
}).strict();

const LaunchLimitsSchema = z.object({
  total: z.number().int().positive().max(100_000),
  daily: z.number().int().positive().max(100_000),
  hourly: z.number().int().positive().max(100_000),
}).strict();

const AuthorizationSchema = z.object({
  actor: IdentifierSchema,
  source: TextSchema.max(300),
  reason: TextSchema.max(2_000),
}).strict();

const ProviderSchema = z.object({
  providerKey: z.literal("SEARXNG"),
  operation: z.literal("EVIDENCE_SEARCH"),
}).strict();

export const AutonomousPilotLaunchSpecSchema = z.object({
  launchKey: IdentifierSchema,
  actionId: IdentifierSchema,
  campaign: CampaignLaunchSchema,
  brief: CampaignBriefSchema,
  sellerKnowledge: SellerKnowledgeDocumentSchema,
  provider: ProviderSchema,
  authorization: AuthorizationSchema,
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  limits: LaunchLimitsSchema,
  replyChatId: z.string().trim().max(200).optional().default(""),
}).strict().superRefine((spec, context) => {
  const equalText = (left: string, right: string): boolean =>
    left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");

  if (!equalText(spec.campaign.market, spec.brief.market)) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "market"],
      message: "must match brief.market",
    });
  }
  if (!equalText(spec.campaign.product, spec.brief.productFamily)) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "product"],
      message: "must match brief.productFamily",
    });
  }
  if (spec.campaign.targetCount !== spec.brief.targetCount) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "targetCount"],
      message: "must match brief.targetCount",
    });
  }
  if (!spec.brief.buyerTypes.some((buyerType) => equalText(buyerType, spec.campaign.buyerType))) {
    context.addIssue({
      code: "custom",
      path: ["campaign", "buyerType"],
      message: "must be included in brief.buyerTypes",
    });
  }
  if (spec.brief.transport !== "SMTP") {
    context.addIssue({
      code: "custom",
      path: ["brief", "transport"],
      message: "must be SMTP for an autonomous send pilot",
    });
  }
  const allowedProviders = new Set(
    spec.brief.providerBudget.allowedProviders.map((provider) => provider.toLocaleLowerCase("en-US")),
  );
  const requiredProviders = ["searxng", "local-public-web"] as const;
  for (const provider of requiredProviders) {
    if (allowedProviders.has(provider)) continue;
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget", "allowedProviders"],
      message: `must explicitly include ${provider}`,
    });
  }
  const selectedVerifiers = ["hunter", "bouncer"].filter((provider) => allowedProviders.has(provider));
  if (selectedVerifiers.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget", "allowedProviders"],
      message: "must include exactly one independent email verifier: hunter or bouncer",
    });
  }
  if (spec.brief.providerBudget.mode !== "CAPPED" ||
    (spec.brief.providerBudget.maxUnits === 0 && spec.brief.providerBudget.maxAmountUsd === 0)) {
    context.addIssue({
      code: "custom",
      path: ["brief", "providerBudget"],
      message: "an autonomous send pilot requires a positive CAPPED budget for independent email verification",
    });
  }
  if (!(spec.limits.hourly <= spec.limits.daily && spec.limits.daily <= spec.limits.total)) {
    context.addIssue({
      code: "custom",
      path: ["limits"],
      message: "must satisfy 0 < hourly <= daily <= total",
    });
  }
  if (Date.parse(spec.expiresAt) <= Date.parse(spec.validFrom)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "must be later than validFrom",
    });
  }
  const sellerReadiness = assessSellerReadiness(spec.sellerKnowledge);
  if (!sellerReadiness.ready) {
    for (const blocker of sellerReadiness.blockers) {
      context.addIssue({
        code: "custom",
        path: ["sellerKnowledge"],
        message: blocker,
      });
    }
    return;
  }
  const sellerStore = new SellerKnowledgeStore(spec.sellerKnowledge);
  for (const offerId of spec.brief.offerIds) {
    if (!sellerStore.getApprovedOffer(offerId, spec.brief.market, "EMAIL")) {
      context.addIssue({
        code: "custom",
        path: ["brief", "offerIds"],
        message: `${offerId} must identify an active public-approved EMAIL offer for the brief market`,
      });
    }
  }
});

export type AutonomousPilotLaunchSpec = z.infer<typeof AutonomousPilotLaunchSpecSchema>;

const LaunchResultSchema = z.object({
  ids: z.object({
    campaignId: IdentifierSchema,
    briefId: IdentifierSchema,
    versionId: IdentifierSchema,
    shadowApprovalId: IdentifierSchema,
    providerBudgetApprovalId: IdentifierSchema,
    externalSendApprovalId: IdentifierSchema,
    sendAuthorizationId: IdentifierSchema,
    jobId: IdentifierSchema,
  }).strict(),
  status: z.literal("LAUNCHED"),
  limits: z.object({
    total: z.number().int().positive(),
    daily: z.number().int().positive(),
    hourly: z.number().int().positive(),
    maximumSequenceIndex: z.literal(0),
  }).strict(),
}).strict();

export type AutonomousPilotLaunchResult = z.infer<typeof LaunchResultSchema>;

const PersistedLaunchRecordSchema = z.object({
  schemaVersion: z.literal("autonomous-pilot-launch-record-v2"),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  briefHash: z.string().regex(/^[a-f0-9]{64}$/),
  sellerKnowledgeHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: LaunchResultSchema,
}).strict();

interface AutonomousPilotLaunchCliOptions {
  specPath: string;
  confirmed: true;
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function specError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "$root"}: ${issue.message}`)
    .sort()
    .join("; ");
  return new Error(`Invalid autonomous pilot launch spec: ${details}`);
}

export function parseAutonomousPilotLaunchSpec(input: unknown): AutonomousPilotLaunchSpec {
  const parsed = AutonomousPilotLaunchSpecSchema.safeParse(input);
  if (!parsed.success) throw specError(parsed.error);
  return parsed.data;
}

export function readAutonomousPilotLaunchSpec(filePathInput: string): AutonomousPilotLaunchSpec {
  const filePath = path.resolve(filePathInput.trim());
  if (path.extname(filePath).toLocaleLowerCase("en-US") !== ".json") {
    throw new Error("Autonomous pilot launch spec must be a .json file");
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error("Autonomous pilot launch spec path must identify a file");
  if (stats.size > 1_000_000) throw new Error("Autonomous pilot launch spec exceeds the 1 MB limit");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new Error("Autonomous pilot launch spec is not valid JSON");
  }
  return parseAutonomousPilotLaunchSpec(raw);
}

export function parseAutonomousPilotLaunchCliArgs(args: readonly string[]): AutonomousPilotLaunchCliOptions {
  let specPath = "";
  let confirmed = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--confirm-launch") {
      if (confirmed) throw new Error("--confirm-launch may only be supplied once");
      confirmed = true;
      continue;
    }
    if (argument === "--spec") {
      if (specPath) throw new Error("--spec may only be supplied once");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--spec requires a JSON file path");
      specPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown launch option: ${argument}`);
    positional.push(argument);
  }
  if (!confirmed) throw new Error("launch-autonomous-pilot requires explicit --confirm-launch");
  if (specPath && positional.length > 0) {
    throw new Error("Supply the launch spec either with --spec or as one positional path, not both");
  }
  if (!specPath) {
    if (positional.length !== 1) throw new Error("launch-autonomous-pilot requires one JSON spec file");
    specPath = positional[0]!;
  } else if (positional.length > 0) {
    throw new Error("Unexpected positional launch arguments");
  }
  return { specPath, confirmed: true };
}

function normalizedBrief(spec: AutonomousPilotLaunchSpec): CampaignBrief {
  return CampaignBriefSchema.parse({
    ...spec.brief,
    schemaVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
    id: `autonomous-pilot:${spec.launchKey.toLocaleLowerCase("en-US")}`,
    version: 1,
  });
}

function boundPublicSellerKnowledge(spec: AutonomousPilotLaunchSpec): SellerKnowledgeDocument {
  const offerIds = new Set(spec.brief.offerIds);
  const offers = spec.sellerKnowledge.offers.filter((offer) => offerIds.has(offer.id));
  const sellerFactIds = new Set(offers.flatMap((offer) => offer.sellerFactIds));
  const productIds = new Set(offers.map((offer) => offer.productId));
  const document = SellerKnowledgeDocumentSchema.parse({
    ...spec.sellerKnowledge,
    profile: {
      ...spec.sellerKnowledge.profile,
      products: spec.sellerKnowledge.profile.products.filter((product) => productIds.has(product.id)),
    },
    facts: spec.sellerKnowledge.facts.filter((fact) => sellerFactIds.has(fact.id)),
    offers,
    privateCases: [],
  });
  const readiness = assessSellerReadiness(document);
  if (!readiness.ready) {
    throw new Error(`Bound public seller knowledge is not ready: ${readiness.blockers.join("; ")}`);
  }
  if (document.offers.length !== spec.brief.offerIds.length) {
    throw new Error("Every Campaign Brief offer must be bound to one active public seller offer");
  }
  return document;
}

function assertReplayMaterial(
  db: AgentDatabase,
  spec: AutonomousPilotLaunchSpec,
  briefHash: string,
  sellerKnowledgeHash: string,
  result: AutonomousPilotLaunchResult,
): void {
  const { ids, limits } = result;
  const campaign = db.db.prepare(
    `SELECT market, product, buyer_type, target_count, daily_limit, hourly_limit, followup_days_json
     FROM campaigns WHERE id=?`,
  ).get(ids.campaignId) as Record<string, unknown> | undefined;
  const version = db.db.prepare(
    "SELECT brief_id, brief_hash FROM campaign_versions WHERE id=?",
  ).get(ids.versionId) as Record<string, unknown> | undefined;
  const binding = db.db.prepare(
    "SELECT brief_id, version_id, brief_hash FROM campaign_provider_bindings WHERE campaign_id=?",
  ).get(ids.campaignId) as Record<string, unknown> | undefined;
  const sendAuthorization = db.db.prepare(
    `SELECT campaign_approval_id, brief_id, version_id, campaign_id, total_limit, daily_limit,
            hourly_limit, maximum_sequence_index, valid_from, expires_at
     FROM campaign_send_authorizations WHERE id=?`,
  ).get(ids.sendAuthorizationId) as Record<string, unknown> | undefined;
  const job = db.db.prepare(
    "SELECT job_type, payload_json FROM jobs WHERE id=?",
  ).get(ids.jobId) as Record<string, unknown> | undefined;
  const approvalRows = db.db.prepare(
    `SELECT id, scope FROM campaign_approvals
     WHERE id IN (?, ?, ?)`,
  ).all(ids.shadowApprovalId, ids.providerBudgetApprovalId, ids.externalSendApprovalId) as
    Array<{ id: string; scope: string }>;
  const approvalScopes = new Map(approvalRows.map((approval) => [approval.id, approval.scope]));

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = job ? JSON.parse(String(job.payload_json)) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }
  const replayValid = campaign && version && binding && sendAuthorization && job && payload &&
    String(campaign.market).trim().toLocaleLowerCase("en-US") ===
      spec.campaign.market.toLocaleLowerCase("en-US") &&
    String(campaign.product).trim().toLocaleLowerCase("en-US") ===
      spec.campaign.product.toLocaleLowerCase("en-US") &&
    String(campaign.buyer_type).trim().toLocaleLowerCase("en-US") ===
      spec.campaign.buyerType.toLocaleLowerCase("en-US") &&
    Number(campaign.target_count) === spec.campaign.targetCount &&
    Number(campaign.daily_limit) === limits.daily && Number(campaign.hourly_limit) === limits.hourly &&
    String(campaign.followup_days_json) === "[]" &&
    version.brief_id === ids.briefId && version.brief_hash === briefHash &&
    binding.brief_id === ids.briefId && binding.version_id === ids.versionId && binding.brief_hash === briefHash &&
    sendAuthorization.campaign_approval_id === ids.externalSendApprovalId &&
    sendAuthorization.brief_id === ids.briefId && sendAuthorization.version_id === ids.versionId &&
    sendAuthorization.campaign_id === ids.campaignId &&
    Number(sendAuthorization.total_limit) === limits.total &&
    Number(sendAuthorization.daily_limit) === limits.daily &&
    Number(sendAuthorization.hourly_limit) === limits.hourly &&
    Number(sendAuthorization.maximum_sequence_index) === 0 &&
    sendAuthorization.valid_from === new Date(Date.parse(spec.validFrom)).toISOString() &&
    sendAuthorization.expires_at === new Date(Date.parse(spec.expiresAt)).toISOString() &&
    approvalScopes.get(ids.shadowApprovalId) === "SHADOW_PLAN" &&
    approvalScopes.get(ids.providerBudgetApprovalId) === "PROVIDER_BUDGET" &&
    approvalScopes.get(ids.externalSendApprovalId) === "EXTERNAL_SEND" &&
    job.job_type === "DISCOVER_CAMPAIGN" && payload.campaignId === ids.campaignId &&
    payload.briefId === ids.briefId && payload.versionId === ids.versionId &&
    payload.briefHash === briefHash && payload.sellerKnowledgeHash === sellerKnowledgeHash &&
    deterministicSellerContentHash(payload.sellerKnowledge) === sellerKnowledgeHash &&
    JSON.stringify(payload.allowedOfferIds) === JSON.stringify(spec.brief.offerIds);
  if (!replayValid) {
    throw new Error("Autonomous pilot launch record is stale or does not match its immutable DB material");
  }
}

export function launchAutonomousPilot(
  db: AgentDatabase,
  input: unknown,
): AutonomousPilotLaunchResult {
  const spec = parseAutonomousPilotLaunchSpec(input);
  const migration = db.getMigrationStatus();
  if (migration.currentVersion < 14 || migration.currentVersion !== migration.latestVersion) {
    throw new Error("launch-autonomous-pilot requires the current autonomous-send database schema");
  }

  const launchSettingKey = `autonomous_pilot_launch:${spec.launchKey.toLocaleLowerCase("en-US")}`;
  const specHash = canonicalHash(spec);
  const brief = normalizedBrief(spec);
  const briefHash = canonicalHash(brief);
  const sellerKnowledge = boundPublicSellerKnowledge(spec);
  const sellerKnowledgeHash = deterministicSellerContentHash(sellerKnowledge);
  const budgetHash = canonicalHash({
    providerBudget: brief.providerBudget,
    llmBudget: brief.llmBudget,
  });
  const authorization = {
    actor: spec.authorization.actor,
    actorType: "HUMAN" as const,
    roles: ["SALES_MANAGER" as const],
  };

  return db.runInTransaction(() => {
    const replayJson = db.getSetting(launchSettingKey);
    if (replayJson) {
      let replay: z.infer<typeof PersistedLaunchRecordSchema>;
      try {
        replay = PersistedLaunchRecordSchema.parse(JSON.parse(replayJson) as unknown);
      } catch {
        throw new Error("Autonomous pilot launch key has an invalid persisted record");
      }
      if (replay.specHash !== specHash) {
        throw new Error("Autonomous pilot launch key was reused with different spec material");
      }
      if (replay.briefHash !== briefHash) {
        throw new Error("Autonomous pilot launch brief no longer matches its persisted hash");
      }
      if (replay.sellerKnowledgeHash !== sellerKnowledgeHash) {
        throw new Error("Autonomous pilot launch seller knowledge no longer matches its persisted hash");
      }
      assertReplayMaterial(db, spec, replay.briefHash, replay.sellerKnowledgeHash, replay.result);
      return replay.result;
    }

    const campaignId = db.createCampaign({
      name: spec.campaign.name,
      market: spec.campaign.market,
      product: spec.campaign.product,
      buyerType: spec.campaign.buyerType,
      targetCount: spec.campaign.targetCount,
      createdBy: spec.authorization.actor,
      dailyLimit: spec.limits.daily,
      hourlyLimit: spec.limits.hourly,
      followupDays: [],
    });
    const savedBrief = db.saveCampaignDraft({
      briefKey: `autonomous-pilot:${spec.launchKey.toLocaleLowerCase("en-US")}`,
      brief,
      parserVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
      createdBy: spec.authorization.actor,
    });
    if (savedBrief.briefHash !== briefHash || savedBrief.versionNumber !== 1) {
      throw new Error("Autonomous pilot launch key resolved to unexpected Campaign Brief material");
    }

    const approvalBase = {
      briefId: savedBrief.briefId,
      versionId: savedBrief.versionId,
      authorizationSource: spec.authorization.source,
      reason: spec.authorization.reason,
    };
    const shadowApproval = db.saveCampaignScopedApproval({
      ...approvalBase,
      scope: "SHADOW_PLAN",
      actionId: `${spec.actionId}:shadow-plan`,
    }, authorization);
    const providerBudgetApproval = db.saveCampaignScopedApproval({
      ...approvalBase,
      scope: "PROVIDER_BUDGET",
      actionId: `${spec.actionId}:provider-budget`,
      budgetHash,
    }, authorization);
    const externalSendApproval = db.saveCampaignScopedApproval({
      ...approvalBase,
      scope: "EXTERNAL_SEND",
      actionId: spec.actionId,
    }, authorization);

    db.bindProviderCampaign({
      campaignId,
      briefId: savedBrief.briefId,
      versionId: savedBrief.versionId,
      briefHash: savedBrief.briefHash,
      createdBy: spec.authorization.actor,
    });
    const selectedVerifier = spec.brief.providerBudget.allowedProviders
      .map((provider) => provider.toLocaleLowerCase("en-US"))
      .find((provider) => provider === "hunter" || provider === "bouncer");
    if (!selectedVerifier) throw new Error("Approved campaign brief has no independent email verifier");
    const requiredProviderCapabilities = [
      { providerKey: spec.provider.providerKey, operation: spec.provider.operation, chargeable: false },
      { providerKey: "local-public-web", operation: "WEBSITE_CRAWL", chargeable: false },
      { providerKey: selectedVerifier, operation: "EMAIL_VERIFICATION", chargeable: true },
    ] as const;
    for (const required of requiredProviderCapabilities) {
      const providerContext = db.getAuthorizedProviderCampaignContext(
        campaignId,
        required.providerKey,
        { chargeable: required.chargeable },
      );
      let capabilities: unknown = null;
      try {
        capabilities = JSON.parse(String(providerContext.capabilities_json));
      } catch {
        capabilities = null;
      }
      if (!Array.isArray(capabilities) || !capabilities.includes(required.operation)) {
        throw new Error(`${required.providerKey} provider registry does not authorize ${required.operation}`);
      }
    }

    const sendAuthorization = db.saveCampaignSendAuthorization({
      campaignApprovalId: externalSendApproval.id,
      briefId: savedBrief.briefId,
      versionId: savedBrief.versionId,
      briefHash: savedBrief.briefHash,
      campaignId,
      market: spec.campaign.market,
      transport: "SMTP",
      totalLimit: spec.limits.total,
      dailyLimit: spec.limits.daily,
      hourlyLimit: spec.limits.hourly,
      maximumSequenceIndex: 0,
      validFrom: spec.validFrom,
      expiresAt: spec.expiresAt,
      policyVersion: "campaign-autonomous-pilot-v1",
      actionId: spec.actionId,
      authorizationSource: spec.authorization.source,
      reason: spec.authorization.reason,
    }, authorization);

    const jobId = db.enqueueJob("DISCOVER_CAMPAIGN", {
      campaignId,
      briefId: savedBrief.briefId,
      versionId: savedBrief.versionId,
      briefHash: savedBrief.briefHash,
      sendAuthorizationId: sendAuthorization.id,
      launchKey: spec.launchKey,
      provider: spec.provider,
      sellerKnowledge,
      sellerKnowledgeHash,
      allowedOfferIds: brief.offerIds,
      createdBy: spec.authorization.actor,
      replyChatId: spec.replyChatId,
      maximumSequenceIndex: 0,
    }, undefined, {
      dedupeKey: `autonomous-pilot:${spec.launchKey.toLocaleLowerCase("en-US")}:discover`,
      lane: "RESEARCH",
      priority: 20,
    });
    db.setCampaignStatus(campaignId, "QUEUED");

    const result: AutonomousPilotLaunchResult = {
      ids: {
        campaignId,
        briefId: savedBrief.briefId,
        versionId: savedBrief.versionId,
        shadowApprovalId: shadowApproval.id,
        providerBudgetApprovalId: providerBudgetApproval.id,
        externalSendApprovalId: externalSendApproval.id,
        sendAuthorizationId: sendAuthorization.id,
        jobId,
      },
      status: "LAUNCHED",
      limits: {
        total: spec.limits.total,
        daily: spec.limits.daily,
        hourly: spec.limits.hourly,
        maximumSequenceIndex: 0,
      },
    };
    const launchRecord = {
      schemaVersion: "autonomous-pilot-launch-record-v2" as const,
      specHash,
      briefHash,
      sellerKnowledgeHash,
      result,
    };
    if (!db.setSettingIfAbsent(launchSettingKey, canonicalJson(launchRecord))) {
      throw new Error("Autonomous pilot launch key was concurrently reserved");
    }
    return result;
  });
}
