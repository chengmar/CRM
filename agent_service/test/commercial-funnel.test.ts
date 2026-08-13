import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDatabase,
  LATEST_SCHEMA_VERSION,
  type WorkflowAuthorization,
} from "../src/db.js";
import {
  buildCommercialFunnelReport,
  parseCommercialFunnelCliOptions,
  runCommercialFunnelOperator,
  type CommercialSlice,
  type TouchpointAttributionSlice,
} from "../src/reporting/commercial-funnel.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];
const databases: AgentDatabase[] = [];
const createdAt = "2026-07-20T01:00:00.000Z";
const deliveredAt = "2026-07-20T02:00:00.000Z";
const generatedAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
const salesperson: WorkflowAuthorization = {
  actor: "sales-fixture",
  actorType: "HUMAN",
  roles: ["SALES", "SALES_MANAGER"],
};

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // Individual tests close successful fixtures before cleanup.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDatabase(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commercial-funnel-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  databases.push(db);
  return db;
}

interface DeliveryFixture {
  accountId: string;
  campaignId: string;
  enrollmentId: string;
  leadId: string;
  messageId: string;
  playId: string;
  playVersionId: string;
}

function createDeliveryFixture(
  db: AgentDatabase,
  input: {
    key: string;
    market: string;
    track: "ACTIVE_INTENT" | "ICP_FIT";
    offer: string;
    channel: "email" | "whatsapp";
    status: "DELIVERED" | "REPLIED" | "SENT";
    accountId?: string;
  },
): DeliveryFixture {
  const campaignId = db.createCampaign({
    name: `${input.key} campaign`,
    market: input.market,
    product: "sample product application",
    buyerType: "industrial end user",
    targetCount: 20,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [3, 7],
  });
  const play = db.upsertPlay({
    key: `${input.key}-play`,
    name: `${input.market} ${input.offer}`,
    country: input.market,
    buyerArchetype: "industrial end user",
    application: `${input.key} sample application`,
    productFamily: "sample products",
    roleFamily: "engineering",
    qualificationTrack: input.track,
    offer: input.offer,
    channel: input.channel === "email" ? "EMAIL" : "WHATSAPP",
    status: "APPROVED",
    definition: { fixture: input.key },
    createdBy: "fixture",
  });
  db.linkCampaignToPlayVersion(campaignId, play.playVersionId, "fixture");
  const accountId = input.accountId ?? db.upsertAccount({
    domain: `${input.key}.commercial-fixture.example`,
    displayName: `${input.key} account`,
    countryCode: input.market,
    source: "fixture",
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `${input.key} company`,
    domain: `${input.key}.lead-fixture.example`,
    website: `https://${input.key}.lead-fixture.example`,
    country: input.market,
    buyerType: "industrial end user",
    product: "sample products",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: createdAt,
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ sourceUrl: `https://${input.key}.lead-fixture.example/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const legacyEnrollment = db.db.prepare(
    "SELECT id FROM play_enrollments WHERE legacy_lead_id=?",
  ).get(leadId) as { id: string };
  db.db.prepare(`
    UPDATE play_enrollments SET account_id=?, play_version_id=?, campaign_id=?,
      status='APPROVED', qualification_track=?, source='fixture', updated_at=? WHERE id=?
  `).run(
    accountId,
    play.playVersionId,
    campaignId,
    input.track,
    createdAt,
    legacyEnrollment.id,
  );
  const email = `${input.key}@${input.key}.lead-fixture.example`;
  const whatsapp = `+6010000${input.key.replace(/\D/g, "").padStart(4, "0")}`;
  const contactId = db.upsertContact({
    leadId,
    name: `${input.key} buyer`,
    title: "Engineering Manager",
    email,
    whatsapp,
    sourceUrl: `https://${input.key}.lead-fixture.example/team`,
    employmentVerifiedAt: createdAt,
    emailStatus: "VALID",
    emailRisk: "fixture verification",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
    whatsappOptInAt: createdAt,
  });
  db.transitionLead(leadId, "VERIFYING", "fixture", "verified fixture");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "fixture", "ready fixture");
  const messageId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: input.channel,
    destination: input.channel === "email" ? email : whatsapp,
    subject: "Fixture subject",
    body: "Fixture body",
    sequenceIndex: 0,
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "fixture-reviewer", db.getSequenceReviewHash(leadId));
  db.setSetting("outbound_paused", "false");
  db.claimMessageForSending(messageId);
  db.markMessageSent(messageId, `<${input.key}@provider.fixture>`);
  db.db.prepare("UPDATE outbound_messages SET sent_at=?, updated_at=? WHERE id=?")
    .run(deliveredAt, deliveredAt, messageId);
  if (input.status === "DELIVERED") {
    db.db.prepare("UPDATE outbound_messages SET status='DELIVERED', updated_at=? WHERE id=?")
      .run(deliveredAt, messageId);
  } else if (input.status === "REPLIED") {
    db.markOutboundFromInbound(messageId, "REPLIED");
  }
  return {
    accountId,
    campaignId,
    enrollmentId: legacyEnrollment.id,
    leadId,
    messageId,
    playId: play.playId,
    playVersionId: play.playVersionId,
  };
}

function addProviderCost(
  db: AgentDatabase,
  fixture: DeliveryFixture,
  key: string,
  costMicros: number,
): void {
  const providerId = `provider-${key}`;
  db.db.prepare(`
    INSERT INTO provider_registry(
      id, provider_key, display_name, provider_kind, status, capabilities_json,
      policy_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'CONTACT_DATA', 'DISABLED', '[]', '{}', ?, ?)
  `).run(providerId, key, `${key} provider`, createdAt, createdAt);
  db.db.prepare(`
    INSERT INTO resource_usage(
      id, provider_id, play_version_id, account_id, resource_type, operation,
      units, cost_micros, currency, idempotency_key, occurred_at, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'CONTACT', 'EMAIL_VERIFY', 1, ?, 'USD', ?, ?, '{}', ?)
  `).run(
    `usage-${key}`,
    providerId,
    fixture.playVersionId,
    fixture.accountId,
    costMicros,
    `usage-${key}`,
    createdAt,
    createdAt,
  );
}

function addExperiment(db: AgentDatabase, fixture: DeliveryFixture, key: string): void {
  const experiment = db.saveExperimentDefinition({
    experimentKey: key,
    hypothesis: `${key} descriptive fixture hypothesis`,
    primaryVariable: "OFFER",
    arms: ["CONTROL", "CHECKLIST"],
    allocationSalt: `${key}-stable-salt`,
    createdBy: "fixture",
  });
  db.assignExperimentArm({
    experimentId: experiment.id,
    subjectType: "ACCOUNT",
    subjectId: fixture.accountId,
  });
}

function findSlice(slices: CommercialSlice[], label: string): CommercialSlice {
  const slice = slices.find((candidate) => candidate.label === label);
  if (!slice) throw new Error(`Missing commercial slice: ${label}`);
  return slice;
}

function findAttribution(
  slices: TouchpointAttributionSlice[],
  label: string,
): TouchpointAttributionSlice {
  const slice = slices.find((candidate) => candidate.label === label);
  if (!slice) throw new Error(`Missing attribution slice: ${label}`);
  return slice;
}

describe("delivered-cohort commercial reporting", () => {
  it("reports commercial outcomes across required dimensions and keeps touchpoint positions descriptive", () => {
    const db = makeDatabase();
    const malaysia = createDeliveryFixture(db, {
      key: "my1",
      market: "MY",
      track: "ACTIVE_INTENT",
      offer: "RFQ checklist",
      channel: "email",
      status: "DELIVERED",
    });
    const vietnam = createDeliveryFixture(db, {
      key: "vn2",
      market: "VN",
      track: "ICP_FIT",
      offer: "sample product data sheet",
      channel: "whatsapp",
      status: "REPLIED",
    });
    const sentOnly = createDeliveryFixture(db, {
      key: "sent3",
      market: "PH",
      track: "ACTIVE_INTENT",
      offer: "Excluded sent-only offer",
      channel: "email",
      status: "SENT",
    });
    addProviderCost(db, malaysia, "apollo-fixture", 1_000_000);
    addProviderCost(db, vietnam, "wiza-fixture", 2_000_000);
    addProviderCost(db, sentOnly, "sent-only-provider", 99_000_000);
    addExperiment(db, malaysia, "my-offer-test");
    addExperiment(db, vietnam, "vn-offer-test");
    addExperiment(db, sentOnly, "sent-only-test");

    const p1 = db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "p1-fixture",
      sender: "buyer@my1.example",
      recipient: "sales@example.invalid",
      subject: "RFQ",
      bodyText: "Please quote this system.",
      receivedAt: "2026-07-21T00:00:00.000Z",
      classification: "P1_INQUIRY",
      accountId: malaysia.accountId,
      leadId: malaysia.leadId,
      outboundMessageId: malaysia.messageId,
      correlationMethod: "IN_REPLY_TO",
      correlationConfidence: 1,
    });
    db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "referral-fixture",
      sender: "buyer@my1.example",
      bodyText: "Please speak with our plant engineer.",
      receivedAt: "2026-07-21T00:01:00.000Z",
      classification: "REFERRAL",
      accountId: malaysia.accountId,
      leadId: malaysia.leadId,
      outboundMessageId: malaysia.messageId,
      correlationMethod: "IN_REPLY_TO",
      correlationConfidence: 1,
    });
    const p2 = db.upsertInquiryIntake({
      source: "WHATSAPP",
      providerEventId: "p2-fixture",
      sender: "+84123456789",
      bodyText: "Please send technical information.",
      receivedAt: "2026-07-21T00:02:00.000Z",
      classification: "P2_INTEREST",
      accountId: vietnam.accountId,
      leadId: vietnam.leadId,
      outboundMessageId: vietnam.messageId,
      correlationMethod: "PROVIDER_THREAD",
      correlationConfidence: 1,
    });
    const sentIntake = db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "sent-only-inquiry",
      sender: "buyer@sent3.example",
      bodyText: "This must remain outside a delivered cohort.",
      receivedAt: "2026-07-21T00:03:00.000Z",
      classification: "P1_INQUIRY",
      accountId: sentOnly.accountId,
      leadId: sentOnly.leadId,
      outboundMessageId: sentOnly.messageId,
      correlationMethod: "IN_REPLY_TO",
      correlationConfidence: 1,
    });

    const wonOpportunity = db.createOrGetOpportunity({
      idempotencyKey: "won-opportunity",
      source: "EMAIL",
      accountId: malaysia.accountId,
      intakeId: p1.id,
      enrollmentId: malaysia.enrollmentId,
      stage: "TECHNICAL_DISCOVERY",
      owner: "sales-fixture",
    });
    const quote = db.createQuote({
      opportunityId: wonOpportunity.id,
      idempotencyKey: "won-quote",
      amountMinor: 100_000,
      currency: "USD",
      grossMarginBps: 2_500,
    }, salesperson);
    db.transitionQuoteStatus(quote.id, "APPROVED", salesperson, "fixture approval");
    db.transitionQuoteStatus(quote.id, "SUBMITTED", salesperson, "fixture submission");
    db.transitionQuoteStatus(quote.id, "ACCEPTED", salesperson, "fixture acceptance");
    db.transitionOpportunityStage(wonOpportunity.id, "QUOTED", salesperson, "quote submitted");
    db.transitionOpportunityStage(wonOpportunity.id, "WON", salesperson, "fixture won", {
      wonQuoteId: quote.id,
    });
    db.createOrGetOpportunity({
      idempotencyKey: "p2-opportunity",
      source: "WHATSAPP",
      accountId: vietnam.accountId,
      intakeId: p2.id,
      enrollmentId: vietnam.enrollmentId,
      stage: "INQUIRY_QUALIFIED",
      owner: "sales-fixture",
    });
    db.createOrGetOpportunity({
      idempotencyKey: "sent-only-opportunity",
      source: "EMAIL",
      accountId: sentOnly.accountId,
      intakeId: sentIntake.id,
      enrollmentId: sentOnly.enrollmentId,
      stage: "INQUIRY_QUALIFIED",
      owner: "sales-fixture",
    });

    const insertTouchpoint = db.db.prepare(`
      INSERT INTO touchpoints(
        id, account_id, opportunity_id, source, medium, campaign, content, landing,
        referrer, attribution_position, occurred_at, idempotency_key, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `);
    insertTouchpoint.run(
      "tp-first", malaysia.accountId, wonOpportunity.id, "organic_search", "organic",
      "my-content", "sample-product-guide", "/my/sample-product", "https://search.example",
      "FIRST", "2026-07-19T00:00:00.000Z", "tp-first", createdAt,
    );
    insertTouchpoint.run(
      "tp-assist", malaysia.accountId, wonOpportunity.id, "referral", "email",
      "partner-referral", null, null, "partner self-report",
      "ASSIST", "2026-07-20T00:00:00.000Z", "tp-assist", createdAt,
    );
    insertTouchpoint.run(
      "tp-last", malaysia.accountId, wonOpportunity.id, "direct", "web",
      null, "rfq-checklist", "/rfq", null,
      "LAST", "2026-07-21T00:00:00.000Z", "tp-last", createdAt,
    );
    insertTouchpoint.run(
      "tp-unspecified", malaysia.accountId, wonOpportunity.id, "manual_note", "manual",
      null, null, null, null,
      "UNSPECIFIED", "2026-07-21T00:01:00.000Z", "tp-unspecified", createdAt,
    );

    const before = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };
    const report = buildCommercialFunnelReport(db, { generatedAt });
    const after = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };

    expect(after.count).toBe(before.count);
    expect(report.cohort).toMatchObject({
      basis: "delivered_evidence",
      explicitlyExcludedStatus: "SENT",
    });
    expect(report.overall.counts).toEqual({
      deliveredCohorts: 2,
      deliveredAccounts: 2,
      deliveredMessages: 2,
      qualifiedAccounts: 2,
      namedCurrentContactAccounts: 2,
      validContactAccounts: 2,
      readyAccounts: 2,
      approvedAccounts: 2,
      hardBounceAccounts: 0,
      negativeAccounts: 0,
      unsubscribeAccounts: 0,
      p1Accounts: 1,
      p2Accounts: 1,
      referralAccounts: 1,
      inquiries: 2,
      quoteOpportunities: 1,
      deals: 1,
    });
    expect(report.overall.rates).toMatchObject({
      denominator: "delivered_accounts",
      deliveredRate: 1,
      p1Rate: 0.5,
      p2Rate: 0.5,
      referralRate: 0.5,
      inquiryRate: 1,
      quoteOpportunityRate: 0.5,
      dealRate: 0.5,
    });
    expect(report.overall.money).toEqual({
      revenueMinorByCurrency: { USD: 100_000 },
      grossMarginMinorByCurrency: { USD: 25_000 },
      costMicrosByCurrency: { USD: 3_000_000 },
      costPerValidMicrosByCurrency: { USD: 1_500_000 },
      costPerInquiryMicrosByCurrency: { USD: 1_500_000 },
      costPerQuoteMicrosByCurrency: { USD: 3_000_000 },
      costPerDealMicrosByCurrency: { USD: 3_000_000 },
    });

    expect(report.byDimension.market.map((slice) => slice.label)).toEqual(["MY", "VN"]);
    expect(report.byDimension.play).toHaveLength(2);
    expect(report.byDimension.qualificationTrack.map((slice) => slice.label).sort())
      .toEqual(["ACTIVE_INTENT", "ICP_FIT"]);
    expect(report.byDimension.channel.map((slice) => slice.label).sort()).toEqual(["email", "whatsapp"]);
    expect(report.byDimension.offer.map((slice) => slice.label).sort())
      .toEqual(["RFQ checklist", "sample product data sheet"]);
    expect(report.byDimension.provider.map((slice) => slice.label).sort())
      .toEqual(["apollo-fixture provider", "wiza-fixture provider"]);
    expect(report.byDimension.experiment.map((slice) => slice.label).join(" "))
      .not.toContain("sent-only-test");
    expect(report.byDimension.experiment).toHaveLength(2);
    expect(findSlice(report.byDimension.provider, "apollo-fixture provider").money.costMicrosByCurrency)
      .toEqual({ USD: 1_000_000 });
    expect(findSlice(report.byDimension.provider, "wiza-fixture provider").money.costMicrosByCurrency)
      .toEqual({ USD: 2_000_000 });

    const first = findAttribution(report.touchpointAttribution.first.bySource, "organic_search");
    const assist = findAttribution(report.touchpointAttribution.assist.bySource, "referral");
    const last = findAttribution(report.touchpointAttribution.last.bySource, "direct");
    for (const value of [first, assist, last]) {
      expect(value).toMatchObject({ opportunities: 1, quoteOpportunities: 1, deals: 1 });
      expect(value.associatedRevenueMinorByCurrency).toEqual({ USD: 100_000 });
      expect(value.associatedGrossMarginMinorByCurrency).toEqual({ USD: 25_000 });
    }
    expect(report.touchpointAttribution).toMatchObject({
      interpretation: "DESCRIPTIVE_ONLY",
      cohortRestriction: "DELIVERED_COHORT_ONLY",
      positionBasis: "STORED_OBSERVED_POSITION",
      unpositionedTouchpoints: 1,
    });
    expect(report.notes.join(" ")).toContain("descriptive only");
    expect(report.notes.join(" ")).toContain("SENT-only messages are excluded");
    expect(report.overall.money.costMicrosByCurrency.USD).not.toBe(102_000_000);
    db.close();
  });

  it("leaves account-level commercial rows unresolved when one account has multiple delivered plays", () => {
    const db = makeDatabase();
    const sharedAccount = db.upsertAccount({
      domain: "shared-account.commercial-fixture.example",
      displayName: "Shared account",
      countryCode: "MY",
      source: "fixture",
    });
    const playA = createDeliveryFixture(db, {
      key: "shared-a",
      market: "MY",
      track: "ACTIVE_INTENT",
      offer: "Offer A",
      channel: "email",
      status: "DELIVERED",
      accountId: sharedAccount,
    });
    createDeliveryFixture(db, {
      key: "shared-b",
      market: "VN",
      track: "ICP_FIT",
      offer: "Offer B",
      channel: "email",
      status: "DELIVERED",
      accountId: sharedAccount,
    });
    const opportunity = db.createOrGetOpportunity({
      idempotencyKey: "ambiguous-account-opportunity",
      source: "MANUAL",
      accountId: sharedAccount,
      stage: "INQUIRY_QUALIFIED",
      owner: "fixture",
    });
    db.db.prepare(`
      INSERT INTO provider_registry(
        id, provider_key, display_name, provider_kind, status, capabilities_json,
        policy_json, created_at, updated_at
      ) VALUES ('provider-ambiguous', 'ambiguous', 'Ambiguous provider', 'OTHER',
        'DISABLED', '[]', '{}', ?, ?)
    `).run(createdAt, createdAt);
    db.db.prepare(`
      INSERT INTO resource_usage(
        id, provider_id, account_id, resource_type, operation, units, cost_micros,
        currency, idempotency_key, occurred_at, metadata_json, created_at
      ) VALUES ('usage-ambiguous', 'provider-ambiguous', ?, 'RESEARCH', 'ACCOUNT', 1,
        5000000, 'USD', 'usage-ambiguous', ?, '{}', ?)
    `).run(sharedAccount, createdAt, createdAt);
    db.db.prepare(`
      INSERT INTO touchpoints(
        id, account_id, opportunity_id, source, medium, attribution_position,
        occurred_at, idempotency_key, metadata_json, created_at
      ) VALUES ('tp-ambiguous', ?, ?, 'manual', 'manual', 'FIRST', ?,
        'tp-ambiguous', '{}', ?)
    `).run(sharedAccount, opportunity.id, createdAt, createdAt);

    const report = buildCommercialFunnelReport(db, { generatedAt });
    expect(report.overall.counts).toMatchObject({
      deliveredCohorts: 2,
      deliveredAccounts: 1,
      inquiries: 0,
    });
    expect(report.byDimension.play).toHaveLength(2);
    expect(report.overall.money.costMicrosByCurrency).toEqual({});
    expect(report.unresolved).toMatchObject({ opportunities: 1, resourceUsage: 1 });
    expect(report.touchpointAttribution.first.bySource).toEqual([]);
    expect(playA.accountId).toBe(sharedAccount);
    db.close();
  });

  it("validates delivery-cohort time windows", () => {
    const db = makeDatabase();
    expect(() => buildCommercialFunnelReport(db, {
      startAt: "2026-07-21T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z",
    })).toThrow("endAt must be later than startAt");
    expect(() => buildCommercialFunnelReport(db, { startAt: "not-a-date" }))
      .toThrow("startAt must be a valid date");
    db.close();
  });

  it("exposes a bounded read-only CLI operator result without changing database rows", () => {
    const db = makeDatabase();
    const before = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };

    const result = runCommercialFunnelOperator(db, [
      "--start-at=2026-07-20T00:00:00.000Z",
      "--end-at", "2026-07-21T00:00:00.000Z",
      "--generated-at", generatedAt,
    ]);

    const after = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };
    const queryOnly = db.db.prepare("PRAGMA query_only").get() as { query_only: number };
    expect(result).toMatchObject({
      command: "commercial-funnel",
      readOnly: true,
      externalActionsAttempted: false,
      report: {
        generatedAt,
        cohort: {
          basis: "delivered_evidence",
          startAt: "2026-07-20T00:00:00.000Z",
          endAt: "2026-07-21T00:00:00.000Z",
        },
      },
    });
    expect(after.count).toBe(before.count);
    expect(queryOnly.query_only).toBe(0);
    db.close();
  });

  it("opens the report database read-only before initialization or migration", () => {
    const writable = makeDatabase();
    const databasePath = writable.databasePath;
    writable.close();
    const readOnly = new AgentDatabase(databasePath, { readOnly: true });
    databases.push(readOnly);

    expect(readOnly.readOnly).toBe(true);
    expect(readOnly.db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(() => readOnly.setSetting("must_not_write", "true")).toThrow();
    expect(runCommercialFunnelOperator(readOnly, ["--generated-at", generatedAt])).toMatchObject({
      readOnly: true,
      externalActionsAttempted: false,
    });
    expect(readOnly.db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    readOnly.close();
  });

  it("rejects a future schema in read-only mode without changing the database", () => {
    const futureVersion = LATEST_SCHEMA_VERSION + 1;
    for (const source of ["schema_migrations", "user_version"] as const) {
      const writable = makeDatabase();
      const databasePath = writable.databasePath;
      writable.close();

      const future = new DatabaseSync(databasePath);
      if (source === "schema_migrations") {
        future.prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        ).run(futureVersion, "future fixture", generatedAt);
      } else {
        future.exec(`PRAGMA user_version = ${futureVersion}`);
      }
      future.close();
      const before = fs.readFileSync(databasePath);

      expect(() => new AgentDatabase(databasePath, { readOnly: true })).toThrow(
        `Database schema version ${futureVersion} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
      );

      const after = fs.readFileSync(databasePath);
      expect(after.equals(before)).toBe(true);
      const observer = new DatabaseSync(databasePath, { readOnly: true });
      expect(observer.prepare("PRAGMA user_version").get()).toEqual({
        user_version: source === "user_version" ? futureVersion : LATEST_SCHEMA_VERSION,
      });
      expect(observer.prepare(
        "SELECT max(version) AS version FROM schema_migrations",
      ).get()).toEqual({
        version: source === "schema_migrations" ? futureVersion : LATEST_SCHEMA_VERSION,
      });
      observer.close();
    }
  });

  it("rejects unknown, duplicate, missing and invalid CLI report options", () => {
    expect(parseCommercialFunnelCliOptions([
      "--start-at", "2026-07-20T00:00:00.000Z",
      "--end-at=2026-07-21T00:00:00.000Z",
    ])).toEqual({
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-21T00:00:00.000Z",
    });
    expect(() => parseCommercialFunnelCliOptions(["--unknown", "value"]))
      .toThrow("Unknown commercial-funnel option");
    expect(() => parseCommercialFunnelCliOptions(["--start-at"]))
      .toThrow("--start-at requires a date value");
    expect(() => parseCommercialFunnelCliOptions([
      "--start-at=2026-07-20T00:00:00.000Z",
      "--start-at=2026-07-21T00:00:00.000Z",
    ])).toThrow("Duplicate commercial-funnel option");

    const db = makeDatabase();
    expect(() => runCommercialFunnelOperator(db, ["--start-at=not-a-date"]))
      .toThrow("startAt must be a valid date");
    const queryOnly = db.db.prepare("PRAGMA query_only").get() as { query_only: number };
    expect(queryOnly.query_only).toBe(0);
    db.close();
  });
});
