import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION, type PlayInput } from "../src/db.js";

const tempDirs: string[] = [];
const now = "2026-07-19T08:00:00.000Z";

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

function databasePath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function seedV9Database(file: string): void {
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version, name, applied_at) VALUES
      (1, 'v1', '${now}'), (2, 'v2', '${now}'), (3, 'v3', '${now}'),
      (4, 'v4', '${now}'), (5, 'v5', '${now}'), (6, 'v6', '${now}'),
      (7, 'v7', '${now}'), (8, 'v8', '${now}'), (9, 'v9', '${now}');

    CREATE TABLE campaigns(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      market TEXT NOT NULL,
      product TEXT NOT NULL,
      buyer_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE leads(
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES campaigns(id),
      company TEXT NOT NULL,
      domain TEXT NOT NULL,
      website TEXT NOT NULL,
      country TEXT NOT NULL,
      buyer_type TEXT NOT NULL,
      product TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE lead_sources(
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id),
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_date TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contacts(
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id),
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      email TEXT,
      whatsapp TEXT,
      linkedin TEXT,
      source_url TEXT NOT NULL,
      employment_verified_at TEXT,
      email_status TEXT NOT NULL,
      whatsapp_opt_in_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE outbound_messages(id TEXT PRIMARY KEY);
    CREATE TABLE dnc(
      id TEXT PRIMARY KEY,
      value_type TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(value_type, value)
    );

    INSERT INTO campaigns VALUES
      ('campaign_a', 'Malaysia integrators', 'Malaysia', 'sample components', 'integrator',
       'DRAFT', 'legacy-user', '${now}', '${now}'),
      ('campaign_b', 'Vietnam distributors', 'Vietnam', 'sample products', 'distributor',
       'PAUSED', 'legacy-user', '${now}', '${now}');
    INSERT INTO leads VALUES
      ('lead_a1', 'campaign_a', 'Example Manufacturing', 'WWW.Example.COM.',
       'https://example.com', 'Malaysia', 'integrator', 'sample components', 'ENRICHING', '${now}', '${now}'),
      ('lead_a2', 'campaign_b', 'Example Manufacturing Ltd', 'example.com',
       'https://www.example.com', 'Vietnam', 'distributor', 'sample products', 'READY_FOR_REVIEW', '${now}', '${now}'),
      ('lead_b1', 'campaign_a', 'Second Industries', 'second.example',
       'https://second.example', 'Malaysia', 'integrator', 'sample components', 'REJECTED', '${now}', '${now}');
    INSERT INTO lead_sources VALUES
      ('source_1', 'lead_a1', 'https://example.com/about', 'official_website',
       '2026-07-01', 'Legacy source evidence remains in the legacy table', '${now}');
    INSERT INTO contacts VALUES
      ('contact_1', 'lead_a1', 'Alice Tan', 'Procurement Manager', 'ALICE@EXAMPLE.COM',
       '+60 12-345 6789', 'https://www.linkedin.com/in/alice-tan',
       'https://example.com/team', '2026-06-01T00:00:00.000Z', 'VALID',
       '2026-06-02T00:00:00.000Z', '${now}', '${now}'),
      ('contact_2', 'lead_a2', 'Alice Tan', 'Purchasing Lead', 'alice@example.com',
       NULL, NULL, 'https://example.com/people', NULL, 'UNKNOWN', NULL, '${now}', '${now}');
    INSERT INTO outbound_messages VALUES ('legacy_message_1');
    INSERT INTO dnc VALUES
      ('legacy_dnc_1', 'email', 'blocked@example.com', 'legacy opt-out', 'legacy', '${now}');
  `);
  legacy.close();
}

const requiredTables = [
  "accounts", "account_domains", "account_locations", "account_identifiers", "account_sources",
  "facilities", "facility_identifiers", "facility_processes", "lead_account_links",
  "people", "employments", "contact_points", "contact_provider_assertions",
  "plays", "play_versions", "campaign_play_links", "play_enrollments", "exclusions",
  "source_documents", "page_snapshots", "evidence_facts", "company_dossiers", "dossier_versions",
  "provider_registry", "provider_runs", "provider_attempts", "provider_assertions",
  "provider_budgets", "resource_usage", "inquiry_intakes", "inquiry_facts",
  "qualification_runs", "opportunities", "quotes", "sales_tasks", "touchpoints", "consents",
];

describe("acquisition schema v10", () => {
  it("migrates a seeded v9 database into canonical entities without losing compatibility data", () => {
    const file = databasePath("export-agent-schema-v10-migration-");
    seedV9Database(file);

    let db = new AgentDatabase(file);
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    const tables = new Set(
      (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    expect(requiredTables.every((table) => tables.has(table))).toBe(true);

    expect(db.getAcquisitionFoundationSummary()).toMatchObject({
      schemaVersion: LATEST_SCHEMA_VERSION,
      accounts: 2,
      accountDomains: 2,
      people: 2,
      employments: 2,
      contactPoints: 4,
      plays: 2,
      playVersions: 2,
      playEnrollments: 3,
    });
    const exampleAccount = db.getAccountByDomain("https://www.EXAMPLE.com/company");
    expect(exampleAccount).toMatchObject({ primary_domain: "example.com" });
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM lead_account_links WHERE account_id=?",
    ).get(String(exampleAccount?.id))).toMatchObject({ count: 2 });
    expect(db.listAccountPlayEnrollments(String(exampleAccount?.id))).toHaveLength(2);

    const contactOnePoints = db.db.prepare(
      "SELECT kind, verification_status, send_eligible FROM contact_points WHERE legacy_contact_id=? ORDER BY kind",
    ).all("contact_1") as Array<Record<string, unknown>>;
    expect(contactOnePoints.map((row) => row.kind)).toEqual(["EMAIL", "LINKEDIN", "WHATSAPP"]);
    expect(contactOnePoints.every((row) => row.send_eligible === 0)).toBe(true);
    expect(db.db.prepare(
      "SELECT status, is_current FROM employments WHERE legacy_contact_id='contact_1'",
    ).get()).toMatchObject({ status: "STALE", is_current: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM contact_provider_assertions").get())
      .toMatchObject({ count: 4 });

    expect(db.db.prepare("SELECT evidence FROM lead_sources WHERE id='source_1'").get())
      .toMatchObject({ evidence: "Legacy source evidence remains in the legacy table" });
    expect(db.db.prepare("SELECT count(*) AS count FROM account_sources").get())
      .toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM source_documents").get())
      .toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM leads").get()).toMatchObject({ count: 3 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaigns").get()).toMatchObject({ count: 2 });
    expect(db.db.prepare("SELECT count(*) AS count FROM contacts").get()).toMatchObject({ count: 2 });
    expect(db.db.prepare("SELECT count(*) AS count FROM dnc").get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toMatchObject({ count: 1 });
    expect(() => db.db.prepare(
      "UPDATE play_versions SET content_hash='changed-content-hash' WHERE id='play_version_legacy:campaign_a:1'",
    ).run()).toThrow(/immutable/i);
    expect(db.checkIntegrity().ok).toBe(true);

    const beforeReopen = db.getAcquisitionFoundationSummary();
    db.close();
    db = new AgentDatabase(file);
    expect(db.getAcquisitionFoundationSummary()).toEqual(beforeReopen);
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=10").get())
      .toMatchObject({ count: 1 });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("supports account multi-play enrollment, independent exclusions, and idempotent inbound sales flow", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v10-api-"));
    const accountId = db.upsertAccount({
      domain: "WWW.Acme-Industrial.Example.",
      displayName: "Acme Industrial",
      website: "https://acme-industrial.example",
      countryCode: "MY",
      accountType: "END_USER",
      source: "test",
    });
    expect(db.upsertAccount({
      domain: "https://www.acme-industrial.example/about",
      displayName: "Acme Industrial Updated",
    })).toBe(accountId);

    const basePlay: Omit<PlayInput, "key" | "name" | "offer" | "definition"> = {
      country: "Malaysia",
      buyerArchetype: "Industrial end user",
      application: "sample application",
      productFamily: "sample components",
      roleFamily: "Procurement",
      qualificationTrack: "ICP_FIT",
      channel: "EMAIL",
      createdBy: "test",
    };
    const firstPlay = db.upsertPlay({
      ...basePlay,
      key: "my-sample-product-a",
      name: "Malaysia sample components",
      offer: "Application checklist",
      definition: { messageAngle: "maintenance" },
    });
    expect(db.upsertPlay({
      ...basePlay,
      key: "my-sample-product-a",
      name: "Malaysia sample components",
      offer: "Application checklist",
      definition: { messageAngle: "maintenance" },
    })).toEqual(firstPlay);
    const secondVersion = db.upsertPlay({
      ...basePlay,
      key: "my-sample-product-a",
      name: "Malaysia sample components",
      offer: "Application checklist",
      definition: { messageAngle: "downtime" },
    });
    expect(secondVersion).toMatchObject({ playId: firstPlay.playId, versionNumber: 2 });
    const secondPlay = db.upsertPlay({
      ...basePlay,
      key: "my-sample-product-b",
      name: "Malaysia sample products",
      productFamily: "Sample Products",
      offer: "Product selection worksheet",
      definition: { messageAngle: "energy" },
    });

    expect(db.enrollAccountInPlay({
      accountId,
      playVersionId: secondVersion.playVersionId,
      qualificationTrack: "ICP_FIT",
    })).toMatchObject({ inserted: true });
    expect(db.enrollAccountInPlay({
      accountId,
      playVersionId: secondPlay.playVersionId,
      qualificationTrack: "ICP_FIT",
    })).toMatchObject({ inserted: true });
    expect(db.enrollAccountInPlay({
      accountId,
      playVersionId: secondPlay.playVersionId,
      qualificationTrack: "ICP_FIT",
    })).toMatchObject({ inserted: false });
    expect(db.listAccountPlayEnrollments(accountId)).toHaveLength(2);
    expect(db.db.prepare("SELECT count(*) AS count FROM leads").get()).toMatchObject({ count: 0 });
    expect(() => db.db.prepare("UPDATE plays SET status='INVALID' WHERE id=?").run(firstPlay.playId))
      .toThrow();

    const exclusion = db.addExclusion({
      exclusionType: "OUT_OF_ICP",
      accountId,
      reason: "Outside the approved segment",
      source: "human-review",
    });
    expect(exclusion.inserted).toBe(true);
    expect(db.addExclusion({
      exclusionType: "OUT_OF_ICP",
      accountId,
      reason: "Outside the approved segment",
      source: "human-review",
    })).toEqual({ id: exclusion.id, inserted: false });
    expect(db.hasActiveExclusion({ accountId, exclusionType: "OUT_OF_ICP" })).toBe(true);
    expect(db.db.prepare("SELECT count(*) AS count FROM dnc").get()).toMatchObject({ count: 0 });
    expect(db.hasDncMatch([{ type: "domain", value: "acme-industrial.example" }])).toBe(false);

    const intake = db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "provider-event-1",
      messageId: "<message-1@example.test>",
      contentHash: "a".repeat(64),
      sender: "BUYER@ACME-INDUSTRIAL.EXAMPLE",
      recipient: "sales@example.test",
      subject: "RFQ",
      bodyText: "Please quote a sample product systems.",
      receivedAt: now,
      classification: "AMBIGUOUS",
    });
    expect(intake).toMatchObject({ inserted: true, status: "QUARANTINED" });
    expect(db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "provider-event-1",
      messageId: "<different@example.test>",
      contentHash: "b".repeat(64),
      sender: "buyer@acme-industrial.example",
      bodyText: "different payload",
      receivedAt: now,
    }).id).toBe(intake.id);
    expect(db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "provider-event-2",
      messageId: "<message-1@example.test>",
      contentHash: "c".repeat(64),
      sender: "buyer@acme-industrial.example",
      bodyText: "different payload again",
      receivedAt: now,
    }).id).toBe(intake.id);
    expect(db.upsertInquiryIntake({
      source: "EMAIL",
      contentHash: "a".repeat(64),
      sender: "buyer@acme-industrial.example",
      bodyText: "same content hash",
      receivedAt: now,
    }).id).toBe(intake.id);
    db.quarantineInquiryIntake(intake.id, "ambiguous sender", "AMBIGUOUS");

    for (const classification of [
      "REFERRAL", "WRONG_PERSON", "NEEDS_INFO", "NOT_FIT", "SPAM", "AMBIGUOUS",
    ]) {
      expect(db.upsertInquiryIntake({
        source: "EMAIL",
        providerEventId: `classification-${classification}`,
        sender: `${classification.toLowerCase()}@example.test`,
        bodyText: classification,
        receivedAt: now,
        classification,
      }).inserted).toBe(true);
    }

    const opportunity = db.createOrGetOpportunity({
      idempotencyKey: `inquiry-opportunity:${intake.id}`,
      intakeId: intake.id,
      accountId,
      source: "EMAIL_INQUIRY",
      stage: "NEEDS_INFO",
      owner: "sales-owner",
    });
    expect(opportunity.created).toBe(true);
    expect(db.createOrGetOpportunity({
      idempotencyKey: `inquiry-opportunity:${intake.id}`,
      intakeId: intake.id,
      source: "EMAIL_INQUIRY",
    })).toEqual({ id: opportunity.id, created: false });
    expect(db.getOpportunity(opportunity.id)).toMatchObject({ stage: "NEEDS_INFO" });

    const task = db.createOrGetSalesTask({
      idempotencyKey: `inquiry-followup:${opportunity.id}`,
      taskType: "INQUIRY_FOLLOWUP",
      opportunityId: opportunity.id,
      accountId,
      owner: "sales-owner",
      dueAt: "2026-07-19T09:00:00.000Z",
      sourceSignal: intake.id,
    });
    expect(task.created).toBe(true);
    expect(db.createOrGetSalesTask({
      idempotencyKey: `inquiry-followup:${opportunity.id}`,
      taskType: "INQUIRY_FOLLOWUP",
      opportunityId: opportunity.id,
      owner: "sales-owner",
      dueAt: "2026-07-19T09:00:00.000Z",
    })).toEqual({ id: task.id, created: false });
    expect(db.getSalesTask(task.id)).toMatchObject({ status: "OPEN" });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({
      accounts: 1,
      plays: 2,
      playVersions: 3,
      playEnrollments: 2,
      activeExclusions: 1,
      inquiryIntakes: 7,
      quarantinedIntakes: 7,
      opportunities: 1,
      openSalesTasks: 1,
    });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });
});
