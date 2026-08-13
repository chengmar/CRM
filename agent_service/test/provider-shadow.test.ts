import { describe, expect, it } from "vitest";
import { runProviderShadowBakeoff } from "../src/acquisition/providers/provider-shadow.js";

describe("provider synthetic shadow", () => {
  it("keeps a threshold-passing candidate blocked while authorization is absent", () => {
    const report = runProviderShadowBakeoff();
    const apollo = report.rows.find((row) => row.providerId === "APOLLO_OFFICIAL");
    expect(report).toMatchObject({
      datasetKind: "SYNTHETIC_NO_CUSTOMER_DATA",
      networkCalls: 0,
      externalWrites: 0,
    });
    expect(apollo).toMatchObject({
      activationStatus: "BLOCKED_DISABLED",
      thresholdOutcome: "GO_CANDIDATE",
      finalDecision: "BLOCKED_DISABLED",
    });
    expect(apollo?.reasons).toEqual(expect.arrayContaining([
      "BLOCKED_DISABLED",
      "SYNTHETIC_FIXTURE_ONLY_NO_EXTERNAL_AUTHORIZATION",
    ]));
  });
});
