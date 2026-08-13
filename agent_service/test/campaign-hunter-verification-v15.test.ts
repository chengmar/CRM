import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignHunterEmailVerifier } from "../src/acquisition/providers/campaign-runtime.js";
import { HunterOfficialAdapter } from "../src/acquisition/providers/hunter-official.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";
import { DiscoveryService } from "../src/search/discovery.js";
import { StrictLegacyDiscoveryRuntime } from "../src/search/legacy-discovery-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-hunter-v15-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function authorizedCampaign(
  db: AgentDatabase,
  suffix: string,
  options: { mode?: "CAPPED" | "ZERO_COST"; allowedProviders?: string[] } = {},
) {
  const campaignId = db.createCampaign({
    name: `hunter-${suffix}`,
    market: "Malaysia",
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 10,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [3, 7, 14],
  });
  const mode = options.mode ?? "CAPPED";
  const providerBudget = {
    mode,
    allowedProviders: options.allowedProviders ?? ["searxng", "local-public-web", "hunter"],
    unit: "REQUESTS",
    maxUnits: mode === "CAPPED" ? 10 : 0,
    maxAmountUsd: mode === "CAPPED" ? 1 : 0,
    requiresSeparateApproval: true,
  };
  const saved = db.saveCampaignDraft({
    briefKey: `hunter:${suffix}`,
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

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    ACQ_HUNTER_V2_ENABLED: "true",
    HUNTER_API_KEY: "test-secret",
    HUNTER_REQUEST_TIMEOUT_MS: "1000",
    HUNTER_CACHE_TTL_SECONDS: "3600",
    HUNTER_EMAIL_VERIFICATION_COST_UNITS: "1",
    HUNTER_EMAIL_VERIFICATION_COST_MICROS: "25000",
    ...overrides,
  });
}

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

function verifier(
  db: AgentDatabase,
  scope: { campaignId: string; versionId: string },
  fetchImpl: typeof fetch,
  configOverrides: Record<string, string> = {},
) {
  const loaded = config(configOverrides);
  const adapter = new HunterOfficialAdapter({
    enabled: loaded.ACQ_HUNTER_V2_ENABLED,
    apiKey: loaded.HUNTER_API_KEY,
    requestTimeoutMs: loaded.HUNTER_REQUEST_TIMEOUT_MS,
    fetchImpl,
    resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
    costByOperation: {
      WORK_EMAIL_DISCOVERY: { costUnits: 1, usd: 0.025, currency: "USD" },
      EMAIL_VERIFICATION: { costUnits: 1, usd: 0.025, currency: "USD" },
    },
  });
  return new CampaignHunterEmailVerifier({ db, scope, config: loaded, adapter });
}

function request(suffix = "1") {
  const email = `jane${suffix}@buyer.com`;
  const emailHash = hash(email);
  return {
    email,
    expectedDomain: "buyer.com",
    personRef: `person-${suffix}`,
    discoveryAssertionId: `public-web-discovery-${suffix}`,
    discoverySourceKey: "LOCAL_PUBLIC_WEB" as const,
    discoverySourceUrl: "https://buyer.com/team",
    discoveryEvidenceHash: hash({ emailHash, source: "https://buyer.com/team", scope: suffix }),
  };
}

function addContact(db: AgentDatabase, campaignId: string, email: string, status: "VALID" | "RISKY" | "INVALID") {
  const leadId = db.upsertLead({
    campaignId,
    company: "Buyer Engineering",
    domain: "buyer.com",
    website: "https://buyer.com/",
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 30,
    activityScore: 10,
    contactScore: 20,
    channelScore: status === "VALID" ? 5 : 2,
    totalScore: 95,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "ACTIVE_PROJECT",
    demandEvidence: [],
    sendEligible: status === "VALID",
    eligibilityReasons: [],
  });
  const contactId = db.upsertContact({
    leadId,
    name: "Jane Buyer",
    title: "Procurement Manager",
    email,
    sourceUrl: "https://buyer.com/team",
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: status,
    emailRisk: `Hunter verifier ${status.toLowerCase()}`,
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
    verificationNotes: "public fixture",
  });
  return { leadId, contactId };
}

describe("campaign-bound Hunter verification v15", () => {
  it("wires a public webpage email through discovery into Hunter provenance", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{
      exchange: "mx.fixture.test",
      priority: 10,
    }]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-hunter-discovery-"));
    tempDirs.push(directory);
    const businessDir = path.join(directory, "business");
    fs.mkdirSync(businessDir, { recursive: true });
    fs.writeFileSync(path.join(businessDir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: Fixture Exporter",
      "  website: https://seller.example",
      "product:",
      "  name_en: sample product application",
      "  models_or_specs:",
      "    - sample products",
    ].join("\n"), "utf8");
    const loaded = loadConfig({
      AGENT_DB_PATH: path.join(directory, "agent.db"),
      BUSINESS_DATA_DIR: businessDir,
      SEARCH_PROVIDER: "searxng",
      SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
      ACQ_SEARXNG_V2_ENABLED: "true",
      SEARXNG_LOCAL_ENDPOINT_ALLOWED: "true",
      SEARXNG_REQUEST_TIMEOUT_MS: "1000",
      SEARXNG_CACHE_TTL_SECONDS: "3600",
      ACQ_LOCAL_PUBLIC_WEB_ENABLED: "true",
      LOCAL_PUBLIC_WEB_TIMEOUT_MS: "1000",
      LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: "3600",
      ACQ_HUNTER_V2_ENABLED: "true",
      HUNTER_API_KEY: "test-secret",
      HUNTER_REQUEST_TIMEOUT_MS: "1000",
      HUNTER_CACHE_TTL_SECONDS: "3600",
      HUNTER_EMAIL_VERIFICATION_COST_UNITS: "1",
      HUNTER_EMAIL_VERIFICATION_COST_MICROS: "25000",
      RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      MAX_DISCOVERY_ROUNDS: "1",
      MAX_DISCOVERY_CONCURRENCY: "1",
      MAX_SEARCH_CONCURRENCY: "1",
      MAX_SEARCH_RESULTS_PER_CAMPAIGN: "20",
      MAX_PAGES_PER_CAMPAIGN: "10",
      MAX_COMPANY_PAGES: "1",
      MAX_CONTACTS_PER_COMPANY: "1",
      SEARCH_RETRY_ATTEMPTS: "1",
      SEARCH_RETRY_BASE_DELAY_MS: "1",
      MAX_LLM_CALLS_PER_JOB: "30",
      HERMES_RESEARCH_ENABLED: "false",
    });
    const db = new AgentDatabase(loaded.AGENT_DB_PATH);
    try {
    const scope = authorizedCampaign(db, "discovery");
    const network = vi.fn<typeof fetch>(async (target) => {
      const url = new URL(String(target));
      if (url.origin === "http://127.0.0.1:8888") {
        return new Response(JSON.stringify({
          results: [{
            title: "Buyer Engineering",
            url: "https://buyer.com/",
            content: "Buyer Engineering has an active sample product application integration project in Malaysia.",
          }],
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.origin === "https://buyer.com" && url.pathname === "/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url.origin === "https://buyer.com" && url.pathname === "/") {
        return new Response([
          "<html><head><title>Buyer Engineering</title></head><body>",
          "<p>Buyer Engineering is a system integrator delivering an active sample product application project. Project update 2026-06-01.</p>",
          "<p>Jane Buyer - Procurement Manager at Buyer Engineering - jane1@buyer.com</p>",
          "</body></html>",
        ].join(""), { headers: { "content-type": "text/html" } });
      }
      if (url.origin === "https://api.hunter.io" && url.pathname === "/v2/email-verifier") {
        return jsonResponse({
          email: "jane1@buyer.com",
          status: "valid",
          score: 98,
          accept_all: false,
          disposable: false,
          webmail: false,
          block: false,
        });
      }
      throw new Error(`Unexpected fixture network target: ${url.origin}${url.pathname}`);
    });
    vi.stubGlobal("fetch", network);
    const hunterAdapter = new HunterOfficialAdapter({
      enabled: true,
      apiKey: "test-secret",
      requestTimeoutMs: 1_000,
      fetchImpl: network,
      resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      costByOperation: {
        WORK_EMAIL_DISCOVERY: { costUnits: 1, usd: 0.025, currency: "USD" },
        EMAIL_VERIFICATION: { costUnits: 1, usd: 0.025, currency: "USD" },
      },
    });
    const llm = {
      isConfigured: () => true,
      json: async (purpose: string, _system: string, user: string) => {
        if (purpose === "market_research_plan") {
          return {
            market: "Malaysia",
            productTerms: ["sample product application", "sample products"],
            buyerTerms: ["system integrator"],
            queries: ["sample products integrator Malaysia"],
          };
        }
        if (purpose === "search_result_company_extraction") return { candidates: [] };
        if (purpose === "company_due_diligence") {
          return {
            companyName: "Buyer Engineering",
            companyType: "system integrator",
            fitScore: 30,
            matchedProducts: ["sample product application", "sample products"],
            risks: [],
            recommendedOffer: "sample product application",
            researchSummary: "Qualified active public project fixture.",
            evidence: [{ claim: "Active sample application project", sourceUrl: "https://buyer.com/" }],
          };
        }
        if (purpose === "decision_maker_enrichment") {
          const payload = JSON.parse(user) as {
            website_pages: Array<{
              url: string;
              evidenceScopes: Array<{ id: string; text: string; emails: Array<{ email: string }> }>;
            }>;
          };
          const page = payload.website_pages.find((item) => item.url === "https://buyer.com/")!;
          const evidenceScope = page.evidenceScopes.find((item) =>
            item.emails.some((email) => email.email === "jane1@buyer.com"))!;
          return {
            contacts: [{
              name: "Jane Buyer",
              title: "Procurement Manager",
              email: "jane1@buyer.com",
              emailSourceUrl: page.url,
              sourceScopeId: evidenceScope.id,
              emailScopeId: evidenceScope.id,
              linkedin: null,
              sourceUrl: page.url,
              evidence: evidenceScope.text,
              employmentVerified: true,
            }],
          };
        }
        return {};
      },
    };
    const runtime = new StrictLegacyDiscoveryRuntime(loaded, {
      database: db,
      websiteResolver: async () => [{ address: "8.8.8.8", family: 4 }],
      hunterAdapter,
    });
    const service = new DiscoveryService(loaded, db, llm as never, undefined, {
      runtimeContracts: runtime,
    });
    const summary = await service.run({
      id: scope.campaignId,
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 1,
    });

    expect(summary.contactsFound).toBe(1);
    expect(summary.verifiedEmails).toBe(1);
    const contact = db.db.prepare(
      "SELECT * FROM contacts WHERE lower(email)='jane1@buyer.com'",
    ).get() as Record<string, unknown>;
    expect(contact).toMatchObject({ email_status: "VALID", catch_all: 0 });
    expect(String(contact.verification_notes)).toContain("STRICT_EMAIL_VERIFICATION:");
    expect(db.getIndependentValidEmailVerification({
      contactId: String(contact.id),
      email: "jane1@buyer.com",
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toMatchObject({
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey: "HUNTER",
      independentlyVerified: true,
    });
    expect(network.mock.calls.filter(([target]) =>
      new URL(String(target)).pathname === "/v2/email-finder")).toHaveLength(0);
    expect(network.mock.calls.filter(([target]) =>
      new URL(String(target)).pathname === "/v2/email-verifier")).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 60_000);

  it("uses exact CAPPED authorization, persists independent VALID lineage, and caches cost idempotently", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "valid");
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      email: "jane1@buyer.com",
      status: "valid",
      score: 98,
      accept_all: false,
      disposable: false,
      webmail: false,
      block: false,
    }));
    const bridge = verifier(db, scope, fetchImpl);
    const input = request();
    const first = await bridge.verify(input);
    const second = await bridge.verify(input);

    expect(first).toMatchObject({
      status: "VALID",
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey: "HUNTER",
      independentlyVerified: true,
      providerMailboxVerdict: "VALID_ASSERTION",
    });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(db.db.prepare(
      `SELECT count(*) AS count, sum(units) AS units, sum(cost_micros) AS cost
       FROM resource_usage usage JOIN provider_runs run ON run.id=usage.provider_run_id
       WHERE run.campaign_id=? AND run.campaign_version_id=?`,
    ).get(scope.campaignId, scope.versionId)).toMatchObject({ count: 1, units: 1, cost: 25_000 });

    const contact = addContact(db, scope.campaignId, input.email, "VALID");
    expect(db.persistIndependentEmailVerification({
      contactId: contact.contactId,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
      providerRunId: first!.providerRunId,
      discoveryAssertionId: first!.discoveryAssertionId,
      verificationAssertionId: first!.verificationAssertionId,
      emailHash: first!.emailHash,
      discoverySourceKey: first!.discoverySourceKey,
      verifierSourceKey: first!.verifierSourceKey,
      discoverySourceUrl: first!.discoverySourceUrl,
      discoveryEvidenceHash: first!.discoveryEvidenceHash,
      providerMailboxVerdict: first!.providerMailboxVerdict,
      catchAll: first!.catchAll,
      disposable: first!.disposable,
      roleMailbox: first!.roleMailbox,
      confidence: first!.confidence,
      rawPayloadHash: first!.rawPayloadHash,
      observedAt: first!.observedAt,
      expiresAt: first!.expiresAt,
      creditUnits: first!.creditUnits,
      estimatedCostMicros: first!.estimatedCostMicros,
    })).toEqual({ discoveryCreated: true, verificationCreated: true });
    const lineage = db.getIndependentValidEmailVerification({
      contactId: contact.contactId,
      email: input.email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    });
    expect(lineage).toMatchObject({
      discoveryAssertionId: first!.discoveryAssertionId,
      verificationAssertionId: first!.verificationAssertionId,
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey: "HUNTER",
      independentlyVerified: true,
      providerMailboxVerdict: "VALID_ASSERTION",
    });
    expect(db.db.prepare(
      `SELECT count(*) AS count FROM contact_provider_assertions verification
       JOIN contact_provider_assertions discovery
         ON discovery.provider_assertion_id=verification.discovery_assertion_id
       WHERE verification.assertion_type='EMAIL_VERIFICATION'
         AND discovery.assertion_type='EMAIL_DISCOVERY'
         AND verification.provider_id<>discovery.provider_id`,
    ).get()).toMatchObject({ count: 1 });
    const persistedText = JSON.stringify({
      runs: db.db.prepare("SELECT metadata_json FROM provider_runs").all(),
      cache: db.db.prepare("SELECT response_json FROM provider_response_cache").all(),
      events: db.db.prepare("SELECT payload_json FROM events WHERE entity_type='provider_run'").all(),
    });
    expect(persistedText).not.toContain(input.email);
    expect(persistedText).not.toContain("test-secret");
    db.close();
  });

  it.each([
    ["feature disabled", { ACQ_HUNTER_V2_ENABLED: "false" }, "CAPPED", ["searxng", "local-public-web", "hunter"]],
    ["missing key", { HUNTER_API_KEY: "" }, "CAPPED", ["searxng", "local-public-web", "hunter"]],
    ["ZERO_COST campaign", {}, "ZERO_COST", ["searxng", "local-public-web", "hunter"]],
    ["not allowlisted", {}, "CAPPED", ["searxng", "local-public-web"]],
  ] as const)("keeps the local risky result and never calls Hunter when %s", async (
    _label,
    configOverrides,
    mode,
    allowedProviders,
  ) => {
    const db = database();
    const scope = authorizedCampaign(db, `blocked-${_label.replace(/\s+/g, "-")}`, {
      mode,
      allowedProviders: [...allowedProviders],
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await verifier(db, scope, fetchImpl, { ...configOverrides }).verify(request());
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM provider_runs WHERE campaign_id=?",
    ).get(scope.campaignId)).toMatchObject({ count: 0 });
    db.close();
  });

  it.each([
    ["catch-all", { status: "valid", accept_all: true, disposable: false }, "RISKY", "RISKY_ASSERTION"],
    ["invalid", { status: "invalid", accept_all: false, disposable: false }, "INVALID", "INVALID_ASSERTION"],
  ] as const)("does not upgrade a %s Hunter response", async (_label, fields, status, verdict) => {
    const db = database();
    const scope = authorizedCampaign(db, _label);
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      email: "jane1@buyer.com",
      score: 95,
      ...fields,
    }));
    const result = await verifier(db, scope, fetchImpl).verify(request());
    expect(result).toMatchObject({ status, providerMailboxVerdict: verdict });
    expect(result?.status).not.toBe("VALID");
    db.close();
  });

  it("recovers only an expired provider-run lease and leaves the replacement in flight", () => {
    const db = database();
    const scope = authorizedCampaign(db, "stale");
    const requestHash = hash({ emailHash: hash("lease@buyer.com") });
    const start = () => db.beginProviderRun({
      campaignId: scope.campaignId,
      versionId: scope.versionId,
      providerKey: "hunter",
      operation: "EMAIL_VERIFICATION",
      requestHash,
      requestedCount: 1,
      chargeable: true,
      estimatedUnits: 1,
      estimatedCostMicros: 25_000,
      staleAfterSeconds: 30,
    });
    const first = start();
    expect(first).toMatchObject({ status: "STARTED", attemptNumber: 1 });
    expect(start()).toMatchObject({ status: "IN_FLIGHT", attemptNumber: 1 });
    db.db.prepare(
      "UPDATE provider_runs SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?",
    ).run(first.providerRunId);
    const recovered = start();
    expect(recovered).toMatchObject({
      status: "STARTED",
      providerRunId: first.providerRunId,
      attemptNumber: 2,
    });
    expect(start()).toMatchObject({
      status: "IN_FLIGHT",
      providerRunId: first.providerRunId,
      attemptNumber: 2,
    });
    expect(db.db.prepare(
      `SELECT status, error_class FROM provider_attempts
       WHERE provider_run_id=? AND attempt_number=1`,
    ).get(first.providerRunId)).toMatchObject({
      status: "FAILED",
      error_class: "STALE_PROVIDER_RUN_LEASE_EXPIRED",
    });
    expect(db.db.prepare(
      `SELECT count(*) AS count FROM events
       WHERE entity_type='provider_run' AND entity_id=?
         AND event_type='PROVIDER_RUN_STALE_LEASE_RECOVERED'`,
    ).get(first.providerRunId)).toMatchObject({ count: 1 });
    db.close();
  });
});
