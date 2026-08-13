import { createHash } from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { WebsiteAssessment } from "../types.js";
import {
  CrawlBudgetLedger,
  CrawlRouter,
  type CrawlRouterPolicy,
} from "../acquisition/crawl-router.js";
import type {
  CrawlDecisionAudit,
  CrawlPageObservation,
  CrawlPageRequest,
  CrawlProvider,
} from "../acquisition/crawl-contracts.js";
import { ProviderBudget } from "../acquisition/provider-runtime.js";
import {
  ProviderRequestSchema,
  type ProviderId,
  type ProviderOperation,
  type ProviderRequest,
  type StrictProviderAdapter,
} from "../acquisition/providers/contracts.js";
import { createDisabledProviderRegistry } from "../acquisition/providers/disabled-adapters.js";
import { LocalPublicWebsiteProvider } from "../acquisition/providers/local-public-web.js";
import {
  CampaignApprovedEmailVerifier,
  CampaignSearxngSearchProvider,
  CampaignWebsiteAssessor,
  type CampaignEmailVerifier,
} from "../acquisition/providers/campaign-runtime.js";
import type { BouncerOfficialAdapter } from "../acquisition/providers/bouncer-official.js";
import type { HunterOfficialAdapter } from "../acquisition/providers/hunter-official.js";
import { createSearxngOfficialAdapter } from "../acquisition/providers/searxng-official.js";
import type { SearchProvider } from "./provider.js";
import type { WebsiteAddressResolver } from "./website.js";
import {
  StrictProviderRuntime,
  type ProviderAuditEvent,
  type ProviderContractResult,
} from "../acquisition/providers/strict-runtime.js";

export type LegacyDiscoveryJobType = "DISCOVER_CAMPAIGN" | "ENRICH_CONTACTS";

export interface LegacyDiscoveryRuntimeInput {
  jobType: LegacyDiscoveryJobType;
  campaignId: string;
  market: string;
  product: string;
  buyerType: string;
}

export interface LegacyDiscoveryRuntimeReport {
  campaignId: string;
  versionId: string | null;
  searchProviderId: ProviderId;
  providerChecks: Array<{
    providerId: ProviderId;
    operation: ProviderOperation;
    status: ProviderContractResult["status"] | "READY_LIVE";
    reason: ProviderContractResult["reason"];
  }>;
  crawl: {
    providerId: string;
    status: "SUCCEEDED" | "READY_LIVE";
    mode: "SHADOW" | "LIVE";
  };
}

export interface LegacyDiscoveryRuntimeContract {
  assertJob(input: LegacyDiscoveryRuntimeInput): Promise<LegacyDiscoveryRuntimeReport>;
  createSearchProvider(report: LegacyDiscoveryRuntimeReport): SearchProvider;
  createWebsiteAssessor(report: LegacyDiscoveryRuntimeReport): (
    rawUrl: string,
    userAgent?: string,
    maxPages?: number,
  ) => Promise<WebsiteAssessment>;
  createEmailVerifier(report: LegacyDiscoveryRuntimeReport): CampaignEmailVerifier;
}

export type LegacyDiscoveryRuntimeBlockCode =
  | "SEARCH_PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_NOT_REGISTERED"
  | "PROVIDER_CONTRACT_BLOCKED"
  | "LEGACY_LIVE_PROVIDER_NOT_WIRED"
  | "CRAWL_PROVIDER_CONTRACT_BLOCKED"
  | "LEGACY_LIVE_CRAWL_NOT_WIRED";

export class LegacyDiscoveryRuntimeBlockedError extends Error {
  override readonly name = "LegacyDiscoveryRuntimeBlockedError";

  constructor(
    readonly code: LegacyDiscoveryRuntimeBlockCode,
    readonly providerId: string | null = null,
    readonly status: string | null = null,
    readonly reason: string | null = null,
  ) {
    super([
      `Legacy discovery blocked by strict runtime: ${code}`,
      providerId ? `provider=${providerId}` : "",
      status ? `status=${status}` : "",
      reason ? `reason=${reason}` : "",
    ].filter(Boolean).join("; "));
  }
}

interface StrictLegacyDiscoveryRuntimeOptions {
  database?: AgentDatabase;
  websiteResolver?: WebsiteAddressResolver;
  hunterAdapter?: HunterOfficialAdapter;
  bouncerAdapter?: BouncerOfficialAdapter;
  providerRegistry?: ReadonlyMap<ProviderId, StrictProviderAdapter>;
  crawlProvider?: CrawlProvider;
  providerBudget?: {
    maxCostUnits: number;
    maxUsd: number;
  };
  providerAudit?: (event: ProviderAuditEvent) => void;
  crawlAudit?: (event: CrawlDecisionAudit) => void;
  now?: () => Date;
}

const disabledLegacyCrawlProvider: CrawlProvider = {
  id: "LEGACY_LOCAL_WEBSITE_CRAWL",
  kind: "LOCAL",
  mode: "SHADOW",
  enabled: false,
  configured: false,
  async crawlAccount() {
    throw new Error("Disabled legacy crawl provider cannot execute");
  },
  async crawlPage() {
    throw new Error("Disabled legacy crawl provider cannot execute");
  },
  classifyFailure: () => "PROVIDER_DISABLED",
  estimateCost: () => ({ costUnits: 0 }),
  supportsContentType: () => false,
};

function configured(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name?: unknown }).name || "PROVIDER_ERROR").slice(0, 100);
  }
  return "PROVIDER_ERROR";
}

export function selectLegacySearchProvider(
  config: Pick<AgentConfig, "SEARCH_PROVIDER" | "SERPER_API_KEY" | "EXA_API_KEY" | "SEARXNG_BASE_URL">,
): ProviderId {
  const requested = config.SEARCH_PROVIDER;
  if (requested === "serper") return "SERPER";
  if (requested === "exa") return "EXA";
  if (requested === "searxng") return "SEARXNG";
  if (requested === "auto") {
    if (configured(config.SERPER_API_KEY)) return "SERPER";
    if (configured(config.EXA_API_KEY)) return "EXA";
    if (configured(config.SEARXNG_BASE_URL)) return "SEARXNG";
  }
  throw new LegacyDiscoveryRuntimeBlockedError("SEARCH_PROVIDER_NOT_CONFIGURED");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compactQuery(input: LegacyDiscoveryRuntimeInput): string {
  const value = [input.product, input.buyerType, input.market]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
  return value.length >= 3 ? value : "legacy discovery preflight";
}

function providerRequest(
  providerId: ProviderId,
  input: LegacyDiscoveryRuntimeInput,
): ProviderRequest {
  if (providerId === "HUNTER") {
    return ProviderRequestSchema.parse({
      operation: "WORK_EMAIL_DISCOVERY",
      accountId: input.campaignId,
      canonicalDomain: "example.com",
      person: {
        personRef: `preflight-person-${input.campaignId}`.slice(0, 200),
        providerPersonId: null,
        fullName: "Legacy Discovery Preflight",
      },
      roleFamily: "PROCUREMENT",
      personalEmailAllowed: false,
      roleMailboxAllowed: false,
    });
  }
  return ProviderRequestSchema.parse({
    operation: "EVIDENCE_SEARCH",
    accountId: input.campaignId,
    query: compactQuery(input),
    publicSourcesOnly: true,
    localFetchValidationRequired: true,
  });
}

function preflightAdapter(
  adapter: StrictProviderAdapter,
  now: () => Date,
): StrictProviderAdapter {
  return {
    manifest: adapter.manifest,
    requestSchema: adapter.requestSchema,
    responseSchema: adapter.responseSchema,
    health: async () => ({
      state: "HEALTHY",
      checkedAt: now().toISOString(),
      detail: "Local fixture preflight; no provider network call",
    }),
    estimateCost: (request) => adapter.estimateCost(request),
    execute: async (request) => ({
      response: {
        providerId: adapter.manifest.providerId,
        providerRunId: `legacy-preflight-${adapter.manifest.providerId.toLowerCase()}`,
        operation: request.operation,
        result: "NO_MATCH",
        assertions: [],
        rawPayloadHash: hash({
          providerId: adapter.manifest.providerId,
          operation: request.operation,
          fixturePreflight: true,
        }),
        retryAfterSeconds: null,
      },
      actualCost: { costUnits: 0, usd: 0, currency: "USD" },
      upstreamRequestId: null,
      networkAttempted: false,
      externalWriteAttempted: false,
    }),
  };
}

function crawlPreflightRequest(input: LegacyDiscoveryRuntimeInput, now: () => Date): CrawlPageRequest {
  const checkedAt = now().toISOString();
  return {
    campaignId: input.campaignId,
    accountId: `preflight-account-${input.campaignId}`.slice(0, 200),
    runId: `legacy-${input.jobType.toLowerCase()}-${input.campaignId}`,
    requestedUrl: "https://example.com/",
    officialBaseUrl: "https://example.com/",
    pageType: "RUNTIME_PREFLIGHT",
    robots: {
      status: "ALLOWED",
      checkedUrl: "https://example.com/robots.txt",
      checkedAt,
    },
    resolution: {
      hostname: "example.com",
      addresses: [{ address: "93.184.216.34", family: 4 }],
      checkedAt,
    },
  };
}

function preflightCrawlProvider(provider: CrawlProvider): CrawlProvider {
  const content = "<html><body>local fixture crawl preflight</body></html>";
  const observation = (request: CrawlPageRequest): CrawlPageObservation => ({
    requestedUrl: request.requestedUrl,
    finalUrl: request.requestedUrl,
    canonicalUrl: request.requestedUrl,
    httpStatus: 200,
    robotsStatus: "ALLOWED",
    contentType: "text/html; charset=utf-8",
    content,
    bytes: Buffer.byteLength(content),
    elapsedMs: 0,
    actualCostUnits: 0,
    truncated: false,
    structureRecovered: true,
    timedOut: false,
    error: null,
    finalResolution: request.resolution,
  });
  return {
    id: provider.id,
    kind: provider.kind,
    mode: provider.mode,
    enabled: provider.enabled,
    configured: provider.configured,
    async crawlAccount(request) {
      return { pages: request.pages.map(observation), cursor: null };
    },
    async crawlPage(request) {
      return observation(request);
    },
    classifyFailure: () => null,
    estimateCost: () => ({ costUnits: 0 }),
    supportsContentType: (contentType) => contentType === "text/html",
  };
}

export class StrictLegacyDiscoveryRuntime implements LegacyDiscoveryRuntimeContract {
  private readonly registry: ReadonlyMap<ProviderId, StrictProviderAdapter>;
  private readonly crawlProvider: CrawlProvider;
  private readonly runtime: StrictProviderRuntime;
  private readonly providerBudget: { maxCostUnits: number; maxUsd: number };
  private readonly crawlAudit: (event: CrawlDecisionAudit) => void;
  private readonly now: () => Date;
  private readonly database: AgentDatabase | null;
  private readonly websiteResolver: WebsiteAddressResolver | undefined;
  private readonly hunterAdapter: HunterOfficialAdapter | undefined;
  private readonly bouncerAdapter: BouncerOfficialAdapter | undefined;

  constructor(
    private readonly config: AgentConfig,
    options: StrictLegacyDiscoveryRuntimeOptions = {},
  ) {
    if (options.providerRegistry) {
      this.registry = options.providerRegistry;
    } else {
      const registry = new Map(createDisabledProviderRegistry());
      registry.set("SEARXNG", createSearxngOfficialAdapter(config));
      this.registry = registry;
    }
    this.crawlProvider = options.crawlProvider ?? new LocalPublicWebsiteProvider(
      config.ACQ_LOCAL_PUBLIC_WEB_ENABLED,
      { userAgent: config.RESEARCH_USER_AGENT, resolver: options.websiteResolver },
    );
    this.providerBudget = options.providerBudget ?? { maxCostUnits: 0, maxUsd: 0 };
    this.crawlAudit = options.crawlAudit ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.database = options.database ?? null;
    this.websiteResolver = options.websiteResolver;
    this.hunterAdapter = options.hunterAdapter;
    this.bouncerAdapter = options.bouncerAdapter;
    this.runtime = new StrictProviderRuntime({
      audit: options.providerAudit ?? (() => undefined),
      now: this.now,
    });
  }

  async assertJob(input: LegacyDiscoveryRuntimeInput): Promise<LegacyDiscoveryRuntimeReport> {
    const searchProviderId = selectLegacySearchProvider(this.config);
    const providerChecks: LegacyDiscoveryRuntimeReport["providerChecks"] = [];
    providerChecks.push(await this.assertProvider(searchProviderId, input));
    const crawl = await this.assertCrawl(input);
    const context = this.database && searchProviderId === "SEARXNG" &&
      providerChecks[0]?.status === "READY_LIVE"
      ? this.database.getAuthorizedProviderCampaignContext(input.campaignId, "searxng", { chargeable: false })
      : null;
    return {
      campaignId: input.campaignId,
      versionId: context ? String(context.version_id) : null,
      searchProviderId,
      providerChecks,
      crawl,
    };
  }

  createSearchProvider(report: LegacyDiscoveryRuntimeReport): SearchProvider {
    if (!this.database || report.searchProviderId !== "SEARXNG" || !report.versionId ||
      report.providerChecks[0]?.status !== "READY_LIVE") {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "LEGACY_LIVE_PROVIDER_NOT_WIRED",
        report.searchProviderId,
        null,
        "strict campaign-bound SearXNG runtime is not ready",
      );
    }
    return new CampaignSearxngSearchProvider(this.database, {
      campaignId: report.campaignId,
      versionId: report.versionId,
    }, this.config);
  }

  createWebsiteAssessor(report: LegacyDiscoveryRuntimeReport): (
    rawUrl: string,
    userAgent?: string,
    maxPages?: number,
  ) => Promise<WebsiteAssessment> {
    if (!this.database || !report.versionId || report.crawl.status !== "READY_LIVE") {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "LEGACY_LIVE_CRAWL_NOT_WIRED",
        report.crawl.providerId,
        null,
        "strict campaign-bound local website runtime is not ready",
      );
    }
    const assessor = new CampaignWebsiteAssessor({
      db: this.database,
      scope: { campaignId: report.campaignId, versionId: report.versionId },
      config: this.config,
      provider: this.crawlProvider instanceof LocalPublicWebsiteProvider
        ? this.crawlProvider
        : undefined,
      resolver: this.websiteResolver,
    });
    return (rawUrl, userAgent = this.config.RESEARCH_USER_AGENT, maxPages = 1) =>
      assessor.assess(rawUrl, userAgent, maxPages);
  }

  createEmailVerifier(report: LegacyDiscoveryRuntimeReport): CampaignEmailVerifier {
    if (!this.database || !report.versionId) {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "LEGACY_LIVE_PROVIDER_NOT_WIRED",
        "HUNTER",
        null,
        "campaign-bound email verification database is unavailable",
      );
    }
    return new CampaignApprovedEmailVerifier({
      db: this.database,
      scope: { campaignId: report.campaignId, versionId: report.versionId },
      config: this.config,
      hunterAdapter: this.hunterAdapter,
      bouncerAdapter: this.bouncerAdapter,
    });
  }

  private async assertProvider(
    providerId: ProviderId,
    input: LegacyDiscoveryRuntimeInput,
  ): Promise<LegacyDiscoveryRuntimeReport["providerChecks"][number]> {
    const adapter = this.registry.get(providerId);
    if (!adapter) {
      throw new LegacyDiscoveryRuntimeBlockedError("PROVIDER_NOT_REGISTERED", providerId);
    }
    if (adapter.manifest.implementationState === "OFFICIAL_API_ADAPTER") {
      if (providerId !== "SEARXNG") {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "LEGACY_LIVE_PROVIDER_NOT_WIRED",
          providerId,
          null,
          "only the strict campaign-bound SearXNG adapter is wired",
        );
      }
      if (!adapter.manifest.activation.featureFlagEnabled || !adapter.manifest.activation.configured) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "PROVIDER_CONTRACT_BLOCKED",
          providerId,
          "BLOCKED_DISABLED",
          adapter.manifest.activation.featureFlagEnabled ? "NOT_CONFIGURED" : "FEATURE_FLAG_DISABLED",
        );
      }
      if (adapter.manifest.activation.authorization !== "CAMPAIGN_SCOPED" || !this.database) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "PROVIDER_CONTRACT_BLOCKED",
          providerId,
          "BLOCKED_DISABLED",
          "USER_AUTHORIZATION_NOT_GRANTED",
        );
      }
      try {
        this.database.getAuthorizedProviderCampaignContext(input.campaignId, "searxng", { chargeable: false });
      } catch (error) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "PROVIDER_CONTRACT_BLOCKED",
          providerId,
          "BLOCKED_DISABLED",
          `CAMPAIGN_BUDGET_NOT_AUTHORIZED:${errorClass(error)}`,
        );
      }
      return {
        providerId,
        operation: "EVIDENCE_SEARCH",
        status: "READY_LIVE",
        reason: "NONE",
      };
    }
    const request = providerRequest(providerId, input);
    const checkedAdapter = adapter.manifest.implementationState === "FIXTURE_SHADOW"
      ? preflightAdapter(adapter, this.now)
      : adapter;
    const result = await this.runtime.run({
      adapter: checkedAdapter,
      request,
      budget: new ProviderBudget(this.providerBudget.maxCostUnits, this.providerBudget.maxUsd),
    });
    if (result.status !== "SUCCEEDED_SHADOW") {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "PROVIDER_CONTRACT_BLOCKED",
        providerId,
        result.status,
        result.reason,
      );
    }
    return {
      providerId,
      operation: request.operation,
      status: result.status,
      reason: result.reason,
    };
  }

  private async assertCrawl(
    input: LegacyDiscoveryRuntimeInput,
  ): Promise<LegacyDiscoveryRuntimeReport["crawl"]> {
    if (this.crawlProvider.kind === "LOCAL" && this.crawlProvider.mode === "LIVE") {
      if (this.crawlProvider.id !== "LOCAL_PUBLIC_WEB" ||
        !this.crawlProvider.enabled || !this.crawlProvider.configured) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "CRAWL_PROVIDER_CONTRACT_BLOCKED",
          this.crawlProvider.id,
          "BLOCKED",
          this.crawlProvider.enabled ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_DISABLED",
        );
      }
      if (!this.database) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "LEGACY_LIVE_CRAWL_NOT_WIRED",
          this.crawlProvider.id,
          null,
          "campaign provider database is unavailable",
        );
      }
      try {
        this.database.getAuthorizedProviderCampaignContext(
          input.campaignId,
          "local-public-web",
          { chargeable: false },
        );
      } catch (error) {
        throw new LegacyDiscoveryRuntimeBlockedError(
          "CRAWL_PROVIDER_CONTRACT_BLOCKED",
          this.crawlProvider.id,
          "BLOCKED",
          `CAMPAIGN_BUDGET_NOT_AUTHORIZED:${errorClass(error)}`,
        );
      }
      return { providerId: this.crawlProvider.id, status: "READY_LIVE", mode: "LIVE" };
    }
    if (this.crawlProvider.kind !== "LOCAL" || this.crawlProvider.mode !== "SHADOW") {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "LEGACY_LIVE_CRAWL_NOT_WIRED",
        this.crawlProvider.id,
        null,
        "legacy website fetches require a strict per-page crawl adapter",
      );
    }
    const policy: Partial<CrawlRouterPolicy> = {
      allowExternalFallback: false,
      allowLiveNetwork: false,
      timeoutMs: 1_000,
      maxContentBytes: 10_000,
      allowedContentTypes: ["text/html"],
    };
    const router = new CrawlRouter({
      localProvider: preflightCrawlProvider(this.crawlProvider),
      budget: new CrawlBudgetLedger({
        maxPagesPerCampaign: 1,
        maxPagesPerAccount: 1,
        maxFetchAttemptsPerCampaign: 1,
        maxProviderCostUnitsPerCampaign: 0,
        maxProviderCostUnitsPerAccount: 0,
      }),
      policy,
      audit: this.crawlAudit,
      now: this.now,
    });
    const result = await router.routePage(crawlPreflightRequest(input, this.now));
    if (result.status !== "SUCCEEDED" || result.source !== "LOCAL") {
      throw new LegacyDiscoveryRuntimeBlockedError(
        "CRAWL_PROVIDER_CONTRACT_BLOCKED",
        this.crawlProvider.id,
        result.status,
        result.failureClass ?? result.fallbackBlockReason,
      );
    }
    return {
      providerId: this.crawlProvider.id,
      status: "SUCCEEDED",
      mode: "SHADOW",
    };
  }
}
