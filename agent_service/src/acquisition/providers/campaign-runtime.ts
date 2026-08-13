import { createHash } from "node:crypto";
import type { AgentConfig } from "../../config.js";
import type { AgentDatabase, IndependentOfficialEmailVerifier } from "../../db.js";
import type { SearchResult, WebsiteAssessment } from "../../types.js";
import type { SearchProvider } from "../../search/provider.js";
import {
  prepareWebsiteCrawlPreflight,
  type WebsiteAddressResolver,
} from "../../search/website.js";
import { ProviderBudget, providerRequestHash } from "../provider-runtime.js";
import { CrawlBudgetLedger, CrawlRouter, crawlStableHash, validateCrawlTarget } from "../crawl-router.js";
import type { CrawlDecisionAudit, CrawlPageRequest } from "../crawl-contracts.js";
import {
  ProviderRequestSchema,
  ProviderResponseSchema,
  type StrictProviderAdapter,
} from "./contracts.js";
import { BouncerOfficialAdapter } from "./bouncer-official.js";
import { HunterOfficialAdapter } from "./hunter-official.js";
import {
  LocalPublicWebsiteProvider,
  LocalWebsiteAssessmentSchema,
  parseLocalWebsiteAssessment,
} from "./local-public-web.js";
import {
  SearxngOfficialAdapter,
  createSearxngOfficialAdapter,
  searxngResponseToSearchResults,
} from "./searxng-official.js";
import { StrictProviderRuntime, type ProviderAuditEvent } from "./strict-runtime.js";

export interface AuthorizedCampaignProviderScope {
  campaignId: string;
  versionId: string;
}

export class CampaignProviderRuntimeError extends Error {
  override readonly name = "CampaignProviderRuntimeError";
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name?: unknown }).name || "PROVIDER_ERROR").slice(0, 200);
  }
  return "PROVIDER_ERROR";
}

function positiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function nonNegativeInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

export class CampaignSearxngSearchProvider implements SearchProvider {
  readonly name = "searxng-strict";
  private readonly adapter: SearxngOfficialAdapter;
  private readonly timeoutMs: number;
  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly db: AgentDatabase,
    private readonly scope: AuthorizedCampaignProviderScope,
    config: Pick<
      AgentConfig,
      "SEARXNG_BASE_URL" | "ACQ_SEARXNG_V2_ENABLED" | "SEARXNG_LOCAL_ENDPOINT_ALLOWED" |
      "SEARXNG_REQUEST_TIMEOUT_MS" | "SEARXNG_CACHE_TTL_SECONDS"
    >,
    adapter?: SearxngOfficialAdapter,
  ) {
    this.adapter = adapter ?? createSearxngOfficialAdapter(config);
    this.timeoutMs = positiveInt(config.SEARXNG_REQUEST_TIMEOUT_MS, 20_000, 60_000);
    this.cacheTtlSeconds = positiveInt(config.SEARXNG_CACHE_TTL_SECONDS, 3_600, 30 * 86_400);
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const request = ProviderRequestSchema.parse({
      operation: "EVIDENCE_SEARCH",
      accountId: this.scope.campaignId,
      query,
      limit: Math.max(1, Math.min(25, Math.trunc(limit))),
      publicSourcesOnly: true,
      localFetchValidationRequired: true,
    });
    if (request.operation !== "EVIDENCE_SEARCH") {
      throw new CampaignProviderRuntimeError("SearXNG request schema selected an unexpected operation");
    }
    const requestHash = providerRequestHash({
      campaignId: this.scope.campaignId,
      versionId: this.scope.versionId,
      providerId: "SEARXNG",
      request,
    });
    const run = this.db.beginProviderRun({
      campaignId: this.scope.campaignId,
      versionId: this.scope.versionId,
      providerKey: "searxng",
      operation: request.operation,
      requestHash,
      requestedCount: request.limit,
      chargeable: false,
      metadata: { source: "STRICT_LEGACY_SEARCH_BRIDGE" },
    });
    if (run.status === "CACHED") {
      const cached = ProviderResponseSchema.parse(run.response);
      return searxngResponseToSearchResults(cached, request.query, request.limit);
    }
    if (run.status === "IN_FLIGHT") {
      throw new CampaignProviderRuntimeError("Identical SearXNG request is already in flight");
    }
    if (!run.providerAttemptId) {
      throw new CampaignProviderRuntimeError("Provider ledger did not create an attempt");
    }

    let audit: ProviderAuditEvent | null = null;
    const runtime = new StrictProviderRuntime({ audit: (event) => { audit = event; } });
    try {
      const result = await runtime.run({
        adapter: this.adapter,
        request,
        budget: new ProviderBudget(0, 0),
        campaignAuthorizationVerified: true,
        timeoutMs: this.timeoutMs,
      });
      if (result.status !== "SUCCEEDED_LIVE" || !result.response) {
        throw new CampaignProviderRuntimeError(
          `SearXNG strict execution failed: ${result.status}/${result.reason}`,
        );
      }
      const response = result.response;
      this.db.completeProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        returnedCount: response.assertions.length,
        resultHash: providerRequestHash(response),
        response: response as unknown as Record<string, unknown>,
        cacheTtlSeconds: this.cacheTtlSeconds,
        units: 0,
        costMicros: 0,
        usageIdempotencyKey: `usage:${run.providerRunId}:${run.providerAttemptId}`,
        metadata: { strictAudit: audit },
      });
      return searxngResponseToSearchResults(response, request.query, request.limit);
    } catch (error) {
      if (audit) {
        this.db.recordEvent(
          "provider_run",
          run.providerRunId,
          "PROVIDER_STRICT_AUDIT",
          "system",
          audit as unknown as Record<string, unknown>,
        );
      }
      this.db.failProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        errorClass: errorClass(error),
      });
      throw error;
    }
  }
}

export interface CampaignWebsiteAssessorOptions {
  db: AgentDatabase;
  scope: AuthorizedCampaignProviderScope;
  config: Pick<
    AgentConfig,
    "ACQ_LOCAL_PUBLIC_WEB_ENABLED" | "LOCAL_PUBLIC_WEB_TIMEOUT_MS" |
    "LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS" | "MAX_PAGES_PER_CAMPAIGN" |
    "MAX_COMPANY_PAGES" | "RESEARCH_USER_AGENT"
  >;
  provider?: LocalPublicWebsiteProvider;
  resolver?: WebsiteAddressResolver;
  now?: () => Date;
}

export class CampaignWebsiteAssessor {
  private readonly db: AgentDatabase;
  private readonly scope: AuthorizedCampaignProviderScope;
  private readonly config: CampaignWebsiteAssessorOptions["config"];
  private readonly provider: LocalPublicWebsiteProvider;
  private readonly resolver: WebsiteAddressResolver | undefined;
  private readonly now: () => Date;
  private readonly budget: CrawlBudgetLedger;

  constructor(options: CampaignWebsiteAssessorOptions) {
    this.db = options.db;
    this.scope = options.scope;
    this.config = options.config;
    this.resolver = options.resolver;
    this.now = options.now ?? (() => new Date());
    this.provider = options.provider ?? new LocalPublicWebsiteProvider(
      options.config.ACQ_LOCAL_PUBLIC_WEB_ENABLED,
      { userAgent: options.config.RESEARCH_USER_AGENT, resolver: options.resolver },
    );
    this.budget = new CrawlBudgetLedger({
      maxPagesPerCampaign: Math.max(1, Math.trunc(options.config.MAX_PAGES_PER_CAMPAIGN)),
      maxPagesPerAccount: Math.max(1, Math.trunc(options.config.MAX_COMPANY_PAGES)),
      maxFetchAttemptsPerCampaign: Math.max(1, Math.trunc(options.config.MAX_PAGES_PER_CAMPAIGN)),
      maxProviderCostUnitsPerCampaign: 0,
      maxProviderCostUnitsPerAccount: 0,
    });
  }

  async assess(rawUrl: string, userAgent: string, maxPages: number): Promise<WebsiteAssessment> {
    const target = validateCrawlTarget(rawUrl);
    if (!target.ok) throw new CampaignProviderRuntimeError(`Website target blocked: ${target.failureClass}`);
    const pageLimit = Math.max(1, Math.min(
      Math.trunc(maxPages),
      Math.max(1, Math.trunc(this.config.MAX_COMPANY_PAGES)),
    ));
    const requestHash = crawlStableHash({
      campaignId: this.scope.campaignId,
      versionId: this.scope.versionId,
      providerId: this.provider.id,
      requestedUrl: target.normalizedUrl,
      maxPages: pageLimit,
      userAgent,
    });
    const run = this.db.beginProviderRun({
      campaignId: this.scope.campaignId,
      versionId: this.scope.versionId,
      providerKey: "local-public-web",
      operation: "WEBSITE_CRAWL",
      requestHash,
      requestedCount: pageLimit,
      chargeable: false,
      metadata: { source: "STRICT_LEGACY_WEBSITE_BRIDGE" },
    });
    if (run.status === "CACHED") {
      return LocalWebsiteAssessmentSchema.parse(run.response) as WebsiteAssessment;
    }
    if (run.status === "IN_FLIGHT") {
      throw new CampaignProviderRuntimeError("Identical website crawl is already in flight");
    }
    if (!run.providerAttemptId) {
      throw new CampaignProviderRuntimeError("Website crawl ledger did not create an attempt");
    }
    const reserved = this.db.db.prepare(
      `SELECT coalesce(sum(pr.requested_count), 0) AS pages
       FROM provider_runs pr
       JOIN provider_registry registry ON registry.id=pr.provider_id
       WHERE pr.campaign_id=? AND pr.campaign_version_id=?
         AND registry.provider_key='local-public-web'
         AND pr.status IN ('RUNNING','SUCCEEDED','PARTIAL')`,
    ).get(this.scope.campaignId, this.scope.versionId) as { pages: number };
    if (Number(reserved.pages) > Math.max(1, Math.trunc(this.config.MAX_PAGES_PER_CAMPAIGN))) {
      this.db.failProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        errorClass: "CAMPAIGN_PAGE_BUDGET_EXHAUSTED",
      });
      throw new CampaignProviderRuntimeError("Campaign website page budget is exhausted");
    }

    const controller = new AbortController();
    const timeoutMs = positiveInt(this.config.LOCAL_PUBLIC_WEB_TIMEOUT_MS, 20_000, 60_000);
    const timeout = setTimeout(() => controller.abort(new Error("website crawl timeout")), timeoutMs);
    const audits: CrawlDecisionAudit[] = [];
    try {
      const preflight = await prepareWebsiteCrawlPreflight(
        target.normalizedUrl,
        userAgent,
        this.resolver,
        controller.signal,
        this.now,
      );
      const request: CrawlPageRequest = {
        campaignId: this.scope.campaignId,
        accountId: `candidate-${hash(target.registrableDomain).slice(0, 32)}`,
        runId: run.providerRunId,
        requestedUrl: preflight.normalizedUrl,
        officialBaseUrl: preflight.normalizedUrl,
        pageType: "SEARXNG_CANDIDATE_WEBSITE",
        maxPages: pageLimit,
        robots: preflight.robots,
        resolution: preflight.resolution,
      };
      const router = new CrawlRouter({
        localProvider: this.provider,
        budget: this.budget,
        policy: {
          allowExternalFallback: false,
          allowLiveNetwork: true,
          timeoutMs,
          maxContentBytes: 2_000_000,
          allowedContentTypes: ["application/json"],
        },
        audit: (event) => audits.push(event),
        now: this.now,
      });
      const result = await router.routePage(request);
      if (result.status !== "SUCCEEDED" || !result.content) {
        throw new CampaignProviderRuntimeError(
          `Website crawl failed: ${result.status}/${result.failureClass ?? result.fallbackBlockReason}`,
        );
      }
      const assessment = parseLocalWebsiteAssessment(result.content);
      this.db.completeProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        returnedCount: assessment.pages.length,
        resultHash: result.contentHash ?? providerRequestHash(assessment),
        response: assessment as unknown as Record<string, unknown>,
        cacheTtlSeconds: positiveInt(
          this.config.LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS,
          3_600,
          30 * 86_400,
        ),
        units: 0,
        costMicros: 0,
        usageIdempotencyKey: `usage:${run.providerRunId}:${run.providerAttemptId}`,
        metadata: { crawlAudit: audits.at(-1) ?? null },
      });
      return assessment;
    } catch (error) {
      if (audits.length > 0) {
        this.db.recordEvent(
          "provider_run",
          run.providerRunId,
          "CRAWL_STRICT_AUDIT",
          "system",
          audits.at(-1) as unknown as Record<string, unknown>,
        );
      }
      this.db.failProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        errorClass: errorClass(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface CampaignEmailVerificationInput {
  email: string;
  expectedDomain: string;
  personRef: string;
  discoveryAssertionId: string;
  discoverySourceKey: "LOCAL_PUBLIC_WEB";
  discoverySourceUrl: string;
  discoveryEvidenceHash: string;
}

export interface CampaignEmailVerificationOutcome {
  status: "VALID" | "RISKY" | "INVALID" | "UNKNOWN";
  reason: string;
  catchAll: boolean;
  disposable: boolean;
  roleMailbox: boolean;
  discoverySourceKey: "LOCAL_PUBLIC_WEB";
  verifierSourceKey: IndependentOfficialEmailVerifier;
  independentlyVerified: true;
  discoveryAssertionId: string;
  verificationAssertionId: string;
  providerRunId: string;
  emailHash: string;
  providerMailboxVerdict:
    | "VALID_ASSERTION"
    | "INVALID_ASSERTION"
    | "RISKY_ASSERTION"
    | "UNKNOWN_ASSERTION";
  confidence: number;
  rawPayloadHash: string;
  observedAt: string;
  expiresAt: string;
  creditUnits: number;
  estimatedCostMicros: number;
  discoverySourceUrl: string;
  discoveryEvidenceHash: string;
}

export interface CampaignEmailVerifier {
  verify(input: CampaignEmailVerificationInput): Promise<CampaignEmailVerificationOutcome | null>;
}

export interface CampaignHunterEmailVerifierOptions {
  db: AgentDatabase;
  scope: AuthorizedCampaignProviderScope;
  config: Pick<
    AgentConfig,
    "ACQ_HUNTER_V2_ENABLED" | "HUNTER_API_KEY" | "HUNTER_REQUEST_TIMEOUT_MS" |
    "HUNTER_CACHE_TTL_SECONDS" | "HUNTER_EMAIL_VERIFICATION_COST_UNITS" |
    "HUNTER_EMAIL_VERIFICATION_COST_MICROS"
  >;
  adapter?: HunterOfficialAdapter;
}

export interface CampaignBouncerEmailVerifierOptions {
  db: AgentDatabase;
  scope: AuthorizedCampaignProviderScope;
  config: Pick<
    AgentConfig,
    "ACQ_BOUNCER_V2_ENABLED" | "BOUNCER_API_KEY" | "BOUNCER_REQUEST_TIMEOUT_MS" |
    "BOUNCER_CACHE_TTL_SECONDS" | "BOUNCER_EMAIL_VERIFICATION_COST_UNITS" |
    "BOUNCER_EMAIL_VERIFICATION_COST_MICROS"
  >;
  adapter?: BouncerOfficialAdapter;
}

interface CampaignOfficialEmailVerifierOptions {
  db: AgentDatabase;
  scope: AuthorizedCampaignProviderScope;
  providerId: IndependentOfficialEmailVerifier;
  providerKey: "hunter" | "bouncer";
  enabled: boolean;
  apiKey: string;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  verificationCostUnits: number;
  verificationCostMicros: number;
  adapter: StrictProviderAdapter;
}

class CampaignOfficialEmailVerifier implements CampaignEmailVerifier {
  private readonly db: AgentDatabase;
  private readonly scope: AuthorizedCampaignProviderScope;
  private readonly providerId: IndependentOfficialEmailVerifier;
  private readonly providerKey: "hunter" | "bouncer";
  private readonly enabled: boolean;
  private readonly apiKey: string;
  private readonly adapter: StrictProviderAdapter;
  private readonly timeoutMs: number;
  private readonly cacheTtlSeconds: number;
  private readonly costUnits: number;
  private readonly costMicros: number;

  constructor(options: CampaignOfficialEmailVerifierOptions) {
    this.db = options.db;
    this.scope = options.scope;
    this.providerId = options.providerId;
    this.providerKey = options.providerKey;
    this.enabled = options.enabled;
    this.apiKey = options.apiKey;
    this.timeoutMs = positiveInt(options.requestTimeoutMs, 20_000, 60_000);
    this.cacheTtlSeconds = positiveInt(options.cacheTtlSeconds, 86_400, 30 * 86_400);
    this.costUnits = positiveInt(options.verificationCostUnits, 1, 1_000_000);
    this.costMicros = nonNegativeInt(
      options.verificationCostMicros,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.adapter = options.adapter;
  }

  async verify(input: CampaignEmailVerificationInput): Promise<CampaignEmailVerificationOutcome | null> {
    if (!this.enabled || !this.apiKey.trim() ||
      input.discoverySourceKey !== "LOCAL_PUBLIC_WEB") {
      return null;
    }
    let context: Record<string, unknown>;
    try {
      context = this.db.getAuthorizedProviderCampaignContext(
        this.scope.campaignId,
        this.providerKey,
        { chargeable: true },
      );
    } catch {
      return null;
    }
    if (String(context.version_id) !== this.scope.versionId) return null;

    const requestResult = ProviderRequestSchema.safeParse({
      operation: "EMAIL_VERIFICATION",
      accountId: this.scope.campaignId,
      personRef: input.personRef,
      email: input.email,
      expectedDomain: input.expectedDomain,
      discoveryAssertionId: input.discoveryAssertionId,
      discoveryProviderId: input.discoverySourceKey,
      independentVerificationRequired: true,
    });
    if (!requestResult.success || requestResult.data.operation !== "EMAIL_VERIFICATION") return null;
    const request = requestResult.data;
    const requestHash = providerRequestHash({
      campaignId: this.scope.campaignId,
      versionId: this.scope.versionId,
      providerId: this.providerId,
      request,
    });
    let run: ReturnType<AgentDatabase["beginProviderRun"]>;
    try {
      run = this.db.beginProviderRun({
        campaignId: this.scope.campaignId,
        versionId: this.scope.versionId,
        providerKey: this.providerKey,
        operation: request.operation,
        requestHash,
        requestedCount: 1,
        chargeable: true,
        estimatedUnits: this.costUnits,
        estimatedCostMicros: this.costMicros,
        staleAfterSeconds: Math.max(30, Math.ceil(this.timeoutMs / 1_000) + 30),
        metadata: {
          source: "STRICT_PUBLIC_WEB_EMAIL_VERIFICATION",
          discoverySourceKey: input.discoverySourceKey,
          verifierSourceKey: this.providerId,
          discoveryEvidenceHash: input.discoveryEvidenceHash,
        },
      });
    } catch {
      return null;
    }
    if (run.status === "CACHED") {
      return this.toOutcome(
        ProviderResponseSchema.parse(run.response),
        run.providerRunId,
        input,
      );
    }
    if (run.status === "IN_FLIGHT" || !run.providerAttemptId) return null;

    let audit: ProviderAuditEvent | null = null;
    const runtime = new StrictProviderRuntime({ audit: (event) => { audit = event; } });
    try {
      const providerBudget = context.providerBudget as Record<string, unknown>;
      const result = await runtime.run({
        adapter: this.adapter,
        request,
        budget: new ProviderBudget(
          Number(providerBudget.maxUnits),
          Number(providerBudget.maxAmountUsd),
        ),
        campaignAuthorizationVerified: true,
        timeoutMs: this.timeoutMs,
      });
      if (result.status !== "SUCCEEDED_LIVE" || !result.response) {
        this.db.failProviderRun({
          providerRunId: run.providerRunId,
          providerAttemptId: run.providerAttemptId,
          errorClass: `STRICT_${this.providerId}_${result.status}`,
        });
        return null;
      }
      const actualUnits = result.audit.actualCost.costUnits;
      const actualCostMicros = Math.round(result.audit.actualCost.usd * 1_000_000);
      this.db.completeProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        returnedCount: result.response.assertions.length,
        resultHash: providerRequestHash(result.response),
        response: result.response as unknown as Record<string, unknown>,
        cacheTtlSeconds: this.cacheTtlSeconds,
        units: actualUnits,
        costMicros: actualCostMicros,
        usageIdempotencyKey: `usage:${run.providerRunId}:${run.providerAttemptId}`,
        metadata: { strictAudit: audit },
      });
      return this.toOutcome(result.response, run.providerRunId, input);
    } catch (error) {
      if (audit) {
        this.db.recordEvent(
          "provider_run",
          run.providerRunId,
          "PROVIDER_STRICT_AUDIT",
          "system",
          audit as unknown as Record<string, unknown>,
        );
      }
      this.db.failProviderRun({
        providerRunId: run.providerRunId,
        providerAttemptId: run.providerAttemptId,
        errorClass: errorClass(error),
      });
      return null;
    }
  }

  private toOutcome(
    response: ReturnType<typeof ProviderResponseSchema.parse>,
    providerRunId: string,
    input: CampaignEmailVerificationInput,
  ): CampaignEmailVerificationOutcome | null {
    const expectedEmailHash = createHash("sha256")
      .update(input.email.trim().toLowerCase())
      .digest("hex");
    const assertion = response.assertions.find((item) =>
      item.kind === "EMAIL_VERIFICATION" &&
      item.discoveryAssertionId === input.discoveryAssertionId &&
      item.discoveryProviderId === "LOCAL_PUBLIC_WEB" &&
      item.verificationProviderId === this.providerId &&
      item.emailHash === expectedEmailHash);
    if (!assertion || assertion.kind !== "EMAIL_VERIFICATION") return null;
    const status = assertion.providerMailboxVerdict === "VALID_ASSERTION"
      ? "VALID"
      : assertion.providerMailboxVerdict === "INVALID_ASSERTION"
        ? "INVALID"
        : assertion.providerMailboxVerdict === "RISKY_ASSERTION"
          ? "RISKY"
          : "UNKNOWN";
    return {
      status,
      reason: assertion.providerMailboxVerdict === "VALID_ASSERTION"
        ? `${this.providerId} independently verified the public-web work email`
        : assertion.providerMailboxVerdict === "INVALID_ASSERTION"
          ? `${this.providerId} verifier invalid`
          : assertion.providerMailboxVerdict === "RISKY_ASSERTION"
            ? `${this.providerId} verifier risky${assertion.catchAll ? "; catch-all" : ""}`
            : `${this.providerId} verifier returned an unknown mailbox verdict`,
      catchAll: assertion.catchAll,
      disposable: assertion.disposable,
      roleMailbox: assertion.roleMailbox,
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey: this.providerId,
      independentlyVerified: true,
      discoveryAssertionId: assertion.discoveryAssertionId,
      verificationAssertionId: assertion.assertionId,
      providerRunId,
      emailHash: assertion.emailHash,
      providerMailboxVerdict: assertion.providerMailboxVerdict,
      confidence: assertion.confidence,
      rawPayloadHash: assertion.rawPayloadHash,
      observedAt: assertion.observedAt,
      expiresAt: assertion.expiresAt,
      creditUnits: assertion.creditUnits,
      estimatedCostMicros: Math.round(assertion.estimatedUsd * 1_000_000),
      discoverySourceUrl: input.discoverySourceUrl,
      discoveryEvidenceHash: input.discoveryEvidenceHash,
    };
  }
}

function verificationCost(units: number, micros: number) {
  return {
    costUnits: positiveInt(units, 1, 1_000_000),
    usd: nonNegativeInt(micros, 0, Number.MAX_SAFE_INTEGER) / 1_000_000,
    currency: "USD" as const,
  };
}

export class CampaignHunterEmailVerifier extends CampaignOfficialEmailVerifier {
  constructor(options: CampaignHunterEmailVerifierOptions) {
    const timeoutMs = positiveInt(options.config.HUNTER_REQUEST_TIMEOUT_MS, 20_000, 60_000);
    const cost = verificationCost(
      options.config.HUNTER_EMAIL_VERIFICATION_COST_UNITS,
      options.config.HUNTER_EMAIL_VERIFICATION_COST_MICROS,
    );
    super({
      db: options.db,
      scope: options.scope,
      providerId: "HUNTER",
      providerKey: "hunter",
      enabled: options.config.ACQ_HUNTER_V2_ENABLED,
      apiKey: options.config.HUNTER_API_KEY,
      requestTimeoutMs: timeoutMs,
      cacheTtlSeconds: options.config.HUNTER_CACHE_TTL_SECONDS,
      verificationCostUnits: cost.costUnits,
      verificationCostMicros: Math.round(cost.usd * 1_000_000),
      adapter: options.adapter ?? new HunterOfficialAdapter({
        enabled: options.config.ACQ_HUNTER_V2_ENABLED,
        apiKey: options.config.HUNTER_API_KEY,
        requestTimeoutMs: timeoutMs,
        costByOperation: {
          WORK_EMAIL_DISCOVERY: cost,
          EMAIL_VERIFICATION: cost,
        },
      }),
    });
  }
}

export class CampaignBouncerEmailVerifier extends CampaignOfficialEmailVerifier {
  constructor(options: CampaignBouncerEmailVerifierOptions) {
    const timeoutMs = positiveInt(options.config.BOUNCER_REQUEST_TIMEOUT_MS, 20_000, 60_000);
    const cost = verificationCost(
      options.config.BOUNCER_EMAIL_VERIFICATION_COST_UNITS,
      options.config.BOUNCER_EMAIL_VERIFICATION_COST_MICROS,
    );
    super({
      db: options.db,
      scope: options.scope,
      providerId: "BOUNCER",
      providerKey: "bouncer",
      enabled: options.config.ACQ_BOUNCER_V2_ENABLED,
      apiKey: options.config.BOUNCER_API_KEY,
      requestTimeoutMs: timeoutMs,
      cacheTtlSeconds: options.config.BOUNCER_CACHE_TTL_SECONDS,
      verificationCostUnits: cost.costUnits,
      verificationCostMicros: Math.round(cost.usd * 1_000_000),
      adapter: options.adapter ?? new BouncerOfficialAdapter({
        enabled: options.config.ACQ_BOUNCER_V2_ENABLED,
        apiKey: options.config.BOUNCER_API_KEY,
        requestTimeoutMs: timeoutMs,
        verificationCost: cost,
      }),
    });
  }
}

export interface CampaignApprovedEmailVerifierOptions {
  db: AgentDatabase;
  scope: AuthorizedCampaignProviderScope;
  config: Pick<
    AgentConfig,
    "ACQ_HUNTER_V2_ENABLED" | "HUNTER_API_KEY" | "HUNTER_REQUEST_TIMEOUT_MS" |
    "HUNTER_CACHE_TTL_SECONDS" | "HUNTER_EMAIL_VERIFICATION_COST_UNITS" |
    "HUNTER_EMAIL_VERIFICATION_COST_MICROS" | "ACQ_BOUNCER_V2_ENABLED" |
    "BOUNCER_API_KEY" | "BOUNCER_REQUEST_TIMEOUT_MS" | "BOUNCER_CACHE_TTL_SECONDS" |
    "BOUNCER_EMAIL_VERIFICATION_COST_UNITS" | "BOUNCER_EMAIL_VERIFICATION_COST_MICROS"
  >;
  hunterAdapter?: HunterOfficialAdapter;
  bouncerAdapter?: BouncerOfficialAdapter;
}

export class CampaignApprovedEmailVerifier implements CampaignEmailVerifier {
  private readonly hunter: CampaignHunterEmailVerifier;
  private readonly bouncer: CampaignBouncerEmailVerifier;

  constructor(private readonly options: CampaignApprovedEmailVerifierOptions) {
    this.hunter = new CampaignHunterEmailVerifier({
      db: options.db,
      scope: options.scope,
      config: options.config,
      adapter: options.hunterAdapter,
    });
    this.bouncer = new CampaignBouncerEmailVerifier({
      db: options.db,
      scope: options.scope,
      config: options.config,
      adapter: options.bouncerAdapter,
    });
  }

  async verify(input: CampaignEmailVerificationInput): Promise<CampaignEmailVerificationOutcome | null> {
    const verifier = this.approvedVerifier();
    if (verifier === "HUNTER") return this.hunter.verify(input);
    if (verifier === "BOUNCER") return this.bouncer.verify(input);
    return null;
  }

  private approvedVerifier(): IndependentOfficialEmailVerifier | null {
    let context: Record<string, unknown>;
    try {
      context = this.options.db.getAuthorizedProviderCampaignContext(
        this.options.scope.campaignId,
        "searxng",
        { chargeable: false },
      );
    } catch {
      return null;
    }
    if (String(context.version_id) !== this.options.scope.versionId) return null;
    let brief: Record<string, unknown>;
    try {
      brief = JSON.parse(String(context.brief_json)) as Record<string, unknown>;
    } catch {
      return null;
    }
    const providerBudget = brief.providerBudget;
    if (!providerBudget || typeof providerBudget !== "object" || Array.isArray(providerBudget)) return null;
    const allowedProviders = new Set(
      (Array.isArray((providerBudget as Record<string, unknown>).allowedProviders)
        ? (providerBudget as Record<string, unknown>).allowedProviders as unknown[]
        : [])
        .map((provider) => String(provider).trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    );
    if (!allowedProviders.has("searxng") || !allowedProviders.has("local-public-web")) return null;
    const selected = (["hunter", "bouncer"] as const).filter((provider) => allowedProviders.has(provider));
    if (selected.length !== 1) return null;
    return selected[0] === "hunter" ? "HUNTER" : "BOUNCER";
  }
}
