export type CrawlProviderKind = "LOCAL" | "EXTERNAL";
export type CrawlProviderMode = "SHADOW" | "LIVE";
export type CrawlRobotsStatus = "ALLOWED" | "DISALLOWED" | "UNKNOWN" | "CHECK_FAILED";

export type CrawlFailureClass =
  | "INVALID_URL"
  | "UNSAFE_TARGET"
  | "DNS_UNRESOLVED"
  | "CROSS_DOMAIN"
  | "ROBOTS_DENIED"
  | "ROBOTS_UNVERIFIED"
  | "RATE_LIMITED"
  | "ACCESS_BLOCKED"
  | "TIMEOUT"
  | "JS_REQUIRED"
  | "PARTIAL_CONTENT"
  | "UNSUPPORTED_DOCUMENT"
  | "STRUCTURE_UNRECOVERABLE"
  | "CONTENT_TOO_LARGE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_CONTRACT_VIOLATION"
  | "BUDGET_EXHAUSTED"
  | "UNKNOWN_FAILURE";

export const FALLBACK_ELIGIBLE_FAILURES: ReadonlySet<CrawlFailureClass> = new Set([
  "JS_REQUIRED",
  "PARTIAL_CONTENT",
  "ACCESS_BLOCKED",
  "UNSUPPORTED_DOCUMENT",
  "STRUCTURE_UNRECOVERABLE",
]);

export interface CrawlResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface CrawlResolutionEvidence {
  hostname: string;
  addresses: CrawlResolvedAddress[];
  checkedAt: string;
}

export interface CrawlRobotsDecision {
  status: CrawlRobotsStatus;
  checkedUrl: string;
  checkedAt: string;
}

export interface CrawlPageRequest {
  campaignId: string;
  accountId: string;
  runId: string;
  requestedUrl: string;
  officialBaseUrl: string;
  pageType?: string;
  maxPages?: number;
  robots: CrawlRobotsDecision;
  resolution: CrawlResolutionEvidence;
}

export interface CrawlAccountRequest {
  campaignId: string;
  accountId: string;
  runId: string;
  officialBaseUrl: string;
  pages: CrawlPageRequest[];
}

export interface CrawlProviderCostEstimate {
  costUnits: number;
}

export interface CrawlProviderContext {
  signal: AbortSignal;
  dryRun: boolean;
  remainingCampaignFetchAttempts: number;
  remainingAccountPages: number;
  remainingCampaignCostUnits: number;
  remainingAccountCostUnits: number;
}

export interface CrawlErrorObservation {
  code: string;
  message?: string;
}

export interface CrawlPageObservation {
  requestedUrl: string;
  finalUrl?: string | null;
  canonicalUrl?: string | null;
  httpStatus?: number | null;
  robotsStatus: CrawlRobotsStatus;
  contentType?: string | null;
  content?: string | Uint8Array | null;
  bytes?: number | null;
  elapsedMs?: number | null;
  actualCostUnits?: number | null;
  truncated?: boolean;
  structureRecovered?: boolean;
  timedOut?: boolean;
  error?: CrawlErrorObservation | null;
  finalResolution?: CrawlResolutionEvidence | null;
}

export interface CrawlAccountObservation {
  pages: CrawlPageObservation[];
  cursor?: string | null;
}

export interface CrawlProvider {
  readonly id: string;
  readonly kind: CrawlProviderKind;
  readonly mode: CrawlProviderMode;
  readonly enabled: boolean;
  readonly configured: boolean;
  crawlAccount(
    request: CrawlAccountRequest,
    context: CrawlProviderContext,
  ): Promise<CrawlAccountObservation>;
  crawlPage(
    request: CrawlPageRequest,
    context: CrawlProviderContext,
  ): Promise<CrawlPageObservation>;
  classifyFailure(observation: CrawlPageObservation): CrawlFailureClass | null;
  estimateCost(request: CrawlPageRequest | CrawlAccountRequest): CrawlProviderCostEstimate;
  supportsContentType(contentType: string): boolean;
}

export interface CrawlPageSnapshot {
  runId: string;
  campaignId: string;
  accountId: string;
  providerId: string;
  providerKind: CrawlProviderKind;
  requestedUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  httpStatus: number | null;
  robotsStatus: CrawlRobotsStatus;
  contentType: string | null;
  bytes: number;
  pageType: string | null;
  fetchedAt: string;
  elapsedMs: number;
  contentHash: string | null;
  duplicateContent: boolean;
  costUnits: number;
  failureClass: CrawlFailureClass | null;
  outcome: "SUCCESS" | "FAILURE";
}

export type CrawlFallbackBlockReason =
  | "NOT_NEEDED"
  | "USED"
  | "FAILURE_NOT_ELIGIBLE"
  | "POLICY_DISABLED"
  | "LIVE_NETWORK_DISABLED"
  | "PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "CONTENT_TYPE_UNSUPPORTED"
  | "BUDGET_EXHAUSTED";

export type CrawlRouteStatus = "SUCCEEDED" | "FAILED" | "BLOCKED" | "BUDGET_EXHAUSTED";

export interface CrawlRouteResult {
  idempotencyKey: string;
  requestHash: string;
  status: CrawlRouteStatus;
  source: CrawlProviderKind | null;
  providerId: string | null;
  failureClass: CrawlFailureClass | null;
  fallbackEligible: boolean;
  fallbackUsed: boolean;
  fallbackBlockReason: CrawlFallbackBlockReason;
  content: string | Uint8Array | null;
  contentHash: string | null;
  shouldProcess: boolean;
  replayed: boolean;
  snapshots: CrawlPageSnapshot[];
}

export interface CrawlDecisionAudit {
  idempotencyKey: string;
  requestHash: string;
  campaignId: string;
  accountId: string;
  runId: string;
  requestedUrlHash: string;
  status: CrawlRouteStatus | "REPLAYED";
  source: CrawlProviderKind | null;
  providerId: string | null;
  localFailureClass: CrawlFailureClass | null;
  finalFailureClass: CrawlFailureClass | null;
  fallbackEligible: boolean;
  fallbackUsed: boolean;
  fallbackBlockReason: CrawlFallbackBlockReason;
  fetchAttempts: number;
  contentHash: string | null;
  duplicateContent: boolean;
  decidedAt: string;
}

export interface CrawlBudgetLimits {
  maxPagesPerCampaign: number;
  maxPagesPerAccount: number;
  maxFetchAttemptsPerCampaign: number;
  maxProviderCostUnitsPerCampaign: number;
  maxProviderCostUnitsPerAccount: number;
}

export interface CrawlBudgetSnapshot {
  campaignId: string;
  accountId?: string;
  pages: number;
  fetchAttempts: number;
  providerCostUnits: number;
  remainingPages: number;
  remainingFetchAttempts: number;
  remainingProviderCostUnits: number;
}
