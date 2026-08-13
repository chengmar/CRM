import { describe, expect, it, vi } from "vitest";
import {
  assignExperimentArm,
  executeEnrichmentWaterfall,
  runExperimentSystemShadow,
  validateSequenceInformationGain,
} from "../src/acquisition/experiment-system.js";

const definition = {
  experimentId: "experiment-1",
  version: 1,
  primaryVariable: "OFFER",
  arms: [
    { id: "a", variable: "OFFER", value: "checklist", weight: 1 },
    { id: "b", variable: "OFFER", value: "guide", weight: 1 },
  ],
  shadowOnly: true,
  externalSendAuthorized: false,
};

describe("WO-03 experiment system", () => {
  it("assigns the same account to a stable arm", () => {
    const first = assignExperimentArm({ definition, accountId: "account-1", assignmentSalt: "salt-1" });
    expect(assignExperimentArm({ definition, accountId: "account-1", assignmentSalt: "salt-1" }))
      .toEqual(first);
  });

  it("rejects experiments that vary more than the primary variable", () => {
    expect(() => assignExperimentArm({
      definition: {
        ...definition,
        arms: [definition.arms[0], { id: "b", variable: "PROVIDER", value: "Apollo", weight: 1 }],
      },
      accountId: "account-1",
      assignmentSalt: "salt-1",
    })).toThrow(/only its primary variable/i);
  });

  it("makes zero expensive calls after a failed free prerequisite", async () => {
    const execute = vi.fn(async (step: { id: string }) =>
      step.id === "free" ? { stopConditions: ["NOT_ICP"] } : {});
    const result = await executeEnrichmentWaterfall({
      steps: [
        { id: "free", provider: "LOCAL", purpose: "ACCOUNT", estimatedCostMicros: 0, prerequisites: [], stopConditions: [] },
        { id: "contact", provider: "APOLLO", purpose: "CONTACT", estimatedCostMicros: 100, prerequisites: ["ACCOUNT_QUALIFIED"], stopConditions: ["NOT_ICP"] },
      ],
      initialFacts: [],
      budgetMicros: 1_000,
      execute,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.results[1]).toMatchObject({ status: "SKIPPED_PREREQUISITE" });
    expect(result.spentMicros).toBe(0);
  });

  it("requires new information in every follow-up and caps the sequence at three", () => {
    expect(validateSequenceInformationGain([
      { sequenceIndex: 0, factIds: ["fact-1"], offerId: "offer-1", question: "Who owns this?" },
      { sequenceIndex: 1, factIds: ["fact-1"], offerId: "offer-1", question: "Who owns this?" },
    ])).toMatchObject({ valid: false, blockers: ["SEQUENCE_NO_INFORMATION_GAIN:1"] });
    expect(validateSequenceInformationGain(Array.from({ length: 4 }, (_, sequenceIndex) => ({
      sequenceIndex,
      factIds: [`fact-${sequenceIndex}`],
      offerId: null,
      question: `Question ${sequenceIndex}`,
    }))).valid).toBe(false);
  });

  it("runs 100 stable synthetic assignments with no sends or paid calls", async () => {
    const report = await runExperimentSystemShadow();
    expect(report).toMatchObject({
      assignments: 100,
      stableReassignments: 100,
      expensiveCallsAfterFailedPrerequisite: 0,
      sequenceValid: true,
      safety: { externalSends: 0, paidCalls: 0, externalWrites: 0 },
      verdict: "HOLD",
    });
  });
});
