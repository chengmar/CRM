import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

function createLead(db: AgentDatabase): string {
  const campaignId = db.createCampaign({
    name: "database-operations",
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
  return db.upsertLead({
    campaignId,
    company: "Database Test Company",
    domain: "database-test.invalid",
    website: "https://database-test.invalid",
    country: "Vietnam",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
}

describe("database operations", () => {
  it("initializes fresh operational safety switches in the database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-safe-defaults-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));

    expect(db.getSetting("outbound_paused")).toBe("true");
    expect(db.getSetting("daily_research_enabled")).toBe("false");
    db.close();
  });

  it("lists settings by literal prefix without scanning unrelated keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-setting-prefix-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    db.setSettings({
      "feishu_user:alpha": "one",
      "feishu_user:beta": "two",
      "feishu_users:other": "three",
      "literal_%:match": "four",
      "literal_x:other": "five",
    });

    expect(db.listSettings("feishu_user:")).toEqual({
      "feishu_user:alpha": "one",
      "feishu_user:beta": "two",
    });
    expect(db.listSettings("literal_%:")).toEqual({ "literal_%:match": "four" });
    expect(db.listSettings("")).toMatchObject({
      daily_research_enabled: "false",
      "feishu_user:alpha": "one",
      outbound_paused: "true",
    });

    const queryPlan = db.db.prepare(
      "EXPLAIN QUERY PLAN SELECT key, value FROM settings WHERE key >= ? AND key < ? ORDER BY key",
    ).all("feishu_user:", "feishu_user;") as Array<{ detail: string }>;
    expect(queryPlan.some((row) => row.detail.includes("SEARCH settings USING INDEX"))).toBe(true);
    db.close();
  });

  it("migrates a schema v3 database to idempotent inbound processing without losing source outcomes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-v3-migration-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "agent.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES
        (1, 'initial production schema', '2026-07-14T00:00:00.000Z'),
        (2, 'auditable deep discovery', '2026-07-18T00:00:00.000Z'),
        (3, 'channel-less contact identity deduplication', '2026-07-18T01:00:00.000Z');
      CREATE TABLE leads(
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'READY_FOR_REVIEW',
        send_eligible INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE lead_sources(lead_id TEXT NOT NULL, source_type TEXT NOT NULL);
      CREATE TABLE inbound_messages(
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        lead_id TEXT,
        channel TEXT NOT NULL,
        classification TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE source_metrics(
        source_type TEXT PRIMARY KEY,
        leads INTEGER NOT NULL DEFAULT 0,
        replies INTEGER NOT NULL DEFAULT 0,
        inquiries INTEGER NOT NULL DEFAULT 0,
        bounces INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO leads VALUES ('lead_v3', 'READY_FOR_REVIEW', 1);
      INSERT INTO lead_sources VALUES ('lead_v3', 'official_website'), ('lead_v3', 'official_website');
      INSERT INTO inbound_messages VALUES
        ('inb_reply', 'provider_reply', 'lead_v3', 'email', 'P1_INQUIRY', '2026-07-18T02:00:00.000Z'),
        ('inb_bounce', 'provider_bounce', 'lead_v3', 'email', 'BOUNCE', '2026-07-18T03:00:00.000Z');
      INSERT INTO source_metrics VALUES ('official_website', 99, 99, 99, 99, '2026-07-18T00:00:00.000Z');
      PRAGMA user_version=3;
    `);
    legacy.close();

    const migrated = new AgentDatabase(databasePath);
    expect(migrated.getMigrationStatus()).toMatchObject({
      currentVersion: LATEST_SCHEMA_VERSION,
      latestVersion: LATEST_SCHEMA_VERSION,
    });
    expect(LATEST_SCHEMA_VERSION).toBe(19);
    expect(migrated.db.prepare(
      "SELECT provider_key, status FROM provider_registry WHERE id='provider_bouncer'",
    ).get()).toEqual({ provider_key: "bouncer", status: "ENABLED" });
    expect(migrated.db.prepare(
      `SELECT count(*) AS count FROM schema_migrations
       WHERE version=16 AND name='independent official email verifier provenance'`,
    ).get()).toEqual({ count: 1 });
    expect(
      (migrated.db.prepare("PRAGMA table_info(inbound_messages)").all() as Array<{ name: string }>)
        .some((column) => column.name === "processed_at"),
    ).toBe(true);
    expect(
      (migrated.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>)
        .some((column) => column.name === "dedupe_key"),
    ).toBe(true);
    expect(migrated.db.prepare(
      `SELECT send_eligible, demand_evidence_qualified, demand_policy_version,
         enrichment_attempts, enrichment_next_at
       FROM leads WHERE id='lead_v3'`,
    ).get()).toEqual({
      send_eligible: 0,
      demand_evidence_qualified: 0,
      demand_policy_version: "",
      enrichment_attempts: 0,
      enrichment_next_at: null,
    });
    expect(migrated.listSourceMetrics()).toEqual([
      expect.objectContaining({
        source_type: "official_website",
        leads: 1,
        replies: 1,
        inquiries: 1,
        bounces: 1,
      }),
    ]);
    expect(migrated.checkIntegrity().ok).toBe(true);
    migrated.close();
  });

  it("migrates schema v8 by cancelling duplicate active enrichment jobs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-v8-migration-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "agent.db");

    const current = new AgentDatabase(databasePath);
    const exhaustedLeadId = createLead(current);
    current.transitionLead(exhaustedLeadId, "VERIFYING", "test", "prepare v8 enrichment state");
    current.transitionLead(exhaustedLeadId, "ENRICHING", "test", "prepare v8 enrichment state");
    current.db.prepare(
      "UPDATE leads SET enrichment_attempts=3, enrichment_next_at=NULL WHERE id=?",
    ).run(exhaustedLeadId);
    current.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_jobs_active_dedupe;
      DELETE FROM schema_migrations WHERE version=9;
      ALTER TABLE jobs DROP COLUMN dedupe_key;
      PRAGMA user_version=8;

      INSERT INTO jobs(
        id, job_type, status, payload_json, attempts, max_attempts, run_after,
        locked_at, created_at, updated_at, lane, priority, worker_id, lease_token, lease_expires_at
      ) VALUES
        (
          'job_running', 'ENRICH_CONTACTS', 'RUNNING', '{"campaignId":"campaign_v8","pass":2}',
          1, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:02:00.000Z',
          '2026-07-19T00:02:00.000Z', '2026-07-19T00:02:00.000Z', 'RESEARCH', 10,
          'worker-v8', 'lease-v8', '2026-07-19T00:10:00.000Z'
        ),
        (
          'job_duplicate', 'ENRICH_CONTACTS', 'QUEUED', '{"campaignId":"campaign_v8","pass":2}',
          0, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:01:00.000Z',
          '2026-07-19T00:01:00.000Z', '2026-07-19T00:01:00.000Z', 'RESEARCH', 10,
          'stale-worker', 'stale-lease', '2026-07-19T00:09:00.000Z'
        ),
        (
          'job_next_pass', 'ENRICH_CONTACTS', 'QUEUED', '{"campaignId":"campaign_v8","pass":3}',
          0, 3, '2026-07-19T00:00:00.000Z', NULL,
          '2026-07-19T00:03:00.000Z', '2026-07-19T00:03:00.000Z', 'RESEARCH', 10,
          NULL, NULL, NULL
        ),
        (
          'job_queued_max', 'SYNC_BITABLE', 'QUEUED', '{}',
          3, 3, '2026-07-19T00:00:00.000Z', NULL,
          '2026-07-19T00:04:00.000Z', '2026-07-19T00:04:00.000Z', 'OPERATIONS', 70,
          NULL, NULL, NULL
        ),
        (
          'job_expired_running_max', 'ENRICH_CONTACTS', 'RUNNING',
          '{"campaignId":"campaign_expired","pass":1}',
          3, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:05:00.000Z',
          '2026-07-19T00:05:00.000Z', '2026-07-19T00:05:00.000Z', 'RESEARCH', 10,
          'expired-worker', 'expired-lease', '2000-01-01T00:00:00.000Z'
        ),
        (
          'job_expired_replacement', 'ENRICH_CONTACTS', 'QUEUED',
          '{"campaignId":"campaign_expired","pass":2}',
          0, 3, '2026-07-19T00:00:00.000Z', NULL,
          '2026-07-19T00:06:00.000Z', '2026-07-19T00:06:00.000Z', 'RESEARCH', 10,
          NULL, NULL, NULL
        ),
        (
          'job_invalid_null', 'ENRICH_CONTACTS', 'RUNNING', 'null',
          1, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:07:00.000Z',
          '2026-07-19T00:07:00.000Z', '2026-07-19T00:07:00.000Z', 'RESEARCH', 10,
          'invalid-null-worker', 'invalid-null-lease', '2099-07-19T00:10:00.000Z'
        ),
        (
          'job_invalid_array', 'ENRICH_CONTACTS', 'QUEUED', '[]',
          0, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:08:00.000Z',
          '2026-07-19T00:08:00.000Z', '2026-07-19T00:08:00.000Z', 'RESEARCH', 10,
          'invalid-array-worker', 'invalid-array-lease', '2099-07-19T00:10:00.000Z'
        ),
        (
          'job_missing_campaign', 'ENRICH_CONTACTS', 'RUNNING', '{}',
          1, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:09:00.000Z',
          '2026-07-19T00:09:00.000Z', '2026-07-19T00:09:00.000Z', 'RESEARCH', 10,
          'missing-campaign-worker', 'missing-campaign-lease', '2099-07-19T00:10:00.000Z'
        );
    `);
    legacy.close();

    const migrated = new AgentDatabase(databasePath);
    expect(migrated.getMigrationStatus()).toMatchObject({
      currentVersion: LATEST_SCHEMA_VERSION,
      latestVersion: LATEST_SCHEMA_VERSION,
    });
    expect(migrated.getJob("job_running")).toMatchObject({
      status: "RUNNING",
      dedupe_key: "contact-enrichment:campaign_v8",
      worker_id: "worker-v8",
      lease_token: "lease-v8",
    });
    expect(migrated.getJob("job_duplicate")).toMatchObject({
      status: "FAILED",
      dedupe_key: null,
      last_error: "duplicate active enrichment job cancelled during schema v9 migration",
      locked_at: null,
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(migrated.getJob("job_next_pass")).toMatchObject({
      status: "FAILED",
      dedupe_key: null,
      last_error: "duplicate active enrichment job cancelled during schema v9 migration",
    });
    expect(migrated.getJob("job_queued_max")).toMatchObject({
      status: "FAILED",
      last_error: "queued job was already at maximum attempts during schema v9 migration",
    });
    expect(migrated.getJob("job_expired_running_max")).toMatchObject({
      status: "FAILED",
      last_error: "job lease expired at maximum attempts during schema v9 migration",
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(migrated.getJob("job_expired_replacement")).toMatchObject({
      status: "QUEUED",
      dedupe_key: "contact-enrichment:campaign_expired",
    });
    for (const id of ["job_invalid_null", "job_invalid_array"]) {
      expect(migrated.getJob(id)).toMatchObject({
        status: "FAILED",
        dedupe_key: null,
        last_error: "invalid enrichment payload during active-job deduplication migration",
        locked_at: null,
        worker_id: null,
        lease_token: null,
        lease_expires_at: null,
      });
    }
    expect(migrated.getJob("job_missing_campaign")).toMatchObject({
      status: "FAILED",
      dedupe_key: null,
      last_error: "missing campaign id during active-job deduplication migration",
      locked_at: null,
      worker_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(migrated.getLead(exhaustedLeadId)).toMatchObject({
      status: "ENRICHMENT_EXHAUSTED",
      enrichment_attempts: 3,
      enrichment_next_at: null,
    });
    expect(migrated.enqueueJob(
      "ENRICH_CONTACTS",
      { campaignId: "campaign_v8", pass: 2 },
      undefined,
      { dedupeKey: "contact-enrichment:campaign_v8" },
    )).toBe("job_running");
    expect(migrated.checkIntegrity().ok).toBe(true);
    migrated.close();
  });

  it("tracks schema migrations and preserves queued jobs in a verified snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-db-"));
    tempDirs.push(dir);
    const sourcePath = path.join(dir, "agent.db");
    const snapshotPath = path.join(dir, "snapshot.db");

    const db = new AgentDatabase(sourcePath);
    expect(db.getMigrationStatus()).toMatchObject({
      currentVersion: LATEST_SCHEMA_VERSION,
      latestVersion: LATEST_SCHEMA_VERSION,
    });
    expect(db.checkIntegrity().ok).toBe(true);

    const jobId = db.enqueueJob(
      "PERSISTENCE_PROBE",
      { test: true },
      new Date(Date.now() + 60_000).toISOString(),
    );
    const runningJobId = db.enqueueJob("PERSISTENCE_PROBE", { running: true });
    expect(db.claimDueJob({
      workerId: "snapshot-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })?.id).toBe(runningJobId);
    const snapshot = db.backupTo(snapshotPath);
    expect(snapshot.integrity.ok).toBe(true);
    expect(snapshot.bytes).toBeGreaterThan(0);
    db.close();

    const reopened = new AgentDatabase(sourcePath);
    expect(reopened.getJob(jobId)?.status).toBe("QUEUED");
    expect(reopened.recoverExpiredJobs()).toBe(0);
    reopened.db
      .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", runningJobId);
    expect(reopened.recoverExpiredJobs()).toBe(1);
    expect(reopened.recoverExpiredJobs()).toBe(0);
    expect(reopened.getJob(runningJobId)?.status).toBe("QUEUED");
    reopened.close();

    const restored = new AgentDatabase(snapshotPath);
    expect(restored.getJob(jobId)?.status).toBe("QUEUED");
    expect(restored.checkIntegrity().ok).toBe(true);
    restored.close();
  });

  it("records source outcomes against every independent source without double-counting a URL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-source-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    db.addLeadSource(leadId, "https://example.com/company", "official_website", null, "company page");
    db.addLeadSource(leadId, "https://example.com/company", "official_website", null, "duplicate");
    db.addLeadSource(leadId, "https://example.com/products", "official_website", null, "second URL, same source type");
    db.addLeadSource(leadId, "https://expo.example/2026/company", "trade_show", "2026-05-01", "exhibitor");
    db.recordSourceOutcome(leadId, "reply");
    db.recordSourceOutcome(leadId, "inquiry");
    db.recordSourceOutcome(leadId, "bounce");
    db.recordSourceOutcome(leadId, "reply");
    db.recordSourceOutcome(leadId, "inquiry");
    db.recordSourceOutcome(leadId, "bounce");

    const metrics = db.listSourceMetrics();
    expect(metrics).toHaveLength(2);
    for (const row of metrics) {
      expect(row.leads).toBe(1);
      expect(row.replies).toBe(1);
      expect(row.inquiries).toBe(1);
      expect(row.bounces).toBe(1);
    }
    db.close();
  });

  it("supports global domain deduplication and the contact-enrichment queue", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-enrichment-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    const lead = db.getLead(leadId)!;
    db.transitionLead(leadId, "VERIFYING", "test", "research complete");
    db.transitionLead(leadId, "ENRICHING", "test", "named contact missing");

    expect(db.findLeadByDomain("database-test.invalid")?.id).toBe(leadId);
    expect(db.listEnrichingLeads(String(lead.campaign_id), 10)).toEqual([
      expect.objectContaining({ id: leadId, status: "ENRICHING" }),
    ]);
    db.close();
  });

  it("deduplicates a named contact even when no public email or phone is available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-contact-dedup-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    const first = db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      sourceUrl: "https://example.invalid/about",
      emailStatus: "UNKNOWN",
      emailRisk: "not public",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    const second = db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      sourceUrl: "https://example.invalid/team",
      emailStatus: "UNKNOWN",
      emailRisk: "not public",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    const enriched = db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      email: "jane@example.invalid",
      sourceUrl: "https://example.invalid/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "deep verifier valid",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });

    expect(second).toBe(first);
    expect(enriched).toBe(first);
    expect(db.listContactsForLead(leadId)).toHaveLength(1);
    expect(db.getContact(first)).toMatchObject({
      email: "jane@example.invalid",
      email_status: "VALID",
    });
    db.close();
  });

  it("keeps hard failures and known mailbox risks sticky across re-enrichment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-contact-risk-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    const contactId = db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      email: "jane@example.invalid",
      sourceUrl: "https://example.invalid/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "RISKY",
      emailRisk: "Reacher verdict: risky; catch-all domain",
      roleAddress: false,
      disposableAddress: false,
      catchAll: true,
    });
    db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      email: "jane@example.invalid",
      sourceUrl: "https://example.invalid/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "later provider valid",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    expect(db.getContact(contactId)).toMatchObject({ email_status: "RISKY", catch_all: 1 });

    db.markContactEmailInvalid(contactId, "hard bounce");
    db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Managing Director",
      email: "jane@example.invalid",
      sourceUrl: "https://example.invalid/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "later provider valid",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    expect(db.getContact(contactId)).toMatchObject({
      email_status: "INVALID",
      email_risk: expect.stringContaining("hard bounce"),
      catch_all: 1,
    });
    db.close();
  });

  it("downgrades explicit verifier risk without discarding a prior valid result on transient failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-contact-risk-strength-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    const explicitRiskId = db.upsertContact({
      leadId,
      name: "Explicit Risk",
      title: "Procurement Manager",
      email: "explicit@example.invalid",
      sourceUrl: "https://example.invalid/team",
      emailStatus: "VALID",
      emailRisk: "Reacher verdict: safe",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    db.upsertContact({
      leadId,
      name: "Explicit Risk",
      title: "Procurement Manager",
      email: "explicit@example.invalid",
      sourceUrl: "https://example.invalid/team",
      emailStatus: "RISKY",
      emailRisk: "Reacher verdict: risky",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    expect(db.getContact(explicitRiskId)).toMatchObject({ email_status: "RISKY" });

    const transientId = db.upsertContact({
      leadId,
      name: "Transient Risk",
      title: "Engineering Director",
      email: "transient@example.invalid",
      sourceUrl: "https://example.invalid/team",
      emailStatus: "VALID",
      emailRisk: "Reacher verdict: safe",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    db.upsertContact({
      leadId,
      name: "Transient Risk",
      title: "Engineering Director",
      email: "transient@example.invalid",
      sourceUrl: "https://example.invalid/team",
      emailStatus: "RISKY",
      emailRisk: "MX valid; deep verification unavailable",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    expect(db.getContact(transientId)).toMatchObject({ email_status: "VALID" });
    db.close();
  });

  it("counts only matched distinct leads as replies, inquiries and bounces", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-metrics-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    const now = new Date().toISOString();
    const insert = (
      providerId: string,
      classification: "P1_INQUIRY" | "P2_INTEREST" | "OTHER_REPLY" | "UNKNOWN" | "BOUNCE",
      matched: boolean,
    ) => db.insertInbound({
      channel: "email",
      providerId,
      fromAddress: `${providerId}@example.invalid`,
      bodyText: providerId,
      receivedAt: now,
      classification,
      confidence: 0.9,
      reason: "fixture",
      leadId: matched ? leadId : null,
    });

    insert("matched-inquiry-1", "P1_INQUIRY", true);
    insert("matched-inquiry-2", "P2_INTEREST", true);
    insert("matched-reply", "OTHER_REPLY", true);
    insert("matched-unknown", "UNKNOWN", true);
    insert("matched-bounce", "BOUNCE", true);
    insert("unmatched-inquiry", "P2_INTEREST", false);
    insert("unmatched-reply", "OTHER_REPLY", false);

    expect(db.getMetrics()).toMatchObject({
      replies: 1,
      inquiries: 1,
      bounces: 1,
      softBounces: 0,
      whatsappDeliveryFailures: 0,
      matchedInbound: 5,
      unmatchedInbound: 2,
    });
    db.close();
  });
});
