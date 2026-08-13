import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDatabase,
  LATEST_SCHEMA_VERSION,
  type IndependentEmailVerificationPersistenceInput,
  type IndependentOfficialEmailVerifier,
} from "../src/db.js";
import { DEMAND_POLICY_VERSION, type EmailVerificationStatus } from "../src/types.js";

const tempDirs: string[] = [];
const openDatabases = new Set<AgentDatabase>();

afterEach(() => {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
      // The test already closed this database.
    }
  }
  openDatabases.clear();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

function databasePath(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(directory);
  return path.join(directory, "agent.db");
}

function database(prefix = "campaign-independent-v16"): AgentDatabase {
  const db = new AgentDatabase(databasePath(prefix));
  openDatabases.add(db);
  return db;
}

interface CampaignScope {
  campaignId: string;
  versionId: string;
}

function authorizedCampaign(
  db: AgentDatabase,
  suffix: string,
  options: {
    verifier?: IndependentOfficialEmailVerifier;
    verifiers?: IndependentOfficialEmailVerifier[];
    extraProviders?: string[];
    maxUnits?: number;
    maxAmountUsd?: number;
  } = {},
): CampaignScope {
  const campaignId = db.createCampaign({
    name: `independent-verifier-${suffix}`,
    market: "Malaysia",
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 10,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [3, 7, 14],
  });
  const providerBudget = {
    mode: "CAPPED",
    allowedProviders: [
      "searxng",
      "local-public-web",
      ...(options.verifiers ?? [options.verifier ?? "BOUNCER"])
        .map((verifier) => verifier.toLowerCase()),
      ...(options.extraProviders ?? []),
    ],
    unit: "REQUESTS",
    maxUnits: options.maxUnits ?? 20,
    maxAmountUsd: options.maxAmountUsd ?? 2,
    requiresSeparateApproval: true,
  };
  const saved = db.saveCampaignDraft({
    briefKey: `independent-verifier:${suffix}`,
    brief: {
      market: "Malaysia",
      productFamily: "sample product application",
      qualificationTracks: ["ICP_FIT"],
      transport: "NONE",
      providerBudget,
      llmBudget: null,
    },
    createdBy: "fixture",
  });
  db.saveCampaignScopedApproval({
    briefId: saved.briefId,
    versionId: saved.versionId,
    scope: "SHADOW_PLAN",
    actionId: `shadow:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, { actor: "campaign-approver", actorType: "HUMAN", roles: ["CAMPAIGN_APPROVER"] });
  db.saveCampaignScopedApproval({
    briefId: saved.briefId,
    versionId: saved.versionId,
    scope: "PROVIDER_BUDGET",
    actionId: `budget:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
    budgetHash: hash({ providerBudget, llmBudget: null }),
  }, { actor: "budget-approver", actorType: "HUMAN", roles: ["BUDGET_APPROVER"] });
  db.bindProviderCampaign({
    campaignId,
    briefId: saved.briefId,
    versionId: saved.versionId,
    briefHash: saved.briefHash,
    createdBy: "fixture",
  });
  return { campaignId, versionId: saved.versionId };
}

function addContact(
  db: AgentDatabase,
  campaignId: string,
  suffix: string,
  status: EmailVerificationStatus,
): { leadId: string; contactId: string; email: string; sourceUrl: string } {
  const domain = `${suffix}.buyer.test`;
  const sourceUrl = `https://${domain}/team`;
  const leadId = db.upsertLead({
    campaignId,
    company: `Buyer ${suffix}`,
    domain,
    website: `https://${domain}/`,
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 30,
    activityScore: 10,
    contactScore: 20,
    channelScore: status === "VALID" ? 5 : 0,
    totalScore: status === "VALID" ? 95 : 90,
    grade: "GOLD",
    lastActivityAt: "2026-07-20T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "ACTIVE_PROJECT",
    demandEvidence: [],
    sendEligible: status === "VALID",
    eligibilityReasons: [],
  });
  const email = `buyer-${suffix}@${domain}`;
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${suffix}`,
    title: "Procurement Manager",
    email,
    sourceUrl,
    employmentVerifiedAt: "2026-07-20T00:00:00.000Z",
    emailStatus: status,
    emailRisk: `official verifier fixture ${status.toLowerCase()}`,
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  return { leadId, contactId, email, sourceUrl };
}

interface VerificationFixtureOptions {
  verdict?: IndependentEmailVerificationPersistenceInput["providerMailboxVerdict"];
  verifier?: IndependentOfficialEmailVerifier;
  responseProviderId?: IndependentOfficialEmailVerifier;
  assertionProviderId?: IndependentOfficialEmailVerifier;
  assertionVerificationProviderId?: IndependentOfficialEmailVerifier;
  assertionSourceUri?: string;
  omitResponseProviderRunId?: boolean;
  catchAll?: boolean;
  disposable?: boolean;
  roleMailbox?: boolean;
}

function completedVerification(
  db: AgentDatabase,
  scope: CampaignScope,
  contact: { contactId: string; email: string; sourceUrl: string },
  suffix: string,
  options: VerificationFixtureOptions = {},
): IndependentEmailVerificationPersistenceInput {
  const verifier = options.verifier ?? "BOUNCER";
  const responseProviderId = options.responseProviderId ?? verifier;
  const assertionProviderId = options.assertionProviderId ?? verifier;
  const assertionVerificationProviderId = options.assertionVerificationProviderId ?? verifier;
  const assertionSourceUri = options.assertionSourceUri ?? (verifier === "HUNTER"
    ? "https://hunter.io/email-verifier"
    : "https://api.usebouncer.com/v1.1/email/verify");
  const providerKey = verifier.toLowerCase();
  const verdict = options.verdict ?? "VALID_ASSERTION";
  const emailHash = hash(contact.email.trim().toLowerCase());
  const discoveryAssertionId = `public-web-discovery-${suffix}`;
  const verificationAssertionId = `${providerKey}-verification-${suffix}`;
  const observedAt = "2026-07-20T00:00:00.000Z";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const rawPayloadHash = hash({ providerKey, suffix, verdict });
  const upstreamProviderRunId = `${providerKey}-upstream-${suffix}`;
  const run = db.beginProviderRun({
    campaignId: scope.campaignId,
    versionId: scope.versionId,
    providerKey,
    operation: "EMAIL_VERIFICATION",
    requestHash: hash({ emailHash, discoveryAssertionId, verifier }),
    requestedCount: 1,
    chargeable: true,
    estimatedUnits: 1,
    estimatedCostMicros: 25_000,
  });
  if (run.status !== "STARTED" || !run.providerAttemptId) {
    throw new Error("Official verifier fixture provider run did not start");
  }
  const response = {
    providerId: responseProviderId,
    providerRunId: upstreamProviderRunId,
    operation: "EMAIL_VERIFICATION",
    result: "ASSERTIONS_RETURNED",
    assertions: [{
      assertionId: verificationAssertionId,
      providerId: assertionProviderId,
      providerRunId: upstreamProviderRunId,
      accountId: scope.campaignId,
      kind: "EMAIL_VERIFICATION",
      sourceUri: assertionSourceUri,
      personRef: `person-${suffix}`,
      emailHash,
      discoveryAssertionId,
      discoveryProviderId: "LOCAL_PUBLIC_WEB",
      verificationProviderId: assertionVerificationProviderId,
      providerMailboxVerdict: verdict,
      catchAll: options.catchAll ?? false,
      disposable: options.disposable ?? false,
      roleMailbox: options.roleMailbox ?? false,
      localMailboxVerdict: "UNCHANGED",
      confidence: verdict === "VALID_ASSERTION" ? 0.98 : 0.4,
      creditUnits: 1,
      estimatedUsd: 0.025,
      rawPayloadHash,
      observedAt,
      expiresAt,
    }],
    rawPayloadHash,
    retryAfterSeconds: null,
  };
  if (options.omitResponseProviderRunId) {
    delete (response as Partial<typeof response>).providerRunId;
  }
  db.completeProviderRun({
    providerRunId: run.providerRunId,
    providerAttemptId: run.providerAttemptId,
    returnedCount: 1,
    resultHash: hash(response),
    response,
    cacheTtlSeconds: 3_600,
    units: 1,
    costMicros: 25_000,
    usageIdempotencyKey: `${providerKey}-usage-${suffix}`,
  });
  return {
    contactId: contact.contactId,
    campaignId: scope.campaignId,
    versionId: scope.versionId,
    providerRunId: run.providerRunId,
    discoveryAssertionId,
    verificationAssertionId,
    emailHash,
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    verifierSourceKey: verifier,
    discoverySourceUrl: contact.sourceUrl,
    discoveryEvidenceHash: hash({ emailHash, sourceUrl: contact.sourceUrl }),
    providerMailboxVerdict: verdict,
    catchAll: options.catchAll ?? false,
    disposable: options.disposable ?? false,
    roleMailbox: options.roleMailbox ?? false,
    confidence: verdict === "VALID_ASSERTION" ? 0.98 : 0.4,
    rawPayloadHash,
    observedAt,
    expiresAt,
    creditUnits: 1,
    estimatedCostMicros: 25_000,
  };
}

describe("independent official email verification v16", () => {
  it("migrates v15 through the current tiered verifier schema", () => {
    const target = databasePath("independent-verifier-v15-migration");
    const initialized = new AgentDatabase(target);
    initialized.close();

    const legacy = new DatabaseSync(target);
    legacy.exec(`
      DROP TRIGGER IF EXISTS trg_v16_campaign_message_independent_email_insert;
      DROP TRIGGER IF EXISTS trg_v17_campaign_message_recipient_tier_insert;
      CREATE TRIGGER trg_v15_campaign_message_independent_email_insert
      BEFORE INSERT ON campaign_message_authorizations BEGIN
        SELECT RAISE(ABORT, 'legacy Hunter-only trigger fixture');
      END;
      DELETE FROM provider_registry WHERE id='provider_bouncer';
      DROP TABLE IF EXISTS imap_message_failures;
      DELETE FROM schema_migrations WHERE version IN (16,17,18);
      PRAGMA user_version=15;
    `);
    legacy.close();

    const migrated = new AgentDatabase(target);
    openDatabases.add(migrated);
    expect(migrated.getMigrationStatus()).toMatchObject({
      currentVersion: 19,
      latestVersion: LATEST_SCHEMA_VERSION,
    });
    expect(migrated.db.prepare(
      "SELECT id, provider_key, provider_kind, status FROM provider_registry WHERE id='provider_bouncer'",
    ).get()).toEqual({
      id: "provider_bouncer",
      provider_key: "bouncer",
      provider_kind: "EMAIL_VERIFICATION",
      status: "ENABLED",
    });
    const triggers = migrated.db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='trigger' AND name='trg_v17_campaign_message_recipient_tier_insert'`,
    ).all() as Array<{ name: string; sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.name).toBe("trg_v17_campaign_message_recipient_tier_insert");
    expect(triggers[0]?.sql.toLowerCase()).toContain("in ('hunter','bouncer')");
    expect(triggers[0]?.sql).toContain("verification_run.campaign_version_id=csa.version_id");
  });

  it("persists and returns independently VALID Bouncer lineage with a fixed official source URI", () => {
    const db = database();
    const scope = authorizedCampaign(db, "bouncer-valid");
    const contact = addContact(db, scope.campaignId, "bouncer-valid", "VALID");
    const verification = completedVerification(db, scope, contact, "bouncer-valid");

    expect(db.persistIndependentEmailVerification(verification)).toEqual({
      discoveryCreated: true,
      verificationCreated: true,
    });
    expect(db.getIndependentValidEmailVerification({
      contactId: contact.contactId,
      email: contact.email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toMatchObject({
      verifierSourceKey: "BOUNCER",
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      providerMailboxVerdict: "VALID_ASSERTION",
      independentlyVerified: true,
    });
    expect(db.db.prepare(
      `SELECT provider_id, verification_provider_id, source_uri, result
       FROM contact_provider_assertions WHERE assertion_type='EMAIL_VERIFICATION'`,
    ).get()).toEqual({
      provider_id: "provider_bouncer",
      verification_provider_id: "provider_bouncer",
      source_uri: "https://api.usebouncer.com/v1.1/email/verify",
      result: "CONFIRMED",
    });
  });

  it("rejects ambiguous bindings, caller-supplied free flags, and cross-provider budget expansion", () => {
    const ambiguousDb = database();
    expect(() => authorizedCampaign(ambiguousDb, "ambiguous", {
      verifiers: ["HUNTER", "BOUNCER"],
    })).toThrow(/at most one independent email verifier/i);

    const chargeabilityDb = database();
    const chargeabilityScope = authorizedCampaign(chargeabilityDb, "chargeability");
    expect(() => chargeabilityDb.beginProviderRun({
      campaignId: chargeabilityScope.campaignId,
      versionId: chargeabilityScope.versionId,
      providerKey: "bouncer",
      operation: "EMAIL_VERIFICATION",
      requestHash: hash("caller-free-bypass"),
      requestedCount: 1,
      chargeable: false,
    })).toThrow(/chargeability.*registry policy/i);

    const budgetDb = database();
    const budgetScope = authorizedCampaign(budgetDb, "campaign-total-budget", {
      extraProviders: ["paid-fixture"],
      maxUnits: 1,
      maxAmountUsd: 0.025,
    });
    const budgetContact = addContact(budgetDb, budgetScope.campaignId, "campaign-total-budget", "VALID");
    completedVerification(
      budgetDb,
      budgetScope,
      budgetContact,
      "campaign-total-budget",
    );
    const now = "2026-07-20T00:00:00.000Z";
    budgetDb.db.prepare(
      `INSERT INTO provider_registry(
         id, provider_key, display_name, provider_kind, status, capabilities_json,
         policy_json, created_at, updated_at
       ) VALUES ('provider_paid_fixture', 'paid-fixture', 'Paid fixture',
         'EMAIL_VERIFICATION', 'ENABLED', '["EMAIL_VERIFICATION"]',
         '{"chargeable":true,"readOnly":true}', ?, ?)`,
    ).run(now, now);
    expect(() => budgetDb.beginProviderRun({
      campaignId: budgetScope.campaignId,
      versionId: budgetScope.versionId,
      providerKey: "paid-fixture",
      operation: "EMAIL_VERIFICATION",
      requestHash: hash("second-provider-budget-expansion"),
      requestedCount: 1,
      chargeable: true,
      estimatedUnits: 1,
      estimatedCostMicros: 25_000,
    })).toThrow(/Provider Budget is exhausted/i);
  });

  it.each([
    ["risky", "RISKY" as const, "RISKY_ASSERTION" as const, true],
    ["unknown", "UNKNOWN" as const, "UNKNOWN_ASSERTION" as const, false],
  ])("persists a Bouncer %s result without making it independently VALID", (
    suffix,
    contactStatus,
    verdict,
    catchAll,
  ) => {
    const db = database();
    const scope = authorizedCampaign(db, `bouncer-${suffix}`);
    const contact = addContact(db, scope.campaignId, `bouncer-${suffix}`, contactStatus);
    const verification = completedVerification(db, scope, contact, `bouncer-${suffix}`, {
      verdict,
      catchAll,
    });

    expect(db.persistIndependentEmailVerification(verification).verificationCreated).toBe(true);
    expect(db.getIndependentValidEmailVerification({
      contactId: contact.contactId,
      email: contact.email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toBeNull();
    expect(db.db.prepare(
      `SELECT mailbox_verdict, result FROM contact_provider_assertions
       WHERE assertion_type='EMAIL_VERIFICATION'`,
    ).get()).toEqual({ mailbox_verdict: verdict, result: "ASSERTED" });
  });

  it("downgrades an existing VALID contact when Bouncer later reports explicit mailbox risk", () => {
    const db = database();
    const scope = authorizedCampaign(db, "bouncer-risk-downgrade");
    const contact = addContact(db, scope.campaignId, "bouncer-risk-downgrade", "VALID");
    expect(db.upsertContact({
      leadId: contact.leadId,
      name: "Buyer bouncer-risk-downgrade",
      title: "Procurement Manager",
      email: contact.email,
      sourceUrl: contact.sourceUrl,
      employmentVerifiedAt: "2026-07-20T00:00:00.000Z",
      emailStatus: "RISKY",
      emailRisk: "Bouncer verifier risky",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    })).toBe(contact.contactId);
    expect(db.getContact(contact.contactId)).toMatchObject({
      email_status: "RISKY",
      email_risk: "Bouncer verifier risky",
    });
  });

  it("rejects caller and immutable-cache attempts to spoof the official verifier", () => {
    const callerDb = database();
    const callerScope = authorizedCampaign(callerDb, "caller-spoof");
    const callerContact = addContact(callerDb, callerScope.campaignId, "caller-spoof", "VALID");
    const callerVerification = completedVerification(
      callerDb,
      callerScope,
      callerContact,
      "caller-spoof",
    );
    expect(() => callerDb.persistIndependentEmailVerification({
      ...callerVerification,
      verifierSourceKey: "HUNTER",
    })).toThrow(/does not match the contact or provider run/i);

    const cacheDb = database();
    const cacheScope = authorizedCampaign(cacheDb, "cache-spoof");
    const cacheContact = addContact(cacheDb, cacheScope.campaignId, "cache-spoof", "VALID");
    const cacheVerification = completedVerification(cacheDb, cacheScope, cacheContact, "cache-spoof", {
      responseProviderId: "HUNTER",
      assertionProviderId: "HUNTER",
      assertionVerificationProviderId: "HUNTER",
    });
    expect(() => cacheDb.persistIndependentEmailVerification(cacheVerification))
      .toThrow(/not present in the immutable provider response/i);

    const sourceDb = database();
    const sourceScope = authorizedCampaign(sourceDb, "source-spoof");
    const sourceContact = addContact(sourceDb, sourceScope.campaignId, "source-spoof", "VALID");
    const sourceVerification = completedVerification(sourceDb, sourceScope, sourceContact, "source-spoof", {
      assertionSourceUri: "https://attacker.invalid/verify",
    });
    expect(() => sourceDb.persistIndependentEmailVerification(sourceVerification))
      .toThrow(/not present in the immutable provider response/i);

    const contractDb = database();
    const contractScope = authorizedCampaign(contractDb, "contract-spoof");
    const contractContact = addContact(contractDb, contractScope.campaignId, "contract-spoof", "VALID");
    const contractVerification = completedVerification(
      contractDb,
      contractScope,
      contractContact,
      "contract-spoof",
      { omitResponseProviderRunId: true },
    );
    expect(() => contractDb.persistIndependentEmailVerification(contractVerification))
      .toThrow(/provider response contract is invalid/i);

    const riskyDb = database();
    const riskyScope = authorizedCampaign(riskyDb, "valid-risk-spoof");
    const riskyContact = addContact(riskyDb, riskyScope.campaignId, "valid-risk-spoof", "VALID");
    const riskyVerification = completedVerification(riskyDb, riskyScope, riskyContact, "valid-risk-spoof", {
      catchAll: true,
    });
    expect(() => riskyDb.persistIndependentEmailVerification(riskyVerification))
      .toThrow(/Risky mailbox flags cannot be persisted as independently VALID/i);
  });

  it("preserves the v15 Hunter persistence and query contract", () => {
    const db = database();
    const scope = authorizedCampaign(db, "hunter-compatibility", { verifier: "HUNTER" });
    const contact = addContact(db, scope.campaignId, "hunter-compatibility", "VALID");
    const verification = completedVerification(db, scope, contact, "hunter-compatibility", {
      verifier: "HUNTER",
    });
    expect(db.persistIndependentEmailVerification(verification).verificationCreated).toBe(true);
    expect(db.getIndependentValidEmailVerification({
      contactId: contact.contactId,
      email: contact.email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toMatchObject({ verifierSourceKey: "HUNTER" });
    expect(db.db.prepare(
      `SELECT source_uri FROM contact_provider_assertions
       WHERE assertion_type='EMAIL_VERIFICATION'`,
    ).get()).toEqual({ source_uri: "https://hunter.io/email-verifier" });
  });
});
