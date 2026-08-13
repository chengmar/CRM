import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { AgentDatabase } from "../src/db.js";
import { currentDeliverabilityPolicy } from "../src/outreach/deliverability-policy.js";

function database(totalSent: number, bounceSent = totalSent, bounceRate = 0): AgentDatabase {
  return {
    countSentSince: () => totalSent,
    getBounceStats: () => ({ sent: bounceSent, bounced: Math.round(bounceSent * bounceRate), rate: bounceRate }),
  } as unknown as AgentDatabase;
}

function enterpriseConfig(warmupComplete: boolean) {
  return loadConfig({
    EMAIL_FROM_ADDRESS: "sender@manufacturer.example",
    EMAIL_DAILY_LIMIT: "500",
    EMAIL_HOURLY_LIMIT: "100",
    EMAIL_MIN_INTERVAL_SECONDS: "30",
    EMAIL_MAX_HARD_BOUNCE_RATE: "0.03",
    EMAIL_WARMUP_COMPLETE: String(warmupComplete),
  });
}

describe("enterprise mailbox deliverability ramp", () => {
  it("allows a new authenticated enterprise mailbox to start under a bounded first stage", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(false), database(0))).toEqual({
      mode: "adaptive",
      dailyTarget: 10,
      hourlyCeiling: 2,
      minimumIntervalSeconds: 900,
      stage: "enterprise_initial_reputation_check",
    });
  });

  it("expands only after observed sends while warm-up remains incomplete", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(false), database(10))).toMatchObject({
      dailyTarget: 25,
      hourlyCeiling: 5,
      minimumIntervalSeconds: 300,
      stage: "enterprise_controlled_ramp",
    });
    expect(currentDeliverabilityPolicy(enterpriseConfig(false), database(50))).toMatchObject({
      dailyTarget: 50,
      hourlyCeiling: 10,
      minimumIntervalSeconds: 180,
      stage: "enterprise_observation_required",
    });
  });

  it("uses configured limits only after warm-up is explicitly complete", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(true), database(50))).toEqual({
      mode: "fixed",
      dailyTarget: 500,
      hourlyCeiling: 100,
      minimumIntervalSeconds: 30,
      stage: "configured",
    });
  });

  it("enters recovery before increasing volume when hard bounces rise", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(false), database(20, 20, 0.05))).toEqual({
      mode: "adaptive",
      dailyTarget: 10,
      hourlyCeiling: 2,
      minimumIntervalSeconds: 900,
      stage: "deliverability_recovery",
    });
  });

  it("does not let completed warm-up bypass hard-bounce recovery", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(true), database(29, 29, 1 / 29))).toEqual({
      mode: "adaptive",
      dailyTarget: 10,
      hourlyCeiling: 2,
      minimumIntervalSeconds: 900,
      stage: "deliverability_recovery",
    });
  });

  it("returns to configured capacity when the audited window reaches the configured threshold", () => {
    expect(currentDeliverabilityPolicy(enterpriseConfig(true), database(34, 34, 1 / 34))).toEqual({
      mode: "fixed",
      dailyTarget: 500,
      hourlyCeiling: 100,
      minimumIntervalSeconds: 30,
      stage: "configured",
    });
  });
});
