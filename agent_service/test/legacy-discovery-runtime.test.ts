import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import type { ProviderCost, ProviderHealth } from "../src/acquisition/provider-runtime.js";
import type { CrawlProvider } from "../src/acquisition/crawl-contracts.js";
import {
  ProviderManifestSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  type ProviderCapability,
  type ProviderId,
  type StrictProviderAdapter,
} from "../src/acquisition/providers/contracts.js";
import { createDisabledProviderRegistry } from "../src/acquisition/providers/disabled-adapters.js";
import {
  StrictLegacyDiscoveryRuntime,
  type LegacyDiscoveryRuntimeInput,
} from "../src/search/legacy-discovery-runtime.js";

const prohibitedFields = [
  "API_CREDENTIAL",
  "DNC_DATABASE",
  "REPLY_BODY",
  "PRIVATE_CASE",
  "QUOTE",
  "CUSTOMER_NOTE",
  "UNPUBLISHED_PRODUCT_DATA",
  "FULL_CRM",
  "PERSONAL_EMAIL",
  "PHONE_NUMBER",
] as const;

const input: LegacyDiscoveryRuntimeInput = {
  jobType: "DISCOVER_CAMPAIGN",
  campaignId: "campaign-fixture",
  market: "Malaysia",
  product: "sample products",
  buyerType: "system integrator",
};

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    SEARCH_PROVIDER: "serper",
    SERPER_API_KEY: "fixture-serper-key",
    EXA_API_KEY: "",
    SEARXNG_BASE_URL: "",
    HUNTER_API_KEY: "",
    ...overrides,
  } as AgentConfig;
}

function fixtureProvider(
  providerId: ProviderId,
  capability: ProviderCapability,
  implementationState: "FIXTURE_SHADOW" | "OFFICIAL_API_ADAPTER" = "FIXTURE_SHADOW",
): StrictProviderAdapter & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    throw new Error("The original adapter must not execute during runtime preflight");
  });
  return {
    manifest: ProviderManifestSchema.parse({
      providerId,
      displayName: `${providerId} local fixture`,
      capabilities: [capability],
      implementationState,
      featureFlag: `ACQ_${providerId}_FIXTURE_ENABLED`,
      activation: {
        featureFlagEnabled: true,
        configured: true,
        authorization: implementationState === "FIXTURE_SHADOW"
          ? "NOT_REQUIRED_FIXTURE"
          : "SHADOW_APPROVED",
      },
      networkPolicy: implementationState === "FIXTURE_SHADOW" ? "DENY" : "OFFICIAL_API_ONLY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: capability === "EVIDENCE_SEARCH"
          ? ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"]
          : ["PUBLIC_PERSON_IDENTITY", "B2B_WORK_EMAIL"],
        prohibitedFields,
        personalEmailAllowed: false,
        phoneAllowed: false,
      },
    }),
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderResponseSchema,
    health: async (): Promise<ProviderHealth> => ({
      state: "HEALTHY",
      checkedAt: "2026-07-20T00:00:00.000Z",
      detail: "local fixture",
    }),
    estimateCost: (): ProviderCost => ({ costUnits: 0, usd: 0, currency: "USD" }),
    execute,
  };
}

function fixtureCrawlProvider(): CrawlProvider & { crawlPage: ReturnType<typeof vi.fn> } {
  const crawlPage = vi.fn(async () => {
    throw new Error("The original crawl adapter must not execute during runtime preflight");
  });
  return {
    id: "LOCAL_CRAWL_FIXTURE",
    kind: "LOCAL",
    mode: "SHADOW",
    enabled: true,
    configured: true,
    async crawlAccount() {
      throw new Error("The original crawl adapter must not execute during runtime preflight");
    },
    crawlPage,
    classifyFailure: () => null,
    estimateCost: () => ({ costUnits: 0 }),
    supportsContentType: () => true,
  };
}

function registryWith(...adapters: StrictProviderAdapter[]): Map<ProviderId, StrictProviderAdapter> {
  const registry = new Map(createDisabledProviderRegistry());
  for (const adapter of adapters) registry.set(adapter.manifest.providerId, adapter);
  return registry;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy discovery strict runtime preflight", () => {
  it.each([
    ["serper", "SERPER", { SERPER_API_KEY: "fixture-key" }],
    ["exa", "EXA", { EXA_API_KEY: "fixture-key" }],
    ["searxng", "SEARXNG", { SEARXNG_BASE_URL: "https://search.fixture.invalid" }],
  ] as const)("blocks an unauthorized legacy %s path before fetch", async (searchProvider, providerId, keys) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = new StrictLegacyDiscoveryRuntime(config({
      SEARCH_PROVIDER: searchProvider,
      SERPER_API_KEY: "",
      EXA_API_KEY: "",
      ...keys,
    }));

    await expect(runtime.assertJob(input)).rejects.toMatchObject({
      code: "PROVIDER_CONTRACT_BLOCKED",
      providerId,
      status: "BLOCKED_DISABLED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never activates the legacy Hunter path even when its key exists", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const search = fixtureProvider("SERPER", "EVIDENCE_SEARCH");
    const runtime = new StrictLegacyDiscoveryRuntime(
      config({ HUNTER_API_KEY: "fixture-hunter-key" }),
      { providerRegistry: registryWith(search) },
    );

    await expect(runtime.assertJob(input)).rejects.toMatchObject({
      code: "CRAWL_PROVIDER_CONTRACT_BLOCKED",
      providerId: "LOCAL_PUBLIC_WEB",
      status: "BLOCKED",
    });
    expect(search.execute).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks the direct legacy website crawler after provider fixtures pass", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const search = fixtureProvider("SERPER", "EVIDENCE_SEARCH");
    const runtime = new StrictLegacyDiscoveryRuntime(config(), {
      providerRegistry: registryWith(search),
    });

    await expect(runtime.assertJob(input)).rejects.toMatchObject({
      code: "CRAWL_PROVIDER_CONTRACT_BLOCKED",
      providerId: "LOCAL_PUBLIC_WEB",
      status: "BLOCKED",
      reason: "PROVIDER_DISABLED",
    });
    expect(search.execute).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows only explicit no-network fixture contracts through the worker preflight", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const search = fixtureProvider("SERPER", "EVIDENCE_SEARCH");
    const hunter = fixtureProvider("HUNTER", "WORK_EMAIL_DISCOVERY");
    const crawl = fixtureCrawlProvider();
    const runtime = new StrictLegacyDiscoveryRuntime(
      config({ HUNTER_API_KEY: "fixture-hunter-key" }),
      {
        providerRegistry: registryWith(search, hunter),
        crawlProvider: crawl,
      },
    );

    await expect(runtime.assertJob(input)).resolves.toMatchObject({
      searchProviderId: "SERPER",
      providerChecks: [
        { providerId: "SERPER", operation: "EVIDENCE_SEARCH", status: "SUCCEEDED_SHADOW" },
      ],
      crawl: { providerId: "LOCAL_CRAWL_FIXTURE", status: "SUCCEEDED", mode: "SHADOW" },
    });
    expect(search.execute).not.toHaveBeenCalled();
    expect(hunter.execute).not.toHaveBeenCalled();
    expect(crawl.crawlPage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let a live official adapter use preflight to re-enable legacy direct calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const liveSearch = fixtureProvider("SERPER", "EVIDENCE_SEARCH", "OFFICIAL_API_ADAPTER");
    const runtime = new StrictLegacyDiscoveryRuntime(config(), {
      providerRegistry: registryWith(liveSearch),
      crawlProvider: fixtureCrawlProvider(),
    });

    await expect(runtime.assertJob(input)).rejects.toMatchObject({
      code: "LEGACY_LIVE_PROVIDER_NOT_WIRED",
      providerId: "SERPER",
    });
    expect(liveSearch.execute).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
