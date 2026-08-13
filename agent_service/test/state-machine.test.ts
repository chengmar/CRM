import { describe, expect, it } from "vitest";
import { assertLeadTransition, assertMessageTransition, isAutomationLocked } from "../src/state-machine.js";

describe("state machine", () => {
  it("allows the production happy path", () => {
    expect(() => assertLeadTransition("NEW", "VERIFYING")).not.toThrow();
    expect(() => assertLeadTransition("VERIFYING", "READY_FOR_REVIEW")).not.toThrow();
    expect(() => assertLeadTransition("ENRICHING", "ENRICHMENT_EXHAUSTED")).not.toThrow();
    expect(() => assertLeadTransition("ENRICHMENT_EXHAUSTED", "ENRICHING")).not.toThrow();
    expect(() => assertLeadTransition("READY_FOR_REVIEW", "APPROVED")).not.toThrow();
    expect(() => assertMessageTransition("PENDING_APPROVAL", "APPROVED")).not.toThrow();
  });

  it("does not allow reopening human takeover", () => {
    expect(() => assertLeadTransition("HUMAN_TAKEOVER", "CONTACTED")).toThrow();
    expect(isAutomationLocked("HUMAN_TAKEOVER", true)).toBe(true);
  });
});
