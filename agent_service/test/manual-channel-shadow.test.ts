import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createManualChannelTaskPlan,
  runManualChannelShadow,
} from "../src/acquisition/manual-channel.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    accountId: "account-1",
    personId: "person-1",
    accountName: "Fixture Account",
    buyerType: "SYSTEM_INTEGRATOR_EPC",
    contactName: "Morgan Lee",
    title: "Engineering Manager",
    roleRelevant: true,
    profileUrl: "https://www.linkedin.com/in/fixture",
    profileCompanyMatches: true,
    employmentVerifiedAt: "2026-07-01T00:00:00.000Z",
    employmentExpiresAt: "2026-09-01T00:00:00.000Z",
    evidence: {
      exactQuote: "Public fixture role evidence.",
      sourceUrl: "https://fixture.invalid/contact",
      contentHash: createHash("sha256").update("fixture").digest("hex"),
      public: true,
    },
    suggestedConnectionText: "I work with sample product application projects and would value connecting.",
    citedFactIds: ["fact-1"],
    dncMatch: false,
    excluded: false,
    ownershipConflict: false,
    asOf: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("WO-16 manual channel tasks", () => {
  it("creates a review task without any platform action", () => {
    expect(createManualChannelTaskPlan(candidate())).toMatchObject({
      status: "READY_FOR_HUMAN_REVIEW",
      blockers: [],
      externalAction: "NONE",
      requiresHumanAction: true,
      automatedLinkedInRequest: false,
      automatedMessage: false,
    });
  });

  it("removes suggested text when employment or company requires verification", () => {
    const plan = createManualChannelTaskPlan(candidate({
      profileCompanyMatches: false,
      employmentVerifiedAt: null,
      employmentExpiresAt: null,
    }));
    expect(plan.status).toBe("VERIFY_REQUIRED");
    expect(plan.suggestedConnectionText).toBeNull();
  });

  it("blocks private evidence and DNC", () => {
    const value = candidate({ dncMatch: true });
    value.evidence = { ...(value.evidence as Record<string, unknown>), public: false };
    const plan = createManualChannelTaskPlan(value);
    expect(plan.status).toBe("BLOCKED");
    expect(plan.blockers).toEqual(expect.arrayContaining(["EVIDENCE_NOT_PUBLIC", "DNC_MATCH"]));
  });

  it("uses a stable idempotency key and rejects login material in profile URLs", () => {
    expect(createManualChannelTaskPlan(candidate()).idempotencyKey)
      .toBe(createManualChannelTaskPlan(candidate({ taskId: "task-replay" })).idempotencyKey);
    expect(() => createManualChannelTaskPlan(candidate({
      profileUrl: "https://www.linkedin.com/in/fixture?session=secret",
    }))).toThrow(/public HTTPS/i);
  });

  it("runs 100 fixtures with zero platform or external actions", () => {
    const report = runManualChannelShadow();
    expect(report.candidates).toBe(100);
    expect(report.duplicateTaskKeys).toBe(0);
    expect(report.safety).toEqual({
      profileRequests: 0,
      connectionRequests: 0,
      messages: 0,
      browserAutomation: 0,
      externalWrites: 0,
    });
    expect(report.verdict).toBe("HOLD");
  });
});
