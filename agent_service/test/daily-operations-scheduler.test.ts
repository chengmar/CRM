import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";
import {
  DailyOperationsScheduler,
  type DailyOperationsNotifier,
} from "../src/jobs/daily-operations.js";

const tempDirs: string[] = [];
const afterTarget = new Date("2026-07-19T02:00:00.000Z");
const beforeTarget = new Date("2026-07-19T00:30:00.000Z");
const runKey = "daily_operations_run:2026-07-19";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
});

function databasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-daily-operations-scheduler-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function notifier() {
  return {
    enqueue: vi.fn<DailyOperationsNotifier["enqueue"]>(async () => ({ notificationId: "ntf-report" })),
  };
}

function options() {
  return {
    targetHour: 9,
    dailySendCapacity: 500,
    dispatchPlanLimit: 20,
    timeZone: "Asia/Shanghai",
    reservationTtlMs: 15 * 60_000,
  };
}

describe("daily operations scheduler", () => {
  it("uses the Shanghai local-day window, waits for the target hour and covers daily capacity", async () => {
    const db = new AgentDatabase(databasePath());
    const plan = vi.fn(async () => [{ allowed: true }, { allowed: false }]);
    const durable = notifier();
    const early = new DailyOperationsScheduler(db, options(), plan, durable, () => beforeTarget);

    await expect(early.tick()).resolves.toBe("BEFORE_TARGET_HOUR");
    expect(plan).not.toHaveBeenCalled();

    const scheduler = new DailyOperationsScheduler(db, options(), plan, durable, () => afterTarget);
    expect(scheduler.getPlanLimit()).toBe(500);
    await expect(scheduler.tick()).resolves.toBe("QUEUED");
    expect(plan).toHaveBeenCalledWith(500);
    expect(durable.enqueue).toHaveBeenCalledOnce();
    expect(durable.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "DAILY_OPERATIONS_REPORT",
      idempotencyKey: runKey,
      report: expect.objectContaining({
        localDate: "2026-07-19",
        timeZone: "Asia/Shanghai",
        startAt: "2026-07-18T16:00:00.000Z",
        endAt: "2026-07-19T16:00:00.000Z",
        inventory: expect.objectContaining({ dispatchPlanLimit: 500 }),
      }),
      text: expect.stringContaining("外贸智能体运营日报 2026-07-19"),
    }));
    expect(JSON.parse(db.getSetting(runKey) ?? "{}")).toMatchObject({
      version: 1,
      state: "QUEUED",
      notificationId: "ntf-report",
    });

    await expect(scheduler.tick()).resolves.toBe("ALREADY_QUEUED");
    expect(plan).toHaveBeenCalledOnce();
    expect(durable.enqueue).toHaveBeenCalledOnce();
    db.close();
  });

  it("does not leave a completed marker when durable notification enqueue fails and retries cleanly", async () => {
    const db = new AgentDatabase(databasePath());
    const plan = vi.fn(async () => []);
    const enqueue = vi.fn<DailyOperationsNotifier["enqueue"]>()
      .mockRejectedValueOnce(new Error("durable queue unavailable"))
      .mockResolvedValueOnce({ notificationId: "ntf-retry" });
    const scheduler = new DailyOperationsScheduler(
      db,
      options(),
      plan,
      { enqueue },
      () => afterTarget,
    );

    await expect(scheduler.tick()).rejects.toThrow("durable queue unavailable");
    expect(db.getSetting(runKey)).toBeNull();
    await expect(scheduler.tick()).resolves.toBe("QUEUED");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(JSON.parse(db.getSetting(runKey) ?? "{}")).toMatchObject({
      state: "QUEUED",
      notificationId: "ntf-retry",
    });
    db.close();
  });

  it("uses a database reservation to prevent duplicate reports across scheduler instances", async () => {
    const file = databasePath();
    const firstDb = new AgentDatabase(file);
    const secondDb = new AgentDatabase(file);
    const plan = vi.fn(async () => []);
    const durable = notifier();
    const first = new DailyOperationsScheduler(firstDb, options(), plan, durable, () => afterTarget);
    const second = new DailyOperationsScheduler(secondDb, options(), plan, durable, () => afterTarget);

    const results = await Promise.all([first.tick(), second.tick()]);
    expect(results).toContain("QUEUED");
    expect(results).toContain("RESERVED_BY_ANOTHER_WORKER");
    expect(plan).toHaveBeenCalledOnce();
    expect(durable.enqueue).toHaveBeenCalledOnce();
    firstDb.close();
    secondDb.close();
  });

  it("takes over an expired reservation but leaves a fresh reservation alone", async () => {
    const db = new AgentDatabase(databasePath());
    const plan = vi.fn(async () => []);
    const durable = notifier();
    const scheduler = new DailyOperationsScheduler(db, options(), plan, durable, () => afterTarget);
    db.setSetting(runKey, JSON.stringify({
      version: 1,
      state: "RESERVED",
      token: "expired-worker",
      reservedAt: "2026-07-19T01:30:00.000Z",
    }));

    await expect(scheduler.tick()).resolves.toBe("QUEUED");
    expect(durable.enqueue).toHaveBeenCalledOnce();

    db.db.prepare("DELETE FROM settings WHERE key=?").run(runKey);
    db.setSetting(runKey, JSON.stringify({
      version: 1,
      state: "RESERVED",
      token: "active-worker",
      reservedAt: "2026-07-19T01:55:00.000Z",
    }));
    await expect(scheduler.tick()).resolves.toBe("RESERVED_BY_ANOTHER_WORKER");
    expect(durable.enqueue).toHaveBeenCalledOnce();
    db.close();
  });

  it("can be disabled through settings and validates scheduler limits", async () => {
    const db = new AgentDatabase(databasePath());
    const plan = vi.fn(async () => []);
    const durable = notifier();
    db.setSetting("daily_operations_enabled", "false");
    const scheduler = new DailyOperationsScheduler(db, options(), plan, durable, () => afterTarget);
    await expect(scheduler.tick()).resolves.toBe("DISABLED");
    expect(plan).not.toHaveBeenCalled();
    expect(() => new DailyOperationsScheduler(
      db,
      { ...options(), targetHour: 24 },
      plan,
      durable,
    )).toThrow("targetHour");
    db.close();
  });

  it("uses the real Feishu bridge to persist one retryable report while offline", async () => {
    const db = new AgentDatabase(databasePath());
    const feishu = new FeishuIntegration(loadConfig({}), db);
    const scheduler = new DailyOperationsScheduler(
      db,
      options(),
      async () => [],
      { enqueue: (notification) => feishu.enqueueDailyOperationsReport(notification) },
      () => afterTarget,
    );

    await expect(scheduler.tick()).resolves.toBe("QUEUED");
    await expect(scheduler.tick()).resolves.toBe("ALREADY_QUEUED");
    const pending = db.listPendingNotifications(100);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      event_type: "DAILY_OPERATIONS_REPORT",
      status: "PENDING",
    });
    expect(JSON.parse(String(pending[0]?.payload_json))).toMatchObject({
      report: { localDate: "2026-07-19" },
      text: expect.stringContaining("外贸智能体运营日报 2026-07-19"),
    });
    db.close();
  });
});
