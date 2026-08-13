import crypto from "node:crypto";
import type { AgentDatabase } from "../db.js";
import { logger } from "../logger.js";
import {
  buildDailyOperationsReport,
  formatDailyOperationsReport,
  type DailyOperationsDispatchItem,
  type DailyOperationsReport,
} from "../reporting/daily-operations.js";
import { localDayUtcWindow } from "../reporting/funnel.js";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RESERVATION_TTL_MS = 15 * 60_000;

export interface DailyOperationsNotification {
  eventType: "DAILY_OPERATIONS_REPORT";
  idempotencyKey: string;
  report: DailyOperationsReport;
  text: string;
}

export interface DailyOperationsNotificationReceipt {
  notificationId?: string;
}

/** Resolves only after the notification has been durably and idempotently queued. */
export interface DailyOperationsNotifier {
  enqueue(notification: DailyOperationsNotification): Promise<DailyOperationsNotificationReceipt | void>;
}

export type DailyOperationsDispatchPlanProvider = (
  limit: number,
) => DailyOperationsDispatchItem[] | Promise<DailyOperationsDispatchItem[]>;

export interface DailyOperationsSchedulerOptions {
  targetHour: number;
  dailySendCapacity: number;
  timeZone?: string;
  dispatchPlanLimit?: number;
  pollIntervalMs?: number;
  reservationTtlMs?: number;
}

export type DailyOperationsTickResult =
  | "DISABLED"
  | "BEFORE_TARGET_HOUR"
  | "ALREADY_QUEUED"
  | "RESERVED_BY_ANOTHER_WORKER"
  | "QUEUED";

interface RunState {
  version: 1;
  state: "RESERVED" | "QUEUED";
  token: string;
  reservedAt: string;
  queuedAt?: string;
  notificationId?: string;
}

function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).find((part) => part.type === "hour")?.value;
  const result = Number(hour);
  if (!Number.isInteger(result) || result < 0 || result > 23) {
    throw new Error(`Unable to calculate local hour for time zone ${timeZone}`);
  }
  return result;
}

function parseRunState(value: string): RunState | null {
  try {
    const parsed = JSON.parse(value) as Partial<RunState>;
    if (parsed.version !== 1 || (parsed.state !== "RESERVED" && parsed.state !== "QUEUED")) return null;
    if (typeof parsed.token !== "string" || typeof parsed.reservedAt !== "string") return null;
    return parsed as RunState;
  } catch {
    return null;
  }
}

export class DailyOperationsScheduler {
  private readonly timeZone: string;
  private readonly targetHour: number;
  private readonly dailySendCapacity: number;
  private readonly dispatchPlanLimit: number;
  private readonly pollIntervalMs: number;
  private readonly reservationTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: AgentDatabase,
    options: DailyOperationsSchedulerOptions,
    private readonly dispatchPlanProvider: DailyOperationsDispatchPlanProvider,
    private readonly notifier: DailyOperationsNotifier,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(options.targetHour) || options.targetHour < 0 || options.targetHour > 23) {
      throw new Error("Daily operations targetHour must be an integer from 0 to 23");
    }
    if (!Number.isInteger(options.dailySendCapacity) || options.dailySendCapacity < 0) {
      throw new Error("Daily operations dailySendCapacity must be a non-negative integer");
    }
    if (options.dispatchPlanLimit !== undefined &&
      (!Number.isInteger(options.dispatchPlanLimit) || options.dispatchPlanLimit < 0)) {
      throw new Error("Daily operations dispatchPlanLimit must be a non-negative integer");
    }
    this.targetHour = options.targetHour;
    this.dailySendCapacity = options.dailySendCapacity;
    this.dispatchPlanLimit = Math.max(
      this.dailySendCapacity,
      options.dispatchPlanLimit ?? this.dailySendCapacity,
    );
    this.timeZone = options.timeZone?.trim() || DEFAULT_TIME_ZONE;
    this.pollIntervalMs = Math.max(1_000, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.reservationTtlMs = Math.max(1_000, Math.trunc(options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS));
    localDayUtcWindow(new Date(0), this.timeZone);
  }

  isEnabled(): boolean {
    return this.db.getSetting("daily_operations_enabled") !== "false";
  }

  getPlanLimit(): number {
    return this.dispatchPlanLimit;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((error) => logger.error({ error }, "Daily operations scheduler failed")),
      this.pollIntervalMs,
    );
    void this.tick().catch((error) => logger.error({ error }, "Initial daily operations report failed"));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<DailyOperationsTickResult> {
    if (!this.isEnabled()) return "DISABLED";
    const now = this.nowProvider();
    if (!Number.isFinite(now.getTime())) throw new Error("Daily operations nowProvider returned an invalid date");
    if (localHour(now, this.timeZone) < this.targetHour) return "BEFORE_TARGET_HOUR";
    if (this.running) return "RESERVED_BY_ANOTHER_WORKER";

    const window = localDayUtcWindow(now, this.timeZone);
    const runKey = `daily_operations_run:${window.localDate}`;
    const reservation = this.reserve(runKey, now);
    if (reservation === "ALREADY_QUEUED") return reservation;
    if (reservation === null) return "RESERVED_BY_ANOTHER_WORKER";

    this.running = true;
    try {
      const dispatchPlan = await this.dispatchPlanProvider(this.dispatchPlanLimit);
      if (!Array.isArray(dispatchPlan)) {
        throw new Error("Daily operations dispatchPlanProvider must return an array");
      }
      if (dispatchPlan.length > this.dispatchPlanLimit) {
        throw new Error("Daily operations dispatchPlanProvider exceeded its requested limit");
      }
      const report = buildDailyOperationsReport(this.db, {
        ...window,
        timeZone: this.timeZone,
        generatedAt: now.toISOString(),
        dispatchPlan,
        dispatchPlanLimit: this.dispatchPlanLimit,
      });
      const text = formatDailyOperationsReport(report);
      const receipt = await this.notifier.enqueue({
        eventType: "DAILY_OPERATIONS_REPORT",
        idempotencyKey: runKey,
        report,
        text,
      });
      const queued: RunState = {
        ...reservation,
        state: "QUEUED",
        queuedAt: now.toISOString(),
        ...(receipt?.notificationId ? { notificationId: receipt.notificationId } : {}),
      };
      const changed = this.db.db.prepare(
        "UPDATE settings SET value=?, updated_at=? WHERE key=? AND value=?",
      ).run(JSON.stringify(queued), now.toISOString(), runKey, JSON.stringify(reservation));
      if (Number(changed.changes) !== 1) {
        throw new Error("Daily operations reservation changed before it could be marked queued");
      }
      return "QUEUED";
    } catch (error) {
      this.release(runKey, reservation);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private reserve(runKey: string, now: Date): RunState | "ALREADY_QUEUED" | null {
    const state: RunState = {
      version: 1,
      state: "RESERVED",
      token: crypto.randomUUID(),
      reservedAt: now.toISOString(),
    };
    const serialized = JSON.stringify(state);
    const inserted = this.db.db.prepare(
      "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)",
    ).run(runKey, serialized, now.toISOString());
    if (Number(inserted.changes) === 1) return state;

    const existingValue = this.db.getSetting(runKey);
    if (existingValue === null) return null;
    const existing = parseRunState(existingValue);
    // Unknown/legacy values are treated as completed to preserve once-per-day behavior.
    if (existing === null || existing.state === "QUEUED") return "ALREADY_QUEUED";
    const reservedAt = Date.parse(existing.reservedAt);
    if (Number.isFinite(reservedAt) && now.getTime() - reservedAt < this.reservationTtlMs) return null;

    const takenOver = this.db.db.prepare(
      "UPDATE settings SET value=?, updated_at=? WHERE key=? AND value=?",
    ).run(serialized, now.toISOString(), runKey, existingValue);
    return Number(takenOver.changes) === 1 ? state : null;
  }

  private release(runKey: string, reservation: RunState): void {
    this.db.db.prepare("DELETE FROM settings WHERE key=? AND value=?")
      .run(runKey, JSON.stringify(reservation));
  }
}
