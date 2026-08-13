import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];
const openDatabases = new Set<AgentDatabase>();

afterEach(() => {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  openDatabases.clear();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-auto-send-v14-"));
  tempDirs.push(directory);
  const db = new AgentDatabase(path.join(directory, "agent.db"));
  openDatabases.add(db);
  db.setSetting("outbound_paused", "false");
  return db;
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const manager = {
  actor: "sales-manager",
  actorType: "HUMAN" as const,
  roles: ["SALES_MANAGER" as const],
};

const SCHEDULED_AT = "2026-07-20T00:00:00.000Z";

interface CampaignFixture {
  campaignId: string;
  briefId: string;
  versionId: string;
  briefHash: string;
  sendAuthorizationId: string;
}

function campaignFixture(
  db: AgentDatabase,
  suffix: string,
  limits: { total: number; daily: number; hourly: number } = { total: 5, daily: 5, hourly: 5 },
  verifier: "HUNTER" | "BOUNCER" = "BOUNCER",
): CampaignFixture {
  const market = "Malaysia";
  const campaignId = db.createCampaign({
    name: `autonomous-${suffix}`,
    market,
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: limits.total,
    createdBy: "fixture",
    dailyLimit: limits.daily,
    hourlyLimit: limits.hourly,
    followupDays: [3, 7, 14],
  });
  const providerBudget = {
    mode: "CAPPED",
    allowedProviders: ["searxng", "local-public-web", verifier.toLowerCase()],
    unit: "REQUESTS",
    maxUnits: 100,
    maxAmountUsd: 10,
    requiresSeparateApproval: true,
  };
  const brief = {
    market,
    productFamily: "sample product application",
    qualificationTracks: ["ICP_FIT"],
    transport: "SMTP",
    providerBudget,
    llmBudget: null,
  };
  const draft = db.saveCampaignDraft({
    briefKey: `autonomous:${suffix}`,
    brief,
    parserVersion: "campaign-brief-v2",
    createdBy: "fixture",
  });
  db.saveCampaignScopedApproval({
    briefId: draft.briefId,
    versionId: draft.versionId,
    scope: "SHADOW_PLAN",
    actionId: `shadow:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, { actor: "campaign-approver", actorType: "HUMAN", roles: ["CAMPAIGN_APPROVER"] });
  const budgetHash = hash({ providerBudget, llmBudget: null });
  db.saveCampaignScopedApproval({
    briefId: draft.briefId,
    versionId: draft.versionId,
    scope: "PROVIDER_BUDGET",
    actionId: `budget:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
    budgetHash,
  }, { actor: "budget-approver", actorType: "HUMAN", roles: ["BUDGET_APPROVER"] });
  const sendApproval = db.saveCampaignScopedApproval({
    briefId: draft.briefId,
    versionId: draft.versionId,
    scope: "EXTERNAL_SEND",
    actionId: `external-send:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, manager);
  const sendAuthorization = db.saveCampaignSendAuthorization({
    campaignApprovalId: sendApproval.id,
    briefId: draft.briefId,
    versionId: draft.versionId,
    briefHash: draft.briefHash,
    campaignId,
    market,
    transport: "SMTP",
    totalLimit: limits.total,
    dailyLimit: limits.daily,
    hourlyLimit: limits.hourly,
    maximumSequenceIndex: 0,
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    policyVersion: "campaign-autonomous-pilot-v1",
    actionId: `send-policy:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, manager);
  db.bindProviderCampaign({
    campaignId,
    briefId: draft.briefId,
    versionId: draft.versionId,
    briefHash: draft.briefHash,
    createdBy: "fixture",
  });
  return {
    campaignId,
    briefId: draft.briefId,
    versionId: draft.versionId,
    briefHash: draft.briefHash,
    sendAuthorizationId: sendAuthorization.id,
  };
}

function groundedMessage(
  db: AgentDatabase,
  campaign: CampaignFixture,
  suffix: string,
  verifierSourceKey: "HUNTER" | "BOUNCER" = "BOUNCER",
): { leadId: string; contactId: string; messageVersionId: string; reviewHash: string } {
  const domain = `${suffix}.example.test`;
  const accountId = db.upsertAccount({ domain, displayName: `Account ${suffix}`, countryCode: "MY" });
  const leadId = db.upsertLead({
    campaignId: campaign.campaignId,
    company: `Buyer ${suffix}`,
    domain,
    website: `https://${domain}`,
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: "2026-07-20T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://${domain}/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "fixture", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "fixture", "qualified");
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${suffix}`,
    title: "Procurement Manager",
    email: `buyer-${suffix}@${domain}`,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt: "2026-07-20T00:00:00.000Z",
    emailStatus: "VALID",
    emailRisk: "independently verified fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  const destination = `buyer-${suffix}@${domain}`;
  const emailHash = createHash("sha256").update(destination.trim().toLowerCase()).digest("hex");
  const discoveryAssertionId = `public-web-discovery-${suffix}`;
  const providerKey = verifierSourceKey.toLowerCase();
  const verificationAssertionId = `${providerKey}-verification-${suffix}`;
  const rawPayloadHash = hash({ destination, status: "valid" });
  const upstreamProviderRunId = `${providerKey}-upstream-${suffix}`;
  const providerRun = db.beginProviderRun({
    campaignId: campaign.campaignId,
    versionId: campaign.versionId,
    providerKey,
    operation: "EMAIL_VERIFICATION",
    requestHash: hash({ emailHash, discoveryAssertionId }),
    requestedCount: 1,
    chargeable: true,
    estimatedUnits: 1,
    estimatedCostMicros: 25_000,
  });
  if (providerRun.status !== "STARTED" || !providerRun.providerAttemptId) {
    throw new Error("Official verifier fixture provider run did not start");
  }
  const providerResponse = {
    providerId: verifierSourceKey,
    providerRunId: upstreamProviderRunId,
    operation: "EMAIL_VERIFICATION",
    result: "ASSERTIONS_RETURNED",
    assertions: [{
      assertionId: verificationAssertionId,
      providerId: verifierSourceKey,
      providerRunId: upstreamProviderRunId,
      accountId: campaign.campaignId,
      sourceUri: verifierSourceKey === "HUNTER"
        ? "https://hunter.io/email-verifier"
        : "https://api.usebouncer.com/v1.1/email/verify",
      kind: "EMAIL_VERIFICATION",
      personRef: `person-${suffix}`,
      emailHash,
      discoveryAssertionId,
      discoveryProviderId: "LOCAL_PUBLIC_WEB",
      verificationProviderId: verifierSourceKey,
      providerMailboxVerdict: "VALID_ASSERTION",
      catchAll: false,
      disposable: false,
      roleMailbox: false,
      localMailboxVerdict: "UNCHANGED",
      confidence: 0.98,
      creditUnits: 1,
      estimatedUsd: 0.025,
      rawPayloadHash,
      observedAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }],
    rawPayloadHash,
    retryAfterSeconds: null,
  };
  db.completeProviderRun({
    providerRunId: providerRun.providerRunId,
    providerAttemptId: providerRun.providerAttemptId,
    returnedCount: 1,
    resultHash: hash(providerResponse),
    response: providerResponse,
    cacheTtlSeconds: 3_600,
    units: 1,
    costMicros: 25_000,
    usageIdempotencyKey: `${providerKey}-usage-${suffix}`,
  });
  db.persistIndependentEmailVerification({
    contactId,
    campaignId: campaign.campaignId,
    versionId: campaign.versionId,
    providerRunId: providerRun.providerRunId,
    discoveryAssertionId,
    verificationAssertionId,
    emailHash,
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    verifierSourceKey,
    discoverySourceUrl: `https://${domain}/team`,
    discoveryEvidenceHash: hash({ emailHash, source: `https://${domain}/team` }),
    providerMailboxVerdict: "VALID_ASSERTION",
    catchAll: false,
    disposable: false,
    roleMailbox: false,
    confidence: 0.98,
    rawPayloadHash,
    observedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    creditUnits: 1,
    estimatedCostMicros: 25_000,
  });
  const plan = db.savePersonalizationPlan({
    planKey: `plan:${suffix}`,
    accountId,
    leadId,
    contactId,
    qualificationTrack: "ICP_FIT",
    qualificationPolicyVersion: "qualification-policy-v2",
    sellerFactSetVersion: "seller-facts-v1",
    locale: "en-MY",
    plan: { accountId, leadId, contactId, observedFact: "public fixture fact" },
    factIds: [`fact:${suffix}`],
    createdBy: "fixture",
    status: "VALID",
  });
  const message = db.saveMessageVersion({
    messageKey: `message:${suffix}`,
    personalizationPlanId: plan.id,
    subject: `Grounded subject ${suffix}`,
    body: `Grounded body ${suffix}\n\nReply unsubscribe to opt out.`,
    destination,
    sequenceIndex: 0,
    generationMode: "DETERMINISTIC_COMPILER",
    promptVersion: "deterministic-no-prompt",
    model: "deterministic-no-model",
    templateVersion: "grounded-message-compiler-v1",
    lintVersion: "message-grounding-lint-v2",
    lintResult: { passed: true, blockers: [], warnings: [] },
    angle: "public fixture fact",
    locale: "en-MY",
    sellerFactSetVersion: "seller-facts-v1",
    factIds: [`fact:${suffix}`],
    createdBy: "fixture",
    status: "PENDING_APPROVAL",
  });
  return { leadId, contactId, messageVersionId: message.id, reviewHash: message.reviewHash };
}

describe("campaign autonomous send authorization v14", () => {
  it("persists exact immutable campaign and message authorization lineage and claims it", () => {
    const db = database();
    expect(LATEST_SCHEMA_VERSION).toBe(19);
    const campaign = campaignFixture(db, "happy", undefined, "BOUNCER");
    const message = groundedMessage(db, campaign, "happy", "BOUNCER");
    const contact = db.getContact(message.contactId);
    expect(db.getIndependentValidEmailVerification({
      contactId: message.contactId,
      email: String(contact?.email),
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
    })).toMatchObject({ verifierSourceKey: "BOUNCER", independentlyVerified: true });
    const authorization = db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: campaign.sendAuthorizationId,
      messageVersionId: message.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    expect(authorization).toMatchObject({ created: true, reviewHash: message.reviewHash });
    expect(db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: campaign.sendAuthorizationId,
      messageVersionId: message.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    })).toMatchObject({ created: false, outboundMessageId: authorization.outboundMessageId });
    expect(db.db.prepare(
      `SELECT authorization_mode, current_version_id, campaign_send_authorization_id,
              campaign_message_authorization_id, status
       FROM outbound_messages WHERE id=?`,
    ).get(authorization.outboundMessageId)).toMatchObject({
      authorization_mode: "CAMPAIGN_POLICY",
      current_version_id: message.messageVersionId,
      campaign_send_authorization_id: campaign.sendAuthorizationId,
      campaign_message_authorization_id: authorization.id,
      status: "APPROVED",
    });
    expect(() => db.db.prepare("UPDATE outbound_messages SET subject='tampered' WHERE id=?")
      .run(authorization.outboundMessageId)).toThrow(/immutable/i);
    expect(() => db.db.prepare("UPDATE campaign_message_authorizations SET evaluator_version='changed' WHERE id=?")
      .run(authorization.id)).toThrow(/immutable/i);
    expect(db.claimMessageForSending(authorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toMatchObject({ status: "SENDING", current_version_id: message.messageVersionId });
    db.close();
  });

  it("rechecks DNC, independently VALID email, and reply-stop after policy authorization", () => {
    const dncDb = database();
    const dncCampaign = campaignFixture(dncDb, "dnc");
    const dncMessage = groundedMessage(dncDb, dncCampaign, "dnc", "BOUNCER");
    const dncAuthorization = dncDb.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: dncCampaign.sendAuthorizationId,
      messageVersionId: dncMessage.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    const destination = String(dncDb.getContact(dncMessage.contactId)?.email);
    dncDb.addDnc("email", destination, "late opt out", "fixture");
    expect(() => dncDb.claimMessageForSending(dncAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toThrow(/do-not-contact/i);
    dncDb.close();

    const invalidDb = database();
    const invalidCampaign = campaignFixture(invalidDb, "invalid");
    const invalidMessage = groundedMessage(invalidDb, invalidCampaign, "invalid", "BOUNCER");
    const invalidAuthorization = invalidDb.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: invalidCampaign.sendAuthorizationId,
      messageVersionId: invalidMessage.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    invalidDb.markContactEmailInvalid(invalidMessage.contactId, "late verifier conflict");
    expect(() => invalidDb.claimMessageForSending(invalidAuthorization.outboundMessageId, {
      allowRiskyEmail: true,
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toThrow(/email status is INVALID/i);
    invalidDb.close();

    const replyDb = database();
    const replyCampaign = campaignFixture(replyDb, "reply");
    const replyMessage = groundedMessage(replyDb, replyCampaign, "reply", "BOUNCER");
    const replyAuthorization = replyDb.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: replyCampaign.sendAuthorizationId,
      messageVersionId: replyMessage.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    replyDb.stopAutomationForReply(replyMessage.leadId, "inbound", "customer replied");
    expect(() => replyDb.claimMessageForSending(replyAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toThrow(/status is CANCELLED/i);
    replyDb.close();
  });

  it("reserves campaign hourly capacity atomically and blocks authorization beyond total scope", () => {
    const db = database();
    const campaign = campaignFixture(db, "limits", { total: 2, daily: 2, hourly: 1 });
    const first = groundedMessage(db, campaign, "limit-first", "BOUNCER");
    const second = groundedMessage(db, campaign, "limit-second", "BOUNCER");
    const firstAuthorization = db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: campaign.sendAuthorizationId,
      messageVersionId: first.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    const secondAuthorization = db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: campaign.sendAuthorizationId,
      messageVersionId: second.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    const third = groundedMessage(db, campaign, "limit-third", "BOUNCER");
    expect(() => db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: campaign.sendAuthorizationId,
      messageVersionId: third.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    })).toThrow(/total authorization limit/i);
    db.claimMessageForSending(firstAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    });
    expect(() => db.claimMessageForSending(secondAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:01.000Z"),
    })).toThrow(/campaign authorized hourly send limit reached/i);
    db.close();
  });

  it("invalidates claim on a newer Campaign Brief version or explicit revocation", () => {
    const staleDb = database();
    const staleCampaign = campaignFixture(staleDb, "stale");
    const staleMessage = groundedMessage(staleDb, staleCampaign, "stale");
    const staleAuthorization = staleDb.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: staleCampaign.sendAuthorizationId,
      messageVersionId: staleMessage.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    staleDb.saveCampaignDraft({
      briefKey: "autonomous:stale",
      brief: { market: "Malaysia", productFamily: "changed", transport: "SMTP" },
      createdBy: "fixture",
    });
    expect(() => staleDb.claimMessageForSending(staleAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toThrow(/stale or disabled/i);
    staleDb.close();

    const revokedDb = database();
    const revokedCampaign = campaignFixture(revokedDb, "revoked");
    const revokedMessage = groundedMessage(revokedDb, revokedCampaign, "revoked");
    const revokedAuthorization = revokedDb.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: revokedCampaign.sendAuthorizationId,
      messageVersionId: revokedMessage.messageVersionId,
      scheduledAt: SCHEDULED_AT,
      evaluatorVersion: "campaign-message-gate-v1",
    });
    revokedDb.revokeCampaignSendAuthorization(
      revokedCampaign.sendAuthorizationId,
      "revoke:fixture",
      "operator stop",
      manager,
    );
    expect(() => revokedDb.claimMessageForSending(revokedAuthorization.outboundMessageId, {
      now: new Date("2026-07-20T08:00:00.000Z"),
    })).toThrow(/revoked/i);
    revokedDb.close();
  });

  it("binds zero-cost SearXNG inside an exact capped budget and journals cache and retry attempts", () => {
    const db = database();
    const campaign = campaignFixture(db, "provider");
    expect(db.bindProviderCampaign({
      campaignId: campaign.campaignId,
      briefId: campaign.briefId,
      versionId: campaign.versionId,
      briefHash: campaign.briefHash,
      createdBy: "fixture",
    })).toEqual({ created: false });
    expect(db.bindProviderCampaign({
      campaignId: campaign.campaignId,
      briefId: campaign.briefId,
      versionId: campaign.versionId,
      briefHash: campaign.briefHash,
      createdBy: "fixture",
    })).toEqual({ created: false });
    expect(db.getAuthorizedProviderCampaignContext(
      campaign.campaignId,
      "SEARXNG",
      { chargeable: false },
    )).toMatchObject({ providerKey: "searxng", provider_status: "ENABLED" });
    expect(db.getAuthorizedProviderCampaignContext(
      campaign.campaignId,
      "local-public-web",
      { chargeable: false },
    )).toMatchObject({ providerKey: "local-public-web", provider_status: "ENABLED" });

    const requestHash = hash({ query: "sample product application Malaysia" });
    const started = db.beginProviderRun({
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
      providerKey: "searxng",
      operation: "EVIDENCE_SEARCH",
      requestHash,
      requestedCount: 10,
      chargeable: false,
    });
    expect(started).toMatchObject({ status: "STARTED", attemptNumber: 1 });
    expect(db.beginProviderRun({
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
      providerKey: "searxng",
      operation: "EVIDENCE_SEARCH",
      requestHash,
      requestedCount: 10,
      chargeable: false,
    })).toMatchObject({ status: "IN_FLIGHT", providerRunId: started.providerRunId });
    const response = { results: [{ url: "https://example.test/evidence", title: "Evidence" }] };
    const completed = db.completeProviderRun({
      providerRunId: started.providerRunId,
      providerAttemptId: started.providerAttemptId!,
      returnedCount: 1,
      resultHash: hash(response),
      response,
      cacheTtlSeconds: 3600,
      units: 0,
      costMicros: 0,
      usageIdempotencyKey: `usage:${started.providerRunId}:1`,
    });
    expect(completed.created).toBe(true);
    expect(db.beginProviderRun({
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
      providerKey: "searxng",
      operation: "EVIDENCE_SEARCH",
      requestHash,
      requestedCount: 10,
      chargeable: false,
    })).toMatchObject({ status: "CACHED", response });

    const retryHash = hash({ query: "retry fixture" });
    const failed = db.beginProviderRun({
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
      providerKey: "searxng",
      operation: "EVIDENCE_SEARCH",
      requestHash: retryHash,
      requestedCount: 5,
      chargeable: false,
    });
    expect(db.failProviderRun({
      providerRunId: failed.providerRunId,
      providerAttemptId: failed.providerAttemptId!,
      errorClass: "TEMPORARY_NETWORK",
    })).toEqual({ changed: true });
    expect(db.beginProviderRun({
      campaignId: campaign.campaignId,
      versionId: campaign.versionId,
      providerKey: "searxng",
      operation: "EVIDENCE_SEARCH",
      requestHash: retryHash,
      requestedCount: 5,
      chargeable: false,
    })).toMatchObject({ status: "STARTED", attemptNumber: 2, providerRunId: failed.providerRunId });
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM resource_usage WHERE provider_run_id=? AND cost_micros=0",
    ).get(started.providerRunId)).toMatchObject({ count: 1 });
    db.close();
  });
});
