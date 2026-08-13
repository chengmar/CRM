import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { getDomain } from "tldts";
import {
  FALLBACK_ELIGIBLE_FAILURES,
  type CrawlBudgetLimits,
  type CrawlBudgetSnapshot,
  type CrawlDecisionAudit,
  type CrawlFailureClass,
  type CrawlFallbackBlockReason,
  type CrawlPageObservation,
  type CrawlPageRequest,
  type CrawlPageSnapshot,
  type CrawlProvider,
  type CrawlProviderContext,
  type CrawlResolutionEvidence,
  type CrawlResolvedAddress,
  type CrawlRouteResult,
  type CrawlRouteStatus,
} from "./crawl-contracts.js";

const MAX_CRAWL_URL_LENGTH = 2_000;
const unsafeIpv4 = new BlockList();
const unsafeIpv6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unsafeIpv4.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  unsafeIpv6.addSubnet(network, prefix, "ipv6");
}

const unsafeHostSuffixes = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export interface ValidatedCrawlTarget {
  ok: true;
  url: URL;
  normalizedUrl: string;
  hostname: string;
  registrableDomain: string;
}

export interface RejectedCrawlTarget {
  ok: false;
  failureClass: Extract<CrawlFailureClass, "INVALID_URL" | "UNSAFE_TARGET" | "DNS_UNRESOLVED" | "CROSS_DOMAIN">;
  reason: string;
}

export type CrawlTargetValidation = ValidatedCrawlTarget | RejectedCrawlTarget;

export interface CrawlRouterPolicy {
  allowExternalFallback: boolean;
  allowLiveNetwork: boolean;
  timeoutMs: number;
  maxContentBytes: number;
  allowedContentTypes: readonly string[];
}

export const DEFAULT_CRAWL_ROUTER_POLICY: Readonly<CrawlRouterPolicy> = Object.freeze({
  allowExternalFallback: false,
  allowLiveNetwork: false,
  timeoutMs: 15_000,
  maxContentBytes: 1_000_000,
  allowedContentTypes: Object.freeze([
    "text/html",
    "application/xhtml+xml",
    "text/plain",
    "text/markdown",
  ]),
});

interface CampaignBudgetState {
  pages: Set<string>;
  fetchAttempts: number;
  providerCostUnits: number;
}

interface AccountBudgetState {
  pages: Set<string>;
  fetchAttempts: number;
  providerCostUnits: number;
}

interface FetchReservation {
  campaignId: string;
  accountId: string;
  reservedCostUnits: number;
  finalized: boolean;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function wholeNonNegative(value: number, name: string): number {
  finiteNonNegative(value, name);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export class CrawlBudgetLedger {
  readonly limits: Readonly<CrawlBudgetLimits>;
  private readonly campaigns = new Map<string, CampaignBudgetState>();
  private readonly accounts = new Map<string, AccountBudgetState>();

  constructor(limits: CrawlBudgetLimits) {
    this.limits = Object.freeze({
      maxPagesPerCampaign: wholeNonNegative(limits.maxPagesPerCampaign, "maxPagesPerCampaign"),
      maxPagesPerAccount: wholeNonNegative(limits.maxPagesPerAccount, "maxPagesPerAccount"),
      maxFetchAttemptsPerCampaign: wholeNonNegative(
        limits.maxFetchAttemptsPerCampaign,
        "maxFetchAttemptsPerCampaign",
      ),
      maxProviderCostUnitsPerCampaign: finiteNonNegative(
        limits.maxProviderCostUnitsPerCampaign,
        "maxProviderCostUnitsPerCampaign",
      ),
      maxProviderCostUnitsPerAccount: finiteNonNegative(
        limits.maxProviderCostUnitsPerAccount,
        "maxProviderCostUnitsPerAccount",
      ),
    });
  }

  claimPage(campaignId: string, accountId: string, pageKey: string): boolean {
    const campaign = this.campaign(campaignId);
    const account = this.account(campaignId, accountId);
    if (campaign.pages.has(pageKey) && account.pages.has(pageKey)) return true;
    if (campaign.pages.size >= this.limits.maxPagesPerCampaign ||
      account.pages.size >= this.limits.maxPagesPerAccount) return false;
    campaign.pages.add(pageKey);
    account.pages.add(pageKey);
    return true;
  }

  claimFetch(campaignId: string, accountId: string, estimatedCostUnits: number): FetchReservation | null {
    const estimate = finiteNonNegative(estimatedCostUnits, "estimatedCostUnits");
    const campaign = this.campaign(campaignId);
    const account = this.account(campaignId, accountId);
    if (campaign.fetchAttempts >= this.limits.maxFetchAttemptsPerCampaign ||
      campaign.providerCostUnits + estimate > this.limits.maxProviderCostUnitsPerCampaign ||
      account.providerCostUnits + estimate > this.limits.maxProviderCostUnitsPerAccount) return null;

    campaign.fetchAttempts += 1;
    account.fetchAttempts += 1;
    campaign.providerCostUnits += estimate;
    account.providerCostUnits += estimate;
    return { campaignId, accountId, reservedCostUnits: estimate, finalized: false };
  }

  finalizeFetch(reservation: FetchReservation, actualCostUnits: number): void {
    if (reservation.finalized) return;
    const actual = finiteNonNegative(actualCostUnits, "actualCostUnits");
    const delta = actual - reservation.reservedCostUnits;
    this.campaign(reservation.campaignId).providerCostUnits += delta;
    this.account(reservation.campaignId, reservation.accountId).providerCostUnits += delta;
    reservation.finalized = true;
  }

  campaignSnapshot(campaignId: string): CrawlBudgetSnapshot {
    const state = this.campaign(campaignId);
    return {
      campaignId,
      pages: state.pages.size,
      fetchAttempts: state.fetchAttempts,
      providerCostUnits: state.providerCostUnits,
      remainingPages: Math.max(0, this.limits.maxPagesPerCampaign - state.pages.size),
      remainingFetchAttempts: Math.max(
        0,
        this.limits.maxFetchAttemptsPerCampaign - state.fetchAttempts,
      ),
      remainingProviderCostUnits: Math.max(
        0,
        this.limits.maxProviderCostUnitsPerCampaign - state.providerCostUnits,
      ),
    };
  }

  accountSnapshot(campaignId: string, accountId: string): CrawlBudgetSnapshot {
    const state = this.account(campaignId, accountId);
    return {
      campaignId,
      accountId,
      pages: state.pages.size,
      fetchAttempts: state.fetchAttempts,
      providerCostUnits: state.providerCostUnits,
      remainingPages: Math.max(0, this.limits.maxPagesPerAccount - state.pages.size),
      remainingFetchAttempts: this.campaignSnapshot(campaignId).remainingFetchAttempts,
      remainingProviderCostUnits: Math.max(
        0,
        this.limits.maxProviderCostUnitsPerAccount - state.providerCostUnits,
      ),
    };
  }

  private campaign(campaignId: string): CampaignBudgetState {
    let state = this.campaigns.get(campaignId);
    if (!state) {
      state = { pages: new Set(), fetchAttempts: 0, providerCostUnits: 0 };
      this.campaigns.set(campaignId, state);
    }
    return state;
  }

  private account(campaignId: string, accountId: string): AccountBudgetState {
    const key = `${campaignId}:${accountId}`;
    let state = this.accounts.get(key);
    if (!state) {
      state = { pages: new Set(), fetchAttempts: 0, providerCostUnits: 0 };
      this.accounts.set(key, state);
    }
    return state;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function crawlStableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function crawlContentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function domainForHostname(hostname: string): string {
  if (isIP(hostname)) return hostname;
  return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname.replace(/^www\./, ""))
    .toLowerCase();
}

function isPublicAddress(value: CrawlResolvedAddress): boolean {
  const address = normalizedHostname(value.address);
  if (isIP(address) !== value.family) return false;
  return value.family === 4
    ? !unsafeIpv4.check(address, "ipv4")
    : !unsafeIpv6.check(address, "ipv6");
}

function validateResolution(hostname: string, resolution: CrawlResolutionEvidence): RejectedCrawlTarget | null {
  if (normalizedHostname(resolution.hostname) !== hostname) {
    return { ok: false, failureClass: "DNS_UNRESOLVED", reason: "resolution hostname mismatch" };
  }
  if (resolution.addresses.length === 0) {
    return { ok: false, failureClass: "DNS_UNRESOLVED", reason: "target has no validated address" };
  }
  if (resolution.addresses.some((address) => !isPublicAddress(address))) {
    return { ok: false, failureClass: "UNSAFE_TARGET", reason: "private or reserved target address rejected" };
  }
  return null;
}

export function normalizeCrawlUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.searchParams.sort();
  return normalized.toString();
}

export function validateCrawlTarget(
  rawUrl: string,
  options: {
    resolution?: CrawlResolutionEvidence;
    expectedOfficialBaseUrl?: string;
  } = {},
): CrawlTargetValidation {
  const candidate = rawUrl.trim();
  if (!candidate || candidate.length > MAX_CRAWL_URL_LENGTH) {
    return { ok: false, failureClass: "INVALID_URL", reason: "URL is empty or exceeds the length limit" };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, failureClass: "INVALID_URL", reason: "URL parsing failed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, failureClass: "INVALID_URL", reason: "only HTTP(S) URLs are crawlable" };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, failureClass: "UNSAFE_TARGET", reason: "credentials and non-default ports are rejected" };
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === "localhost" || unsafeHostSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, failureClass: "UNSAFE_TARGET", reason: "local hostname rejected" };
  }
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicAddress({ address: hostname, family: literalFamily })) {
      return { ok: false, failureClass: "UNSAFE_TARGET", reason: "private or reserved literal address rejected" };
    }
  } else if (!hostname.includes(".") || hostname.length > 253) {
    return { ok: false, failureClass: "UNSAFE_TARGET", reason: "non-public hostname rejected" };
  }

  if (options.resolution) {
    const resolutionFailure = validateResolution(hostname, options.resolution);
    if (resolutionFailure) return resolutionFailure;
  }

  if (options.expectedOfficialBaseUrl) {
    const official = validateCrawlTarget(options.expectedOfficialBaseUrl);
    if (!official.ok) return official;
    const exactIpRequired = isIP(hostname) || isIP(official.hostname);
    const sameDomain = exactIpRequired
      ? hostname === official.hostname
      : domainForHostname(hostname) === official.registrableDomain;
    if (!sameDomain) {
      return { ok: false, failureClass: "CROSS_DOMAIN", reason: "target is outside the official domain" };
    }
  }

  return {
    ok: true,
    url,
    normalizedUrl: normalizeCrawlUrl(url),
    hostname,
    registrableDomain: domainForHostname(hostname),
  };
}

function normalizedContentType(value: string | null | undefined): string {
  return String(value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function byteLength(content: string | Uint8Array | null | undefined): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  return content?.byteLength ?? 0;
}

function isJavascriptShell(content: string, contentType: string): boolean {
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") return false;
  const scripts = content.match(/<script\b/gi)?.length ?? 0;
  const visible = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const shellMarker = /<(?:div|main)\b[^>]*(?:id|class)=["'][^"']*(?:app|root|shell)[^"']*["'][^>]*>\s*<\/(?:div|main)>/i
    .test(content) || /(?:enable|requires?)\s+javascript/i.test(visible);
  return visible.length < 120 && (shellMarker || scripts >= 2);
}

export function classifyCrawlFailure(
  observation: CrawlPageObservation,
  supportsContentType: (contentType: string) => boolean = () => true,
): CrawlFailureClass | null {
  if (observation.robotsStatus === "DISALLOWED") return "ROBOTS_DENIED";
  if (observation.robotsStatus !== "ALLOWED") return "ROBOTS_UNVERIFIED";
  const errorCode = String(observation.error?.code ?? "").toUpperCase();
  if (observation.timedOut || /TIMEOUT|TIMED_OUT|ABORT/.test(errorCode)) return "TIMEOUT";
  if (observation.httpStatus === 429) return "RATE_LIMITED";
  if ([401, 403, 407].includes(observation.httpStatus ?? 0)) return "ACCESS_BLOCKED";
  if ((observation.httpStatus ?? 0) >= 400) return "HTTP_ERROR";
  if (FALLBACK_ELIGIBLE_FAILURES.has(errorCode as CrawlFailureClass)) {
    return errorCode as CrawlFailureClass;
  }
  if (observation.error) return "NETWORK_ERROR";
  if (observation.truncated) return "PARTIAL_CONTENT";
  if (observation.structureRecovered === false) return "STRUCTURE_UNRECOVERABLE";

  const contentType = normalizedContentType(observation.contentType);
  if (!contentType || !supportsContentType(contentType)) return "UNSUPPORTED_DOCUMENT";
  const content = observation.content;
  if (content === null || content === undefined || byteLength(content) === 0) return "PARTIAL_CONTENT";
  if (typeof content === "string" && isJavascriptShell(content, contentType)) return "JS_REQUIRED";
  return null;
}

export interface OfficialCrawlPageCandidate {
  url: string;
  resolution: CrawlResolutionEvidence;
  pageType?: string;
  source: "OFFICIAL_BASE" | "OFFICIAL_LINK" | "SEARCH_ASSERTION" | "DIRECTORY_ASSERTION";
}

export interface OfficialCrawlPagePlan {
  accepted: OfficialCrawlPageCandidate[];
  rejected: Array<{ candidate: OfficialCrawlPageCandidate; reason: string }>;
}

const pageTypePriority: Record<string, number> = {
  PROCUREMENT: 50,
  TENDER: 48,
  PROJECT: 45,
  PRODUCT: 40,
  SOLUTION: 38,
  CONTACT: 35,
  TEAM: 34,
  ABOUT: 30,
  NEWS: 20,
  OTHER: 0,
};

export function prioritizeOfficialCrawlPages(input: {
  officialBaseUrl: string;
  candidates: OfficialCrawlPageCandidate[];
  maxPages: number;
}): OfficialCrawlPagePlan {
  const maxPages = wholeNonNegative(input.maxPages, "maxPages");
  const official = validateCrawlTarget(input.officialBaseUrl);
  if (!official.ok) {
    return {
      accepted: [],
      rejected: input.candidates.map((candidate) => ({ candidate, reason: official.reason })),
    };
  }

  const accepted = new Map<string, { candidate: OfficialCrawlPageCandidate; score: number }>();
  const rejected: OfficialCrawlPagePlan["rejected"] = [];
  for (const candidate of input.candidates) {
    const validation = validateCrawlTarget(candidate.url, {
      resolution: candidate.resolution,
      expectedOfficialBaseUrl: input.officialBaseUrl,
    });
    if (!validation.ok) {
      rejected.push({ candidate, reason: validation.reason });
      continue;
    }
    const exactBase = validation.normalizedUrl === official.normalizedUrl ? 1_000 : 0;
    const sourceScore = candidate.source === "OFFICIAL_BASE"
      ? 300
      : candidate.source === "OFFICIAL_LINK"
        ? 200
        : candidate.source === "SEARCH_ASSERTION"
          ? 50
          : 0;
    const hostScore = validation.hostname === official.hostname ? 20 : 0;
    const typeScore = pageTypePriority[String(candidate.pageType ?? "OTHER").toUpperCase()] ?? 0;
    const score = exactBase + sourceScore + hostScore + typeScore;
    const existing = accepted.get(validation.normalizedUrl);
    if (!existing || score > existing.score) accepted.set(validation.normalizedUrl, { candidate, score });
  }

  return {
    accepted: [...accepted.entries()]
      .sort(([leftUrl, left], [rightUrl, right]) => right.score - left.score || leftUrl.localeCompare(rightUrl))
      .slice(0, maxPages)
      .map(([, item]) => item.candidate),
    rejected,
  };
}

interface ProviderAttemptResult {
  observation: CrawlPageObservation | null;
  snapshot: CrawlPageSnapshot | null;
  failureClass: CrawlFailureClass | null;
  budgetBlocked: boolean;
}

export interface CrawlRouterOptions {
  localProvider: CrawlProvider;
  fallbackProvider?: CrawlProvider | null;
  budget: CrawlBudgetLedger;
  policy?: Partial<CrawlRouterPolicy>;
  audit?: (decision: CrawlDecisionAudit) => void;
  now?: () => Date;
}

function safePolicy(input: Partial<CrawlRouterPolicy> | undefined): CrawlRouterPolicy {
  const timeoutMs = wholeNonNegative(input?.timeoutMs ?? DEFAULT_CRAWL_ROUTER_POLICY.timeoutMs, "timeoutMs");
  const maxContentBytes = wholeNonNegative(
    input?.maxContentBytes ?? DEFAULT_CRAWL_ROUTER_POLICY.maxContentBytes,
    "maxContentBytes",
  );
  const allowedContentTypes = (input?.allowedContentTypes ?? DEFAULT_CRAWL_ROUTER_POLICY.allowedContentTypes)
    .map((value) => normalizedContentType(value))
    .filter(Boolean);
  if (timeoutMs === 0 || maxContentBytes === 0 || allowedContentTypes.length === 0) {
    throw new Error("crawl timeout, content limit, and allowed content types must be non-zero");
  }
  return {
    allowExternalFallback: input?.allowExternalFallback ?? false,
    allowLiveNetwork: input?.allowLiveNetwork ?? false,
    timeoutMs,
    maxContentBytes,
    allowedContentTypes: [...new Set(allowedContentTypes)],
  };
}

function routeIdentity(request: CrawlPageRequest): { requestHash: string; idempotencyKey: string } {
  const normalizedRequested = (() => {
    try {
      return normalizeCrawlUrl(new URL(request.requestedUrl));
    } catch {
      return request.requestedUrl.trim();
    }
  })();
  const requestHash = crawlStableHash({
    accountId: request.accountId,
    campaignId: request.campaignId,
    officialBaseUrl: request.officialBaseUrl,
    requestedUrl: normalizedRequested,
    maxPages: request.maxPages ?? 1,
    robotsStatus: request.robots.status,
    runId: request.runId,
  });
  return { requestHash, idempotencyKey: `crawl:${requestHash}` };
}

export class CrawlRouter {
  private readonly localProvider: CrawlProvider;
  private readonly fallbackProvider: CrawlProvider | null;
  private readonly budget: CrawlBudgetLedger;
  private readonly policy: CrawlRouterPolicy;
  private readonly audit: (decision: CrawlDecisionAudit) => void;
  private readonly now: () => Date;
  private readonly completed = new Map<string, CrawlRouteResult>();
  private readonly inFlight = new Map<string, Promise<CrawlRouteResult>>();
  private readonly processedContentHashes = new Set<string>();

  constructor(options: CrawlRouterOptions) {
    this.localProvider = options.localProvider;
    this.fallbackProvider = options.fallbackProvider ?? null;
    this.budget = options.budget;
    this.policy = safePolicy(options.policy);
    this.audit = options.audit ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async routePage(request: CrawlPageRequest): Promise<CrawlRouteResult> {
    const identity = routeIdentity(request);
    const cached = this.completed.get(identity.idempotencyKey);
    if (cached) return this.replay(request, cached);
    const existing = this.inFlight.get(identity.idempotencyKey);
    if (existing) return this.replay(request, await existing);

    const execution = this.routeUncached(request, identity);
    this.inFlight.set(identity.idempotencyKey, execution);
    try {
      const result = await execution;
      this.completed.set(identity.idempotencyKey, result);
      return result;
    } finally {
      this.inFlight.delete(identity.idempotencyKey);
    }
  }

  private replay(request: CrawlPageRequest, original: CrawlRouteResult): CrawlRouteResult {
    const replayed = { ...original, replayed: true, snapshots: [] };
    this.audit({
      idempotencyKey: original.idempotencyKey,
      requestHash: original.requestHash,
      campaignId: request.campaignId,
      accountId: request.accountId,
      runId: request.runId,
      requestedUrlHash: crawlStableHash(request.requestedUrl),
      status: "REPLAYED",
      source: original.source,
      providerId: original.providerId,
      localFailureClass: null,
      finalFailureClass: original.failureClass,
      fallbackEligible: original.fallbackEligible,
      fallbackUsed: original.fallbackUsed,
      fallbackBlockReason: original.fallbackBlockReason,
      fetchAttempts: 0,
      contentHash: original.contentHash,
      duplicateContent: Boolean(original.contentHash && !original.shouldProcess),
      decidedAt: this.now().toISOString(),
    });
    return replayed;
  }

  private async routeUncached(
    request: CrawlPageRequest,
    identity: { requestHash: string; idempotencyKey: string },
  ): Promise<CrawlRouteResult> {
    const official = validateCrawlTarget(request.officialBaseUrl);
    if (!official.ok) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: official.failureClass,
        fallbackBlockReason: "FAILURE_NOT_ELIGIBLE",
      });
    }
    const target = validateCrawlTarget(request.requestedUrl, {
      resolution: request.resolution,
      expectedOfficialBaseUrl: request.officialBaseUrl,
    });
    if (!target.ok) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: target.failureClass,
        fallbackBlockReason: "FAILURE_NOT_ELIGIBLE",
      });
    }
    if (request.robots.status !== "ALLOWED") {
      const failureClass = request.robots.status === "DISALLOWED" ? "ROBOTS_DENIED" : "ROBOTS_UNVERIFIED";
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass,
        fallbackBlockReason: "FAILURE_NOT_ELIGIBLE",
      });
    }
    if (!this.budget.claimPage(request.campaignId, request.accountId, target.normalizedUrl)) {
      return this.finish(request, identity, {
        status: "BUDGET_EXHAUSTED",
        failureClass: "BUDGET_EXHAUSTED",
        fallbackBlockReason: "BUDGET_EXHAUSTED",
      });
    }

    const localReadiness = this.providerReadiness(this.localProvider);
    if (localReadiness) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: localReadiness.failureClass,
        fallbackBlockReason: localReadiness.blockReason,
      });
    }

    const local = await this.runProvider(this.localProvider, request);
    const snapshots = local.snapshot ? [local.snapshot] : [];
    if (local.budgetBlocked) {
      return this.finish(request, identity, {
        status: "BUDGET_EXHAUSTED",
        failureClass: "BUDGET_EXHAUSTED",
        fallbackBlockReason: "BUDGET_EXHAUSTED",
        snapshots,
      });
    }
    if (!local.failureClass && local.observation) {
      return this.finishSuccess(request, identity, local.observation, snapshots, this.localProvider);
    }

    const localFailure = local.failureClass ?? "UNKNOWN_FAILURE";
    const fallbackEligible = FALLBACK_ELIGIBLE_FAILURES.has(localFailure);
    if (!fallbackEligible) {
      return this.finish(request, identity, {
        status: "FAILED",
        failureClass: localFailure,
        fallbackBlockReason: "FAILURE_NOT_ELIGIBLE",
        localFailure,
        snapshots,
      });
    }
    if (!this.policy.allowExternalFallback) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: localFailure,
        fallbackBlockReason: "POLICY_DISABLED",
        localFailure,
        snapshots,
      });
    }
    const fallback = this.fallbackProvider;
    if (!fallback) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: localFailure,
        fallbackBlockReason: "PROVIDER_NOT_CONFIGURED",
        localFailure,
        snapshots,
      });
    }
    if (fallback.kind !== "EXTERNAL") {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: "PROVIDER_CONTRACT_VIOLATION",
        fallbackBlockReason: "PROVIDER_NOT_CONFIGURED",
        localFailure,
        snapshots,
      });
    }
    const fallbackReadiness = this.providerReadiness(fallback);
    if (fallbackReadiness) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: localFailure,
        fallbackBlockReason: fallbackReadiness.blockReason,
        localFailure,
        snapshots,
      });
    }
    const sourceContentType = normalizedContentType(local.observation?.contentType);
    if (localFailure === "UNSUPPORTED_DOCUMENT" && sourceContentType &&
      !fallback.supportsContentType(sourceContentType)) {
      return this.finish(request, identity, {
        status: "BLOCKED",
        failureClass: localFailure,
        fallbackBlockReason: "CONTENT_TYPE_UNSUPPORTED",
        localFailure,
        snapshots,
      });
    }

    const external = await this.runProvider(fallback, request);
    if (external.snapshot) snapshots.push(external.snapshot);
    if (external.budgetBlocked) {
      return this.finish(request, identity, {
        status: "BUDGET_EXHAUSTED",
        failureClass: "BUDGET_EXHAUSTED",
        fallbackBlockReason: "BUDGET_EXHAUSTED",
        localFailure,
        snapshots,
      });
    }
    if (!external.failureClass && external.observation) {
      return this.finishSuccess(request, identity, external.observation, snapshots, fallback, localFailure);
    }
    return this.finish(request, identity, {
      status: "FAILED",
      failureClass: external.failureClass ?? "UNKNOWN_FAILURE",
      fallbackBlockReason: "USED",
      localFailure,
      fallbackUsed: true,
      snapshots,
    });
  }

  private providerReadiness(provider: CrawlProvider): {
    failureClass: CrawlFailureClass;
    blockReason: CrawlFallbackBlockReason;
  } | null {
    if (!provider.enabled) return { failureClass: "PROVIDER_DISABLED", blockReason: "PROVIDER_DISABLED" };
    if (!provider.configured) {
      return { failureClass: "PROVIDER_NOT_CONFIGURED", blockReason: "PROVIDER_NOT_CONFIGURED" };
    }
    if (provider.mode === "LIVE" && !this.policy.allowLiveNetwork) {
      return { failureClass: "PROVIDER_DISABLED", blockReason: "LIVE_NETWORK_DISABLED" };
    }
    return null;
  }

  private async runProvider(provider: CrawlProvider, request: CrawlPageRequest): Promise<ProviderAttemptResult> {
    let estimate: number;
    try {
      estimate = finiteNonNegative(provider.estimateCost(request).costUnits, "provider estimated costUnits");
    } catch {
      return {
        observation: null,
        snapshot: null,
        failureClass: "PROVIDER_CONTRACT_VIOLATION",
        budgetBlocked: false,
      };
    }
    const reservation = this.budget.claimFetch(request.campaignId, request.accountId, estimate);
    if (!reservation) {
      return { observation: null, snapshot: null, failureClass: "BUDGET_EXHAUSTED", budgetBlocked: true };
    }

    const campaignBudget = this.budget.campaignSnapshot(request.campaignId);
    const accountBudget = this.budget.accountSnapshot(request.campaignId, request.accountId);
    const controller = new AbortController();
    const startedAt = Date.now();
    let observation: CrawlPageObservation;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const context: CrawlProviderContext = {
        signal: controller.signal,
        dryRun: provider.mode === "SHADOW",
        remainingCampaignFetchAttempts: campaignBudget.remainingFetchAttempts,
        remainingAccountPages: accountBudget.remainingPages,
        remainingCampaignCostUnits: campaignBudget.remainingProviderCostUnits,
        remainingAccountCostUnits: accountBudget.remainingProviderCostUnits,
      };
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("crawl provider timeout"));
          reject(Object.assign(new Error("crawl provider timeout"), { code: "TIMEOUT" }));
        }, this.policy.timeoutMs);
      });
      observation = await Promise.race([provider.crawlPage(request, context), timeoutPromise]);
    } catch (error) {
      observation = {
        requestedUrl: request.requestedUrl,
        finalUrl: null,
        canonicalUrl: null,
        httpStatus: null,
        robotsStatus: request.robots.status,
        contentType: null,
        content: null,
        elapsedMs: Date.now() - startedAt,
        actualCostUnits: 0,
        timedOut: controller.signal.aborted || /TIMEOUT|ABORT/i.test(String(error)),
        error: {
          code: controller.signal.aborted ? "TIMEOUT" : errorName(error),
        },
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const actualCost = Number.isFinite(observation.actualCostUnits)
      ? Math.max(0, Number(observation.actualCostUnits))
      : estimate;
    this.budget.finalizeFetch(reservation, actualCost);
    let failureClass = this.validateObservation(provider, request, observation);
    if (actualCost > estimate) failureClass = "PROVIDER_CONTRACT_VIOLATION";

    const contentBytes = byteLength(observation.content);
    const safeForHash = contentBytes > 0 && contentBytes <= this.policy.maxContentBytes;
    const contentHash = safeForHash && observation.content
      ? crawlContentHash(observation.content)
      : null;
    const snapshot: CrawlPageSnapshot = {
      runId: request.runId,
      campaignId: request.campaignId,
      accountId: request.accountId,
      providerId: provider.id,
      providerKind: provider.kind,
      requestedUrl: request.requestedUrl,
      finalUrl: observation.finalUrl ?? null,
      canonicalUrl: observation.canonicalUrl ?? null,
      httpStatus: observation.httpStatus ?? null,
      robotsStatus: observation.robotsStatus,
      contentType: normalizedContentType(observation.contentType) || null,
      bytes: Math.max(contentBytes, observation.bytes ?? 0),
      pageType: request.pageType ?? null,
      fetchedAt: this.now().toISOString(),
      elapsedMs: Math.max(0, observation.elapsedMs ?? Date.now() - startedAt),
      contentHash,
      duplicateContent: false,
      costUnits: actualCost,
      failureClass,
      outcome: failureClass ? "FAILURE" : "SUCCESS",
    };
    return { observation, snapshot, failureClass, budgetBlocked: false };
  }

  private validateObservation(
    provider: CrawlProvider,
    request: CrawlPageRequest,
    observation: CrawlPageObservation,
  ): CrawlFailureClass | null {
    let failure: CrawlFailureClass | null;
    try {
      failure = classifyCrawlFailure(observation, (contentType) => provider.supportsContentType(contentType));
      failure ??= provider.classifyFailure(observation);
    } catch {
      return "PROVIDER_CONTRACT_VIOLATION";
    }
    if (failure) return failure;

    const observedRequest = validateCrawlTarget(observation.requestedUrl, {
      expectedOfficialBaseUrl: request.officialBaseUrl,
    });
    const expectedRequest = validateCrawlTarget(request.requestedUrl, {
      resolution: request.resolution,
      expectedOfficialBaseUrl: request.officialBaseUrl,
    });
    if (!observedRequest.ok || !expectedRequest.ok ||
      observedRequest.normalizedUrl !== expectedRequest.normalizedUrl) {
      return "PROVIDER_CONTRACT_VIOLATION";
    }

    const finalUrl = observation.finalUrl ?? request.requestedUrl;
    const finalStatic = validateCrawlTarget(finalUrl, { expectedOfficialBaseUrl: request.officialBaseUrl });
    if (!finalStatic.ok) return finalStatic.failureClass;
    if (finalStatic.hostname !== expectedRequest.hostname) {
      if (!observation.finalResolution) return "DNS_UNRESOLVED";
      const finalResolved = validateCrawlTarget(finalUrl, {
        expectedOfficialBaseUrl: request.officialBaseUrl,
        resolution: observation.finalResolution,
      });
      if (!finalResolved.ok) return finalResolved.failureClass;
    }

    if (observation.canonicalUrl) {
      const canonical = validateCrawlTarget(observation.canonicalUrl, {
        expectedOfficialBaseUrl: request.officialBaseUrl,
      });
      if (!canonical.ok) return canonical.failureClass;
    }

    const contentType = normalizedContentType(observation.contentType);
    if (!this.policy.allowedContentTypes.includes(contentType)) return "UNSUPPORTED_DOCUMENT";
    const actualBytes = byteLength(observation.content);
    if (actualBytes > this.policy.maxContentBytes ||
      (observation.bytes ?? actualBytes) > this.policy.maxContentBytes) return "CONTENT_TOO_LARGE";
    return null;
  }

  private finishSuccess(
    request: CrawlPageRequest,
    identity: { requestHash: string; idempotencyKey: string },
    observation: CrawlPageObservation,
    snapshots: CrawlPageSnapshot[],
    provider: CrawlProvider,
    localFailure: CrawlFailureClass | null = null,
  ): CrawlRouteResult {
    const content = observation.content ?? null;
    if (!content) {
      return this.finish(request, identity, {
        status: "FAILED",
        failureClass: "PARTIAL_CONTENT",
        fallbackBlockReason: localFailure ? "USED" : "FAILURE_NOT_ELIGIBLE",
        localFailure,
        fallbackUsed: Boolean(localFailure),
        snapshots,
      });
    }
    const contentHash = crawlContentHash(content);
    const duplicate = this.processedContentHashes.has(contentHash);
    if (!duplicate) this.processedContentHashes.add(contentHash);
    const finalSnapshot = snapshots.at(-1);
    if (finalSnapshot) {
      finalSnapshot.contentHash = contentHash;
      finalSnapshot.duplicateContent = duplicate;
    }
    return this.finish(request, identity, {
      status: "SUCCEEDED",
      source: provider.kind,
      providerId: provider.id,
      failureClass: null,
      fallbackBlockReason: localFailure ? "USED" : "NOT_NEEDED",
      localFailure,
      fallbackUsed: Boolean(localFailure),
      content,
      contentHash,
      shouldProcess: !duplicate,
      snapshots,
    });
  }

  private finish(
    request: CrawlPageRequest,
    identity: { requestHash: string; idempotencyKey: string },
    partial: {
      status: CrawlRouteStatus;
      source?: "LOCAL" | "EXTERNAL" | null;
      providerId?: string | null;
      failureClass: CrawlFailureClass | null;
      fallbackBlockReason: CrawlFallbackBlockReason;
      localFailure?: CrawlFailureClass | null;
      fallbackUsed?: boolean;
      content?: string | Uint8Array | null;
      contentHash?: string | null;
      shouldProcess?: boolean;
      snapshots?: CrawlPageSnapshot[];
    },
  ): CrawlRouteResult {
    const localFailure = partial.localFailure ?? null;
    const snapshots = partial.snapshots ?? [];
    const result: CrawlRouteResult = {
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
      status: partial.status,
      source: partial.source ?? null,
      providerId: partial.providerId ?? null,
      failureClass: partial.failureClass,
      fallbackEligible: Boolean(localFailure && FALLBACK_ELIGIBLE_FAILURES.has(localFailure)),
      fallbackUsed: partial.fallbackUsed ?? false,
      fallbackBlockReason: partial.fallbackBlockReason,
      content: partial.content ?? null,
      contentHash: partial.contentHash ?? null,
      shouldProcess: partial.shouldProcess ?? false,
      replayed: false,
      snapshots,
    };
    this.audit({
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
      campaignId: request.campaignId,
      accountId: request.accountId,
      runId: request.runId,
      requestedUrlHash: crawlStableHash(request.requestedUrl),
      status: result.status,
      source: result.source,
      providerId: result.providerId,
      localFailureClass: localFailure,
      finalFailureClass: result.failureClass,
      fallbackEligible: result.fallbackEligible,
      fallbackUsed: result.fallbackUsed,
      fallbackBlockReason: result.fallbackBlockReason,
      fetchAttempts: snapshots.length,
      contentHash: result.contentHash,
      duplicateContent: Boolean(result.contentHash && !result.shouldProcess),
      decidedAt: this.now().toISOString(),
    });
    return result;
  }
}

function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    if ("code" in error && (error as { code?: unknown }).code) {
      return String((error as { code: unknown }).code).slice(0, 100);
    }
    if ("name" in error && (error as { name?: unknown }).name) {
      return String((error as { name: unknown }).name).slice(0, 100);
    }
  }
  return "PROVIDER_ERROR";
}
