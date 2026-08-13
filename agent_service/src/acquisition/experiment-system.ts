import { createHash } from "node:crypto";
import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(200);

export const EnrichmentStepSchema = z.object({
  id: IdSchema,
  provider: IdSchema,
  purpose: z.enum(["ACCOUNT", "CONTACT", "EMAIL_FIND", "EMAIL_VERIFY"]),
  estimatedCostMicros: z.number().int().nonnegative(),
  prerequisites: z.array(IdSchema).max(100),
  stopConditions: z.array(IdSchema).max(100),
}).strict();

export type EnrichmentStep = z.infer<typeof EnrichmentStepSchema>;

export interface WaterfallStepResult {
  stepId: string;
  status: "CALLED" | "SKIPPED_PREREQUISITE" | "SKIPPED_STOP_CONDITION" | "SKIPPED_BUDGET";
  estimatedCostMicros: number;
}

export async function executeEnrichmentWaterfall(input: {
  steps: readonly unknown[];
  initialFacts: readonly string[];
  budgetMicros: number;
  execute: (step: EnrichmentStep) => Promise<{ factsAdded?: string[]; stopConditions?: string[] }>;
}): Promise<{ results: WaterfallStepResult[]; facts: string[]; spentMicros: number }> {
  const steps = z.array(EnrichmentStepSchema).min(1).max(100).parse(input.steps);
  const facts = new Set(input.initialFacts);
  const stops = new Set<string>();
  const results: WaterfallStepResult[] = [];
  let spentMicros = 0;
  for (const step of steps) {
    if (step.prerequisites.some((item) => !facts.has(item))) {
      results.push({ stepId: step.id, status: "SKIPPED_PREREQUISITE", estimatedCostMicros: 0 });
      continue;
    }
    if (step.stopConditions.some((item) => stops.has(item))) {
      results.push({ stepId: step.id, status: "SKIPPED_STOP_CONDITION", estimatedCostMicros: 0 });
      continue;
    }
    if (spentMicros + step.estimatedCostMicros > input.budgetMicros) {
      results.push({ stepId: step.id, status: "SKIPPED_BUDGET", estimatedCostMicros: 0 });
      continue;
    }
    spentMicros += step.estimatedCostMicros;
    const outcome = await input.execute(step);
    for (const fact of outcome.factsAdded ?? []) facts.add(fact);
    for (const stop of outcome.stopConditions ?? []) stops.add(stop);
    results.push({ stepId: step.id, status: "CALLED", estimatedCostMicros: step.estimatedCostMicros });
  }
  return { results, facts: [...facts].sort(), spentMicros };
}

export const ExperimentDefinitionSchema = z.object({
  experimentId: IdSchema,
  version: z.number().int().positive(),
  primaryVariable: z.enum(["QUALIFICATION_TRACK", "OFFER", "MESSAGE_ANGLE", "PROVIDER", "SEQUENCE_LENGTH"]),
  arms: z.array(z.object({
    id: IdSchema,
    variable: z.enum(["QUALIFICATION_TRACK", "OFFER", "MESSAGE_ANGLE", "PROVIDER", "SEQUENCE_LENGTH"]),
    value: z.union([z.string().trim().min(1).max(500), z.number().finite()]),
    weight: z.number().positive(),
  }).strict()).min(2).max(10),
  shadowOnly: z.literal(true),
  externalSendAuthorized: z.literal(false),
}).strict().superRefine((definition, context) => {
  if (definition.arms.some((arm) => arm.variable !== definition.primaryVariable)) {
    context.addIssue({ code: "custom", path: ["arms"], message: "an experiment may vary only its primary variable" });
  }
  if (new Set(definition.arms.map((arm) => arm.id)).size !== definition.arms.length) {
    context.addIssue({ code: "custom", path: ["arms"], message: "arm IDs must be unique" });
  }
});

export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;

export function assignExperimentArm(input: {
  definition: unknown;
  accountId: string;
  assignmentSalt: string;
}): { armId: string; assignmentHash: string } {
  const definition = ExperimentDefinitionSchema.parse(input.definition);
  const accountId = IdSchema.parse(input.accountId);
  const salt = IdSchema.parse(input.assignmentSalt);
  const assignmentHash = createHash("sha256")
    .update(`${definition.experimentId}\0${definition.version}\0${accountId}\0${salt}`)
    .digest("hex");
  const bucket = Number.parseInt(assignmentHash.slice(0, 13), 16) / 0x1fffffffffffff;
  const totalWeight = definition.arms.reduce((sum, arm) => sum + arm.weight, 0);
  let cumulative = 0;
  for (const arm of definition.arms) {
    cumulative += arm.weight / totalWeight;
    if (bucket < cumulative) return { armId: arm.id, assignmentHash };
  }
  return { armId: definition.arms.at(-1)!.id, assignmentHash };
}

export const SequenceMessageEvidenceSchema = z.object({
  sequenceIndex: z.number().int().min(0).max(2),
  factIds: z.array(IdSchema).max(20),
  offerId: IdSchema.nullable(),
  question: z.string().trim().min(1).max(500).nullable(),
}).strict();

export function validateSequenceInformationGain(input: unknown): {
  valid: boolean;
  blockers: string[];
} {
  const parsed = z.array(SequenceMessageEvidenceSchema).min(1).max(3).safeParse(input);
  if (!parsed.success) {
    return { valid: false, blockers: parsed.error.issues.map((issue) =>
      `SEQUENCE_SCHEMA_INVALID:${issue.path.join(".")}:${issue.message}`) };
  }
  const messages = [...parsed.data].sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  const blockers: string[] = [];
  if (messages.some((message, index) => message.sequenceIndex !== index)) blockers.push("SEQUENCE_INDEX_GAP");
  const seenFacts = new Set<string>();
  const seenOffers = new Set<string>();
  const seenQuestions = new Set<string>();
  for (const message of messages) {
    const newFacts = message.factIds.filter((fact) => !seenFacts.has(fact));
    const newOffer = Boolean(message.offerId && !seenOffers.has(message.offerId));
    const normalizedQuestion = message.question?.toLowerCase() ?? null;
    const newQuestion = Boolean(normalizedQuestion && !seenQuestions.has(normalizedQuestion));
    if (message.sequenceIndex > 0 && newFacts.length === 0 && !newOffer && !newQuestion) {
      blockers.push(`SEQUENCE_NO_INFORMATION_GAIN:${message.sequenceIndex}`);
    }
    message.factIds.forEach((fact) => seenFacts.add(fact));
    if (message.offerId) seenOffers.add(message.offerId);
    if (normalizedQuestion) seenQuestions.add(normalizedQuestion);
  }
  return { valid: blockers.length === 0, blockers };
}

export async function runExperimentSystemShadow(): Promise<{
  fixtureSet: "experiment-system-shadow-v1";
  assignments: number;
  stableReassignments: number;
  waterfallProviderCalls: number;
  expensiveCallsAfterFailedPrerequisite: number;
  sequenceValid: boolean;
  safety: { externalSends: 0; paidCalls: 0; externalWrites: 0 };
  verdict: "HOLD";
}> {
  const definition = {
    experimentId: "experiment-offer-shadow",
    version: 1,
    primaryVariable: "OFFER",
    arms: [
      { id: "checklist", variable: "OFFER", value: "RFQ checklist", weight: 1 },
      { id: "application-guide", variable: "OFFER", value: "Application guide", weight: 1 },
    ],
    shadowOnly: true,
    externalSendAuthorized: false,
  };
  const first = Array.from({ length: 100 }, (_, index) =>
    assignExperimentArm({ definition, accountId: `account-${index}`, assignmentSalt: "fixture-salt" }));
  const replay = Array.from({ length: 100 }, (_, index) =>
    assignExperimentArm({ definition, accountId: `account-${index}`, assignmentSalt: "fixture-salt" }));
  let waterfallProviderCalls = 0;
  const waterfall = await executeEnrichmentWaterfall({
    steps: [
      { id: "free-account", provider: "LOCAL", purpose: "ACCOUNT", estimatedCostMicros: 0, prerequisites: [], stopConditions: [] },
      { id: "paid-contact", provider: "APOLLO", purpose: "CONTACT", estimatedCostMicros: 1_000_000, prerequisites: ["ACCOUNT_QUALIFIED"], stopConditions: ["ACCOUNT_NOT_ICP"] },
      { id: "paid-email", provider: "HUNTER", purpose: "EMAIL_FIND", estimatedCostMicros: 1_000_000, prerequisites: ["CONTACT_FOUND"], stopConditions: ["ACCOUNT_NOT_ICP"] },
    ],
    initialFacts: [],
    budgetMicros: 5_000_000,
    execute: async (step) => {
      waterfallProviderCalls += step.estimatedCostMicros > 0 ? 1 : 0;
      return step.id === "free-account" ? { stopConditions: ["ACCOUNT_NOT_ICP"] } : {};
    },
  });
  const sequence = validateSequenceInformationGain([
    { sequenceIndex: 0, factIds: ["fact-1"], offerId: "offer-1", question: "Who owns this application?" },
    { sequenceIndex: 1, factIds: ["fact-2"], offerId: "offer-1", question: "Would a checklist help?" },
    { sequenceIndex: 2, factIds: ["fact-2"], offerId: "offer-2", question: "Should I close the loop?" },
  ]);
  return {
    fixtureSet: "experiment-system-shadow-v1",
    assignments: first.length,
    stableReassignments: first.filter((item, index) => item.armId === replay[index]?.armId &&
      item.assignmentHash === replay[index]?.assignmentHash).length,
    waterfallProviderCalls,
    expensiveCallsAfterFailedPrerequisite: waterfall.results
      .filter((item) => item.stepId !== "free-account" && item.status === "CALLED").length,
    sequenceValid: sequence.valid,
    safety: { externalSends: 0, paidCalls: 0, externalWrites: 0 },
    verdict: "HOLD",
  };
}
