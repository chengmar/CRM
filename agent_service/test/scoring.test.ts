import { describe, expect, it } from "vitest";
import { scoreLead } from "../src/scoring.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

describe("scoreLead", () => {
  it("allows only a fully verified high-quality lead", () => {
    const result = scoreLead({
      fitScore: 30,
      intentScore: 25,
      demandEvidenceQualified: true,
      demandPolicyVersion: DEMAND_POLICY_VERSION,
      activityScore: 20,
      contactScore: 20,
      channelScore: 5,
      independentSourceCount: 2,
      lastActivityAt: new Date().toISOString(),
      namedContact: true,
      employmentVerified: true,
      emailStatus: "VALID",
      roleAddress: false,
      disposableAddress: false,
      dncMatch: false,
    });
    expect(result.totalScore).toBe(100);
    expect(result.grade).toBe("GOLD");
    expect(result.eligibleForReview).toBe(true);
  });

  it("blocks a high-score lead with a generic or risky mailbox", () => {
    const result = scoreLead({
      fitScore: 30,
      intentScore: 25,
      demandEvidenceQualified: true,
      demandPolicyVersion: DEMAND_POLICY_VERSION,
      activityScore: 20,
      contactScore: 20,
      channelScore: 5,
      independentSourceCount: 2,
      lastActivityAt: new Date().toISOString(),
      namedContact: true,
      employmentVerified: true,
      emailStatus: "RISKY",
      roleAddress: true,
      disposableAddress: false,
      dncMatch: false,
    });
    expect(result.totalScore).toBe(100);
    expect(result.eligibleForReview).toBe(false);
    expect(result.reasons).toContain("email status is RISKY");
    expect(result.reasons).toContain("role-based mailbox");
  });

  it("allows an otherwise qualified RISKY mailbox only for the explicit Gmail pilot path", () => {
    const result = scoreLead(
      {
        fitScore: 30,
        intentScore: 25,
        demandEvidenceQualified: true,
        demandPolicyVersion: DEMAND_POLICY_VERSION,
        activityScore: 20,
        contactScore: 20,
        channelScore: 2,
        independentSourceCount: 2,
        lastActivityAt: new Date().toISOString(),
        namedContact: true,
        employmentVerified: true,
        emailStatus: "RISKY",
        roleAddress: false,
        disposableAddress: false,
        dncMatch: false,
      },
      90,
      548,
      new Date(),
      true,
    );
    expect(result.totalScore).toBe(97);
    expect(result.eligibleForReview).toBe(true);
    expect(result.reasons).not.toContain("email status is RISKY");
  });

  it("never accepts a legacy numeric intent score without current deterministic evidence", () => {
    const result = scoreLead({
      fitScore: 30,
      intentScore: 25,
      demandEvidenceQualified: false,
      demandPolicyVersion: "legacy-llm-score",
      activityScore: 20,
      contactScore: 20,
      channelScore: 5,
      independentSourceCount: 3,
      lastActivityAt: new Date().toISOString(),
      namedContact: true,
      employmentVerified: true,
      emailStatus: "VALID",
      roleAddress: false,
      disposableAddress: false,
      dncMatch: false,
    });

    expect(result.totalScore).toBe(75);
    expect(result.eligibleForReview).toBe(false);
    expect(result.reasons).toContain("demand evidence policy is missing or stale");
    expect(result.reasons).toContain("no qualifying direct demand evidence");
  });
});
