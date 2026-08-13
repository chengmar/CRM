import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { loadConfig, type AgentConfig } from "../src/config.js";
import {
  CampaignSearxngSearchProvider,
  CampaignWebsiteAssessor,
} from "../src/acquisition/providers/campaign-runtime.js";
import { LocalPublicWebsiteProvider } from "../src/acquisition/providers/local-public-web.js";
import { SearxngOfficialAdapter } from "../src/acquisition/providers/searxng-official.js";
import type { WebsiteAssessment } from "../src/types.js";
import { StrictLegacyDiscoveryRuntime } from "../src/search/legacy-discovery-runtime.js";
import { DiscoveryService } from "../src/search/discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
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
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-provider-runtime-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function authorizedCampaign(db: AgentDatabase, suffix: string) {
  const campaignId = db.createCampaign({
    name: `provider-${suffix}`,
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
    mode: "ZERO_COST",
    allowedProviders: ["searxng", "local-public-web"],
    unit: "REQUESTS",
    maxUnits: 0,
    maxAmountUsd: 0,
    requiresSeparateApproval: true,
  };
  const saved = db.saveCampaignDraft({
    briefKey: `provider:${suffix}`,
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

function websiteAssessment(url = "https://buyer.example/"): WebsiteAssessment {
  return {
    url,
    domain: "buyer.example",
    reachable: true,
    parked: false,
    title: "Buyer Engineering",
    text: "Buyer Engineering supplies public sample products.",
    emails: ["procurement@buyer.example"],
    phones: [],
    recentActivityAt: null,
    activitySignals: ["website reachable"],
    activityScore: 7,
    pages: [{
      url,
      title: "Buyer Engineering",
      text: "Buyer Engineering supplies public sample products.",
      emails: ["procurement@buyer.example"],
    }],
  };
}

describe("campaign-bound persistent provider runtime", () => {
  it("preflights both live bridges from the exact bound budget without touching legacy providers", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "live-preflight");
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", network);
    const runtime = new StrictLegacyDiscoveryRuntime({
      SEARCH_PROVIDER: "searxng",
      SERPER_API_KEY: "",
      EXA_API_KEY: "",
      SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
      ACQ_SEARXNG_V2_ENABLED: true,
      SEARXNG_LOCAL_ENDPOINT_ALLOWED: true,
      SEARXNG_REQUEST_TIMEOUT_MS: 1_000,
      SEARXNG_CACHE_TTL_SECONDS: 3_600,
      ACQ_LOCAL_PUBLIC_WEB_ENABLED: true,
      LOCAL_PUBLIC_WEB_TIMEOUT_MS: 1_000,
      LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: 3_600,
      RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      MAX_PAGES_PER_CAMPAIGN: 10,
      MAX_COMPANY_PAGES: 3,
      HUNTER_API_KEY: "must-not-enable-legacy-hunter",
    } as AgentConfig, { database: db });

    const report = await runtime.assertJob({
      jobType: "DISCOVER_CAMPAIGN",
      campaignId: scope.campaignId,
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
    });

    expect(report).toMatchObject({
      campaignId: scope.campaignId,
      versionId: scope.versionId,
      searchProviderId: "SEARXNG",
      providerChecks: [{
        providerId: "SEARXNG",
        operation: "EVIDENCE_SEARCH",
        status: "READY_LIVE",
      }],
      crawl: { providerId: "LOCAL_PUBLIC_WEB", status: "READY_LIVE", mode: "LIVE" },
    });
    expect(runtime.createSearchProvider(report).name).toBe("searxng-strict");
    expect(runtime.createWebsiteAssessor(report)).toBeTypeOf("function");
    expect(network).not.toHaveBeenCalled();
    db.close();
  });

  it("persists one zero-cost SearXNG attempt and replays its strict cached response", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "search-cache");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      results: [{
        title: "Buyer Engineering",
        url: "https://buyer.example/",
        content: "Public sample product application evidence.",
      }],
    }), { headers: { "content-type": "application/json" } }));
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "http://127.0.0.1:8888/",
      enabled: true,
      allowLoopbackHttp: true,
      fetchImpl,
    });
    const provider = new CampaignSearxngSearchProvider(db, scope, {
      SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
      ACQ_SEARXNG_V2_ENABLED: true,
      SEARXNG_LOCAL_ENDPOINT_ALLOWED: true,
      SEARXNG_REQUEST_TIMEOUT_MS: 1_000,
      SEARXNG_CACHE_TTL_SECONDS: 3_600,
    }, adapter);

    const first = await provider.search("sample product application Malaysia", 10);
    const replay = await provider.search("sample product application Malaysia", 10);

    expect(first).toEqual(replay);
    expect(first).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(db.db.prepare("SELECT count(*) AS count FROM provider_runs WHERE campaign_id=?")
      .get(scope.campaignId)).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM provider_attempts WHERE status='SUCCEEDED'")
      .get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM resource_usage WHERE cost_micros=0")
      .get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM provider_response_cache")
      .get()).toMatchObject({ count: 1 });
    db.close();
  });

  it("blocks an unbound campaign before the SearXNG adapter can resolve or fetch", async () => {
    const db = database();
    const campaignId = db.createCampaign({
      name: "unbound",
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 10,
      createdBy: "fixture",
      dailyLimit: 10,
      hourlyLimit: 5,
      followupDays: [3, 7, 14],
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CampaignSearxngSearchProvider(db, {
      campaignId,
      versionId: "missing-version",
    }, {
      SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
      ACQ_SEARXNG_V2_ENABLED: true,
      SEARXNG_LOCAL_ENDPOINT_ALLOWED: true,
      SEARXNG_REQUEST_TIMEOUT_MS: 1_000,
      SEARXNG_CACHE_TTL_SECONDS: 3_600,
    }, new SearxngOfficialAdapter({
      baseUrl: "http://127.0.0.1:8888/",
      enabled: true,
      allowLoopbackHttp: true,
      fetchImpl,
    }));

    await expect(provider.search("sample product application Malaysia", 10)).rejects.toThrow(/context|binding/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT count(*) AS count FROM provider_runs").get()).toMatchObject({ count: 0 });
    db.close();
  });

  it("coalesces a running request in SQLite instead of issuing a duplicate fetch", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "search-inflight");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "http://127.0.0.1:8888/",
      enabled: true,
      allowLoopbackHttp: true,
      fetchImpl,
    });
    const config = {
      SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
      ACQ_SEARXNG_V2_ENABLED: true,
      SEARXNG_LOCAL_ENDPOINT_ALLOWED: true,
      SEARXNG_REQUEST_TIMEOUT_MS: 1_000,
      SEARXNG_CACHE_TTL_SECONDS: 3_600,
    };
    const first = new CampaignSearxngSearchProvider(db, scope, config, adapter)
      .search("sample product application Malaysia", 10);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await expect(new CampaignSearxngSearchProvider(db, scope, config, adapter)
      .search("sample product application Malaysia", 10)).rejects.toThrow(/in flight/i);
    release();
    await expect(first).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    db.close();
  });

  it("journals and caches a strict public website assessment under the same campaign budget", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "crawl-cache");
    const robotsFetch = vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", robotsFetch);
    const assessor = vi.fn(async (url: string) => websiteAssessment(url));
    const provider = new LocalPublicWebsiteProvider(true, {
      userAgent: "Fixture-Agent/1.0",
      assessor: assessor as typeof import("../src/search/website.js").assessWebsite,
    });
    const runtime = new CampaignWebsiteAssessor({
      db,
      scope,
      config: {
        ACQ_LOCAL_PUBLIC_WEB_ENABLED: true,
        LOCAL_PUBLIC_WEB_TIMEOUT_MS: 1_000,
        LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: 3_600,
        MAX_PAGES_PER_CAMPAIGN: 10,
        MAX_COMPANY_PAGES: 3,
        RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      },
      provider,
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    const first = await runtime.assess("https://buyer.example/", "Fixture-Agent/1.0", 3);
    const replay = await runtime.assess("https://buyer.example/", "Fixture-Agent/1.0", 3);

    expect(first).toEqual(replay);
    expect(assessor).toHaveBeenCalledOnce();
    expect(robotsFetch).toHaveBeenCalledOnce();
    expect(db.db.prepare(
      `SELECT count(*) AS count FROM provider_runs pr
       JOIN provider_registry registry ON registry.id=pr.provider_id
       WHERE registry.provider_key='local-public-web' AND pr.status='SUCCEEDED'`,
    ).get()).toMatchObject({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM resource_usage WHERE cost_micros=0")
      .get()).toMatchObject({ count: 1 });
    db.close();
  });

  it("records a failed crawl without fetching when DNS contains a private address", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "crawl-private");
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", network);
    const assessor = vi.fn(async (url: string) => websiteAssessment(url));
    const runtime = new CampaignWebsiteAssessor({
      db,
      scope,
      config: {
        ACQ_LOCAL_PUBLIC_WEB_ENABLED: true,
        LOCAL_PUBLIC_WEB_TIMEOUT_MS: 1_000,
        LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: 3_600,
        MAX_PAGES_PER_CAMPAIGN: 10,
        MAX_COMPANY_PAGES: 3,
        RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      },
      provider: new LocalPublicWebsiteProvider(true, {
        userAgent: "Fixture-Agent/1.0",
        assessor: assessor as typeof import("../src/search/website.js").assessWebsite,
      }),
      resolver: async () => [{ address: "10.0.0.8", family: 4 }],
    });

    await expect(runtime.assess("https://buyer.example/", "Fixture-Agent/1.0", 3))
      .rejects.toThrow(/unsafe/i);
    expect(network).not.toHaveBeenCalled();
    expect(assessor).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT status, count(*) AS count FROM provider_attempts GROUP BY status")
      .get()).toMatchObject({ status: "FAILED", count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM resource_usage").get())
      .toMatchObject({ count: 0 });
    db.close();
  });

  it("enforces the persistent campaign page cap before a later website fetch", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "crawl-budget");
    const network = vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", network);
    const assessor = vi.fn(async (url: string) => websiteAssessment(url));
    const runtime = new CampaignWebsiteAssessor({
      db,
      scope,
      config: {
        ACQ_LOCAL_PUBLIC_WEB_ENABLED: true,
        LOCAL_PUBLIC_WEB_TIMEOUT_MS: 1_000,
        LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: 3_600,
        MAX_PAGES_PER_CAMPAIGN: 2,
        MAX_COMPANY_PAGES: 2,
        RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      },
      provider: new LocalPublicWebsiteProvider(true, {
        userAgent: "Fixture-Agent/1.0",
        assessor: assessor as typeof import("../src/search/website.js").assessWebsite,
      }),
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    });

    await expect(runtime.assess("https://buyer.example/", "Fixture-Agent/1.0", 2)).resolves
      .toMatchObject({ reachable: true });
    await expect(runtime.assess("https://second-buyer.example/", "Fixture-Agent/1.0", 1))
      .rejects.toThrow(/page budget/i);
    expect(network).toHaveBeenCalledOnce();
    expect(assessor).toHaveBeenCalledOnce();
    expect(db.db.prepare("SELECT count(*) AS count FROM provider_attempts WHERE status='FAILED'")
      .get()).toMatchObject({ count: 1 });
    db.close();
  });

  it("runs legacy discovery through only the strict SearXNG and local-web ledgers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strict-discovery-e2e-"));
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
    const config = loadConfig({
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
      RESEARCH_USER_AGENT: "Fixture-Agent/1.0",
      MAX_DISCOVERY_ROUNDS: "1",
      MAX_DISCOVERY_CONCURRENCY: "1",
      MAX_SEARCH_CONCURRENCY: "1",
      MAX_SEARCH_RESULTS_PER_CAMPAIGN: "20",
      MAX_PAGES_PER_CAMPAIGN: "10",
      MAX_COMPANY_PAGES: "1",
      MAX_LLM_CALLS_PER_JOB: "20",
      HERMES_RESEARCH_ENABLED: "false",
      HUNTER_API_KEY: "legacy-hunter-must-not-run",
      REACHER_BASE_URL: "https://reacher-must-not-run.example",
    });
    const db = new AgentDatabase(config.AGENT_DB_PATH);
    try {
      const scope = authorizedCampaign(db, "strict-e2e");
      const network = vi.fn<typeof fetch>(async (target) => {
        const url = new URL(String(target));
        if (url.origin === "http://127.0.0.1:8888") {
          return new Response(JSON.stringify({
            results: [{
              title: "Buyer Engineering",
              url: "https://buyer.example/",
              content: "Buyer Engineering supplies sample products to system integrators.",
            }],
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.origin === "https://buyer.example" && url.pathname === "/robots.txt") {
          return new Response("", { status: 404 });
        }
        if (url.origin === "https://buyer.example" && url.pathname === "/") {
          return new Response([
            "<html><head><title>Buyer Engineering</title></head><body>",
            "Buyer Engineering supplies sample products and related systems ",
            "to system integrators. Project update 2026-06-01.",
            "</body></html>",
          ].join(""), { headers: { "content-type": "text/html" } });
        }
        throw new Error(`Unexpected network target in strict fixture: ${url.origin}${url.pathname}`);
      });
      vi.stubGlobal("fetch", network);
      const llm = {
        isConfigured: () => true,
        json: async (purpose: string) => {
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
              matchedProducts: ["sample product application"],
              risks: [],
              recommendedOffer: "sample product application",
              researchSummary: "Qualified public fixture.",
              evidence: [{ claim: "Official public evidence", sourceUrl: "https://buyer.example/" }],
            };
          }
          if (purpose === "decision_maker_enrichment") return { contacts: [] };
          return {};
        },
      };
      const strictRuntime = new StrictLegacyDiscoveryRuntime(config, {
        database: db,
        websiteResolver: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const service = new DiscoveryService(config, db, llm as never, undefined, {
        runtimeContracts: strictRuntime,
      });
      const summary = await service.run({
        id: scope.campaignId,
        market: "Malaysia",
        product: "sample product application",
        buyerType: "system integrator",
        targetCount: 10,
      });

      expect(summary.provider).toBe("searxng-strict");
      expect(network).toHaveBeenCalled();
      expect(db.db.prepare(
        `SELECT registry.provider_key, count(*) AS count
         FROM provider_runs run JOIN provider_registry registry ON registry.id=run.provider_id
         GROUP BY registry.provider_key ORDER BY registry.provider_key`,
      ).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_key: "local-public-web" }),
        expect.objectContaining({ provider_key: "searxng" }),
      ]));
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM resource_usage WHERE cost_micros<>0 OR units<>0",
      ).get()).toMatchObject({ count: 0 });
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM provider_runs WHERE provider_id='provider_legacy_local'",
      ).get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });
});
