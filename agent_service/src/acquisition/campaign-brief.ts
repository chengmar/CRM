import { createHash } from "node:crypto";
import { z } from "zod";

export const CAMPAIGN_BRIEF_SCHEMA_VERSION = "campaign-brief-v2" as const;
export const CAMPAIGN_APPROVAL_SCHEMA_VERSION = "campaign-approval-v2" as const;

const IdSchema = z.string().trim().min(1).max(200);
const TextSchema = z.string().trim().min(1).max(2_000);
const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const CampaignPlanStatusSchema = z.enum([
  "PLAN_DRAFT",
  "PLAN_NEEDS_INPUT",
  "PLAN_APPROVED",
  "BUDGET_PENDING",
  "BUDGET_APPROVED",
  "QUEUED",
  "RESEARCHING",
  "SHADOW_COMPLETE",
  "READY_FOR_SEND_EXPERIMENT",
  "CANCELLED",
]);

export const CampaignTargetMetricSchema = z.enum([
  "ACCOUNTS_RESEARCHED",
  "QUALIFIED_ACCOUNTS",
  "VALID_CONTACTS",
  "READY_FOR_REVIEW",
  "DELIVERED",
]);

export const BudgetSpecSchema = z.object({
  mode: z.enum(["ZERO_COST", "CAPPED"]),
  allowedProviders: z.array(IdSchema).min(1).max(100),
  unit: z.enum(["CREDITS", "TOKENS", "REQUESTS"]),
  maxUnits: z.number().int().nonnegative(),
  maxAmountUsd: z.number().finite().nonnegative(),
  requiresSeparateApproval: z.literal(true),
}).strict().superRefine((budget, context) => {
  if (new Set(budget.allowedProviders.map((provider) => provider.toLocaleLowerCase("en-US"))).size
    !== budget.allowedProviders.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedProviders"],
      message: "must not contain duplicates",
    });
  }
  const normalizedProviders = new Set(
    budget.allowedProviders.map((provider) => provider.toLocaleLowerCase("en-US")),
  );
  if (["hunter", "bouncer"].filter((provider) => normalizedProviders.has(provider)).length > 1) {
    context.addIssue({
      code: "custom",
      path: ["allowedProviders"],
      message: "must include at most one independent email verifier: hunter or bouncer",
    });
  }
  if (budget.mode === "ZERO_COST" && (budget.maxUnits !== 0 || budget.maxAmountUsd !== 0)) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "ZERO_COST requires zero unit and USD caps",
    });
  }
  if (budget.mode === "CAPPED" && budget.maxUnits === 0 && budget.maxAmountUsd === 0) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "CAPPED requires a positive unit or USD cap",
    });
  }
});

export type BudgetSpec = z.infer<typeof BudgetSpecSchema>;

const CampaignBriefShape = {
  schemaVersion: z.literal(CAMPAIGN_BRIEF_SCHEMA_VERSION),
  id: IdSchema,
  version: z.number().int().positive(),
  market: TextSchema.max(120),
  productFamily: TextSchema.max(300),
  buyerTypes: z.array(TextSchema.max(200)).min(1).max(100),
  industries: z.array(TextSchema.max(200)).min(1).max(100),
  roleFamilies: z.array(TextSchema.max(200)).min(1).max(100),
  qualificationTracks: z.array(z.enum(["ACTIVE_INTENT", "HIGH_ICP_FIT"])).min(1).max(2),
  requiredSignals: z.array(TextSchema.max(500)).min(1).max(200),
  exclusions: z.array(TextSchema.max(500)).max(200),
  targetMetric: CampaignTargetMetricSchema,
  targetCount: z.number().int().positive().max(100_000),
  providerBudget: BudgetSpecSchema,
  llmBudget: BudgetSpecSchema,
  offerIds: z.array(IdSchema).min(1).max(100),
  transport: z.enum(["NONE", "SMTP", "EXTERNAL_DRAFT"]),
  deadline: IsoDateTimeSchema.nullable(),
  hypothesis: TextSchema.max(2_000),
} as const;

function addDuplicateIssues(
  value: Record<string, unknown>,
  fields: readonly string[],
  context: z.RefinementCtx,
): void {
  for (const field of fields) {
    const values = value[field];
    if (!Array.isArray(values)) continue;
    const normalized = values.map((entry) => String(entry).trim().toLocaleLowerCase("en-US"));
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", path: [field], message: "must not contain duplicates" });
    }
  }
}

export const CampaignBriefSchema = z.object(CampaignBriefShape).strict().superRefine((brief, context) => {
  addDuplicateIssues(brief, [
    "buyerTypes",
    "industries",
    "roleFamilies",
    "qualificationTracks",
    "requiredSignals",
    "exclusions",
    "offerIds",
  ], context);
  if (brief.qualificationTracks.includes("ACTIVE_INTENT") && brief.requiredSignals.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["requiredSignals"],
      message: "ACTIVE_INTENT requires explicit signals",
    });
  }
});

export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export const CampaignBriefDraftSchema = z.object({
  schemaVersion: z.literal(CAMPAIGN_BRIEF_SCHEMA_VERSION).optional(),
  id: IdSchema.optional(),
  version: z.number().int().positive().optional(),
  market: TextSchema.max(120).optional(),
  productFamily: TextSchema.max(300).optional(),
  buyerTypes: z.array(TextSchema.max(200)).max(100).optional(),
  industries: z.array(TextSchema.max(200)).max(100).optional(),
  roleFamilies: z.array(TextSchema.max(200)).max(100).optional(),
  qualificationTracks: z.array(z.enum(["ACTIVE_INTENT", "HIGH_ICP_FIT"])).max(2).optional(),
  requiredSignals: z.array(TextSchema.max(500)).max(200).optional(),
  exclusions: z.array(TextSchema.max(500)).max(200).optional(),
  targetMetric: CampaignTargetMetricSchema.optional(),
  targetCount: z.number().int().positive().max(100_000).optional(),
  providerBudget: BudgetSpecSchema.optional(),
  llmBudget: BudgetSpecSchema.optional(),
  offerIds: z.array(IdSchema).max(100).optional(),
  transport: z.enum(["NONE", "SMTP", "EXTERNAL_DRAFT"]).optional(),
  deadline: IsoDateTimeSchema.nullable().optional(),
  hypothesis: TextSchema.max(2_000).optional(),
}).strict();

export type CampaignBriefDraft = z.infer<typeof CampaignBriefDraftSchema>;

const REQUIRED_BRIEF_FIELDS = [
  "id",
  "version",
  "market",
  "productFamily",
  "buyerTypes",
  "industries",
  "roleFamilies",
  "qualificationTracks",
  "requiredSignals",
  "exclusions",
  "targetMetric",
  "targetCount",
  "providerBudget",
  "llmBudget",
  "offerIds",
  "deadline",
  "hypothesis",
] as const;

const NON_EMPTY_ARRAY_FIELDS = [
  "buyerTypes",
  "industries",
  "roleFamilies",
  "qualificationTracks",
  "requiredSignals",
  "offerIds",
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function campaignBriefHash(input: unknown): string {
  const brief = CampaignBriefSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(stableValue(brief))).digest("hex");
}

export interface CampaignBriefDraftResult {
  status: "PLAN_DRAFT" | "PLAN_NEEDS_INPUT";
  brief: CampaignBrief | null;
  briefHash: string | null;
  missingFields: string[];
  blockers: string[];
}

function missingDraftFields(draft: CampaignBriefDraft): string[] {
  const record = draft as Record<string, unknown>;
  const missing = REQUIRED_BRIEF_FIELDS.filter((field) => record[field] === undefined);
  for (const field of NON_EMPTY_ARRAY_FIELDS) {
    if (Array.isArray(record[field]) && (record[field] as unknown[]).length === 0) missing.push(field);
  }
  return [...new Set(missing)].sort();
}

export function validateCampaignBriefDraft(input: unknown): CampaignBriefDraftResult {
  const draftResult = CampaignBriefDraftSchema.safeParse(input);
  if (!draftResult.success) {
    const issueFields = draftResult.error.issues
      .map((issue) => String(issue.path[0] ?? "$root"));
    return {
      status: "PLAN_NEEDS_INPUT",
      brief: null,
      briefHash: null,
      missingFields: [...new Set(issueFields)].sort(),
      blockers: draftResult.error.issues.map((issue) =>
        `CAMPAIGN_BRIEF_DRAFT_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const missingFields = missingDraftFields(draftResult.data);
  if (missingFields.length > 0) {
    return {
      status: "PLAN_NEEDS_INPUT",
      brief: null,
      briefHash: null,
      missingFields,
      blockers: missingFields.map((field) => `CAMPAIGN_BRIEF_REQUIRED:${field}`),
    };
  }
  const fullResult = CampaignBriefSchema.safeParse({
    ...draftResult.data,
    schemaVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
    transport: draftResult.data.transport ?? "NONE",
  });
  if (!fullResult.success) {
    return {
      status: "PLAN_NEEDS_INPUT",
      brief: null,
      briefHash: null,
      missingFields: [...new Set(fullResult.error.issues.map((issue) => String(issue.path[0] ?? "$root")))].sort(),
      blockers: fullResult.error.issues.map((issue) =>
        `CAMPAIGN_BRIEF_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  return {
    status: "PLAN_DRAFT",
    brief: fullResult.data,
    briefHash: campaignBriefHash(fullResult.data),
    missingFields: [],
    blockers: [],
  };
}

export const CampaignBriefPatchSchema = z.object({
  market: TextSchema.max(120).optional(),
  productFamily: TextSchema.max(300).optional(),
  buyerTypes: z.array(TextSchema.max(200)).min(1).max(100).optional(),
  industries: z.array(TextSchema.max(200)).min(1).max(100).optional(),
  roleFamilies: z.array(TextSchema.max(200)).min(1).max(100).optional(),
  qualificationTracks: z.array(z.enum(["ACTIVE_INTENT", "HIGH_ICP_FIT"])).min(1).max(2).optional(),
  requiredSignals: z.array(TextSchema.max(500)).min(1).max(200).optional(),
  exclusions: z.array(TextSchema.max(500)).max(200).optional(),
  targetMetric: CampaignTargetMetricSchema.optional(),
  targetCount: z.number().int().positive().max(100_000).optional(),
  providerBudget: BudgetSpecSchema.optional(),
  llmBudget: BudgetSpecSchema.optional(),
  offerIds: z.array(IdSchema).min(1).max(100).optional(),
  transport: z.enum(["NONE", "SMTP", "EXTERNAL_DRAFT"]).optional(),
  deadline: IsoDateTimeSchema.nullable().optional(),
  hypothesis: TextSchema.max(2_000).optional(),
}).strict();

export interface CampaignBriefRevisionResult {
  status: "PLAN_DRAFT" | "PLAN_NEEDS_INPUT";
  brief: CampaignBrief | null;
  briefHash: string | null;
  previousVersion: number | null;
  blockers: string[];
}

export function reviseCampaignBrief(input: {
  currentBrief: unknown;
  patch: unknown;
}): CampaignBriefRevisionResult {
  const currentResult = CampaignBriefSchema.safeParse(input.currentBrief);
  const patchResult = CampaignBriefPatchSchema.safeParse(input.patch);
  const blockers: string[] = [];
  if (!currentResult.success) {
    blockers.push(...currentResult.error.issues.map((issue) =>
      `CAMPAIGN_BRIEF_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  if (!patchResult.success) {
    blockers.push(...patchResult.error.issues.map((issue) =>
      `CAMPAIGN_BRIEF_PATCH_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  } else if (Object.keys(patchResult.data).length === 0) {
    blockers.push("CAMPAIGN_BRIEF_PATCH_EMPTY");
  }
  if (!currentResult.success || !patchResult.success || blockers.length > 0) {
    return {
      status: "PLAN_NEEDS_INPUT",
      brief: null,
      briefHash: null,
      previousVersion: currentResult.success ? currentResult.data.version : null,
      blockers: [...new Set(blockers)].sort(),
    };
  }
  const nextResult = CampaignBriefSchema.safeParse({
    ...currentResult.data,
    ...patchResult.data,
    version: currentResult.data.version + 1,
  });
  if (!nextResult.success) {
    return {
      status: "PLAN_NEEDS_INPUT",
      brief: null,
      briefHash: null,
      previousVersion: currentResult.data.version,
      blockers: nextResult.error.issues.map((issue) =>
        `CAMPAIGN_BRIEF_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  return {
    status: "PLAN_DRAFT",
    brief: nextResult.data,
    briefHash: campaignBriefHash(nextResult.data),
    previousVersion: currentResult.data.version,
    blockers: [],
  };
}

export const CampaignApproverSchema = z.object({
  id: IdSchema,
  name: TextSchema.max(160),
  human: z.literal(true),
}).strict();

const CampaignApprovalBaseShape = {
  schemaVersion: z.literal(CAMPAIGN_APPROVAL_SCHEMA_VERSION),
  id: IdSchema,
  actionId: IdSchema,
  briefId: IdSchema,
  briefVersion: z.number().int().positive(),
  briefHash: HashSchema,
  approvedBy: CampaignApproverSchema,
  approvedAt: IsoDateTimeSchema,
  authorizationSource: z.literal("EXPLICIT_FEISHU_ACTION"),
} as const;

const ShadowApprovalSchema = z.object({
  ...CampaignApprovalBaseShape,
  scope: z.literal("SHADOW_PLAN"),
  shadowAuthorized: z.literal(true),
  providerBudgetAuthorized: z.literal(false),
  externalSendAuthorized: z.literal(false),
  budgetHash: z.null(),
}).strict();

const ProviderBudgetApprovalSchema = z.object({
  ...CampaignApprovalBaseShape,
  scope: z.literal("PROVIDER_BUDGET"),
  shadowAuthorized: z.literal(false),
  providerBudgetAuthorized: z.literal(true),
  externalSendAuthorized: z.literal(false),
  budgetHash: HashSchema,
}).strict();

const ExternalSendApprovalSchema = z.object({
  ...CampaignApprovalBaseShape,
  scope: z.literal("EXTERNAL_SEND"),
  shadowAuthorized: z.literal(false),
  providerBudgetAuthorized: z.literal(false),
  externalSendAuthorized: z.literal(true),
  budgetHash: z.null(),
}).strict();

export const CampaignApprovalSchema = z.discriminatedUnion("scope", [
  ShadowApprovalSchema,
  ProviderBudgetApprovalSchema,
  ExternalSendApprovalSchema,
]);

export type CampaignApproval = z.infer<typeof CampaignApprovalSchema>;
export type CampaignApprovalScope = CampaignApproval["scope"];

function campaignBudgetHash(brief: CampaignBrief): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ providerBudget: brief.providerBudget, llmBudget: brief.llmBudget })))
    .digest("hex");
}

export interface CreateCampaignApprovalResult {
  status: "PLAN_APPROVED" | "BUDGET_APPROVED" | "READY_FOR_SEND_EXPERIMENT" | "REJECTED" | "IDEMPOTENT_REPLAY";
  approval: CampaignApproval | null;
  blockers: string[];
}

export function createScopedCampaignApproval(input: {
  id: string;
  actionId: string;
  scope: CampaignApprovalScope;
  brief: unknown;
  approver: unknown;
  authorizedApproverIds: readonly string[];
  processedActionIds?: readonly string[];
  approvedAt?: Date;
}): CreateCampaignApprovalResult {
  if (new Set(input.processedActionIds ?? []).has(input.actionId)) {
    return { status: "IDEMPOTENT_REPLAY", approval: null, blockers: [] };
  }
  const briefResult = CampaignBriefSchema.safeParse(input.brief);
  const approverResult = CampaignApproverSchema.safeParse(input.approver);
  const blockers: string[] = [];
  if (!briefResult.success) blockers.push("CAMPAIGN_APPROVAL_BRIEF_INVALID");
  if (!approverResult.success) blockers.push("CAMPAIGN_APPROVER_INVALID");
  if (approverResult.success && !new Set(input.authorizedApproverIds).has(approverResult.data.id)) {
    blockers.push("CAMPAIGN_APPROVER_UNAUTHORIZED");
  }
  if (briefResult.success && input.scope === "EXTERNAL_SEND" && briefResult.data.transport === "NONE") {
    blockers.push("CAMPAIGN_EXTERNAL_SEND_TRANSPORT_NONE");
  }
  if (!briefResult.success || !approverResult.success || blockers.length > 0) {
    return { status: "REJECTED", approval: null, blockers: [...new Set(blockers)].sort() };
  }
  const scopeFields = input.scope === "SHADOW_PLAN"
    ? {
      scope: input.scope,
      shadowAuthorized: true,
      providerBudgetAuthorized: false,
      externalSendAuthorized: false,
      budgetHash: null,
    }
    : input.scope === "PROVIDER_BUDGET"
      ? {
        scope: input.scope,
        shadowAuthorized: false,
        providerBudgetAuthorized: true,
        externalSendAuthorized: false,
        budgetHash: campaignBudgetHash(briefResult.data),
      }
      : {
        scope: input.scope,
        shadowAuthorized: false,
        providerBudgetAuthorized: false,
        externalSendAuthorized: true,
        budgetHash: null,
      };
  const approval = CampaignApprovalSchema.parse({
    schemaVersion: CAMPAIGN_APPROVAL_SCHEMA_VERSION,
    id: input.id,
    actionId: input.actionId,
    briefId: briefResult.data.id,
    briefVersion: briefResult.data.version,
    briefHash: campaignBriefHash(briefResult.data),
    approvedBy: approverResult.data,
    approvedAt: (input.approvedAt ?? new Date()).toISOString(),
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
    ...scopeFields,
  });
  const status = input.scope === "SHADOW_PLAN"
    ? "PLAN_APPROVED"
    : input.scope === "PROVIDER_BUDGET"
      ? "BUDGET_APPROVED"
      : "READY_FOR_SEND_EXPERIMENT";
  return { status, approval, blockers: [] };
}

export interface CampaignApprovalValidationResult {
  valid: boolean;
  approval: CampaignApproval | null;
  blockers: string[];
}

export function validateCampaignApproval(input: {
  approval: unknown;
  currentBrief: unknown;
}): CampaignApprovalValidationResult {
  const approvalResult = CampaignApprovalSchema.safeParse(input.approval);
  const briefResult = CampaignBriefSchema.safeParse(input.currentBrief);
  const blockers: string[] = [];
  if (!approvalResult.success) blockers.push("CAMPAIGN_APPROVAL_SCHEMA_INVALID");
  if (!briefResult.success) blockers.push("CAMPAIGN_APPROVAL_CURRENT_BRIEF_INVALID");
  if (!approvalResult.success || !briefResult.success) {
    return { valid: false, approval: null, blockers: [...new Set(blockers)].sort() };
  }
  const approval = approvalResult.data;
  const brief = briefResult.data;
  if (approval.briefId !== brief.id) blockers.push("CAMPAIGN_APPROVAL_BRIEF_ID_MISMATCH");
  if (approval.briefVersion !== brief.version) blockers.push("CAMPAIGN_APPROVAL_VERSION_STALE");
  if (approval.briefHash !== campaignBriefHash(brief)) blockers.push("CAMPAIGN_APPROVAL_HASH_STALE");
  if (approval.scope === "PROVIDER_BUDGET" && approval.budgetHash !== campaignBudgetHash(brief)) {
    blockers.push("CAMPAIGN_APPROVAL_BUDGET_STALE");
  }
  if (approval.scope === "EXTERNAL_SEND" && brief.transport === "NONE") {
    blockers.push("CAMPAIGN_EXTERNAL_SEND_TRANSPORT_NONE");
  }
  return { valid: blockers.length === 0, approval, blockers: [...new Set(blockers)].sort() };
}
