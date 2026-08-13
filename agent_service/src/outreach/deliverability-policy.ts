import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import { isGmailPilotMode } from "./email-policy.js";

export interface DeliverabilityPolicy {
  mode: "adaptive" | "fixed";
  dailyTarget: number;
  hourlyCeiling: number;
  minimumIntervalSeconds: number;
  stage: string;
}

export function currentDeliverabilityPolicy(
  config: AgentConfig,
  db: AgentDatabase,
): DeliverabilityPolicy {
  const gmailPilot = isGmailPilotMode(config);
  const totalSent = db.countSentSince("1970-01-01T00:00:00.000Z", "email");
  const bounce = db.getBounceStats();
  const recoveryThreshold = config.EMAIL_MAX_HARD_BOUNCE_RATE;
  if (bounce.sent >= 5 && bounce.rate > recoveryThreshold) {
    return {
      mode: "adaptive",
      dailyTarget: Math.min(config.EMAIL_DAILY_LIMIT, gmailPilot ? 15 : 10),
      hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, gmailPilot ? 3 : 2),
      minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, gmailPilot ? 1200 : 900),
      stage: "deliverability_recovery",
    };
  }

  if (!gmailPilot && config.EMAIL_WARMUP_COMPLETE) {
    return {
      mode: "fixed",
      dailyTarget: config.EMAIL_DAILY_LIMIT,
      hourlyCeiling: config.EMAIL_HOURLY_LIMIT,
      minimumIntervalSeconds: config.EMAIL_MIN_INTERVAL_SECONDS,
      stage: "configured",
    };
  }

  if (!gmailPilot) {
    if (totalSent < 10) {
      return {
        mode: "adaptive",
        dailyTarget: Math.min(config.EMAIL_DAILY_LIMIT, 10),
        hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 2),
        minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 900),
        stage: "enterprise_initial_reputation_check",
      };
    }
    if (totalSent < 50) {
      return {
        mode: "adaptive",
        dailyTarget: Math.min(config.EMAIL_DAILY_LIMIT, 25),
        hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 5),
        minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 300),
        stage: "enterprise_controlled_ramp",
      };
    }
    return {
      mode: "adaptive",
      dailyTarget: Math.min(config.EMAIL_DAILY_LIMIT, 50),
      hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 10),
      minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 180),
      stage: "enterprise_observation_required",
    };
  }

  if (totalSent < 10) {
    return {
      mode: "adaptive",
      dailyTarget: config.EMAIL_DAILY_LIMIT,
      hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 8),
      minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 300),
      stage: "initial_reputation_check",
    };
  }
  if (totalSent < 30) {
    return {
      mode: "adaptive",
      dailyTarget: config.EMAIL_DAILY_LIMIT,
      hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 12),
      minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 180),
      stage: "controlled_ramp",
    };
  }
  return {
    mode: "adaptive",
    dailyTarget: config.EMAIL_DAILY_LIMIT,
    hourlyCeiling: config.EMAIL_HOURLY_LIMIT,
    minimumIntervalSeconds: config.EMAIL_MIN_INTERVAL_SECONDS,
    stage: "normal",
  };
}
