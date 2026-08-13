import { createHash } from "node:crypto";
import { disabledProviderManifests } from "./disabled-adapters.js";
import { buildProviderBakeoffReport } from "./shadow-bakeoff.js";

interface ProviderShadowRow {
  providerId: string;
  activationStatus: string;
  thresholdOutcome: string;
  finalDecision: string;
  metrics: Record<string, unknown>;
  reasons: string[];
}

export interface ProviderShadowReport {
  fixtureVersion: string;
  datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA";
  generatedAt: string;
  evaluatedAt: string;
  baselineProviderId: string;
  thresholds: Record<string, unknown>;
  networkCalls: 0;
  externalWrites: 0;
  rows: ProviderShadowRow[];
}

function accountHash(index: number): string {
  return createHash("sha256").update(`synthetic-provider-account-${index}`).digest("hex");
}

export function runProviderShadowBakeoff(
  now: () => Date = () => new Date("2026-07-20T00:00:00.000Z"),
): ProviderShadowReport {
  const observations: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 30; index += 1) {
    observations.push({
      providerId: "HUNTER",
      accountIdHash: accountHash(index),
      namedContacts: index < 12 ? 1 : 0,
      employmentCorrect: index < 12 ? 1 : 0,
      employmentIncorrect: 0,
      independentValidEmails: index < 6 ? 1 : 0,
      readyForReview: index < 6 ? 1 : 0,
      wrongCompanyOrCrossDomain: false,
      providerRequests: 1,
      duplicatePaidCalls: 0,
      creditUnits: 0,
      usd: 0,
      inquiries: 0,
    });
    observations.push({
      providerId: "APOLLO_OFFICIAL",
      accountIdHash: accountHash(index),
      namedContacts: index < 20 ? 1 : 0,
      employmentCorrect: index < 20 ? 1 : 0,
      employmentIncorrect: 0,
      independentValidEmails: index < 15 ? 1 : 0,
      readyForReview: index < 15 ? 1 : 0,
      wrongCompanyOrCrossDomain: index === 29,
      providerRequests: 1,
      duplicatePaidCalls: 0,
      creditUnits: 1,
      usd: 1,
      inquiries: 0,
    });
  }
  const manifests = disabledProviderManifests().filter((manifest) =>
    manifest.providerId === "HUNTER" || manifest.providerId === "APOLLO_OFFICIAL",
  );
  return buildProviderBakeoffReport({
    fixtureVersion: "provider-shadow-fixture-v1",
    datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA",
    generatedAt: now().toISOString(),
    baselineProviderId: "HUNTER",
    maxCostPerValidUsd: 5,
    manifests,
    observations,
  }, now) as unknown as ProviderShadowReport;
}
