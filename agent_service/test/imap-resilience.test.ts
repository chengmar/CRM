import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchMessageObject } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import {
  getImapRuntimeHealth,
  initializeImapRuntimeHealth,
  recordImapPollFailure,
  recordImapPollSuccess,
  type ImapHealthTransition,
} from "../src/inbound/email-health.js";
import { EmailInboundListener } from "../src/inbound/email-listener.js";
import type { InboundProcessor } from "../src/inbound/processor.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";
import {
  imapMessageQuarantineCard,
  imapRuntimeHealthCard,
} from "../src/integrations/feishu/cards.js";
import type { AgentLlm } from "../src/llm.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-imap-resilience-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function config(overrides: NodeJS.ProcessEnv = {}): AgentConfig {
  return loadConfig({
    EMAIL_INBOUND_ENABLED: "true",
    EMAIL_POLL_SECONDS: "15",
    IMAP_HEALTH_STALE_SECONDS: "45",
    IMAP_FAILURE_PAUSE_THRESHOLD: "3",
    IMAP_MESSAGE_MAX_ATTEMPTS: "2",
    EMAIL_FROM_ADDRESS: "sender@example.invalid",
    IMAP_HOST: "imap.example.invalid",
    IMAP_USER: "sender@example.invalid",
    IMAP_PASSWORD: "test-only",
    FEISHU_BOT_ENABLED: "true",
    FEISHU_APP_ID: "fixture-app",
    FEISHU_APP_SECRET: "test-only",
    FEISHU_ALERT_OPEN_IDS: "ou_fixture",
    ...overrides,
  });
}

type ListenerInternals = {
  client: unknown;
  uidValidity: string;
  poll(): Promise<boolean>;
  processMessage(message: FetchMessageObject): Promise<void>;
  handleFetchedMessage(message: FetchMessageObject): Promise<void>;
  stageHealthNotification(transition: ImapHealthTransition): void;
};

function listenerFixture(db: AgentDatabase, cfg = config()): {
  listener: EmailInboundListener;
  feishu: FeishuIntegration;
  internals: ListenerInternals;
} {
  const feishu = new FeishuIntegration(cfg, db);
  const listener = new EmailInboundListener(
    cfg,
    db,
    {} as AgentLlm,
    {} as InboundProcessor,
    feishu,
  );
  return { listener, feishu, internals: listener as unknown as ListenerInternals };
}

function fetched(uid: number, subject: string, body: string): FetchMessageObject {
  return {
    uid,
    envelope: {
      subject,
      from: [{ address: "private.sender@example.invalid" }],
    },
    source: Buffer.from([
      "From: private.sender@example.invalid",
      "To: sender@example.invalid",
      `Subject: ${subject}`,
      "",
      body,
    ].join("\r\n")),
  } as unknown as FetchMessageObject;
}

function countEvents(db: AgentDatabase, eventType: string): number {
  return Number((db.db.prepare(
    "SELECT count(*) AS count FROM events WHERE event_type=?",
  ).get(eventType) as { count: number }).count);
}

describe("IMAP runtime health gate", () => {
  it("pauses and durably alerts after threshold failures before the first successful poll", () => {
    const db = database();
    const cfg = config();
    const { internals } = listenerFixture(db, cfg);
    const started = new Date("2026-07-22T00:00:00.000Z");
    initializeImapRuntimeHealth(cfg, db, started);
    db.setSetting("outbound_paused", "false");

    let transition: ImapHealthTransition | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      transition = recordImapPollFailure(
        cfg,
        db,
        { errorClass: "EAUTH", message: "authentication failed" },
        new Date(started.getTime() + attempt * 1_000),
      );
      internals.stageHealthNotification(transition);
    }

    expect(transition?.health).toMatchObject({
      state: "UNHEALTHY",
      sendReady: false,
      consecutiveFailures: 3,
      pauseEpisode: 1,
    });
    expect(db.getSetting("outbound_paused")).toBe("true");
    expect(countEvents(db, "IMAP_RUNTIME_HEALTH_PAUSE")).toBe(1);
    expect(db.listPendingNotifications()).toHaveLength(1);

    const recovered = recordImapPollSuccess(
      cfg,
      db,
      new Date(started.getTime() + 4_000),
    );
    internals.stageHealthNotification(recovered);
    expect(recovered).toMatchObject({ recovered: true, health: { state: "HEALTHY", sendReady: true } });
    expect(db.getSetting("outbound_paused")).toBe("true");
    expect(countEvents(db, "IMAP_RUNTIME_RECOVERED")).toBe(1);
    db.close();
  });

  it("turns a hung first poll into STALE, pauses, and alerts after the startup deadline", () => {
    const db = database();
    const cfg = config();
    const { listener } = listenerFixture(db, cfg);
    const started = new Date("2026-07-22T00:00:00.000Z");
    initializeImapRuntimeHealth(cfg, db, started);
    db.setSetting("outbound_paused", "false");

    expect(getImapRuntimeHealth(cfg, db, new Date(started.getTime() + 45_000))).toMatchObject({
      state: "STARTING",
      sendReady: false,
    });
    const health = listener.enforceHealthGate(new Date(started.getTime() + 46_000));

    expect(health).toMatchObject({ state: "STALE", sendReady: false, pauseEpisode: 1 });
    expect(db.getSetting("outbound_paused")).toBe("true");
    expect(countEvents(db, "IMAP_RUNTIME_HEALTH_PAUSE")).toBe(1);
    listener.enforceHealthGate(new Date(started.getTime() + 60_000));
    expect(countEvents(db, "IMAP_RUNTIME_HEALTH_PAUSE")).toBe(1);
    db.close();
  });
});

describe("IMAP poison-message isolation and replay", () => {
  it("quarantines one failing UID, preserves only replay metadata, and processes the next UID", async () => {
    const db = database();
    const cfg = config();
    const { internals } = listenerFixture(db, cfg);
    internals.uidValidity = "777";
    db.setSetting("imap_uid_validity", "777");
    db.setSetting("imap_last_uid", "0");
    const privateBody = "private original body that must not be copied into quarantine";
    const bad = fetched(10, "Quote for buyer@example.invalid", privateBody);
    const good = fetched(11, "Normal reply", "normal body");
    const processed: number[] = [];
    vi.spyOn(internals, "processMessage").mockImplementation(async (message) => {
      processed.push(Number(message.uid));
      if (message.uid === 10) {
        throw new Error("parse failed for buyer@example.invalid at imap.private.example");
      }
    });
    internals.client = {
      usable: true,
      search: vi.fn(async () => [10, 11]),
      fetchOne: vi.fn(async (uid: number) => uid === 10 ? bad : good),
    };

    await expect(internals.poll()).resolves.toBe(true);
    expect(processed).toEqual([10, 11]);
    expect(db.getSetting("imap_last_uid")).toBe("11");
    expect(db.getImapMessageFailure("777", 10)).toMatchObject({
      status: "RETRY_PENDING",
      attempts: 1,
    });

    await internals.handleFetchedMessage(bad);
    const failure = db.getImapMessageFailure("777", 10)!;
    expect(failure).toMatchObject({
      status: "QUARANTINED",
      attempts: 2,
      quarantine_episode: 1,
      source_size: bad.source?.length,
    });
    expect(failure.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(failure.last_error_message).not.toContain("buyer@example.invalid");
    expect(failure.last_error_message).not.toContain("imap.private.example");
    expect(failure.preview_json).not.toContain(privateBody);
    expect(JSON.stringify(db.listQuarantinedImapMessages())).not.toContain(privateBody);
    const columns = db.db.prepare("PRAGMA table_info(imap_message_failures)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("raw_source");
    expect(countEvents(db, "IMAP_MESSAGE_QUARANTINED")).toBe(1);

    const cursorBefore = db.getSetting("imap_last_uid");
    const mismatch = db.requestImapMessageReplay(failure.id, "operator", "888");
    expect(mismatch).toMatchObject({ requested: false });
    expect(mismatch.reason).toContain("UIDVALIDITY");
    expect(db.getSetting("imap_last_uid")).toBe(cursorBefore);

    const requested = db.requestImapMessageReplay(failure.id, "operator", "777");
    expect(requested).toMatchObject({
      requested: true,
      record: { status: "RETRY_PENDING", attempts: 0 },
    });
    expect(db.getSetting("imap_last_uid")).toBe(cursorBefore);
    expect(db.requestImapMessageReplay(failure.id, "operator", "777")).toMatchObject({
      requested: false,
      reason: expect.stringContaining("等待重新处理"),
    });
    expect(countEvents(db, "IMAP_MESSAGE_REPLAY_REQUESTED")).toBe(1);
    expect(db.listImapRetryUids("777")).toContain(10);

    vi.mocked(internals.processMessage).mockResolvedValue(undefined);
    await internals.handleFetchedMessage(bad);
    expect(db.getImapMessageFailure("777", 10)).toMatchObject({ status: "RESOLVED" });
    expect(db.getSetting("imap_last_uid")).toBe(cursorBefore);
    db.close();
  });

  it("marks old UIDVALIDITY records unreplayable without changing the mailbox cursor", () => {
    const db = database();
    const sourceSha256 = "a".repeat(64);
    const first = db.recordImapMessageFailure({
      uidValidity: "old",
      uid: 12,
      maxAttempts: 1,
      sourceSha256,
      sourceSize: 10,
      preview: { subject: "old" },
      errorClass: "ParseError",
      errorMessage: "failed",
    });
    db.setSetting("imap_last_uid", "99");
    expect(db.expireImapFailuresForUidValidity("new")).toBe(1);
    expect(db.getImapMessageFailure("old", 12)).toMatchObject({ status: "UNREPLAYABLE" });
    expect(db.requestImapMessageReplay(first.id, "operator", "new")).toMatchObject({
      requested: false,
      reason: expect.stringContaining("UIDVALIDITY"),
    });
    expect(db.getSetting("imap_last_uid")).toBe("99");
    db.close();
  });
});

describe("IMAP operations cards", () => {
  it("uses direct Chinese guidance and does not render private error text", () => {
    const health = JSON.stringify(imapRuntimeHealthCard({
      episode: 1,
      state: "UNHEALTHY",
      reason: "private internal reason",
      consecutiveFailures: 3,
      failurePauseThreshold: 3,
      lastPollSuccessAt: null,
      pausedAt: "2026-07-22T00:00:00.000Z",
      recovered: false,
      globalPauseRemains: true,
    }));
    expect(health).toContain("收件监控异常");
    expect(health).toContain("系统已暂停外发");
    expect(health).toContain("客户端专用密码");
    expect(health).not.toContain("private internal reason");

    const quarantine = JSON.stringify(imapMessageQuarantineCard({
      failureId: "imapfail_fixture",
      uidValidity: "777",
      uid: 10,
      attempts: 2,
      maxAttempts: 2,
      quarantineEpisode: 1,
      sourceSha256: "b".repeat(64),
      sourceSize: 100,
      preview: { subject: "脱敏主题" },
      errorClass: "ParseError",
      errorMessage: "private-user@example.invalid imap.private.example secret-value",
    }));
    expect(quarantine).toContain("一封异常邮件已隔离");
    expect(quarantine).toContain("后续收件继续处理");
    expect(quarantine).toContain("replay_quarantined_imap_message");
    expect(quarantine).toContain("确认重新处理");
    expect(quarantine).not.toContain("private-user@example.invalid");
    expect(quarantine).not.toContain("imap.private.example");
  });
});

describe("schema v18 IMAP migration", () => {
  it("upgrades a v17 database, preserves data, and remains restart-idempotent", () => {
    const db = database();
    const databasePath = db.databasePath;
    db.setSetting("preserved_fixture", "yes");
    db.db.exec(`
      DROP TABLE imap_message_failures;
      DELETE FROM schema_migrations WHERE version=18;
      PRAGMA user_version=17;
    `);
    db.close();

    const upgraded = new AgentDatabase(databasePath);
    expect(LATEST_SCHEMA_VERSION).toBe(19);
    expect(upgraded.getSchemaVersion()).toBe(19);
    expect(upgraded.getSetting("preserved_fixture")).toBe("yes");
    expect(upgraded.checkIntegrity()).toMatchObject({ ok: true, foreignKeyViolations: 0 });
    expect(upgraded.db.prepare(
      "SELECT count(*) AS count FROM schema_migrations WHERE version=18",
    ).get()).toEqual({ count: 1 });
    upgraded.close();

    const restarted = new AgentDatabase(databasePath);
    expect(restarted.getSchemaVersion()).toBe(19);
    expect(restarted.db.prepare(
      "SELECT count(*) AS count FROM schema_migrations WHERE version=18",
    ).get()).toEqual({ count: 1 });
    expect(restarted.db.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='imap_message_failures'",
    ).get()).toEqual({ count: 1 });
    restarted.close();
  });
});
