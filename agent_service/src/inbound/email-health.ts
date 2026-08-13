import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";

export type ImapRuntimeHealthState =
  | "DISABLED"
  | "NOT_STARTED"
  | "STARTING"
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "STALE";

export interface ImapRuntimeHealth {
  enabled: boolean;
  state: ImapRuntimeHealthState;
  sendReady: boolean;
  monitorStartedAt: string | null;
  lastPollAttemptAt: string | null;
  lastPollSuccessAt: string | null;
  lastPollFailureAt: string | null;
  consecutiveFailures: number;
  failurePauseThreshold: number;
  staleAfterSeconds: number;
  ageSeconds: number | null;
  pauseEpisode: number;
  globallyPaused: boolean;
  recoveryRequiresManualResume: boolean;
  reason: string;
}

export interface ImapHealthTransition {
  health: ImapRuntimeHealth;
  becameUnhealthy: boolean;
  recovered: boolean;
}

const keys = {
  monitorStartedAt: "imap_monitor_started_at",
  lastAttemptAt: "imap_last_poll_attempt_at",
  lastSuccessAt: "imap_last_poll_success_at",
  lastFailureAt: "imap_last_poll_failure_at",
  consecutiveFailures: "imap_consecutive_failures",
  lastFailureClass: "imap_last_failure_class",
  lastFailureMessage: "imap_last_failure_message",
  state: "imap_runtime_health_state",
  pauseEpisode: "imap_health_pause_episode",
  pausedAt: "imap_health_paused_at",
  recoveredAt: "imap_health_recovered_at",
} as const;

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function imapStaleAfterSeconds(config: AgentConfig): number {
  return Math.max(
    positive(config.IMAP_HEALTH_STALE_SECONDS, 300),
    positive(config.EMAIL_POLL_SECONDS, 60) * 3,
  );
}

export function imapFailurePauseThreshold(config: AgentConfig): number {
  return positive(config.IMAP_FAILURE_PAUSE_THRESHOLD, 3);
}

export function getImapRuntimeHealth(
  config: AgentConfig,
  db: AgentDatabase,
  now = new Date(),
): ImapRuntimeHealth {
  const enabled = config.EMAIL_INBOUND_ENABLED;
  const monitorStartedAt = db.getSetting(keys.monitorStartedAt);
  const lastPollAttemptAt = db.getSetting(keys.lastAttemptAt);
  const lastPollSuccessAt = db.getSetting(keys.lastSuccessAt);
  const lastPollFailureAt = db.getSetting(keys.lastFailureAt);
  const consecutiveFailures = Math.max(
    0,
    Number.parseInt(db.getSetting(keys.consecutiveFailures) ?? "0", 10) || 0,
  );
  const failurePauseThreshold = imapFailurePauseThreshold(config);
  const staleAfterSeconds = imapStaleAfterSeconds(config);
  const started = validDate(monitorStartedAt);
  const success = validDate(lastPollSuccessAt);
  const successIsCurrent = Boolean(started && success && success.getTime() >= started.getTime());
  const ageSeconds = success
    ? Math.max(0, Math.floor((now.getTime() - success.getTime()) / 1000))
    : null;
  const stale = successIsCurrent && ageSeconds !== null && ageSeconds > staleAfterSeconds;
  const startupAgeSeconds = started
    ? Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000))
    : null;
  const startupStale = !successIsCurrent && startupAgeSeconds !== null && startupAgeSeconds > staleAfterSeconds;
  let state: ImapRuntimeHealthState;
  let reason: string;

  if (!enabled) {
    state = "DISABLED";
    reason = "IMAP inbound monitoring is disabled";
  } else if (!started) {
    state = "NOT_STARTED";
    reason = "IMAP runtime monitoring has not started";
  } else if (consecutiveFailures >= failurePauseThreshold) {
    state = "UNHEALTHY";
    reason = "IMAP consecutive poll failures reached the safety threshold";
  } else if (startupStale) {
    state = "STALE";
    reason = "IMAP has not completed a successful poll before the startup freshness deadline";
  } else if (!successIsCurrent) {
    state = "STARTING";
    reason = "IMAP has not completed a successful poll in the current process";
  } else if (stale) {
    state = "STALE";
    reason = "IMAP last successful poll is stale";
  } else if (consecutiveFailures > 0) {
    state = "DEGRADED";
    reason = "IMAP has a recent successful poll but a later poll failed";
  } else {
    state = "HEALTHY";
    reason = "IMAP reply monitoring is current";
  }

  const globallyPaused = db.getSetting("outbound_paused") === "true";
  return {
    enabled,
    state,
    sendReady: state === "HEALTHY" || state === "DEGRADED",
    monitorStartedAt,
    lastPollAttemptAt,
    lastPollSuccessAt,
    lastPollFailureAt,
    consecutiveFailures,
    failurePauseThreshold,
    staleAfterSeconds,
    ageSeconds,
    pauseEpisode: Math.max(0, Number.parseInt(db.getSetting(keys.pauseEpisode) ?? "0", 10) || 0),
    globallyPaused,
    recoveryRequiresManualResume: globallyPaused,
    reason,
  };
}

export function initializeImapRuntimeHealth(
  config: AgentConfig,
  db: AgentDatabase,
  now = new Date(),
): ImapRuntimeHealth {
  if (!config.EMAIL_INBOUND_ENABLED) return getImapRuntimeHealth(config, db, now);
  db.setSettings({
    [keys.monitorStartedAt]: now.toISOString(),
    [keys.lastAttemptAt]: "",
    [keys.consecutiveFailures]: "0",
    [keys.lastFailureClass]: "",
    [keys.lastFailureMessage]: "",
    [keys.state]: "STARTING",
  });
  return getImapRuntimeHealth(config, db, now);
}

export function recordImapPollSuccess(
  config: AgentConfig,
  db: AgentDatabase,
  now = new Date(),
): ImapHealthTransition {
  if (!db.getSetting(keys.monitorStartedAt)) {
    db.setSetting(keys.monitorStartedAt, now.toISOString());
  }
  const before = getImapRuntimeHealth(config, db, now);
  db.setSettings({
    [keys.lastAttemptAt]: now.toISOString(),
    [keys.lastSuccessAt]: now.toISOString(),
    [keys.consecutiveFailures]: "0",
    [keys.lastFailureClass]: "",
    [keys.lastFailureMessage]: "",
    [keys.state]: "HEALTHY",
    ...(new Set<ImapRuntimeHealthState>(["UNHEALTHY", "STALE"]).has(before.state)
      ? { [keys.recoveredAt]: now.toISOString() }
      : {}),
  });
  return {
    health: getImapRuntimeHealth(config, db, now),
    becameUnhealthy: false,
    recovered: new Set<ImapRuntimeHealthState>(["UNHEALTHY", "STALE"]).has(before.state),
  };
}

export function recordImapPollFailure(
  config: AgentConfig,
  db: AgentDatabase,
  failure: { errorClass: string; message: string },
  now = new Date(),
): ImapHealthTransition {
  if (!db.getSetting(keys.monitorStartedAt)) {
    db.setSetting(keys.monitorStartedAt, now.toISOString());
  }
  const before = getImapRuntimeHealth(config, db, now);
  const failures = before.consecutiveFailures + 1;
  const unhealthy = failures >= imapFailurePauseThreshold(config);
  const becameUnhealthy = unhealthy && !new Set<ImapRuntimeHealthState>(["UNHEALTHY", "STALE"]).has(before.state);
  const episode = becameUnhealthy ? before.pauseEpisode + 1 : before.pauseEpisode;
  db.setSettings({
    [keys.lastAttemptAt]: now.toISOString(),
    [keys.lastFailureAt]: now.toISOString(),
    [keys.consecutiveFailures]: String(failures),
    [keys.lastFailureClass]: failure.errorClass.slice(0, 120),
    [keys.lastFailureMessage]: failure.message.slice(0, 500),
    [keys.state]: unhealthy ? "UNHEALTHY" : "DEGRADED",
    ...(unhealthy ? {
      outbound_paused: "true",
      [keys.pauseEpisode]: String(episode),
      [keys.pausedAt]: now.toISOString(),
    } : {}),
  });
  return {
    health: getImapRuntimeHealth(config, db, now),
    becameUnhealthy,
    recovered: false,
  };
}

export function enforceImapHealthFreshness(
  config: AgentConfig,
  db: AgentDatabase,
  now = new Date(),
): ImapHealthTransition {
  const before = getImapRuntimeHealth(config, db, now);
  const mustPause = before.enabled && (before.state === "STALE" || before.state === "UNHEALTHY");
  if (!mustPause) return { health: before, becameUnhealthy: false, recovered: false };
  const alreadyRecorded = db.getSetting(keys.state) === before.state && before.globallyPaused;
  const episode = alreadyRecorded ? before.pauseEpisode : before.pauseEpisode + 1;
  db.setSettings({
    outbound_paused: "true",
    [keys.state]: before.state,
    [keys.pauseEpisode]: String(episode),
    [keys.pausedAt]: db.getSetting(keys.pausedAt) || now.toISOString(),
  });
  return {
    health: getImapRuntimeHealth(config, db, now),
    becameUnhealthy: !alreadyRecorded,
    recovered: false,
  };
}

export function imapClaimPolicy(config: AgentConfig): {
  requireFreshImapMonitoring: boolean;
  imapHealthMaxAgeSeconds: number;
  imapFailureThreshold: number;
} {
  return {
    requireFreshImapMonitoring: config.EMAIL_INBOUND_ENABLED,
    imapHealthMaxAgeSeconds: imapStaleAfterSeconds(config),
    imapFailureThreshold: imapFailurePauseThreshold(config),
  };
}
