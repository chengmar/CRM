import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { disabledProviderManifests } from "../src/acquisition/providers/disabled-adapters.js";
import {
  buildProviderBakeoffReport,
  type ProviderBakeoffObservation,
} from "../src/acquisition/providers/shadow-bakeoff.js";
import type { ProviderId } from "../src/acquisition/providers/contracts.js";

function accountHash(providerId: ProviderId, index: number): string {
  return createHash("sha256").update(`${providerId}:synthetic-account:${index}`).digest("hex");
}

function observations(providerId: ProviderId, profile: "BASELINE" | "GO" | "HOLD"): ProviderBakeoffObservation[] {
  return Array.from({ length: 30 }, (_, index) => {
    const namedLimit = profile === "BASELINE" ? 10 : profile === "GO" ? 20 : 18;
    const validLimit = profile === "BASELINE" ? 5 : profile === "GO" ? 12 : 9;
    const named = index < namedLimit;
    const valid = index < validLimit;
    return {
      providerId,
      accountIdHash: accountHash(providerId, index),
      namedContacts: named ? 1 : 0,
      employmentCorrect: named && index !== namedLimit - 1 ? 1 : 0,
      employmentIncorrect: named && index === namedLimit - 1 ? 1 : 0,
      independentValidEmails: valid ? 1 : 0,
      readyForReview: valid ? 1 : 0,
      wrongCompanyOrCrossDomain: index === 0,
      providerRequests: 1,
      duplicatePaidCalls: 0,
      creditUnits: 1,
      usd: 0.1,
      inquiries: 0,
    };
  });
}

describe("synthetic provider bake-off report", () => {
  it("evaluates WO thresholds but keeps every unconfigured adapter BLOCKED_DISABLED", () => {
    const selected = new Set<ProviderId>(["HUNTER", "APOLLO_OFFICIAL", "WIZA"]);
    const report = buildProviderBakeoffReport({
      fixtureVersion: "provider-shadow-fixture-v1",
      datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA",
      generatedAt: "2026-07-20T00:00:00.000Z",
      baselineProviderId: "HUNTER",
      maxCostPerValidUsd: 1,
      manifests: disabledProviderManifests().filter((manifest) => selected.has(manifest.providerId)),
      observations: [
        ...observations("HUNTER", "BASELINE"),
        ...observations("APOLLO_OFFICIAL", "GO"),
        ...observations("WIZA", "HOLD"),
      ],
    }, () => new Date("2026-07-20T01:00:00.000Z"));

    const apollo = report.rows.find((row) => row.providerId === "APOLLO_OFFICIAL")!;
    const wiza = report.rows.find((row) => row.providerId === "WIZA")!;
    expect(report).toMatchObject({
      datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA",
      networkCalls: 0,
      externalWrites: 0,
    });
    expect(apollo.thresholdOutcome).toBe("GO_CANDIDATE");
    expect(apollo.metrics).toMatchObject({
      accounts: 30,
      accountsWithNamedContacts: 20,
      accountsWithIndependentValid: 12,
      employmentPrecision: 0.95,
      wrongCompanyOrCrossDomainRate: 0.033333,
      incrementalValidRatioToBaseline: 2.4,
    });
    expect(apollo.finalDecision).toBe("BLOCKED_DISABLED");
    expect(wiza.thresholdOutcome).toBe("HOLD");
    expect(wiza.finalDecision).toBe("BLOCKED_DISABLED");
  });

  it("rejects duplicate provider/account observations instead of double counting", () => {
    const manifest = disabledProviderManifests().find((item) => item.providerId === "HUNTER")!;
    const duplicate = observations("HUNTER", "BASELINE")[0]!;
    expect(() => buildProviderBakeoffReport({
      fixtureVersion: "provider-shadow-fixture-v1",
      datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA",
      generatedAt: "2026-07-20T00:00:00.000Z",
      baselineProviderId: "HUNTER",
      maxCostPerValidUsd: 1,
      manifests: [manifest],
      observations: [duplicate, duplicate],
    })).toThrow("Duplicate provider/account observation");
  });
});
