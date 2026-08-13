import { z } from "zod";
import {
  ProviderIdSchema,
  ProviderManifestSchema,
  Sha256Schema,
  type ProviderId,
  type ProviderManifest,
} from "./contracts.js";

export const ProviderBakeoffObservationSchema = z.object({
  providerId: ProviderIdSchema,
  accountIdHash: Sha256Schema,
  namedContacts: z.number().int().min(0).max(2),
  employmentCorrect: z.number().int().min(0).max(2),
  employmentIncorrect: z.number().int().min(0).max(2),
  independentValidEmails: z.number().int().min(0).max(2),
  readyForReview: z.number().int().min(0).max(2),
  wrongCompanyOrCrossDomain: z.boolean(),
  providerRequests: z.number().int().nonnegative().max(20),
  duplicatePaidCalls: z.number().int().nonnegative().max(20),
  creditUnits: z.number().nonnegative(),
  usd: z.number().nonnegative(),
  inquiries: z.number().int().nonnegative().max(2),
}).strict().superRefine((value, context) => {
  if (value.employmentCorrect + value.employmentIncorrect > value.namedContacts) {
    context.addIssue({ code: "custom", path: ["employmentCorrect"], message: "Employment reviews exceed contacts" });
  }
  if (value.independentValidEmails > value.namedContacts) {
    context.addIssue({ code: "custom", path: ["independentValidEmails"], message: "VALID exceeds contacts" });
  }
  if (value.readyForReview > value.independentValidEmails) {
    context.addIssue({ code: "custom", path: ["readyForReview"], message: "READY exceeds independent VALID" });
  }
  if (value.inquiries > value.readyForReview) {
    context.addIssue({ code: "custom", path: ["inquiries"], message: "Inquiries exceed READY" });
  }
});

export type ProviderBakeoffObservation = z.infer<typeof ProviderBakeoffObservationSchema>;

export const ProviderBakeoffInputSchema = z.object({
  fixtureVersion: z.string().regex(/^provider-shadow-fixture-v\d+$/),
  datasetKind: z.literal("SYNTHETIC_NO_CUSTOMER_DATA"),
  generatedAt: z.string().datetime({ offset: true }),
  baselineProviderId: ProviderIdSchema,
  maxCostPerValidUsd: z.number().positive(),
  manifests: z.array(ProviderManifestSchema).min(1),
  observations: z.array(ProviderBakeoffObservationSchema),
}).strict();

export type ProviderBakeoffInput = z.infer<typeof ProviderBakeoffInputSchema>;

const ThresholdOutcomeSchema = z.enum([
  "BASELINE",
  "GO_CANDIDATE",
  "HOLD",
  "KILL",
  "INSUFFICIENT_SAMPLE",
]);

const ProviderBakeoffMetricsSchema = z.object({
  accounts: z.number().int().nonnegative(),
  accountsWithNamedContacts: z.number().int().nonnegative(),
  namedContactCoverage: z.number().min(0).max(1).nullable(),
  namedContacts: z.number().int().nonnegative(),
  employmentReviewed: z.number().int().nonnegative(),
  employmentPrecision: z.number().min(0).max(1).nullable(),
  accountsWithIndependentValid: z.number().int().nonnegative(),
  independentValidEmails: z.number().int().nonnegative(),
  independentValidCoverage: z.number().min(0).max(1).nullable(),
  wrongCompanyOrCrossDomainRate: z.number().min(0).max(1).nullable(),
  readyForReview: z.number().int().nonnegative(),
  inquiries: z.number().int().nonnegative(),
  providerRequests: z.number().int().nonnegative(),
  duplicatePaidCalls: z.number().int().nonnegative(),
  creditUnits: z.number().nonnegative(),
  usd: z.number().nonnegative(),
  costPerValidUsd: z.number().nonnegative().nullable(),
  incrementalValidRatioToBaseline: z.number().nonnegative().nullable(),
}).strict();

export const ProviderBakeoffRowSchema = z.object({
  providerId: ProviderIdSchema,
  activationStatus: z.enum(["BLOCKED_DISABLED", "SHADOW_ELIGIBLE"]),
  thresholdOutcome: ThresholdOutcomeSchema,
  finalDecision: z.enum([
    "BLOCKED_DISABLED",
    "BASELINE",
    "GO_CANDIDATE",
    "HOLD",
    "KILL",
    "INSUFFICIENT_SAMPLE",
  ]),
  metrics: ProviderBakeoffMetricsSchema,
  reasons: z.array(z.string().trim().min(1).max(200)).min(1),
}).strict();

export type ProviderBakeoffRow = z.infer<typeof ProviderBakeoffRowSchema>;

export const ProviderBakeoffReportSchema = z.object({
  fixtureVersion: z.string().regex(/^provider-shadow-fixture-v\d+$/),
  datasetKind: z.literal("SYNTHETIC_NO_CUSTOMER_DATA"),
  generatedAt: z.string().datetime({ offset: true }),
  evaluatedAt: z.string().datetime({ offset: true }),
  baselineProviderId: ProviderIdSchema,
  thresholds: z.object({
    minimumAccounts: z.literal(30),
    minimumNamedAccountCoverageCount: z.literal(18),
    minimumIndependentValidAccountCount: z.literal(12),
    minimumEmploymentPrecision: z.literal(0.9),
    maximumWrongCompanyOrCrossDomainRate: z.literal(0.05),
    minimumIncrementalValidRatio: z.literal(2),
    maximumContactsChargedPerAccount: z.literal(2),
    maxCostPerValidUsd: z.number().positive(),
  }).strict(),
  networkCalls: z.literal(0),
  externalWrites: z.literal(0),
  rows: z.array(ProviderBakeoffRowSchema).min(1),
}).strict();

export type ProviderBakeoffReport = z.infer<typeof ProviderBakeoffReportSchema>;

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function aggregate(
  observations: ProviderBakeoffObservation[],
  baselineValidEmails: number,
): z.infer<typeof ProviderBakeoffMetricsSchema> {
  const accounts = observations.length;
  const accountsWithNamedContacts = observations.filter((item) => item.namedContacts > 0).length;
  const namedContacts = observations.reduce((sum, item) => sum + item.namedContacts, 0);
  const employmentCorrect = observations.reduce((sum, item) => sum + item.employmentCorrect, 0);
  const employmentIncorrect = observations.reduce((sum, item) => sum + item.employmentIncorrect, 0);
  const employmentReviewed = employmentCorrect + employmentIncorrect;
  const accountsWithIndependentValid = observations.filter((item) => item.independentValidEmails > 0).length;
  const independentValidEmails = observations.reduce((sum, item) => sum + item.independentValidEmails, 0);
  const wrongCount = observations.filter((item) => item.wrongCompanyOrCrossDomain).length;
  const usd = observations.reduce((sum, item) => sum + item.usd, 0);
  return ProviderBakeoffMetricsSchema.parse({
    accounts,
    accountsWithNamedContacts,
    namedContactCoverage: ratio(accountsWithNamedContacts, accounts),
    namedContacts,
    employmentReviewed,
    employmentPrecision: ratio(employmentCorrect, employmentReviewed),
    accountsWithIndependentValid,
    independentValidEmails,
    independentValidCoverage: ratio(accountsWithIndependentValid, accounts),
    wrongCompanyOrCrossDomainRate: ratio(wrongCount, accounts),
    readyForReview: observations.reduce((sum, item) => sum + item.readyForReview, 0),
    inquiries: observations.reduce((sum, item) => sum + item.inquiries, 0),
    providerRequests: observations.reduce((sum, item) => sum + item.providerRequests, 0),
    duplicatePaidCalls: observations.reduce((sum, item) => sum + item.duplicatePaidCalls, 0),
    creditUnits: observations.reduce((sum, item) => sum + item.creditUnits, 0),
    usd,
    costPerValidUsd: independentValidEmails > 0 ? ratio(usd, independentValidEmails) : null,
    incrementalValidRatioToBaseline: ratio(independentValidEmails, baselineValidEmails),
  });
}

function activationStatus(manifest: ProviderManifest): "BLOCKED_DISABLED" | "SHADOW_ELIGIBLE" {
  const active = manifest.implementationState !== "DISABLED_STUB" &&
    manifest.activation.featureFlagEnabled &&
    manifest.activation.configured &&
    (
      manifest.activation.authorization === "SHADOW_APPROVED" ||
      (
        manifest.implementationState === "FIXTURE_SHADOW" &&
        manifest.activation.authorization === "NOT_REQUIRED_FIXTURE"
      )
    );
  return active ? "SHADOW_ELIGIBLE" : "BLOCKED_DISABLED";
}

function thresholdOutcome(
  providerId: ProviderId,
  baselineProviderId: ProviderId,
  metrics: z.infer<typeof ProviderBakeoffMetricsSchema>,
  maxCostPerValidUsd: number,
): { outcome: z.infer<typeof ThresholdOutcomeSchema>; reasons: string[] } {
  if (providerId === baselineProviderId) {
    return { outcome: "BASELINE", reasons: ["BASELINE_COMPARATOR"] };
  }
  if (metrics.accounts < 30) {
    return { outcome: "INSUFFICIENT_SAMPLE", reasons: ["MINIMUM_30_ACCOUNT_SAMPLE_NOT_MET"] };
  }
  const qualityGatesPass =
    metrics.employmentPrecision !== null && metrics.employmentPrecision >= 0.9 &&
    metrics.wrongCompanyOrCrossDomainRate !== null && metrics.wrongCompanyOrCrossDomainRate <= 0.05 &&
    metrics.duplicatePaidCalls === 0;
  const go = qualityGatesPass &&
    metrics.accountsWithNamedContacts >= 18 &&
    metrics.accountsWithIndependentValid >= 12 &&
    metrics.incrementalValidRatioToBaseline !== null && metrics.incrementalValidRatioToBaseline >= 2 &&
    metrics.costPerValidUsd !== null && metrics.costPerValidUsd <= maxCostPerValidUsd;
  if (go) return { outcome: "GO_CANDIDATE", reasons: ["ALL_WO_PROVIDER_THRESHOLDS_MET_ON_SYNTHETIC_FIXTURE"] };
  const hold = qualityGatesPass &&
    metrics.accountsWithIndependentValid >= 8 &&
    metrics.accountsWithIndependentValid <= 11 &&
    metrics.costPerValidUsd !== null && metrics.costPerValidUsd <= maxCostPerValidUsd;
  if (hold) return { outcome: "HOLD", reasons: ["EIGHT_TO_ELEVEN_INDEPENDENT_VALID_ACCOUNTS"] };
  return { outcome: "KILL", reasons: ["ONE_OR_MORE_PROVIDER_QUALITY_OR_COST_GATES_FAILED"] };
}

function assertUniqueFixtureRows(input: ProviderBakeoffInput): void {
  const manifestIds = new Set(input.manifests.map((manifest) => manifest.providerId));
  if (manifestIds.size !== input.manifests.length) throw new Error("Duplicate provider manifests in bake-off input");
  if (!manifestIds.has(input.baselineProviderId)) throw new Error("Baseline provider manifest is missing");
  const observationKeys = new Set<string>();
  for (const observation of input.observations) {
    if (!manifestIds.has(observation.providerId)) throw new Error("Observation provider manifest is missing");
    const key = `${observation.providerId}:${observation.accountIdHash}`;
    if (observationKeys.has(key)) throw new Error("Duplicate provider/account observation");
    observationKeys.add(key);
  }
}

export function buildProviderBakeoffReport(
  rawInput: unknown,
  now: () => Date = () => new Date(),
): ProviderBakeoffReport {
  const input = ProviderBakeoffInputSchema.parse(rawInput);
  assertUniqueFixtureRows(input);
  const baselineValidEmails = input.observations
    .filter((item) => item.providerId === input.baselineProviderId)
    .reduce((sum, item) => sum + item.independentValidEmails, 0);

  const rows = input.manifests.map((manifest): ProviderBakeoffRow => {
    const observations = input.observations.filter((item) => item.providerId === manifest.providerId);
    const metrics = aggregate(observations, baselineValidEmails);
    const threshold = thresholdOutcome(
      manifest.providerId,
      input.baselineProviderId,
      metrics,
      input.maxCostPerValidUsd,
    );
    const activation = activationStatus(manifest);
    const reasons = activation === "BLOCKED_DISABLED"
      ? ["BLOCKED_DISABLED", ...threshold.reasons, "SYNTHETIC_FIXTURE_ONLY_NO_EXTERNAL_AUTHORIZATION"]
      : threshold.reasons;
    return ProviderBakeoffRowSchema.parse({
      providerId: manifest.providerId,
      activationStatus: activation,
      thresholdOutcome: threshold.outcome,
      finalDecision: activation === "BLOCKED_DISABLED" ? "BLOCKED_DISABLED" : threshold.outcome,
      metrics,
      reasons,
    });
  });

  return ProviderBakeoffReportSchema.parse({
    fixtureVersion: input.fixtureVersion,
    datasetKind: input.datasetKind,
    generatedAt: input.generatedAt,
    evaluatedAt: now().toISOString(),
    baselineProviderId: input.baselineProviderId,
    thresholds: {
      minimumAccounts: 30,
      minimumNamedAccountCoverageCount: 18,
      minimumIndependentValidAccountCount: 12,
      minimumEmploymentPrecision: 0.9,
      maximumWrongCompanyOrCrossDomainRate: 0.05,
      minimumIncrementalValidRatio: 2,
      maximumContactsChargedPerAccount: 2,
      maxCostPerValidUsd: input.maxCostPerValidUsd,
    },
    networkCalls: 0,
    externalWrites: 0,
    rows,
  });
}
