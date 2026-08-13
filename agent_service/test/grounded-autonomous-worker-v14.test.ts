import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPageSnapshot, type EvidenceFact, type PageSnapshot } from "../src/acquisition/evidence.js";
import {
  createPersonalizationPlan,
  type PersonalizationPlan,
  type PersonalizationPlanCandidate,
} from "../src/acquisition/message-grounding.js";
import {
  SellerKnowledgeDocumentSchema,
  SellerKnowledgeStore,
  type SellerKnowledgeDocument,
} from "../src/acquisition/seller-knowledge.js";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import { JobWorker } from "../src/jobs/worker.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const NOW = new Date("2026-07-20T08:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grounded-autonomous-worker-v14-"));
  tempDirs.push(directory);
  const db = new AgentDatabase(path.join(directory, "agent.db"));
  db.setSetting("outbound_paused", "true");
  return db;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met after ${timeoutMs}ms`);
    await delay(5);
  }
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

function sellerDocument(): SellerKnowledgeDocument {
  return SellerKnowledgeDocumentSchema.parse({
    schemaVersion: "seller-knowledge-v2",
    factSetId: "seller-facts-aurora",
    factSetVersion: 3,
    profile: {
      schemaVersion: "seller-profile-v2",
      id: "seller-aurora",
      version: 4,
      status: "APPROVED",
      legalNameEn: "Aurora manufacturing Ltd.",
      brandNameEn: "Aurora Example",
      website: "https://aurora-example.test",
      sender: { name: "Alex Chen", email: "alex@aurora-example.test" },
      postalAddress: {
        line1: "18 Industry Road",
        city: "Nanjing",
        postalCode: "210000",
        country: "China",
      },
      unsubscribe: { method: "REPLY", instruction: "Reply unsubscribe to opt out." },
      products: [{
        id: "product-sample-product",
        name: "Sample Product A",
        modelsOrSpecifications: ["Sample Model A with a documented capacity"],
        publicApproved: true,
      }],
      quoteBoundaries: {
        moq: "MOQ requires manual confirmation.",
        leadTime: "Lead time requires manual confirmation.",
        pricing: "Pricing requires a human-issued quotation.",
        payment: "Payment terms require commercial approval.",
        oem: "OEM requires engineering approval.",
        packaging: "Packaging requires manual confirmation.",
        installation: "Installation requires manual confirmation.",
        requiresHumanApproval: true,
      },
      prohibitedClaims: ["zero maintenance"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
    },
    facts: [{
      schemaVersion: "seller-fact-v2",
      id: "seller-fact-sample-product",
      profileId: "seller-aurora",
      factSetVersion: 3,
      subject: "Aurora Example",
      predicate: "product capability",
      value: "Sample Product A supports 12 units configurations.",
      unit: "kg",
      source: {
        type: "PRODUCT_SHEET",
        url: "https://aurora-example.test/products/sample-product",
        documentId: "datasheet-pj-120",
        contentHash: "a".repeat(64),
      },
      publicApproved: true,
      status: "ACTIVE",
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
      confidentiality: "PUBLIC",
      version: 2,
    }],
    offers: [{
      schemaVersion: "seller-offer-v2",
      id: "offer-checklist",
      profileId: "seller-aurora",
      profileVersion: 4,
      version: 2,
      productId: "product-sample-product",
      text: "We can share an approved application checklist for Sample Product A.",
      sellerFactIds: ["seller-fact-sample-product"],
      status: "ACTIVE",
      publicApproved: true,
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
    }],
    privateCases: [],
  });
}

function evidenceFixture(input: {
  suffix: string;
  accountId: string;
  leadId: string;
  domain: string;
}): { snapshot: PageSnapshot; fact: EvidenceFact } {
  const text = `${input.suffix} Process Systems operates a sample production workflow.`;
  const snapshot = createPageSnapshot({
    id: `snapshot-${input.suffix}`,
    accountId: input.accountId,
    leadId: input.leadId,
    subject: `${input.suffix} Process Systems`,
    sourceUrl: `https://${input.domain}/about`,
    publisher: {
      id: `publisher-${input.suffix}`,
      name: `${input.suffix} Process Systems`,
      domain: input.domain,
    },
    text,
    publishedAt: "2026-06-01T00:00:00.000Z",
    retrievedAt: "2026-07-19T00:00:00.000Z",
  });
  return {
    snapshot,
    fact: {
      schemaVersion: "evidence-fact-v2",
      id: `fact-${input.suffix}-process`,
      accountId: input.accountId,
      leadId: input.leadId,
      subject: `${input.suffix} Process Systems`,
      claim: text,
      exactQuote: text,
      sourceUrl: snapshot.sourceUrl,
      sourceSnapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      observedAt: "2026-06-01T00:00:00.000Z",
      publishedAt: snapshot.publishedAt,
      retrievedAt: snapshot.retrievedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publisher: snapshot.publisher,
      independence: {
        publisherKey: snapshot.publisher.id,
        relationship: "FIRST_PARTY",
        independentFromSeller: true,
        independentFromAccount: false,
      },
      evidenceClass: "FIT",
      allowedUses: ["RESEARCH", "OUTREACH", "QUALIFICATION"],
      visibility: "PUBLIC",
      confidence: "HIGH",
    },
  };
}

function candidate(fact: EvidenceFact): PersonalizationPlanCandidate {
  return {
    buyerRoleFamily: "Engineering",
    processFocus: "sample production process",
    productRequirement: "sample requirement",
    application: "sample workflow",
    matchedProductFamily: "Sample Product A",
    whyNowSignal: null,
    observedFact: { text: fact.claim, factIds: [fact.id] },
    relevanceHypothesis: {
      text: "This may make Sample Product A relevant to the sample application.",
      factIds: [fact.id],
      hedged: true,
    },
    approvedOffer: {
      offerId: "offer-checklist",
      text: "We can share an approved application checklist for Sample Product A.",
      sellerFactIds: ["seller-fact-sample-product"],
    },
    cta: { type: "OFFER_ASSET", text: "Would it be useful if I sent the application checklist?" },
    angle: "sample application",
    locale: "en-MY",
  };
}

function qualificationInput(input: {
  plan: PersonalizationPlan;
  domain: string;
  destination: string;
  fact: EvidenceFact;
  sellerStore: SellerKnowledgeStore;
}): Record<string, unknown> {
  const identity = {
    id: `fact-${input.plan.accountId}-identity`,
    subjectEntityId: input.plan.accountId,
    claimType: "ACCOUNT_IDENTITY",
    signalType: null,
    publisherDomain: input.domain,
    independenceKey: `${input.domain}:official-profile`,
    originalDocumentKey: null,
    authorityClass: "T1_COMPANY_OFFICIAL",
    authorityAllowlisted: false,
    sourceKind: "OFFICIAL_WEBSITE",
    subjectRole: "BUYER",
    exactQuote: `${input.plan.accountName} publishes its official industrial process profile.`,
    entityBound: true,
    effectiveAt: null,
    observedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "CURRENT",
    confidence: 0.95,
    humanReview: "UNREVIEWED",
    allowedQualificationUses: ["ICP_IDENTITY"],
    allowedForOutreach: true,
  };
  const scenario = {
    ...identity,
    id: input.fact.id,
    claimType: "BUSINESS_SCENARIO",
    exactQuote: input.fact.exactQuote,
    allowedQualificationUses: ["ICP_BUSINESS_SCENARIO"],
  };
  const buyerType = {
    ...identity,
    id: `fact-${input.plan.accountId}-buyer-type`,
    claimType: "BUYER_TYPE",
    publisherDomain: "industry-association.test",
    independenceKey: `${input.domain}:association-record`,
    authorityClass: "OTHER",
    sourceKind: "PUBLIC_WEB",
    exactQuote: `${input.plan.accountName} is listed as an industrial process operator.`,
    allowedQualificationUses: ["ICP_BUYER_TYPE"],
  };
  return {
    policyVersion: input.plan.versions.qualificationPolicyVersion,
    asOf: NOW.toISOString(),
    rankScore: 10,
    account: {
      id: input.plan.accountId,
      buyerType: "END_USER_FACTORY",
      officialDomains: [input.domain],
      identityVerified: true,
      identityFactIds: [identity.id],
      businessScenarioVerified: true,
      businessScenarioFactIds: [scenario.id],
      buyerTypeMatchesPlay: true,
      buyerTypeFactIds: [buyerType.id],
      dncMatch: false,
      excluded: false,
      ownershipConflict: false,
    },
    contact: {
      id: input.plan.contactId,
      accountId: input.plan.accountId,
      name: input.plan.contactName,
      named: true,
      title: "Engineering Manager",
      roleFamily: "TECHNICAL_ENGINEERING",
      seniority: "MANAGER",
      employment: {
        accountId: input.plan.accountId,
        status: "CURRENT",
        observedAt: "2026-07-10T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        confidence: 0.95,
        assertionIds: [`employment-${input.plan.contactId}`],
        conflict: false,
      },
      email: {
        address: input.destination,
        status: "VALID",
        workEmail: true,
        roleAddress: false,
        disposable: false,
        catchAll: false,
        domainMatchesAccount: true,
        discoverySourceKey: "public-team-page",
        verifierSourceKey: "independent-verifier",
        independentlyVerified: true,
        observedAt: "2026-07-15T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        confidence: 0.98,
        assertionIds: [`email-verification-${input.plan.contactId}`],
        conflict: false,
      },
      evidenceConfidence: 0.94,
      lastEvidenceAt: "2026-07-15T00:00:00.000Z",
      dncMatch: false,
      excluded: false,
      ownershipConflict: false,
      conflicts: [],
    },
    evidenceFacts: [identity, scenario, buyerType],
    seller: {
      sellerContextId: input.sellerStore.document.profile.id,
      sellerContextApproved: true,
      offerId: input.plan.approvedOffer.offerId,
      offerApproved: true,
    },
    message: {
      draftText: "grounded fixture",
      grounded: true,
      citedFactIds: [scenario.id],
      unsupportedFactIds: [],
    },
  };
}

interface Fixture {
  payload: Record<string, unknown>;
  campaignSendAuthorizationId: string;
  leadId: string;
  contactId: string;
  destination: string;
}

function fixture(
  db: AgentDatabase,
  suffix: string,
  validity: { validFrom: string; expiresAt: string } = {
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
): Fixture {
  const market = "Malaysia";
  const domain = `${suffix}.example.test`;
  const campaignId = db.createCampaign({
    name: `autonomous-${suffix}`,
    market,
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 10,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 10,
    followupDays: [3, 7, 14],
  });
  const providerBudget = {
    mode: "CAPPED",
    allowedProviders: ["searxng", "local-public-web", "hunter"],
    unit: "REQUESTS",
    maxUnits: 10,
    maxAmountUsd: 1,
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
    briefKey: `autonomous-worker:${suffix}`,
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
  db.saveCampaignScopedApproval({
    briefId: draft.briefId,
    versionId: draft.versionId,
    scope: "PROVIDER_BUDGET",
    actionId: `budget:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
    budgetHash: hash({ providerBudget, llmBudget: null }),
  }, { actor: "budget-approver", actorType: "HUMAN", roles: ["BUDGET_APPROVER"] });
  db.bindProviderCampaign({
    campaignId,
    briefId: draft.briefId,
    versionId: draft.versionId,
    briefHash: draft.briefHash,
    createdBy: "fixture",
  });
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
    totalLimit: 10,
    dailyLimit: 10,
    hourlyLimit: 10,
    maximumSequenceIndex: 0,
    validFrom: validity.validFrom,
    expiresAt: validity.expiresAt,
    policyVersion: "campaign-autonomous-pilot-v1",
    actionId: `send-policy:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, manager);

  const accountId = db.upsertAccount({
    domain,
    displayName: `${suffix} Process Systems`,
    countryCode: "MY",
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `${suffix} Process Systems`,
    domain,
    website: `https://${domain}`,
    country: market,
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
  const destination = `engineer@${domain}`;
  const contactId = db.upsertContact({
    leadId,
    name: "Morgan Lee",
    title: "Engineering Manager",
    email: destination,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt: "2026-07-15T00:00:00.000Z",
    emailStatus: "VALID",
    emailRisk: "independently verified fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  const emailHash = createHash("sha256").update(destination.trim().toLowerCase()).digest("hex");
  const discoveryAssertionId = `public-web-discovery-${suffix}`;
  const verificationAssertionId = `hunter-verification-${suffix}`;
  const discoveryEvidenceHash = hash({ destination, source: `https://${domain}/team` });
  const rawPayloadHash = hash({ destination, status: "valid", suffix });
  const upstreamProviderRunId = `hunter-upstream-${suffix}`;
  const providerRun = db.beginProviderRun({
    campaignId,
    versionId: draft.versionId,
    providerKey: "hunter",
    operation: "EMAIL_VERIFICATION",
    requestHash: hash({ emailHash, discoveryAssertionId }),
    requestedCount: 1,
    chargeable: true,
    estimatedUnits: 1,
    estimatedCostMicros: 25_000,
  });
  if (providerRun.status !== "STARTED" || !providerRun.providerAttemptId) {
    throw new Error("Hunter fixture provider run did not start");
  }
  const providerResponse = {
    providerId: "HUNTER",
    providerRunId: upstreamProviderRunId,
    operation: "EMAIL_VERIFICATION",
    result: "ASSERTIONS_RETURNED",
    assertions: [{
      assertionId: verificationAssertionId,
      providerId: "HUNTER",
      providerRunId: upstreamProviderRunId,
      accountId: campaignId,
      sourceUri: "https://hunter.io/email-verifier",
      kind: "EMAIL_VERIFICATION",
      personRef: `person-${suffix}`,
      emailHash,
      discoveryAssertionId,
      discoveryProviderId: "LOCAL_PUBLIC_WEB",
      verificationProviderId: "HUNTER",
      providerMailboxVerdict: "VALID_ASSERTION",
      catchAll: false,
      disposable: false,
      roleMailbox: false,
      localMailboxVerdict: "UNCHANGED",
      confidence: 0.98,
      creditUnits: 1,
      estimatedUsd: 0.025,
      rawPayloadHash,
      observedAt: "2026-07-15T00:00:00.000Z",
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
    usageIdempotencyKey: `hunter-usage-${suffix}`,
  });
  db.persistIndependentEmailVerification({
    contactId,
    campaignId,
    versionId: draft.versionId,
    providerRunId: providerRun.providerRunId,
    discoveryAssertionId,
    verificationAssertionId,
    emailHash,
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    verifierSourceKey: "HUNTER",
    discoverySourceUrl: `https://${domain}/team`,
    discoveryEvidenceHash,
    providerMailboxVerdict: "VALID_ASSERTION",
    catchAll: false,
    disposable: false,
    roleMailbox: false,
    confidence: 0.98,
    rawPayloadHash,
    observedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    creditUnits: 1,
    estimatedCostMicros: 25_000,
  });
  const evidence = evidenceFixture({ suffix, accountId, leadId, domain });
  const sellerStore = new SellerKnowledgeStore(sellerDocument(), NOW);
  const planResult = createPersonalizationPlan({
    id: `plan-${suffix}`,
    accountId,
    accountName: `${suffix} Process Systems`,
    leadId,
    contactId,
    contactName: "Morgan Lee",
    market,
    channel: "EMAIL",
    qualificationTrack: "ICP_FIT",
    candidate: candidate(evidence.fact),
    evidenceFacts: [evidence.fact],
    snapshots: [evidence.snapshot],
    sellerStore,
    versions: {
      dossierVersion: 1,
      playVersion: 1,
      qualificationPolicyVersion: "qualification-policy-v2",
      plannerVersion: "personalization-planner-v2",
      localeVersion: 1,
    },
    now: NOW,
  });
  if (!planResult.plan) throw new Error(planResult.blockers.join("; "));
  const plan = planResult.plan;
  return {
    campaignSendAuthorizationId: sendAuthorization.id,
    leadId,
    contactId,
    destination,
    payload: {
      plan,
      evidenceFacts: [evidence.fact],
      snapshots: [evidence.snapshot],
      sellerKnowledge: sellerStore.document,
      qualificationInput: qualificationInput({ plan, domain, destination, fact: evidence.fact, sellerStore }),
      destination,
      createdBy: "grounded-autonomous-worker-test",
      campaignSendAuthorizationId: sendAuthorization.id,
      scheduledAt: NOW.toISOString(),
      evaluatorVersion: "campaign-message-gate-v1",
    },
  };
}

async function runStageJob(
  db: AgentDatabase,
  payload: Record<string, unknown>,
  replyChatId: string,
): Promise<Record<string, unknown>> {
  const feishu = {
    sendCard: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
  };
  const worker = new JobWorker(
    { messageReviewDestinations: new Set(["chat-one", "chat-two"]) } as never,
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    feishu as never,
    {
      workerId: `grounded-worker-${replyChatId}`,
      pollIntervalMs: 10_000,
      now: () => NOW,
    },
  );
  const jobId = db.enqueueJob("STAGE_GROUNDED_MESSAGE", { ...payload, replyChatId });
  db.db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(jobId);
  worker.start();
  await waitFor(() => new Set(["COMPLETED", "FAILED"]).has(String(db.getJob(jobId)?.status)));
  await worker.stop();
  return db.getJob(jobId)!;
}

function count(db: AgentDatabase, table: string): number {
  return Number((db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

const stagedTables = [
  "qualification_runs",
  "personalization_plans",
  "message_versions",
  "message_review_cards",
  "campaign_message_authorizations",
  "outbound_messages",
] as const;

describe("grounded autonomous worker v14", () => {
  it("authorizes an exact grounded job once, keeps replay stable across reply chats, and honors pause at claim", async () => {
    const db = database();
    try {
      expect(LATEST_SCHEMA_VERSION).toBe(19);
      expect(db.getSetting("outbound_paused")).toBe("true");
      const input = fixture(db, "happy");

      const firstJob = await runStageJob(db, input.payload, "chat-one");
      expect(firstJob.status).toBe("COMPLETED");
      const first = JSON.parse(String(firstJob.result_json)) as Record<string, unknown>;
      expect(first).toMatchObject({
        status: "PENDING_APPROVAL",
        campaignSendAuthorizationId: input.campaignSendAuthorizationId,
        campaignMessageAuthorizationId: expect.any(String),
        outboundMessageId: expect.any(String),
        outboundStatus: "APPROVED",
        externalSendAuthorized: true,
      });
      const outboundMessageId = String(first.outboundMessageId);
      const campaignMessageAuthorizationId = String(first.campaignMessageAuthorizationId);
      expect(db.db.prepare(
        `SELECT status, authorization_mode, campaign_send_authorization_id,
                campaign_message_authorization_id, current_version_id
         FROM outbound_messages WHERE id=?`,
      ).get(outboundMessageId)).toMatchObject({
        status: "APPROVED",
        authorization_mode: "CAMPAIGN_POLICY",
        campaign_send_authorization_id: input.campaignSendAuthorizationId,
        campaign_message_authorization_id: campaignMessageAuthorizationId,
        current_version_id: first.messageVersionId,
      });
      expect(db.db.prepare(
        `SELECT decision, evaluated_by, send_authorized, outbound_message_id, message_version_id
         FROM campaign_message_authorizations WHERE id=?`,
      ).get(campaignMessageAuthorizationId)).toMatchObject({
        decision: "AUTO_SEND_ELIGIBLE",
        evaluated_by: "SYSTEM",
        send_authorized: 1,
        outbound_message_id: outboundMessageId,
        message_version_id: first.messageVersionId,
      });
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM events WHERE entity_id=? AND event_type='MESSAGE_CAMPAIGN_POLICY_AUTHORIZED'",
      ).get(outboundMessageId)).toEqual({ count: 1 });
      expect(() => db.claimMessageForSending(outboundMessageId, { now: NOW }))
        .toThrow(/global outbound pause is active/i);
      expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(outboundMessageId))
        .toEqual({ status: "APPROVED" });

      const replayJob = await runStageJob(db, input.payload, "chat-two");
      expect(replayJob.status).toBe("COMPLETED");
      const replay = JSON.parse(String(replayJob.result_json)) as Record<string, unknown>;
      expect(replay).toMatchObject({
        messageVersionId: first.messageVersionId,
        reviewHash: first.reviewHash,
        campaignSendAuthorizationId: first.campaignSendAuthorizationId,
        campaignMessageAuthorizationId,
        outboundMessageId,
        outboundStatus: "APPROVED",
        externalSendAuthorized: true,
      });
      expect(count(db, "campaign_message_authorizations")).toBe(1);
      expect(count(db, "outbound_messages")).toBe(1);
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM events WHERE entity_id=? AND event_type='MESSAGE_CAMPAIGN_POLICY_AUTHORIZED'",
      ).get(outboundMessageId)).toEqual({ count: 1 });
      expect(db.listPendingNotifications().map((row) => row.destination)).toEqual(["chat-one", "chat-two"]);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: "expired authorization",
      validity: { validFrom: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z" },
      mutate: (_db: AgentDatabase, _input: Fixture) => undefined,
      error: /inactive, revoked, expired, or stale/i,
    },
    {
      name: "revoked authorization",
      validity: undefined,
      mutate: (db: AgentDatabase, input: Fixture) => db.revokeCampaignSendAuthorization(
        input.campaignSendAuthorizationId,
        `revoke:${input.campaignSendAuthorizationId}`,
        "operator stop",
        manager,
      ),
      error: /inactive, revoked, expired, or stale/i,
    },
    {
      name: "do-not-contact recipient",
      validity: undefined,
      mutate: (db: AgentDatabase, input: Fixture) => db.addDnc(
        "email",
        input.destination,
        "recipient opted out",
        "fixture",
      ),
      error: /do-not-contact/i,
    },
    {
      name: "INVALID email",
      validity: undefined,
      mutate: (db: AgentDatabase, input: Fixture) => db.markContactEmailInvalid(
        input.contactId,
        "independent verifier conflict",
      ),
      error: /independently VALID email/i,
    },
  ])("blocks $name atomically without staged half-products", async ({ validity, mutate, error }, index) => {
    const db = database();
    try {
      const input = fixture(db, `blocked-${index}`, validity);
      mutate(db, input);
      expect(Object.fromEntries(stagedTables.map((table) => [table, count(db, table)])))
        .toEqual(Object.fromEntries(stagedTables.map((table) => [table, 0])));

      const job = await runStageJob(db, input.payload, "chat-one");
      expect(job.status).toBe("FAILED");
      expect(String(job.last_error)).toMatch(error);
      expect(Object.fromEntries(stagedTables.map((table) => [table, count(db, table)])))
        .toEqual(Object.fromEntries(stagedTables.map((table) => [table, 0])));
      expect(db.db.prepare("SELECT status FROM leads WHERE id=?").get(input.leadId))
        .toEqual({ status: "READY_FOR_REVIEW" });
      expect(db.listPendingNotifications()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
