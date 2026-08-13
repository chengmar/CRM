import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION, type WorkflowAuthorization } from "../src/db.js";

const tempDirs: string[] = [];
const receivedAt = "2026-07-20T08:00:00.000Z";
const agent: WorkflowAuthorization = { actor: "draft-agent", actorType: "AGENT" };
const engineer: WorkflowAuthorization = {
  actor: "engineer@example.test",
  actorType: "HUMAN",
  roles: ["ENGINEERING"],
};
const localizer: WorkflowAuthorization = {
  actor: "localizer@example.test",
  actorType: "HUMAN",
  roles: ["LOCALIZATION", "CONTENT_REVIEW"],
};
const publisher: WorkflowAuthorization = {
  actor: "publisher@example.test",
  actorType: "HUMAN",
  roles: ["PUBLISHER"],
};
const inboundReviewer: WorkflowAuthorization = {
  actor: "inbound@example.test",
  actorType: "HUMAN",
  roles: ["INBOUND_REVIEW"],
};
const salesperson: WorkflowAuthorization = {
  actor: "sales@example.test",
  actorType: "HUMAN",
  roles: ["SALES"],
};
const salesManager: WorkflowAuthorization = {
  actor: "sales-manager@example.test",
  actorType: "HUMAN",
  roles: ["SALES_MANAGER"],
};

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

function seedMinimalV10(file: string): void {
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, name, applied_at) VALUES
      (1,'v1','${receivedAt}'),(2,'v2','${receivedAt}'),(3,'v3','${receivedAt}'),
      (4,'v4','${receivedAt}'),(5,'v5','${receivedAt}'),(6,'v6','${receivedAt}'),
      (7,'v7','${receivedAt}'),(8,'v8','${receivedAt}'),(9,'v9','${receivedAt}'),
      (10,'v10','${receivedAt}');
    CREATE TABLE events(
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE accounts(id TEXT PRIMARY KEY);
    CREATE TABLE people(id TEXT PRIMARY KEY);
    CREATE TABLE source_documents(id TEXT PRIMARY KEY);
    CREATE TABLE outbound_messages(id TEXT PRIMARY KEY);
    CREATE TABLE touchpoints(id TEXT PRIMARY KEY);
    CREATE TABLE inquiry_intakes(
      id TEXT PRIMARY KEY, intake_status TEXT NOT NULL, normalized_sender TEXT NOT NULL,
      received_at TEXT NOT NULL, quarantine_reason TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE opportunities(
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE quotes(
      id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, version_number INTEGER NOT NULL,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, gross_margin_bps INTEGER,
      status TEXT NOT NULL, created_by TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
      quoted_at TEXT, terms_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO inquiry_intakes VALUES
      ('legacy-intake','QUARANTINED','buyer@example.test','${receivedAt}','unmatched','${receivedAt}');
    INSERT INTO opportunities VALUES ('legacy-opportunity','INQUIRY_QUALIFIED','${receivedAt}');
    INSERT INTO quotes VALUES
      ('legacy-quote','legacy-opportunity',1,12500,'USD',2500,'DRAFT','legacy-sales',NULL,NULL,NULL,'{}',
       '${receivedAt}','${receivedAt}');
  `);
  legacy.close();
}

describe("acquisition schema v11", () => {
  it("upgrades a minimal v10 snapshot additively and preserves intake, opportunity, and quote rows", () => {
    const file = databasePath("export-agent-schema-v11-migration-");
    seedMinimalV10(file);

    let db = new AgentDatabase(file);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const requiredTables = [
      "approved_claims",
      "content_assets",
      "content_versions",
      "content_version_claims",
      "translations",
      "terminology_glossary",
      "content_questions",
      "inbound_prospects",
      "inbound_message_links",
    ];
    const tables = new Set(
      (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    expect(requiredTables.every((table) => tables.has(table))).toBe(true);
    expect(db.db.prepare("SELECT count(*) AS count FROM inquiry_intakes").get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM opportunities").get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM quotes").get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=11").get())
      .toMatchObject({ count: 1 });

    db.close();
    db = new AgentDatabase(file);
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=11").get())
      .toMatchObject({ count: 1 });
    db.close();
  });

  it("enforces versioned claim/content review and excludes private, unapproved, and expired facts", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v11-content-"));
    const publicClaim = db.upsertApprovedClaim({
      claimKey: "sample-operating-range",
      claimType: "PRODUCT_PARAMETER",
      statement: "Approved test fixture operating temperature is 80 C.",
      sourceHash: "a".repeat(64),
      visibility: "PUBLIC",
      allowedMarkets: ["MY"],
      allowedChannels: ["website", "email"],
      createdBy: "draft-agent",
    });
    expect(db.upsertApprovedClaim({
      claimKey: "sample-operating-range",
      claimType: "PRODUCT_PARAMETER",
      statement: "Approved test fixture operating temperature is 80 C.",
      sourceHash: "a".repeat(64),
      visibility: "PUBLIC",
      allowedMarkets: ["MY"],
      allowedChannels: ["website", "email"],
      createdBy: "draft-agent",
    })).toEqual({ ...publicClaim, created: false });
    db.transitionApprovedClaim(publicClaim.id, "ENGINEERING_REVIEW", agent, "ready for engineering");
    expect(() => db.transitionApprovedClaim(publicClaim.id, "APPROVED", agent, "agent approval"))
      .toThrow(/authorized human/i);
    db.transitionApprovedClaim(publicClaim.id, "APPROVED", engineer, "fixture evidence checked");
    expect(db.listExternallyUsableApprovedClaims({ market: "MY", channel: "email" }))
      .toHaveLength(1);
    expect(db.listExternallyUsableApprovedClaims({ market: "VN", channel: "email" }))
      .toHaveLength(0);

    const privateClaim = db.upsertApprovedClaim({
      claimKey: "private-customer-case",
      claimType: "CUSTOMER_CASE",
      statement: "Private customer identity and performance figure.",
      sourceHash: "b".repeat(64),
      visibility: "PRIVATE",
      createdBy: "draft-agent",
    });
    db.transitionApprovedClaim(privateClaim.id, "ENGINEERING_REVIEW", agent, "review privately");
    db.transitionApprovedClaim(privateClaim.id, "APPROVED", engineer, "approved for internal use only");
    expect(db.listExternallyUsableApprovedClaims().map((row) => row.id)).not.toContain(privateClaim.id);

    const expiredClaim = db.upsertApprovedClaim({
      claimKey: "expired-performance",
      claimType: "PERFORMANCE",
      statement: "Expired performance figure.",
      sourceHash: "c".repeat(64),
      visibility: "PUBLIC",
      expiresAt: "2020-01-01T00:00:00.000Z",
      createdBy: "draft-agent",
    });
    db.transitionApprovedClaim(expiredClaim.id, "ENGINEERING_REVIEW", agent, "review");
    expect(() => db.transitionApprovedClaim(expiredClaim.id, "APPROVED", engineer, "approve"))
      .toThrow(/expired/i);

    const asset = db.upsertContentAsset({
      assetKey: "my-product-selection-guide",
      assetType: "TECHNICAL_GUIDE",
      title: "Sample Product selection guide",
      defaultLocale: "en-MY",
      visibility: "PUBLIC",
      targetMarkets: ["MY"],
      createdBy: "draft-agent",
    });
    const version = db.upsertContentVersion({
      assetId: asset.id,
      locale: "en-MY",
      body: "Fixture guide: the approved operating temperature is 80 C.",
      approvedClaimIds: [publicClaim.id],
      createdBy: "draft-agent",
    });
    expect(db.upsertContentVersion({
      assetId: asset.id,
      locale: "en-MY",
      body: "Fixture guide: the approved operating temperature is 80 C.",
      approvedClaimIds: [publicClaim.id],
      createdBy: "draft-agent",
    })).toEqual({ ...version, created: false });
    db.transitionContentVersion(version.id, "TECHNICAL_REVIEW", agent, "submit");
    db.transitionContentVersion(version.id, "LOCALIZATION_REVIEW", engineer, "technical facts checked");
    db.transitionContentVersion(version.id, "APPROVED", localizer, "locale checked");
    expect(() => db.transitionContentVersion(version.id, "PUBLISHED", agent, "agent publish"))
      .toThrow(/authorized human/i);
    db.transitionContentVersion(version.id, "PUBLISHED", publisher, "publication fixture approval");
    expect(db.listExternallyUsableContentVersions({ market: "MY", channel: "website", publishedOnly: true }))
      .toHaveLength(1);
    expect(db.listExternallyUsableContentVersions({ market: "VN", channel: "website" }))
      .toHaveLength(0);

    const privateVersion = db.upsertContentVersion({
      assetId: asset.id,
      locale: "en-MY",
      body: "This public draft improperly references a private customer case.",
      approvedClaimIds: [privateClaim.id],
      createdBy: "draft-agent",
    });
    db.transitionContentVersion(privateVersion.id, "TECHNICAL_REVIEW", agent, "submit");
    db.transitionContentVersion(privateVersion.id, "LOCALIZATION_REVIEW", engineer, "review");
    expect(() => db.transitionContentVersion(privateVersion.id, "APPROVED", localizer, "approve"))
      .toThrow(/private, unapproved, stale, revoked, or expired/i);

    const source = db.db.prepare("SELECT content_hash FROM content_versions WHERE id=?")
      .get(version.id) as { content_hash: string };
    const translation = db.upsertTranslation({
      contentVersionId: version.id,
      locale: "ms-MY",
      body: "Panduan pemilihan kipas ujian.",
      sourceHash: source.content_hash,
      createdBy: "draft-agent",
    });
    db.transitionTranslation(translation.id, "LOCALIZATION_REVIEW", agent, "submit");
    db.transitionTranslation(translation.id, "APPROVED", localizer, "reviewed");
    expect(db.db.prepare("SELECT status FROM translations WHERE id=?").get(translation.id))
      .toMatchObject({ status: "APPROVED" });
    expect(() => db.db.prepare(
      "UPDATE content_versions SET status='DRAFT' WHERE id=?",
    ).run(version.id)).toThrow(/invalid content version status transition/i);
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("keeps quarantine decisions idempotent and prevents accepted inbound from becoming a sendable lead", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v11-inbound-"));
    const acceptedIntake = db.upsertInquiryIntake({
      source: "WEB_FORM",
      providerEventId: "form-v11-accepted",
      sender: "buyer@example.test",
      subject: "RFQ",
      bodyText: "Please quote an sample product for our process.",
      receivedAt,
      classification: "P1_INQUIRY",
    });
    expect(() => db.acceptQuarantinedInquiry(acceptedIntake.id, {}, agent, "agent decision"))
      .toThrow(/authorized human/i);
    const accepted = db.acceptQuarantinedInquiry(acceptedIntake.id, {
      fullName: "Test Buyer",
      companyName: "Fixture Manufacturing",
      countryCode: "MY",
      productInterest: "Sample Product",
      consentStatus: "UNKNOWN",
    }, inboundReviewer, "legitimate fixture inquiry");
    expect(accepted.changed).toBe(true);
    expect(db.acceptQuarantinedInquiry(
      acceptedIntake.id,
      { companyName: "ignored on replay" },
      inboundReviewer,
      "replay",
    )).toEqual({ prospectId: accepted.prospectId, changed: false });
    expect(db.db.prepare("SELECT send_eligible FROM inbound_prospects WHERE id=?").get(accepted.prospectId))
      .toMatchObject({ send_eligible: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM leads").get()).toMatchObject({ count: 0 });
    expect(db.db.prepare("SELECT stage, intake_id FROM opportunities WHERE intake_id=?")
      .get(acceptedIntake.id)).toMatchObject({
        stage: "INQUIRY_QUALIFIED",
        intake_id: acceptedIntake.id,
      });
    expect(db.db.prepare("SELECT task_type, source_signal FROM sales_tasks").get()).toMatchObject({
      task_type: "INQUIRY_FOLLOWUP",
      source_signal: "P1_INQUIRY",
    });
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM events WHERE entity_id=? AND event_type='INQUIRY_QUARANTINE_ACCEPTED'",
    ).get(acceptedIntake.id)).toMatchObject({ count: 1 });
    expect(() => db.rejectQuarantinedInquiry(acceptedIntake.id, inboundReviewer, "incorrect reversal"))
      .toThrow(/accepted/i);

    const rejectedIntake = db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "email-v11-rejected",
      sender: "ambiguous@example.test",
      bodyText: "Ambiguous fixture payload",
      receivedAt,
      classification: "AMBIGUOUS",
    });
    expect(db.rejectQuarantinedInquiry(rejectedIntake.id, inboundReviewer, "manual fixture rejection"))
      .toEqual({ changed: true });
    expect(db.rejectQuarantinedInquiry(rejectedIntake.id, inboundReviewer, "replay"))
      .toEqual({ changed: false });
    expect(db.db.prepare("SELECT body_text, quarantine_decision FROM inquiry_intakes WHERE id=?")
      .get(rejectedIntake.id)).toMatchObject({
      body_text: "Ambiguous fixture payload",
      quarantine_decision: "REJECTED",
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM inbound_prospects WHERE intake_id=?")
      .get(rejectedIntake.id)).toMatchObject({ count: 0 });
    expect(db.linkInboundMessage({
      intakeId: acceptedIntake.id,
      inboundMessageId: "fixture-inbound-message-id",
      correlationMethod: "PROVIDER_EVENT_ID",
      correlationConfidence: 1,
      idempotencyKey: "link:fixture-inbound-message-id",
    }).created).toBe(true);
    expect(db.linkInboundMessage({
      intakeId: acceptedIntake.id,
      inboundMessageId: "fixture-inbound-message-id",
      correlationMethod: "PROVIDER_EVENT_ID",
      correlationConfidence: 1,
      idempotencyKey: "link:fixture-inbound-message-id",
    }).created).toBe(false);
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("allows only authorized humans to set quote money and close WON with an accepted quote", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v11-opportunity-"));
    const intake = db.upsertInquiryIntake({
      source: "MANUAL",
      providerEventId: "opportunity-v11",
      sender: "buyer@example.test",
      bodyText: "Fixture inquiry",
      receivedAt,
      classification: "P1_INQUIRY",
    });
    const opportunity = db.createOrGetOpportunity({
      idempotencyKey: `opportunity:${intake.id}`,
      intakeId: intake.id,
      source: "INBOUND_FIXTURE",
      stage: "INQUIRY_QUALIFIED",
    });
    expect(() => db.createOrGetOpportunity({
      idempotencyKey: "forbidden-direct-won",
      intakeId: intake.id,
      source: "INBOUND_FIXTURE",
      stage: "WON",
    })).toThrow(/authorized human/i);
    db.transitionOpportunityStage(
      opportunity.id,
      "TECHNICAL_DISCOVERY",
      { actor: "opportunity-router", actorType: "SYSTEM" },
      "qualified fixture",
    );
    expect(() => db.createQuote({
      opportunityId: opportunity.id,
      idempotencyKey: "quote:v11:1",
      amountMinor: 125_000,
      currency: "USD",
      grossMarginBps: 3200,
    }, agent)).toThrow(/authorized human/i);
    const quote = db.createQuote({
      opportunityId: opportunity.id,
      idempotencyKey: "quote:v11:1",
      amountMinor: 125_000,
      currency: "usd",
      grossMarginBps: 3200,
      terms: { fixture: true },
    }, salesperson);
    expect(db.createQuote({
      opportunityId: opportunity.id,
      idempotencyKey: "quote:v11:1",
      amountMinor: 999_999,
      currency: "USD",
    }, salesperson)).toEqual({ ...quote, created: false });
    db.transitionQuoteStatus(quote.id, "APPROVED", salesperson, "sales review");
    db.transitionQuoteStatus(quote.id, "SUBMITTED", salesperson, "fixture submission");
    expect(db.getOpportunity(opportunity.id)).toMatchObject({ stage: "QUOTED" });
    db.transitionOpportunityStage(opportunity.id, "NEGOTIATION", salesperson, "buyer negotiating");
    db.transitionQuoteStatus(quote.id, "ACCEPTED", salesperson, "buyer accepted fixture quote");
    expect(() => db.transitionOpportunityStage(
      opportunity.id,
      "WON",
      salesperson,
      "close won",
      { wonQuoteId: quote.id },
    )).toThrow(/SALES_MANAGER/i);
    db.transitionOpportunityStage(
      opportunity.id,
      "WON",
      salesManager,
      "authorized fixture close",
      { wonQuoteId: quote.id },
    );
    expect(db.getOpportunity(opportunity.id)).toMatchObject({
      stage: "WON",
      won_quote_id: quote.id,
      won_amount_minor: 125_000,
      won_currency: "USD",
      won_gross_margin_bps: 3200,
      won_by: salesManager.actor,
    });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });
});
