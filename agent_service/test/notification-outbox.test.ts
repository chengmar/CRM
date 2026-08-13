import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  AgentDatabase,
  LATEST_SCHEMA_VERSION,
  NOTIFICATION_MAX_ATTEMPTS,
} from "../src/db.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function databasePath(prefix = "export-agent-notification-outbox-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function database(): AgentDatabase {
  return new AgentDatabase(databasePath());
}

function queue(
  db: AgentDatabase,
  eventType: string,
  destination: string,
  payload: Record<string, unknown> = {},
): string {
  const eventId = db.recordEvent("notification", "feishu", eventType, "test", payload);
  return db.queueNotification(eventId, "feishu", destination);
}

describe("notification outbox resilience", () => {
  it("adds schema-18 compatible scheduling columns and quarantines exhausted legacy rows", () => {
    const file = databasePath("export-agent-notification-v18-compat-");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE events(
        id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE notifications(
        id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), channel TEXT NOT NULL,
        destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const migration = legacy.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (let version = 1; version <= LATEST_SCHEMA_VERSION; version += 1) {
      migration.run(version, `legacy-v${version}`, "2026-07-22T00:00:00.000Z");
    }
    legacy.exec(`
      INSERT INTO events VALUES
        ('evt-retry','notification','feishu','REPLY_ALERT','test','{}','2026-07-22T00:00:00.000Z'),
        ('evt-dead','notification','feishu','REPLY_ALERT','test','{}','2026-07-22T00:00:00.000Z');
      INSERT INTO notifications VALUES
        ('ntf-retry','evt-retry','feishu','chat-retry','PENDING',1,'temporary',NULL,'2026-07-22T00:00:00.000Z','2026-07-22T00:00:00.000Z'),
        ('ntf-dead','evt-dead','feishu','chat-dead','PENDING',5,'poison',NULL,'2026-07-22T00:00:00.000Z','2026-07-22T00:05:00.000Z');
      PRAGMA user_version=18;
    `);
    legacy.close();

    const db = new AgentDatabase(file);
    const columns = (db.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["next_attempt_at", "dead_lettered_at"]));
    expect(db.db.prepare(
      "SELECT status, next_attempt_at, dead_lettered_at FROM notifications WHERE id='ntf-retry'",
    ).get()).toEqual({
      status: "PENDING",
      next_attempt_at: "2026-07-22T00:00:00.000Z",
      dead_lettered_at: null,
    });
    expect(db.db.prepare(
      "SELECT status, next_attempt_at, dead_lettered_at FROM notifications WHERE id='ntf-dead'",
    ).get()).toEqual({
      status: "DEAD_LETTER",
      next_attempt_at: null,
      dead_lettered_at: "2026-07-22T00:05:00.000Z",
    });
    expect(db.getMigrationStatus()).toMatchObject({ currentVersion: 19, latestVersion: 19 });
    db.close();
  });

  it("uses bounded exponential backoff and moves the fifth failure to dead letter", () => {
    const db = database();
    const notificationId = queue(db, "REPLY_ALERT", "chat-poison");
    let attemptAt = new Date("2026-07-22T00:00:00.000Z");
    const expectedDelays = [30, 60, 120, 240];

    for (let index = 0; index < expectedDelays.length; index += 1) {
      const result = db.markNotificationFailed(
        notificationId,
        "temporary failure for operator@example.test Bearer secret-token-value",
        attemptAt,
      );
      expect(result).toMatchObject({ status: "PENDING", attempts: index + 1 });
      const expected = new Date(attemptAt.getTime() + expectedDelays[index]! * 1_000).toISOString();
      expect(result?.nextAttemptAt).toBe(expected);
      attemptAt = new Date(expected);
    }

    const dead = db.markNotificationFailed(notificationId, "still failing", attemptAt);
    expect(dead).toEqual({
      status: "DEAD_LETTER",
      attempts: NOTIFICATION_MAX_ATTEMPTS,
      nextAttemptAt: null,
      deadLetteredAt: attemptAt.toISOString(),
    });
    expect(db.listPendingNotifications()).toEqual([]);
    expect(db.getNotificationOutboxSummary(attemptAt)).toMatchObject({
      pendingCount: 0,
      dueCount: 0,
      deadLetterCount: 1,
      oldestPendingAgeSeconds: null,
    });
    const stored = db.db.prepare(
      "SELECT status, attempts, last_error FROM notifications WHERE id=?",
    ).get(notificationId) as { status: string; attempts: number; last_error: string };
    expect(stored).toMatchObject({ status: "DEAD_LETTER", attempts: NOTIFICATION_MAX_ATTEMPTS });
    expect(stored.last_error).not.toContain("operator@example.test");
    expect(stored.last_error).not.toContain("secret-token-value");
    db.close();
  });

  it("selects newer inquiry, bounce, and IMAP alerts ahead of twenty due poison rows", () => {
    const db = database();
    for (let index = 0; index < 20; index += 1) {
      const id = queue(db, "DAILY_OPERATIONS_REPORT", `poison-${index}`, { text: "fixture" });
      db.db.prepare(
        "UPDATE notifications SET created_at=?, updated_at=?, next_attempt_at=? WHERE id=?",
      ).run("2026-07-22T10:00:00.000Z", "2026-07-22T10:00:00.000Z", "2026-07-22T10:00:00.000Z", id);
    }
    const criticalTypes = [
      "INQUIRY_ALERT",
      "EMAIL_HARD_BOUNCE_ALERT",
      "IMAP_RUNTIME_HEALTH_PAUSE",
      "IMAP_MESSAGE_QUARANTINED",
    ];
    for (const eventType of criticalTypes) {
      const id = queue(db, eventType, `critical-${eventType}`);
      db.db.prepare(
        "UPDATE notifications SET created_at=?, updated_at=?, next_attempt_at=? WHERE id=?",
      ).run("2026-07-22T11:00:00.000Z", "2026-07-22T11:00:00.000Z", "2026-07-22T11:00:00.000Z", id);
    }

    const selected = db.listDueNotifications(20, new Date("2026-07-22T12:00:00.000Z"));
    expect(selected).toHaveLength(20);
    expect(new Set(selected.slice(0, criticalTypes.length).map((row) => row.event_type)))
      .toEqual(new Set(criticalTypes));
    expect(selected.filter((row) => String(row.destination).startsWith("poison-"))).toHaveLength(16);
    expect(db.getNotificationOutboxSummary(new Date("2026-07-22T12:00:00.000Z"))).toMatchObject({
      pendingCount: 24,
      dueCount: 24,
      deadLetterCount: 0,
      oldestPendingAgeSeconds: 7_200,
    });
    db.close();
  });

  it("does not retry before due time and recovers after the persisted backoff", async () => {
    const db = database();
    const notificationId = queue(db, "UNKNOWN_FIXTURE_ALERT", "chat-recovery");
    const delivery = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Feishu failure"))
      .mockResolvedValueOnce(undefined);
    const integration = new FeishuIntegration(loadConfig({}), db);
    (integration as unknown as { channel: { send: typeof delivery } }).channel = { send: delivery };
    const queued = db.db.prepare(
      "SELECT next_attempt_at FROM notifications WHERE id=?",
    ).get(notificationId) as { next_attempt_at: string };
    const firstAttemptAt = new Date(Date.parse(queued.next_attempt_at) + 1_000);

    await integration.flushPendingNotifications(firstAttemptAt);
    const failed = db.db.prepare(
      "SELECT status, attempts, next_attempt_at FROM notifications WHERE id=?",
    ).get(notificationId) as { status: string; attempts: number; next_attempt_at: string };
    expect(failed).toMatchObject({ status: "PENDING", attempts: 1 });

    await integration.flushPendingNotifications(new Date(Date.parse(failed.next_attempt_at) - 1));
    expect(delivery).toHaveBeenCalledTimes(1);
    await integration.flushPendingNotifications(new Date(failed.next_attempt_at));
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(db.db.prepare(
      "SELECT status, attempts, next_attempt_at FROM notifications WHERE id=?",
    ).get(notificationId)).toEqual({ status: "SENT", attempts: 2, next_attempt_at: null });
    expect(db.getNotificationOutboxSummary(new Date(failed.next_attempt_at))).toMatchObject({
      pendingCount: 0,
      dueCount: 0,
      deadLetterCount: 0,
    });
    db.close();
  });

  it("defers an unbound alert destination without consuming delivery attempts", async () => {
    const db = database();
    const notificationId = queue(db, "INQUIRY_ALERT", "__configured_alert_destination__");
    const delivery = vi.fn(async () => undefined);
    const integration = new FeishuIntegration(loadConfig({}), db);
    (integration as unknown as { channel: { send: typeof delivery } }).channel = { send: delivery };
    const queued = db.db.prepare(
      "SELECT next_attempt_at FROM notifications WHERE id=?",
    ).get(notificationId) as { next_attempt_at: string };
    const attemptAt = new Date(Date.parse(queued.next_attempt_at) + 1_000);

    await integration.flushPendingNotifications(attemptAt);

    expect(delivery).not.toHaveBeenCalled();
    const deferred = db.db.prepare(
      "SELECT status, attempts, next_attempt_at FROM notifications WHERE id=?",
    ).get(notificationId) as { status: string; attempts: number; next_attempt_at: string };
    expect(deferred).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(deferred.next_attempt_at).toBe(new Date(attemptAt.getTime() + 5 * 60_000).toISOString());
    expect(db.listDueNotifications(20, new Date(attemptAt.getTime() + 4 * 60_000))).toEqual([]);
    db.close();
  });
});
