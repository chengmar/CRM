import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueAutonomousGroundedMessagesAfterDiscovery,
  getAutonomousMessageBridgeDiagnostics,
  replayAuthorizedAutonomousCampaignMessages,
} from "../src/acquisition/autonomous-discovery-message-bridge.js";
import { launchAutonomousPilot } from "../src/acquisition/autonomous-pilot-launch.js";
import { CampaignHunterEmailVerifier } from "../src/acquisition/providers/campaign-runtime.js";
import { HunterOfficialAdapter } from "../src/acquisition/providers/hunter-official.js";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { JobWorker } from "../src/jobs/worker.js";
import { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-discovery-bridge-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function sellerKnowledge(): Record<string, unknown> {
  return {
    schemaVersion: "seller-knowledge-v2",
    factSetId: "seller-facts-northstar",
    factSetVersion: 1,
    profile: {
      schemaVersion: "seller-profile-v2",
      id: "seller-northstar",
      version: 1,
      status: "APPROVED",
      legalNameEn: "Northstar manufacturing Ltd.",
      brandNameEn: "Northstar Example",
      website: "https://northstar-manufacturing.test",
      sender: { name: "Alex Chen", email: "alex@northstar-manufacturing.test" },
      postalAddress: {
        line1: "18 Industrial Road",
        city: "Nanjing",
        postalCode: "210000",
        country: "China",
      },
      unsubscribe: { method: "REPLY", instruction: "Reply unsubscribe to opt out." },
      products: [{
        id: "product-sample",
        name: "sample products",
        modelsOrSpecifications: ["Application-specific configuration"],
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
      id: "seller-fact-sample",
      profileId: "seller-northstar",
      factSetVersion: 1,
      subject: "Northstar Example",
      predicate: "product family",
      value: "Sample Products is an approved product family.",
      unit: null,
      source: {
        type: "PRODUCT_SHEET",
        url: "https://northstar-manufacturing.test/products/sample-product",
        documentId: "product-sheet-sample",
        contentHash: "a".repeat(64),
      },
      publicApproved: true,
      status: "ACTIVE",
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
      confidentiality: "PUBLIC",
      version: 1,
    }],
    offers: [{
      schemaVersion: "seller-offer-v2",
      id: "offer-sample-product",
      profileId: "seller-northstar",
      profileVersion: 1,
      version: 1,
      productId: "product-sample",
      text: "We can share approved product material for sample products.",
      sellerFactIds: ["seller-fact-sample"],
      status: "ACTIVE",
      publicApproved: true,
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
    }],
    privateCases: [],
  };
}

function launchSpec(launchKey: string, overrides: {
  buyerTypes?: string[];
  qualificationTracks?: Array<"ACTIVE_INTENT" | "HIGH_ICP_FIT">;
} = {}): Record<string, unknown> {
  const providerBudget = {
    mode: "CAPPED",
    allowedProviders: ["searxng", "local-public-web", "hunter"],
    unit: "REQUESTS",
    maxUnits: 50,
    maxAmountUsd: 10,
    requiresSeparateApproval: true,
  };
  return {
    launchKey,
    actionId: `action-${launchKey}`,
    campaign: {
      name: `Autonomous bridge ${launchKey}`,
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 1,
    },
    brief: {
      schemaVersion: "campaign-brief-v2",
      id: "caller-value",
      version: 9,
      market: "Malaysia",
      productFamily: "sample product application",
      buyerTypes: overrides.buyerTypes ?? ["system integrator"],
      industries: ["sample application"],
      roleFamilies: ["engineering"],
      qualificationTracks: overrides.qualificationTracks ?? ["HIGH_ICP_FIT"],
      requiredSignals: ["documented industrial application"],
      exclusions: ["consumer-only reseller"],
      targetMetric: "VALID_CONTACTS",
      targetCount: 1,
      providerBudget,
      llmBudget: {
        mode: "CAPPED",
        allowedProviders: ["openai"],
        unit: "TOKENS",
        maxUnits: 20_000,
        maxAmountUsd: 5,
        requiresSeparateApproval: true,
      },
      offerIds: ["offer-sample-product"],
      transport: "SMTP",
      deadline: null,
      hypothesis: "Documented applications can support a grounded first email.",
    },
    sellerKnowledge: sellerKnowledge(),
    provider: { providerKey: "SEARXNG", operation: "EVIDENCE_SEARCH" },
    authorization: {
      actor: "workspace-owner",
      source: "THREAD_EXPLICIT_AUTHORIZATION",
      reason: "Bounded autonomous integration fixture",
    },
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    limits: { total: 5, daily: 5, hourly: 5 },
    replyChatId: "",
  };
}

function config(): AgentConfig {
  return loadConfig({
    ACQ_HUNTER_V2_ENABLED: "true",
    HUNTER_API_KEY: "fixture-secret",
    HUNTER_REQUEST_TIMEOUT_MS: "1000",
    HUNTER_CACHE_TTL_SECONDS: "3600",
    HUNTER_EMAIL_VERIFICATION_COST_UNITS: "1",
    HUNTER_EMAIL_VERIFICATION_COST_MICROS: "25000",
  });
}

function hunterVerifier(
  db: AgentDatabase,
  scope: { campaignId: string; versionId: string },
  email: string,
): CampaignHunterEmailVerifier {
  const loaded = config();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    data: {
      email,
      status: "valid",
      score: 98,
      accept_all: false,
      disposable: false,
      webmail: false,
      block: false,
    },
  }), { headers: { "content-type": "application/json" } }));
  const adapter = new HunterOfficialAdapter({
    enabled: true,
    apiKey: loaded.HUNTER_API_KEY,
    requestTimeoutMs: 1_000,
    fetchImpl,
    resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
    costByOperation: {
      WORK_EMAIL_DISCOVERY: { costUnits: 1, usd: 0.025, currency: "USD" },
      EMAIL_VERIFICATION: { costUnits: 1, usd: 0.025, currency: "USD" },
    },
  });
  return new CampaignHunterEmailVerifier({ db, scope, config: loaded, adapter });
}

interface SeedOptions {
  independentEvidence?: boolean;
  emailStatus?: "VALID" | "RISKY" | "UNKNOWN";
  strictVerification?: boolean;
  recipientTier?: "A" | "B";
  demandEvidenceQualified?: boolean;
  additionalTierBMailbox?: boolean;
  buyerType?: string;
  officialScenarioEvidence?: string;
  independentBuyerEvidence?: string;
  directIntent?: boolean;
  contactEvidenceCollision?: { sourceType: string; evidence: string };
}

async function seedDiscoveryResult(
  db: AgentDatabase,
  scope: { campaignId: string; versionId: string },
  options: SeedOptions = {},
): Promise<{ leadId: string; contactId: string; email: string }> {
  const independentEvidence = options.independentEvidence ?? true;
  const emailStatus = options.emailStatus ?? "VALID";
  const recipientTier = options.recipientTier ?? "A";
  const demandEvidenceQualified = options.demandEvidenceQualified ?? true;
  const strictVerification = options.strictVerification ?? (emailStatus === "VALID" && recipientTier === "A");
  const domain = "buyer-industries.com";
  const company = "Buyer Process Systems";
  const observedAt = new Date().toISOString();
  const officialScenarioUrl = `https://${domain}/applications/sample-application`;
  const directIntentQuote = `${company} announced a new plant expansion project for sample application.`;
  const email = recipientTier === "B" ? `sales@${domain}` : `jane@${domain}`;
  const contactSourceUrl = `https://${domain}/${recipientTier === "B" ? "contact" : "team"}`;
  const leadId = db.upsertLead({
    campaignId: scope.campaignId,
    company,
    domain,
    website: `https://${domain}/`,
    country: "Malaysia",
    buyerType: options.buyerType ?? "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 30,
    activityScore: 20,
    contactScore: 20,
    channelScore: emailStatus === "VALID" ? 5 : 0,
    totalScore: emailStatus === "VALID" ? 100 : 95,
    grade: "GOLD",
    lastActivityAt: observedAt,
    demandEvidenceQualified,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "CURRENT_PROJECT",
    demandEvidence: options.directIntent ? [{
      id: `direct-intent-${scope.campaignId}`,
      stage: "CURRENT_PROJECT",
      sourceUrl: officialScenarioUrl,
      publisherDomain: domain,
      sourceDate: observedAt,
      quote: directIntentQuote,
      score: 25,
      sourceKind: "OFFICIAL_PAGE",
      reviewEligible: true,
    }] : [],
    sendEligible: demandEvidenceQualified && recipientTier === "A",
    eligibilityReasons: demandEvidenceQualified ? [] : ["no qualifying direct demand evidence"],
  });
  db.addLeadSource(
    leadId,
    officialScenarioUrl,
    "official_website",
    null,
    options.officialScenarioEvidence ?? (options.directIntent
      ? `${directIntentQuote} ${company} operates a documented sample production process.`
      : `${company} operates a documented sample production process.`),
  );
  const officialMailboxText = `Sales enquiries for ${company}: ${email}`;
  if (recipientTier === "B" && options.contactEvidenceCollision) {
    db.addLeadSource(
      leadId,
      contactSourceUrl,
      options.contactEvidenceCollision.sourceType,
      null,
      options.contactEvidenceCollision.evidence,
    );
  }
  const persistedOfficialMailboxEvidence = recipientTier === "B"
    ? db.persistOfficialMailboxEvidence(leadId, {
      sourceUrl: contactSourceUrl,
      exactText: officialMailboxText,
      observedAt,
    })
    : null;
  if (recipientTier === "A") {
    db.addLeadSource(
      leadId,
      contactSourceUrl,
      "official_website",
      null,
      "Jane Lim is Engineering Manager at Buyer Process Systems.",
    );
  }
  if (independentEvidence) {
    db.addLeadSource(
      leadId,
      "https://industry-association.org/members/buyer-process-systems",
      "industry_association",
      null,
      options.independentBuyerEvidence ?? `${company} is an engineering system integrator for sample facilities projects.`,
    );
  }
  const contactId = db.upsertContact({
    leadId,
    name: recipientTier === "B" ? `${company} team` : "Jane Lim",
    title: recipientTier === "B" ? "Company mailbox" : "Engineering Manager",
    email,
    sourceUrl: contactSourceUrl,
    employmentVerifiedAt: recipientTier === "B" ? null : new Date().toISOString(),
    emailStatus,
    emailRisk: emailStatus === "VALID" ? "independent Hunter verification" : "not verified",
    roleAddress: recipientTier === "B",
    disposableAddress: false,
    catchAll: false,
    officialMailboxEvidence: persistedOfficialMailboxEvidence,
  });
  if (strictVerification) {
    const discoveryAssertionId = `public-web-discovery-${scope.campaignId}`;
    const discoveryEvidenceHash = hash({ emailHash: hash(email), source: contactSourceUrl });
    const verified = await hunterVerifier(db, scope, email).verify({
      email,
      expectedDomain: domain,
      personRef: `person-${contactId}`,
      discoveryAssertionId,
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      discoverySourceUrl: contactSourceUrl,
      discoveryEvidenceHash,
    });
    if (!verified || verified.status !== "VALID") throw new Error("Hunter fixture did not return VALID");
    db.persistIndependentEmailVerification({
      contactId,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
      providerRunId: verified.providerRunId,
      discoveryAssertionId: verified.discoveryAssertionId,
      verificationAssertionId: verified.verificationAssertionId,
      emailHash: verified.emailHash,
      discoverySourceKey: verified.discoverySourceKey,
      verifierSourceKey: verified.verifierSourceKey,
      discoverySourceUrl: verified.discoverySourceUrl,
      discoveryEvidenceHash: verified.discoveryEvidenceHash,
      providerMailboxVerdict: verified.providerMailboxVerdict,
      catchAll: verified.catchAll,
      disposable: verified.disposable,
      roleMailbox: verified.roleMailbox,
      confidence: verified.confidence,
      rawPayloadHash: verified.rawPayloadHash,
      observedAt: verified.observedAt,
      expiresAt: verified.expiresAt,
      creditUnits: verified.creditUnits,
      estimatedCostMicros: verified.estimatedCostMicros,
    });
  }
  if (options.additionalTierBMailbox) {
    const companyMailbox = `sales@${domain}`;
    const companyMailboxUrl = `https://${domain}/contact`;
    const exactPublication = `Email ${companyMailbox} for sales enquiries`;
    const persistedEvidence = db.persistOfficialMailboxEvidence(leadId, {
      sourceUrl: companyMailboxUrl,
      exactText: exactPublication,
      observedAt,
    });
    db.upsertContact({
      leadId,
      name: `${company} team`,
      title: "Company mailbox",
      email: companyMailbox,
      sourceUrl: companyMailboxUrl,
      employmentVerifiedAt: null,
      emailStatus: "RISKY",
      emailRisk: "role mailbox fixture",
      roleAddress: true,
      disposableAddress: false,
      catchAll: false,
      officialMailboxEvidence: persistedEvidence,
    });
  }
  db.transitionLead(leadId, "VERIFYING", "fixture", "public research complete");
  if (demandEvidenceQualified && recipientTier === "A") {
    db.transitionLead(leadId, "READY_FOR_REVIEW", "fixture", "strict fixture gates passed");
  } else {
    db.transitionLead(leadId, "ENRICHING", "fixture", "ICP qualification pending");
  }
  return { leadId, contactId, email };
}

function discoverySummary(campaignId: string, ready: number) {
  return {
    campaignId,
    provider: "fixture-public-web",
    orchestrator: "fixture",
    marketSummary: "fixture",
    queries: ["fixture"],
    roundsCompleted: 1,
    searchResults: 3,
    candidateCompanies: 1,
    domainsAssessed: 1,
    leadsStored: 1,
    companyQualified: 1,
    contactsFound: 1,
    verifiedEmails: ready,
    riskyEmails: 0,
    enrichmentPending: 0,
    eligibleForReview: 1,
    rejected: 0,
    skipped: 0,
    duplicatesSkipped: 0,
    rejectionReasons: {},
    llmCallsUsed: 0,
    llmCallLimit: 0,
    hermesCallsUsed: 0,
    errors: [],
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeWorker(
  db: AgentDatabase,
  launch: ReturnType<typeof launchAutonomousPilot>,
  options: SeedOptions = {},
): JobWorker {
  const discovery = {
    assertLegacyRuntimeContracts: vi.fn(async () => ({ campaignId: launch.ids.campaignId })),
    run: vi.fn(async () => {
      await seedDiscoveryResult(db, {
        campaignId: launch.ids.campaignId,
        versionId: launch.ids.versionId,
      }, options);
      return discoverySummary(launch.ids.campaignId, options.emailStatus === "UNKNOWN" ? 0 : 1);
    }),
  };
  const bitable = { isConfigured: () => false };
  const feishu = {
    sendText: vi.fn(async () => undefined),
    sendCard: vi.fn(async () => undefined),
  };
  return new JobWorker(
    config(),
    db,
    discovery as never,
    {} as never,
    bitable as never,
    {} as never,
    feishu as never,
    { workerId: `autonomous-bridge-${launch.ids.campaignId}`, pollIntervalMs: 5 },
  );
}

function count(db: AgentDatabase, table: string): number {
  return Number((db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

describe("autonomous discovery message bridge", () => {
  it("runs launch -> DISCOVER -> strict STAGE and creates one APPROVED outbound without SMTP", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("happy-path"));
      const worker = fakeWorker(db, launch);
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      expect(db.getJob(launch.ids.jobId)?.status).toBe("COMPLETED");
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM jobs WHERE job_type='STAGE_GROUNDED_MESSAGE' AND status='COMPLETED'",
      ).get()).toEqual({ count: 1 });
      expect(db.db.prepare(
        `SELECT status, authorization_mode, campaign_send_authorization_id
         FROM outbound_messages`,
      ).get()).toMatchObject({
        status: "APPROVED",
        authorization_mode: "CAMPAIGN_POLICY",
        campaign_send_authorization_id: launch.ids.sendAuthorizationId,
      });
      expect(db.getSetting("outbound_paused")).toBe("true");
      expect(count(db, "outbound_messages")).toBe(1);

      const discoverPayload = JSON.parse(String(db.getJob(launch.ids.jobId)?.payload_json)) as Record<string, unknown>;
      const replay = enqueueAutonomousGroundedMessagesAfterDiscovery({ db, discoveryPayload: discoverPayload });
      expect(replay).toMatchObject({ status: "STAGED", enqueued: 0, alreadyStaged: 1, blocked: 0 });
      const campaignReplay = replayAuthorizedAutonomousCampaignMessages({ db });
      expect(campaignReplay).toMatchObject({ campaignCount: 1, enqueued: 0, alreadyStaged: 1, blocked: 0 });
      expect(getAutonomousMessageBridgeDiagnostics(db)).toMatchObject({
        authorizedCampaigns: 1,
        authorizedLeads: 1,
        contactsWithEmail: 1,
        stageJobs: 1,
        outboundMessages: 1,
        messageAuthorizations: 1,
      });
      expect(count(db, "outbound_messages")).toBe(1);
      expect(count(db, "campaign_message_authorizations")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("selects the highest V17-ranked sendable contact instead of the first DB row", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("ranked-contact"));
      const worker = fakeWorker(db, launch, { additionalTierBMailbox: true });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      const leadId = String((db.db.prepare("SELECT id FROM leads").get() as { id: string }).id);
      expect(db.listContactsForLead(leadId).map((contact) => String(contact.email)))
        .toEqual(["sales@buyer-industries.com", "jane@buyer-industries.com"]);
      expect(db.db.prepare(
        `SELECT c.email FROM outbound_messages om JOIN contacts c ON c.id=om.contact_id`,
      ).get()).toEqual({ email: "jane@buyer-industries.com" });
    } finally {
      db.close();
    }
  });

  it("stages a tier B official company mailbox through ICP_FIT without direct demand evidence", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("tier-b-icp"));
      const worker = fakeWorker(db, launch, {
        recipientTier: "B",
        emailStatus: "RISKY",
        strictVerification: false,
        demandEvidenceQualified: false,
        contactEvidenceCollision: {
          sourceType: "search_index",
          evidence: "Search result summary for the official contact page.",
        },
      });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      expect(db.db.prepare(
        `SELECT recipient_tier, role_address, disposable_address, recipient_policy_version,
                length(recipient_evidence_hash) AS evidence_hash_length
         FROM contacts`,
      ).get()).toMatchObject({
        recipient_tier: "B",
        role_address: 1,
        disposable_address: 0,
        recipient_policy_version: "recipient-tier-v1",
        evidence_hash_length: 64,
      });
      expect(db.db.prepare(
        `SELECT source_type, evidence FROM lead_sources
         WHERE source_url='https://buyer-industries.com/contact'`,
      ).get()).toEqual({
        source_type: "official_website",
        evidence: "Search result summary for the official contact page.\n\n" +
          "Sales enquiries for Buyer Process Systems: sales@buyer-industries.com",
      });
      expect(db.db.prepare(
        `SELECT send_eligible, demand_evidence_qualified, outreach_qualification_track,
                outreach_qualification_policy_version, status FROM leads`,
      ).get()).toMatchObject({
        send_eligible: 1,
        demand_evidence_qualified: 0,
        outreach_qualification_track: "ICP_FIT",
        outreach_qualification_policy_version: "qualification-policy-v2",
        status: "APPROVED",
      });
      const outbound = db.db.prepare("SELECT status, body FROM outbound_messages").get() as
        { status: string; body: string };
      expect(outbound.status).toBe("APPROVED");
      expect(outbound.body).toContain("Hi Buyer Process Systems team,");

      const dueMessages = db.getDueMessages(10);
      expect(dueMessages).toHaveLength(1);
      expect(dueMessages[0]).toMatchObject({
        recipient_tier: "B",
        email: dueMessages[0]!.destination,
      });
      expect(db.getCampaignPolicyAuthorizationBlockers(dueMessages[0]!)).toEqual([]);

      const dispatcher = new OutboundDispatcher(config(), db);
      try {
        const plan = dispatcher.plan(10);
        expect(plan).toHaveLength(1);
        expect(plan[0]!.blockers.join(" ")).not.toMatch(/role-based mailbox|tier C|email status is not VALID/i);
        expect(plan[0]!.blockers).not.toContain("tier B recipient binding is incomplete");
      } finally {
        dispatcher.close();
      }

      const messageId = String(dueMessages[0]!.id);
      expect(db.recordOutboundPolicyBlock(messageId, ["global outbound pause is active"])).toBe(true);
      db.setSetting("outbound_paused", "false");
      expect(db.claimMessageForSending(messageId)).toMatchObject({ status: "SENDING" });
      expect(db.db.prepare(
        "SELECT status, failure_reason FROM outbound_messages WHERE id=?",
      ).get(messageId)).toEqual({ status: "SENDING", failure_reason: null });
    } finally {
      db.close();
    }
  });

  it("resolves a free-text industry label from the campaign brief and independent buyer evidence", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("free-text-buyer-type"));
      const worker = fakeWorker(db, launch, {
        buyerType: "sample fabrication",
        recipientTier: "B",
        emailStatus: "RISKY",
        strictVerification: false,
        demandEvidenceQualified: false,
      });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      expect(db.db.prepare(
        "SELECT outreach_qualification_track, send_eligible FROM leads",
      ).get()).toEqual({ outreach_qualification_track: "ICP_FIT", send_eligible: 1 });
      expect(count(db, "outbound_messages")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("uses the authorized campaign buyer category for a tier B ICP mailbox without third-party buyer evidence", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("tier-b-campaign-category", {
        buyerTypes: ["system integrator", "industrial distributor"],
      }));
      const worker = fakeWorker(db, launch, {
        buyerType: "B2B company",
        recipientTier: "B",
        emailStatus: "RISKY",
        strictVerification: false,
        demandEvidenceQualified: false,
        independentEvidence: false,
      });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      expect(db.db.prepare(
        "SELECT outreach_qualification_track, send_eligible FROM leads",
      ).get()).toEqual({ outreach_qualification_track: "ICP_FIT", send_eligible: 1 });
      expect(db.db.prepare(
        "SELECT recipient_tier, email_status FROM contacts",
      ).get()).toEqual({ recipient_tier: "B", email_status: "RISKY" });
      expect(count(db, "outbound_messages")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps an ambiguous B2B label blocked when a multi-archetype brief has no supporting buyer evidence", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("ambiguous-buyer-type", {
        buyerTypes: ["system integrator", "industrial distributor"],
      }));
      const worker = fakeWorker(db, launch, {
        buyerType: "B2B company",
        independentBuyerEvidence: "Buyer Process Systems appears in the association member directory.",
      });
      worker.start();
      await waitFor(() => db.getJob(launch.ids.jobId)?.status === "COMPLETED");
      await worker.stop();

      expect(count(db, "outbound_messages")).toBe(0);
      const events = db.db.prepare(
        "SELECT payload_json FROM events WHERE event_type='AUTONOMOUS_MESSAGE_STAGING_BLOCKED'",
      ).all() as Array<{ payload_json: string }>;
      expect(events.some((row) =>
        row.payload_json.includes("AUTONOMOUS_INDEPENDENT_BUYER_TYPE_EVIDENCE_MISSING"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("uses a short grounded ICP fact instead of purchase language from the full page", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("safe-icp-excerpt"));
      const worker = fakeWorker(db, launch, {
        recipientTier: "B",
        emailStatus: "RISKY",
        strictVerification: false,
        demandEvidenceQualified: false,
        officialScenarioEvidence: [
          "Buyer Process Systems describes a current project procurement programme.",
          "Buyer Process Systems operates a documented sample production process.",
        ].join(" "),
      });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      const outbound = db.db.prepare("SELECT body FROM outbound_messages").get() as { body: string };
      expect(outbound.body).toContain("documented sample production process");
      expect(outbound.body).not.toMatch(/current project|procurement/i);
    } finally {
      db.close();
    }
  });

  it("prefers verified ACTIVE_INTENT when HIGH_ICP_FIT is also permitted", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("dual-track-active-intent", {
        qualificationTracks: ["ACTIVE_INTENT", "HIGH_ICP_FIT"],
      }));
      const worker = fakeWorker(db, launch, {
        directIntent: true,
        demandEvidenceQualified: true,
      });
      worker.start();
      await waitFor(() => count(db, "campaign_message_authorizations") === 1);
      await worker.stop();

      expect(db.db.prepare(
        "SELECT qualification_track FROM qualification_runs",
      ).get()).toEqual({ qualification_track: "ACTIVE_INTENT" });
    } finally {
      db.close();
    }
  });

  it("stages a newly discovered autonomous recipient after contact enrichment", async () => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec("tier-b-after-enrichment"));
      const discoverJob = db.getJob(launch.ids.jobId)!;
      const discoverPayload = JSON.parse(String(discoverJob.payload_json)) as Record<string, unknown>;
      const discovery = {
        assertLegacyRuntimeContracts: vi.fn(async () => ({ campaignId: launch.ids.campaignId })),
        enrichPendingContacts: vi.fn(async () => {
          await seedDiscoveryResult(db, {
            campaignId: launch.ids.campaignId,
            versionId: launch.ids.versionId,
          }, {
            recipientTier: "B",
            emailStatus: "RISKY",
            strictVerification: false,
            demandEvidenceQualified: false,
          });
          return {
            campaignId: launch.ids.campaignId,
            pass: 1,
            attempted: 1,
            contactsFound: 1,
            verifiedEmails: 0,
            riskyEmails: 1,
            readyForReview: 1,
            stillPending: 0,
            nextPass: null,
            remainingInPass: 0,
            remainingEligible: 0,
            nextRunAt: null,
            hermesCallsUsed: 0,
            errors: [],
          };
        }),
      };
      const worker = new JobWorker(
        config(),
        db,
        discovery as never,
        {} as never,
        { isConfigured: () => false } as never,
        {} as never,
        { sendText: vi.fn(async () => undefined), sendCard: vi.fn(async () => undefined) } as never,
      );
      const executor = worker as unknown as {
        execute(jobType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
      };

      const result = await executor.execute("ENRICH_CONTACTS", {
        ...discoverPayload,
        pass: 1,
      });

      expect(result).toMatchObject({
        autonomousMessageBridge: {
          status: "STAGED",
          examined: 1,
          enqueued: 1,
          blocked: 0,
        },
      });
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM jobs WHERE job_type='STAGE_GROUNDED_MESSAGE' AND status='QUEUED'",
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: "seller binding removed",
      options: {},
      mutatePayload: (payload: Record<string, unknown>) => { delete payload.sellerKnowledge; },
      blocker: "AUTONOMOUS_DISCOVERY_PAYLOAD_INVALID:sellerKnowledge",
    },
    {
      name: "second public evidence group missing",
      options: { independentEvidence: false },
      mutatePayload: (_payload: Record<string, unknown>) => undefined,
      blocker: "AUTONOMOUS_TWO_INDEPENDENT_PUBLIC_EVIDENCE_GROUPS_REQUIRED",
    },
    {
      name: "email remains UNKNOWN",
      options: { emailStatus: "UNKNOWN", strictVerification: false },
      mutatePayload: (_payload: Record<string, unknown>) => undefined,
      blocker: "AUTONOMOUS_EMAIL_NOT_VALID",
    },
    {
      name: "VALID email lacks independent lineage",
      options: { emailStatus: "VALID", strictVerification: false },
      mutatePayload: (_payload: Record<string, unknown>) => undefined,
      blocker: "AUTONOMOUS_EMAIL_INDEPENDENT_VALID_PROVENANCE_MISSING",
    },
  ] as const)("records $name as an explicit blocker and never queues STAGE", async ({ options, mutatePayload, blocker }) => {
    const db = database();
    try {
      const launch = launchAutonomousPilot(db, launchSpec(`blocked-${blocker.slice(0, 24).toLowerCase()}`));
      const discoverJob = db.getJob(launch.ids.jobId)!;
      const payload = JSON.parse(String(discoverJob.payload_json)) as Record<string, unknown>;
      mutatePayload(payload);
      db.db.prepare("UPDATE jobs SET payload_json=? WHERE id=?").run(JSON.stringify(payload), launch.ids.jobId);
      const worker = fakeWorker(db, launch, { ...options });
      worker.start();
      await waitFor(() => db.getJob(launch.ids.jobId)?.status === "COMPLETED");
      await worker.stop();

      expect(db.db.prepare(
        "SELECT count(*) AS count FROM jobs WHERE job_type='STAGE_GROUNDED_MESSAGE'",
      ).get()).toEqual({ count: 0 });
      expect(count(db, "outbound_messages")).toBe(0);
      const blockerEvents = db.db.prepare(
        `SELECT payload_json FROM events WHERE event_type='AUTONOMOUS_MESSAGE_STAGING_BLOCKED'`,
      ).all() as Array<{ payload_json: string }>;
      expect(blockerEvents.some((row) => String(row.payload_json).includes(blocker))).toBe(true);
    } finally {
      db.close();
    }
  });
});
