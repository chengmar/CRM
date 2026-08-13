import { createHash } from "node:crypto";
import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(200);
const DateTimeSchema = z.string().datetime({ offset: true });
const HttpsUrlSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password;
}, { message: "signal source must be public HTTPS without credentials" });

export const monitoredSignalTypes = [
  "TENDER",
  "CURRENT_PROJECT",
  "SUPPLIER_REPLACEMENT",
  "PLANT_EXPANSION",
  "NEW_PLANT",
  "NEW_LINE",
  "AIR_OR_ENVIRONMENTAL_PERMIT",
  "EHS_OR_ENGINEERING_HIRING",
  "JOB_CHANGE",
  "DISTRIBUTOR_PORTFOLIO_CHANGE",
  "TRADE_SHOW_PARTICIPATION",
  "EXISTING_EQUIPMENT",
  "EPC_PROJECT_AWARD",
  "GENERAL_NEWS",
  "OPEN_TRACKING",
] as const;
export const MonitoredSignalTypeSchema = z.enum(monitoredSignalTypes);
export type MonitoredSignalType = z.infer<typeof MonitoredSignalTypeSchema>;

export const monitoringSourceKinds = [
  "OFFICIAL_WEBSITE",
  "AUTHORITY_DOCUMENT",
  "LICENSED_PROVIDER",
  "PUBLIC_WEB",
  "MEDIA",
  "DIRECTORY",
  "SEARCH_SNIPPET",
  "OPEN_TRACKING",
] as const;
export const MonitoringSourceKindSchema = z.enum(monitoringSourceKinds);
export type MonitoringSourceKind = z.infer<typeof MonitoringSourceKindSchema>;

export const ruleActions = [
  "ENQUEUE_ACCOUNT_RESEARCH",
  "REVERIFY_EMPLOYMENT",
  "REVERIFY_CONTACT_POINT",
  "CREATE_MANUAL_CALL_TASK",
  "CREATE_MANUAL_LINKEDIN_TASK",
  "CREATE_MANUAL_EMAIL_TASK",
  "NOTIFY_OWNER",
  "FREEZE_OUTREACH",
  "MOVE_TO_WATCHLIST",
] as const;
export const RuleActionSchema = z.enum(ruleActions);
export type RuleAction = z.infer<typeof RuleActionSchema>;

const SignalObservationSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  personId: IdSchema.nullable().default(null),
  signalType: MonitoredSignalTypeSchema,
  sourceUrl: HttpsUrlSchema,
  sourceKind: MonitoringSourceKindSchema,
  exactQuote: z.string().trim().min(1).max(20_000),
  publishedAt: DateTimeSchema.nullable().default(null),
  observedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  confidence: z.number().finite().min(0).max(1),
  authorityClass: z.string().trim().min(1).max(100),
  entityMatch: z.enum(["MATCHED", "AMBIGUOUS", "REJECTED"]),
  diagnosticCount: z.number().int().nonnegative().nullable().default(null),
}).strict().superRefine((signal, context) => {
  const observedAt = Date.parse(signal.observedAt);
  const expiresAt = Date.parse(signal.expiresAt);
  if (expiresAt < observedAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "signal expiry cannot precede observation",
    });
  }
  if (signal.publishedAt && Date.parse(signal.publishedAt) > observedAt) {
    context.addIssue({
      code: "custom",
      path: ["publishedAt"],
      message: "publication cannot occur after observation",
    });
  }
  if (signal.signalType === "JOB_CHANGE" && !signal.personId) {
    context.addIssue({
      code: "custom",
      path: ["personId"],
      message: "job-change signals require an exact person binding",
    });
  }
  if ((signal.signalType === "OPEN_TRACKING") !== (signal.sourceKind === "OPEN_TRACKING")) {
    context.addIssue({
      code: "custom",
      path: ["sourceKind"],
      message: "open-tracking diagnostics must be explicitly typed",
    });
  }
});
export type SignalObservation = z.infer<typeof SignalObservationSchema>;

const RuleConditionSchema = z.object({
  signalTypes: z.array(MonitoredSignalTypeSchema).min(1).max(monitoredSignalTypes.length),
  minimumConfidence: z.number().finite().min(0).max(1).default(0.5),
  allowedAuthorityClasses: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  allowedSourceKinds: z.array(MonitoringSourceKindSchema).max(monitoringSourceKinds.length).default([]),
  maximumAgeDays: z.number().int().positive().max(730).default(365),
  requirePublishedAt: z.boolean().default(false),
}).strict();

const MonitoringRuleVersionSchema = z.object({
  id: IdSchema,
  ruleKey: IdSchema,
  version: z.number().int().positive(),
  status: z.enum(["DRAFT", "SHADOW", "APPROVED", "STALE", "REVOKED"]),
  condition: RuleConditionSchema,
  actions: z.array(RuleActionSchema).min(1).max(ruleActions.length),
  owner: IdSchema,
  dueInMinutes: z.number().int().positive().max(30 * 24 * 60).default(24 * 60),
}).strict().superRefine((rule, context) => {
  if (new Set(rule.condition.signalTypes).size !== rule.condition.signalTypes.length) {
    context.addIssue({ code: "custom", path: ["condition", "signalTypes"], message: "signal types must be unique" });
  }
  if (new Set(rule.actions).size !== rule.actions.length) {
    context.addIssue({ code: "custom", path: ["actions"], message: "rule actions must be unique" });
  }
});
export type MonitoringRuleVersion = z.infer<typeof MonitoringRuleVersionSchema>;

export const salesTaskTypes = [
  "CALL",
  "LINKEDIN_REVIEW",
  "CONTACT_RESEARCH",
  "EMPLOYMENT_REVERIFY",
  "ACCOUNT_RESEARCH",
  "DRAFT_REVIEW",
  "INQUIRY_FOLLOWUP",
  "TECHNICAL_REVIEW",
  "QUOTE_FOLLOWUP",
] as const;
export type SalesTaskType = (typeof salesTaskTypes)[number];

const PendingSalesTaskSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  personId: IdSchema.nullable().default(null),
  playId: IdSchema.nullable().default(null),
  enrollmentId: IdSchema.nullable().default(null),
  taskType: z.enum(salesTaskTypes),
  status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "SNOOZED", "CANCELLED"]),
  owner: IdSchema,
  dueAt: DateTimeSchema,
}).strict();
export type PendingSalesTask = z.infer<typeof PendingSalesTaskSchema>;

const PendingOutreachSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  personId: IdSchema.nullable().default(null),
  playId: IdSchema.nullable().default(null),
  enrollmentId: IdSchema.nullable().default(null),
  status: z.enum([
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "SCHEDULED",
    "SENDING",
    "FAILED",
    "SENT",
    "DELIVERED",
    "REPLIED",
    "BOUNCED",
    "CANCELLED",
  ]),
}).strict();
export type PendingOutreach = z.infer<typeof PendingOutreachSchema>;

const MonitoringContextSchema = z.object({
  asOf: DateTimeSchema,
  accountId: IdSchema,
  playId: IdSchema.nullable().default(null),
  enrollmentId: IdSchema.nullable().default(null),
  owner: IdSchema,
  accountState: z.enum(["ACTIVE", "WATCHLIST", "EXCLUDED", "ARCHIVED"]),
  dncMatch: z.boolean(),
  existingCustomer: z.boolean(),
  activeOpportunity: z.boolean(),
  humanTakeover: z.boolean(),
  ownershipConflict: z.boolean(),
  territoryConflict: z.boolean(),
}).strict();
export type MonitoringContext = z.infer<typeof MonitoringContextSchema>;

const RuleEvaluationInputSchema = z.object({
  rule: MonitoringRuleVersionSchema,
  signals: z.array(SignalObservationSchema).min(1).max(500),
  context: MonitoringContextSchema,
  pendingTasks: z.array(PendingSalesTaskSchema).max(5_000).default([]),
  pendingOutreach: z.array(PendingOutreachSchema).max(5_000).default([]),
}).strict().superRefine((input, context) => {
  if (new Set(input.signals.map((signal) => signal.id)).size !== input.signals.length) {
    context.addIssue({ code: "custom", path: ["signals"], message: "signal IDs must be unique" });
  }
  if (input.signals.some((signal) => signal.accountId !== input.context.accountId)) {
    context.addIssue({
      code: "custom",
      path: ["signals"],
      message: "a rule run cannot mix signals from different accounts",
    });
  }
});

export const cancellationTriggers = [
  "HUMAN_REPLY",
  "P1",
  "P2",
  "REFERRAL",
  "WRONG_PERSON",
  "DNC",
  "BOUNCE",
  "EXISTING_CUSTOMER",
  "ACTIVE_OPPORTUNITY",
  "HUMAN_TAKEOVER",
  "JOB_CHANGE",
  "OWNER_CONFLICT",
  "TERRITORY_CONFLICT",
] as const;
export type CancellationTrigger = (typeof cancellationTriggers)[number];

const FollowupCancellationInputSchema = z.object({
  trigger: z.enum(cancellationTriggers),
  scope: z.enum(["ACCOUNT", "PERSON", "PLAY"]),
  accountId: IdSchema,
  personId: IdSchema.nullable().default(null),
  playId: IdSchema.nullable().default(null),
  authoritativeOwner: IdSchema.nullable().default(null),
  tasks: z.array(PendingSalesTaskSchema).max(5_000),
  outreach: z.array(PendingOutreachSchema).max(5_000),
}).strict().superRefine((input, context) => {
  if (input.scope === "PERSON" && !input.personId) {
    context.addIssue({ code: "custom", path: ["personId"], message: "person scope requires personId" });
  }
  if (input.scope === "PLAY" && !input.playId) {
    context.addIssue({ code: "custom", path: ["playId"], message: "play scope requires playId" });
  }
  if (input.trigger === "JOB_CHANGE" && input.scope !== "PERSON") {
    context.addIssue({ code: "custom", path: ["scope"], message: "job change must be person scoped" });
  }
});

export interface SalesTaskIntent {
  idempotencyKey: string;
  taskType: SalesTaskType;
  owner: string;
  dueAt: string;
  sourceSignalIds: string[];
  accountId: string;
  personId: string | null;
  playId: string | null;
  enrollmentId: string | null;
  payload: Record<string, unknown>;
  externalAction: "NONE";
}

export interface TaskCancellationIntent {
  idempotencyKey: string;
  taskId: string;
  reason: CancellationTrigger;
  externalAction: "NONE";
}

export interface OutreachControlIntent {
  idempotencyKey: string;
  outreachId: string;
  action: "FREEZE" | "CANCEL";
  reason: CancellationTrigger;
  externalAction: "NONE";
}

export interface LocalControlIntent {
  idempotencyKey: string;
  type: "NOTIFY_OWNER" | "FREEZE_OUTREACH" | "MOVE_TO_WATCHLIST" | "MARK_EMPLOYMENT_FORMER";
  accountId: string;
  personId: string | null;
  playId: string | null;
  sourceSignalIds: string[];
  payload: Record<string, unknown>;
  externalAction: "NONE";
}

export interface FollowupCancellationPlan {
  trigger: CancellationTrigger;
  taskCancellations: TaskCancellationIntent[];
  outreachControls: OutreachControlIntent[];
  retainedTaskIds: string[];
  externalActions: 0;
}

export type RuleRunDecision =
  "BLOCKED_RULE_STATUS" |
  "NO_MATCH" |
  "NO_ACTIONABLE_SIGNAL" |
  "BLOCKED_CONFLICT" |
  "MATCHED_SHADOW" |
  "LOCAL_ACTIONS_READY";

export interface SignalRuleRunPlan {
  idempotencyKey: string;
  planHash: string;
  ruleId: string;
  ruleKey: string;
  ruleVersion: number;
  accountId: string;
  playId: string | null;
  inputSignalIds: string[];
  matchedSignalIds: string[];
  decision: RuleRunDecision;
  blockers: string[];
  qualificationEffect: "NONE" | "ACTIVE_INTENT_CANDIDATE";
  actions: RuleAction[];
  taskIntents: SalesTaskIntent[];
  taskCancellations: TaskCancellationIntent[];
  outreachControls: OutreachControlIntent[];
  localControls: LocalControlIntent[];
  commitLocalEffects: boolean;
  safety: {
    externalCalls: 0;
    paidCalls: 0;
    externalWrites: 0;
    messagesSent: 0;
    qualificationMutations: 0;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function uniqueByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

const coldFollowupTaskTypes = new Set<SalesTaskType>([
  "CALL",
  "LINKEDIN_REVIEW",
  "CONTACT_RESEARCH",
  "EMPLOYMENT_REVERIFY",
  "ACCOUNT_RESEARCH",
  "DRAFT_REVIEW",
]);
const jobChangeTaskTypes = new Set<SalesTaskType>(["CALL", "LINKEDIN_REVIEW", "DRAFT_REVIEW"]);
const pendingTaskStatuses = new Set<PendingSalesTask["status"]>(["OPEN", "IN_PROGRESS", "SNOOZED"]);
const pendingOutreachStatuses = new Set<PendingOutreach["status"]>([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "SENDING",
  "FAILED",
]);

function scopeMatches(
  item: { accountId: string; personId: string | null; playId: string | null },
  input: z.infer<typeof FollowupCancellationInputSchema>,
): boolean {
  if (item.accountId !== input.accountId) return false;
  if (input.scope === "PERSON") return item.personId === input.personId;
  if (input.scope === "PLAY") return item.playId === input.playId;
  return true;
}

export function planConflictingFollowupCancellation(rawInput: unknown): FollowupCancellationPlan {
  const input = FollowupCancellationInputSchema.parse(rawInput);
  const taskTypes = input.trigger === "JOB_CHANGE" || input.trigger === "WRONG_PERSON" || input.trigger === "REFERRAL"
    ? jobChangeTaskTypes
    : coldFollowupTaskTypes;
  const taskCancellations: TaskCancellationIntent[] = [];
  const retainedTaskIds: string[] = [];
  for (const task of input.tasks) {
    const wrongOwner = input.trigger === "OWNER_CONFLICT" || input.trigger === "TERRITORY_CONFLICT"
      ? !input.authoritativeOwner || task.owner !== input.authoritativeOwner
      : true;
    if (scopeMatches(task, input) && pendingTaskStatuses.has(task.status) &&
      taskTypes.has(task.taskType) && wrongOwner) {
      taskCancellations.push({
        idempotencyKey: stableHash({ type: "CANCEL_SALES_TASK", taskId: task.id, trigger: input.trigger }),
        taskId: task.id,
        reason: input.trigger,
        externalAction: "NONE",
      });
    } else {
      retainedTaskIds.push(task.id);
    }
  }

  const outreachControls: OutreachControlIntent[] = [];
  for (const outreach of input.outreach) {
    if (!scopeMatches(outreach, input) || !pendingOutreachStatuses.has(outreach.status)) continue;
    const action = input.trigger === "JOB_CHANGE" || input.trigger === "OWNER_CONFLICT" ||
      input.trigger === "TERRITORY_CONFLICT" ? "FREEZE" : "CANCEL";
    outreachControls.push({
      idempotencyKey: stableHash({ type: action, outreachId: outreach.id, trigger: input.trigger }),
      outreachId: outreach.id,
      action,
      reason: input.trigger,
      externalAction: "NONE",
    });
  }

  return {
    trigger: input.trigger,
    taskCancellations: taskCancellations.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    outreachControls: outreachControls.sort((left, right) => left.outreachId.localeCompare(right.outreachId)),
    retainedTaskIds: retainedTaskIds.sort(),
    externalActions: 0,
  };
}

const strongActiveIntentSignals = new Set<MonitoredSignalType>([
  "TENDER",
  "CURRENT_PROJECT",
  "SUPPLIER_REPLACEMENT",
  "PLANT_EXPANSION",
  "NEW_PLANT",
  "NEW_LINE",
  "AIR_OR_ENVIRONMENTAL_PERMIT",
  "EPC_PROJECT_AWARD",
]);
const directActiveIntentSources = new Set<MonitoringSourceKind>(["OFFICIAL_WEBSITE", "AUTHORITY_DOCUMENT"]);

function signalBlockers(signal: SignalObservation, rule: MonitoringRuleVersion, asOfMs: number): string[] {
  const blockers: string[] = [];
  const observedAt = Date.parse(signal.observedAt);
  const publishedAt = signal.publishedAt ? Date.parse(signal.publishedAt) : null;
  const basis = publishedAt ?? observedAt;
  const maximumAgeMs = rule.condition.maximumAgeDays * 86_400_000;
  if (!rule.condition.signalTypes.includes(signal.signalType)) blockers.push("SIGNAL_TYPE_NOT_MATCHED");
  if (signal.confidence < rule.condition.minimumConfidence) blockers.push("SIGNAL_CONFIDENCE_LOW");
  if (signal.entityMatch !== "MATCHED") blockers.push("SIGNAL_ENTITY_NOT_MATCHED");
  if (observedAt > asOfMs || (publishedAt !== null && publishedAt > asOfMs)) blockers.push("SIGNAL_FROM_FUTURE");
  if (Date.parse(signal.expiresAt) < asOfMs || asOfMs - basis > maximumAgeMs) blockers.push("SIGNAL_EXPIRED");
  if (rule.condition.requirePublishedAt && publishedAt === null) blockers.push("SIGNAL_PUBLICATION_DATE_REQUIRED");
  if (rule.condition.allowedAuthorityClasses.length > 0 &&
    !rule.condition.allowedAuthorityClasses.includes(signal.authorityClass)) {
    blockers.push("SIGNAL_AUTHORITY_NOT_ALLOWED");
  }
  if (rule.condition.allowedSourceKinds.length > 0 &&
    !rule.condition.allowedSourceKinds.includes(signal.sourceKind)) {
    blockers.push("SIGNAL_SOURCE_NOT_ALLOWED");
  }
  if (signal.signalType === "OPEN_TRACKING" || signal.sourceKind === "OPEN_TRACKING") {
    blockers.push("OPEN_TRACKING_DIAGNOSTIC_ONLY");
  }
  return [...new Set(blockers)].sort();
}

function taskTypeForAction(action: RuleAction): SalesTaskType | null {
  switch (action) {
    case "ENQUEUE_ACCOUNT_RESEARCH": return "ACCOUNT_RESEARCH";
    case "REVERIFY_EMPLOYMENT": return "EMPLOYMENT_REVERIFY";
    case "REVERIFY_CONTACT_POINT": return "CONTACT_RESEARCH";
    case "CREATE_MANUAL_CALL_TASK": return "CALL";
    case "CREATE_MANUAL_LINKEDIN_TASK": return "LINKEDIN_REVIEW";
    case "CREATE_MANUAL_EMAIL_TASK": return "DRAFT_REVIEW";
    default: return null;
  }
}

function makeTaskIntent(input: {
  runKey: string;
  action: RuleAction | "JOB_CHANGE_SAFEGUARD";
  taskType: SalesTaskType;
  rule: MonitoringRuleVersion;
  context: MonitoringContext;
  personId: string | null;
  sourceSignalIds: string[];
}): SalesTaskIntent {
  const dueAt = new Date(Date.parse(input.context.asOf) + input.rule.dueInMinutes * 60_000).toISOString();
  return {
    idempotencyKey: stableHash({
      runKey: input.runKey,
      action: input.action,
      taskType: input.taskType,
      accountId: input.context.accountId,
      personId: input.personId,
      playId: input.context.playId,
    }),
    taskType: input.taskType,
    owner: input.context.owner,
    dueAt,
    sourceSignalIds: [...input.sourceSignalIds].sort(),
    accountId: input.context.accountId,
    personId: input.personId,
    playId: input.context.playId,
    enrollmentId: input.context.enrollmentId,
    payload: {
      ruleId: input.rule.id,
      ruleKey: input.rule.ruleKey,
      ruleVersion: input.rule.version,
      action: input.action,
      sourceSignalIds: [...input.sourceSignalIds].sort(),
      automatedChannelAction: false,
    },
    externalAction: "NONE",
  };
}

function makeLocalControl(input: {
  runKey: string;
  type: LocalControlIntent["type"];
  context: MonitoringContext;
  personId: string | null;
  sourceSignalIds: string[];
  payload?: Record<string, unknown>;
}): LocalControlIntent {
  return {
    idempotencyKey: stableHash({
      runKey: input.runKey,
      type: input.type,
      accountId: input.context.accountId,
      personId: input.personId,
      playId: input.context.playId,
    }),
    type: input.type,
    accountId: input.context.accountId,
    personId: input.personId,
    playId: input.context.playId,
    sourceSignalIds: [...input.sourceSignalIds].sort(),
    payload: input.payload ?? {},
    externalAction: "NONE",
  };
}

function conflictBlockers(context: MonitoringContext): string[] {
  const blockers: string[] = [];
  if (context.dncMatch) blockers.push("DNC_MATCH");
  if (context.existingCustomer) blockers.push("EXISTING_CUSTOMER");
  if (context.activeOpportunity) blockers.push("ACTIVE_OPPORTUNITY");
  if (context.humanTakeover) blockers.push("HUMAN_TAKEOVER");
  if (context.ownershipConflict) blockers.push("OWNER_CONFLICT");
  if (context.territoryConflict) blockers.push("TERRITORY_CONFLICT");
  if (context.accountState === "EXCLUDED") blockers.push("ACCOUNT_EXCLUDED");
  if (context.accountState === "ARCHIVED") blockers.push("ACCOUNT_ARCHIVED");
  return blockers;
}

function cancellationTriggerForContext(context: MonitoringContext): CancellationTrigger | null {
  if (context.dncMatch) return "DNC";
  if (context.existingCustomer) return "EXISTING_CUSTOMER";
  if (context.activeOpportunity) return "ACTIVE_OPPORTUNITY";
  if (context.humanTakeover) return "HUMAN_TAKEOVER";
  if (context.ownershipConflict) return "OWNER_CONFLICT";
  if (context.territoryConflict) return "TERRITORY_CONFLICT";
  return null;
}

function finishPlan(plan: Omit<SignalRuleRunPlan, "planHash">): SignalRuleRunPlan {
  return { ...plan, planHash: stableHash(plan) };
}

export function evaluateSignalRuleRun(rawInput: unknown): SignalRuleRunPlan {
  const input = RuleEvaluationInputSchema.parse(rawInput);
  const inputSignalIds = input.signals.map((signal) => signal.id).sort();
  const runKey = stableHash({
    type: "SIGNAL_RULE_RUN",
    ruleId: input.rule.id,
    ruleVersion: input.rule.version,
    accountId: input.context.accountId,
    playId: input.context.playId,
    inputSignalIds,
  });
  const safety = {
    externalCalls: 0 as const,
    paidCalls: 0 as const,
    externalWrites: 0 as const,
    messagesSent: 0 as const,
    qualificationMutations: 0 as const,
  };
  const base = {
    idempotencyKey: runKey,
    ruleId: input.rule.id,
    ruleKey: input.rule.ruleKey,
    ruleVersion: input.rule.version,
    accountId: input.context.accountId,
    playId: input.context.playId,
    inputSignalIds,
    safety,
  };

  if (["DRAFT", "STALE", "REVOKED"].includes(input.rule.status)) {
    return finishPlan({
      ...base,
      matchedSignalIds: [],
      decision: "BLOCKED_RULE_STATUS",
      blockers: [`RULE_STATUS_${input.rule.status}`],
      qualificationEffect: "NONE",
      actions: [],
      taskIntents: [],
      taskCancellations: [],
      outreachControls: [],
      localControls: [],
      commitLocalEffects: false,
    });
  }

  const asOfMs = Date.parse(input.context.asOf);
  const relevant = input.signals
    .filter((signal) => input.rule.condition.signalTypes.includes(signal.signalType))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (relevant.length === 0) {
    return finishPlan({
      ...base,
      matchedSignalIds: [],
      decision: "NO_MATCH",
      blockers: ["NO_SIGNAL_TYPE_MATCH"],
      qualificationEffect: "NONE",
      actions: [],
      taskIntents: [],
      taskCancellations: [],
      outreachControls: [],
      localControls: [],
      commitLocalEffects: input.rule.status === "APPROVED",
    });
  }

  const blockersBySignal = new Map(relevant.map((signal) => [signal.id, signalBlockers(signal, input.rule, asOfMs)]));
  const matched = relevant.filter((signal) => blockersBySignal.get(signal.id)?.length === 0);
  const matchedSignalIds = matched.map((signal) => signal.id).sort();
  if (matched.length === 0) {
    return finishPlan({
      ...base,
      matchedSignalIds,
      decision: "NO_ACTIONABLE_SIGNAL",
      blockers: [...new Set([...blockersBySignal.values()].flat())].sort(),
      qualificationEffect: "NONE",
      actions: [],
      taskIntents: [],
      taskCancellations: [],
      outreachControls: [],
      localControls: [],
      commitLocalEffects: input.rule.status === "APPROVED",
    });
  }

  const conflicts = conflictBlockers(input.context);
  if (conflicts.length > 0) {
    const trigger = cancellationTriggerForContext(input.context);
    const cancellation = trigger ? planConflictingFollowupCancellation({
      trigger,
      scope: "ACCOUNT",
      accountId: input.context.accountId,
      personId: null,
      playId: input.context.playId,
      authoritativeOwner: trigger === "OWNER_CONFLICT" || trigger === "TERRITORY_CONFLICT"
        ? input.context.owner
        : null,
      tasks: input.pendingTasks,
      outreach: input.pendingOutreach,
    }) : null;
    return finishPlan({
      ...base,
      matchedSignalIds,
      decision: "BLOCKED_CONFLICT",
      blockers: conflicts.sort(),
      qualificationEffect: "NONE",
      actions: [],
      taskIntents: [],
      taskCancellations: cancellation?.taskCancellations ?? [],
      outreachControls: cancellation?.outreachControls ?? [],
      localControls: [],
      commitLocalEffects: input.rule.status === "APPROVED",
    });
  }

  const primaryPersonId = matched.find((signal) => signal.personId)?.personId ?? null;
  const taskIntents: SalesTaskIntent[] = [];
  const localControls: LocalControlIntent[] = [];
  const taskCancellations: TaskCancellationIntent[] = [];
  const outreachControls: OutreachControlIntent[] = [];
  for (const action of input.rule.actions) {
    const taskType = taskTypeForAction(action);
    if (taskType) {
      taskIntents.push(makeTaskIntent({
        runKey,
        action,
        taskType,
        rule: input.rule,
        context: input.context,
        personId: taskType === "ACCOUNT_RESEARCH" ? null : primaryPersonId,
        sourceSignalIds: matchedSignalIds,
      }));
    } else if (action === "NOTIFY_OWNER") {
      localControls.push(makeLocalControl({
        runKey,
        type: "NOTIFY_OWNER",
        context: input.context,
        personId: primaryPersonId,
        sourceSignalIds: matchedSignalIds,
        payload: { delivery: "LOCAL_OUTBOX_ONLY", owner: input.context.owner },
      }));
    } else if (action === "FREEZE_OUTREACH") {
      localControls.push(makeLocalControl({
        runKey,
        type: "FREEZE_OUTREACH",
        context: input.context,
        personId: primaryPersonId,
        sourceSignalIds: matchedSignalIds,
        payload: { pendingOnly: true },
      }));
    } else if (action === "MOVE_TO_WATCHLIST") {
      localControls.push(makeLocalControl({
        runKey,
        type: "MOVE_TO_WATCHLIST",
        context: input.context,
        personId: null,
        sourceSignalIds: matchedSignalIds,
        payload: { automaticQualificationChange: false },
      }));
    }
  }

  const jobChangesByPerson = new Map<string, string[]>();
  for (const jobChange of matched.filter((signal) => signal.signalType === "JOB_CHANGE")) {
    if (!jobChange.personId) continue;
    const signalIds = jobChangesByPerson.get(jobChange.personId) ?? [];
    signalIds.push(jobChange.id);
    jobChangesByPerson.set(jobChange.personId, signalIds);
  }
  for (const [personId, jobChangeSignalIds] of [...jobChangesByPerson.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const sourceSignalIds = [...jobChangeSignalIds].sort();
    taskIntents.push(makeTaskIntent({
      runKey,
      action: "JOB_CHANGE_SAFEGUARD",
      taskType: "EMPLOYMENT_REVERIFY",
      rule: input.rule,
      context: input.context,
      personId,
      sourceSignalIds,
    }));
    localControls.push(makeLocalControl({
      runKey,
      type: "MARK_EMPLOYMENT_FORMER",
      context: input.context,
      personId,
      sourceSignalIds,
      payload: {
        priorEmploymentStatus: "FORMER",
        newEmployerAssignment: "NONE",
        emailMutation: "NONE",
        reason: "JOB_CHANGE_REQUIRES_HUMAN_RESEARCH",
      },
    }));
    localControls.push(makeLocalControl({
      runKey,
      type: "FREEZE_OUTREACH",
      context: input.context,
      personId,
      sourceSignalIds,
      payload: { pendingOnly: true, reason: "JOB_CHANGE" },
    }));
    const cancellation = planConflictingFollowupCancellation({
      trigger: "JOB_CHANGE",
      scope: "PERSON",
      accountId: input.context.accountId,
      personId,
      playId: input.context.playId,
      authoritativeOwner: input.context.owner,
      tasks: input.pendingTasks,
      outreach: input.pendingOutreach,
    });
    taskCancellations.push(...cancellation.taskCancellations);
    outreachControls.push(...cancellation.outreachControls);
  }

  const qualificationEffect = matched.some((signal) =>
    strongActiveIntentSignals.has(signal.signalType) &&
    directActiveIntentSources.has(signal.sourceKind) &&
    /^(?:T1_|T2_)|^(?:ACCOUNT_OFFICIAL|GOVERNMENT|REGULATOR|PROJECT_OWNER)$/.test(signal.authorityClass))
    ? "ACTIVE_INTENT_CANDIDATE"
    : "NONE";
  const shadow = input.rule.status === "SHADOW";
  return finishPlan({
    ...base,
    matchedSignalIds,
    decision: shadow ? "MATCHED_SHADOW" : "LOCAL_ACTIONS_READY",
    blockers: [],
    qualificationEffect,
    actions: [...input.rule.actions],
    taskIntents: uniqueByKey(
      taskIntents,
      (intent) => [intent.taskType, intent.accountId, intent.personId ?? "", intent.playId ?? ""].join("\0"),
    ),
    taskCancellations: uniqueByKey(taskCancellations, (intent) => intent.idempotencyKey),
    outreachControls: uniqueByKey(outreachControls, (intent) => intent.idempotencyKey),
    localControls: uniqueByKey(localControls, (intent) => intent.idempotencyKey),
    commitLocalEffects: !shadow,
  });
}

export interface StoredSignalRuleRun {
  idempotencyKey: string;
  planHash: string;
}

export interface SignalRuleLedger {
  transaction<T>(operation: () => T): T;
  getRuleRun(idempotencyKey: string): StoredSignalRuleRun | null;
  recordRuleRun(plan: SignalRuleRunPlan): void;
  upsertSalesTask(intent: SalesTaskIntent): boolean;
  cancelSalesTask(intent: TaskCancellationIntent): boolean;
  applyOutreachControl(intent: OutreachControlIntent): boolean;
  recordLocalControl(intent: LocalControlIntent): boolean;
}

export interface SignalRuleExecutionResult {
  created: boolean;
  tasksCreated: number;
  tasksCancelled: number;
  outreachControlled: number;
  localControlsRecorded: number;
  externalActions: 0;
}

export function executeSignalRulePlan(
  ledger: SignalRuleLedger,
  plan: SignalRuleRunPlan,
): SignalRuleExecutionResult {
  const { planHash, ...planContent } = plan;
  if (stableHash(planContent) !== planHash) {
    throw new Error("Rule-run plan hash does not match its immutable content");
  }
  return ledger.transaction(() => {
    const existing = ledger.getRuleRun(plan.idempotencyKey);
    if (existing) {
      if (existing.planHash !== plan.planHash) {
        throw new Error("Rule-run idempotency key was reused with a different plan");
      }
      return {
        created: false,
        tasksCreated: 0,
        tasksCancelled: 0,
        outreachControlled: 0,
        localControlsRecorded: 0,
        externalActions: 0,
      };
    }
    let tasksCreated = 0;
    let tasksCancelled = 0;
    let outreachControlled = 0;
    let localControlsRecorded = 0;
    if (plan.commitLocalEffects) {
      for (const intent of plan.taskIntents) tasksCreated += ledger.upsertSalesTask(intent) ? 1 : 0;
      for (const intent of plan.taskCancellations) tasksCancelled += ledger.cancelSalesTask(intent) ? 1 : 0;
      for (const intent of plan.outreachControls) outreachControlled += ledger.applyOutreachControl(intent) ? 1 : 0;
      for (const intent of plan.localControls) localControlsRecorded += ledger.recordLocalControl(intent) ? 1 : 0;
    }
    ledger.recordRuleRun(plan);
    return {
      created: true,
      tasksCreated,
      tasksCancelled,
      outreachControlled,
      localControlsRecorded,
      externalActions: 0,
    };
  });
}

const MonitoringSubscriptionSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  playId: IdSchema.nullable().default(null),
  status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]),
  signalTypes: z.array(MonitoredSignalTypeSchema).min(1).max(monitoredSignalTypes.length),
  cadenceMinutes: z.number().int().min(15).max(30 * 24 * 60),
  nextRunAt: DateTimeSchema,
  sourceMode: z.literal("LOCAL_INGESTION_ONLY"),
}).strict();

export interface MonitoringRunIntent {
  idempotencyKey: string;
  subscriptionId: string;
  accountId: string;
  playId: string | null;
  scheduledFor: string;
  signalTypes: MonitoredSignalType[];
  status: "AWAITING_LOCAL_OBSERVATIONS";
  sourceMode: "LOCAL_INGESTION_ONLY";
  externalCalls: 0;
  paidCalls: 0;
  externalWrites: 0;
}

export function planMonitoringCycle(rawInput: unknown): {
  asOf: string;
  runIntents: MonitoringRunIntent[];
  skippedSubscriptionIds: string[];
  safety: { externalCalls: 0; paidCalls: 0; externalWrites: 0 };
} {
  const input = z.object({
    asOf: DateTimeSchema,
    subscriptions: z.array(MonitoringSubscriptionSchema).max(10_000),
  }).strict().parse(rawInput);
  const asOfMs = Date.parse(input.asOf);
  const runIntents: MonitoringRunIntent[] = [];
  const skippedSubscriptionIds: string[] = [];
  for (const subscription of input.subscriptions) {
    if (subscription.status !== "ACTIVE" || Date.parse(subscription.nextRunAt) > asOfMs) {
      skippedSubscriptionIds.push(subscription.id);
      continue;
    }
    runIntents.push({
      idempotencyKey: stableHash({
        type: "MONITORING_RUN",
        subscriptionId: subscription.id,
        scheduledFor: subscription.nextRunAt,
      }),
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
      playId: subscription.playId,
      scheduledFor: subscription.nextRunAt,
      signalTypes: [...subscription.signalTypes].sort() as MonitoredSignalType[],
      status: "AWAITING_LOCAL_OBSERVATIONS",
      sourceMode: "LOCAL_INGESTION_ONLY",
      externalCalls: 0,
      paidCalls: 0,
      externalWrites: 0,
    });
  }
  return {
    asOf: input.asOf,
    runIntents: runIntents.sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId)),
    skippedSubscriptionIds: skippedSubscriptionIds.sort(),
    safety: { externalCalls: 0, paidCalls: 0, externalWrites: 0 },
  };
}

export interface SignalMonitoringShadowReport {
  fixtureSet: "signal-monitoring-shadow-v1";
  accounts: 50;
  signals: 100;
  jobChangeSignals: 50;
  entityMatchedSignals: number;
  replayStableRuns: number;
  duplicateTaskKeys: number;
  unsafeRuleActions: number;
  actionValueRate: null;
  safety: { externalCalls: 0; paidCalls: 0; externalWrites: 0; messagesSent: 0 };
  verdict: "HOLD";
  reason: string;
}

export function runSignalMonitoringShadow(): SignalMonitoringShadowReport {
  const asOf = "2026-07-20T00:00:00.000Z";
  const rule = {
    id: "rulev-shadow-signals",
    ruleKey: "watchlist-signal-review",
    version: 1,
    status: "SHADOW",
    condition: {
      signalTypes: ["PLANT_EXPANSION", "JOB_CHANGE"],
      minimumConfidence: 0.75,
      allowedAuthorityClasses: ["T1_COMPANY_OFFICIAL", "LICENSED_B2B_PROVIDER"],
      allowedSourceKinds: ["OFFICIAL_WEBSITE", "LICENSED_PROVIDER"],
      maximumAgeDays: 365,
      requirePublishedAt: false,
    },
    actions: ["ENQUEUE_ACCOUNT_RESEARCH", "NOTIFY_OWNER"],
    owner: "shadow-sales-owner",
    dueInMinutes: 1_440,
  } as const;
  const plans: SignalRuleRunPlan[] = [];
  const replays: SignalRuleRunPlan[] = [];
  let entityMatchedSignals = 0;
  for (let accountIndex = 0; accountIndex < 50; accountIndex += 1) {
    const signals = [0, 1].map((offset) => {
      const fixtureIndex = accountIndex * 2 + offset;
      const jobChange = offset === 1;
      const entityMatch = fixtureIndex < 95 ? "MATCHED" : "AMBIGUOUS";
      if (entityMatch === "MATCHED") entityMatchedSignals += 1;
      return {
        id: `signal-${fixtureIndex}`,
        accountId: `account-${accountIndex}`,
        personId: jobChange ? `person-${accountIndex}` : null,
        signalType: jobChange ? "JOB_CHANGE" : "PLANT_EXPANSION",
        sourceUrl: jobChange
          ? `https://provider.fixture.invalid/employment/${fixtureIndex}`
          : `https://account-${accountIndex}.fixture.invalid/news/expansion`,
        sourceKind: jobChange ? "LICENSED_PROVIDER" : "OFFICIAL_WEBSITE",
        exactQuote: jobChange
          ? "The provider assertion no longer identifies this person as a current employee."
          : "The company announced an additional production line.",
        publishedAt: jobChange ? null : "2026-07-01T00:00:00.000Z",
        observedAt: "2026-07-19T00:00:00.000Z",
        expiresAt: "2026-10-19T00:00:00.000Z",
        confidence: 0.9,
        authorityClass: jobChange ? "LICENSED_B2B_PROVIDER" : "T1_COMPANY_OFFICIAL",
        entityMatch,
        diagnosticCount: null,
      };
    });
    const input = {
      rule,
      signals,
      context: {
        asOf,
        accountId: `account-${accountIndex}`,
        playId: "play-shadow",
        enrollmentId: `enrollment-${accountIndex}`,
        owner: "shadow-sales-owner",
        accountState: "WATCHLIST",
        dncMatch: false,
        existingCustomer: false,
        activeOpportunity: false,
        humanTakeover: false,
        ownershipConflict: false,
        territoryConflict: false,
      },
      pendingTasks: [],
      pendingOutreach: [],
    };
    plans.push(evaluateSignalRuleRun(input));
    replays.push(evaluateSignalRuleRun(input));
  }
  const taskKeys = plans.flatMap((plan) => plan.taskIntents.map((intent) => intent.idempotencyKey));
  return {
    fixtureSet: "signal-monitoring-shadow-v1",
    accounts: 50,
    signals: 100,
    jobChangeSignals: 50,
    entityMatchedSignals,
    replayStableRuns: plans.filter((plan, index) => {
      const replay = replays[index];
      return replay?.idempotencyKey === plan.idempotencyKey && replay.planHash === plan.planHash;
    }).length,
    duplicateTaskKeys: taskKeys.length - new Set(taskKeys).size,
    unsafeRuleActions: plans.flatMap((plan) => plan.actions)
      .filter((action) => !ruleActions.includes(action)).length,
    actionValueRate: null,
    safety: { externalCalls: 0, paidCalls: 0, externalWrites: 0, messagesSent: 0 },
    verdict: "HOLD",
    reason: "Synthetic fixtures prove deterministic safety only; 30-day human task value and downstream inquiry lift are not yet measured.",
  };
}
