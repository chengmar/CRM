import { createHash } from "node:crypto";
import type { AgentConfig } from "../config.js";
import { normalizePublicHttpUrl } from "../http-url.js";
import { getDomain } from "tldts";
import type { EmailVerificationResult } from "./email-verifier.js";

export interface EnrichedContactEmail {
  email: string;
  confidence: number;
  verificationStatus: string;
  evidence: string;
  sourceUris?: string[];
}

const supportedVerificationStatuses = new Set([
  "valid",
  "invalid",
  "accept_all",
  "disposable",
  "risky",
  "unknown",
  "webmail",
]);
const transientHunterStatuses = new Set([500, 502, 503, 504]);
const hunterCacheTtlMs = 5 * 60_000;
const hunterCacheMaxEntries = 1_000;
const hunterMaxRetries = 3;
const hunterRetryBaseDelayMs = 100;
const hunterRetryDelayCapMs = 2_000;

interface HunterCacheEntry {
  promise: Promise<EnrichedContactEmail | null>;
  expiresAt: number;
}

const hunterCache = new Map<string, HunterCacheEntry>();

function normalizedDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^www\./, "");
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

function cloneContact(result: EnrichedContactEmail | null): EnrichedContactEmail | null {
  return result
    ? { ...result, sourceUris: result.sourceUris ? [...result.sourceUris] : undefined }
    : null;
}

function pruneHunterCache(now: number): void {
  for (const [key, entry] of hunterCache) {
    if (entry.expiresAt !== Number.POSITIVE_INFINITY && entry.expiresAt <= now) {
      hunterCache.delete(key);
    }
  }
  while (hunterCache.size >= hunterCacheMaxEntries) {
    const oldestKey = hunterCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    hunterCache.delete(oldestKey);
  }
}

async function cachedHunterLookup(
  key: string,
  lookup: () => Promise<EnrichedContactEmail | null>,
): Promise<EnrichedContactEmail | null> {
  const now = Date.now();
  const cached = hunterCache.get(key);
  if (cached && cached.expiresAt > now) {
    hunterCache.delete(key);
    hunterCache.set(key, cached);
    return cloneContact(await cached.promise);
  }
  if (cached) hunterCache.delete(key);
  pruneHunterCache(now);

  const entry: HunterCacheEntry = {
    promise: Promise.resolve().then(lookup),
    expiresAt: Number.POSITIVE_INFINITY,
  };
  hunterCache.set(key, entry);
  try {
    const result = await entry.promise;
    entry.expiresAt = Date.now() + hunterCacheTtlMs;
    return cloneContact(result);
  } catch (error) {
    if (hunterCache.get(key) === entry) hunterCache.delete(key);
    throw error;
  }
}

function hunterCredentialIdentity(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
}

function hunterCacheKey(
  operation: "finder" | "verifier",
  config: AgentConfig,
  requestIdentity: string,
): string {
  const parsedBaseUrl = new URL(config.HUNTER_BASE_URL.trim());
  const baseUrl = `${parsedBaseUrl.protocol.toLowerCase()}//${parsedBaseUrl.host.toLowerCase()}${parsedBaseUrl.pathname.replace(/\/+$/, "")}${parsedBaseUrl.search}`;
  return [operation, baseUrl, hunterCredentialIdentity(config.HUNTER_API_KEY.trim()), requestIdentity].join("|");
}

function retryAfterMs(response: Response, retryIndex: number): { delayMs: number; exceedsCap: boolean } {
  const header = response.headers.get("retry-after")?.trim();
  let requestedDelay: number | null = null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      requestedDelay = seconds * 1_000;
    } else {
      const retryAt = Date.parse(header);
      if (Number.isFinite(retryAt)) requestedDelay = Math.max(0, retryAt - Date.now());
    }
  }
  const fallbackDelay = hunterRetryBaseDelayMs * (2 ** retryIndex);
  return {
    delayMs: Math.min(requestedDelay ?? fallbackDelay, hunterRetryDelayCapMs),
    exceedsCap: requestedDelay !== null && requestedDelay > hunterRetryDelayCapMs,
  };
}

async function waitBeforeRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed error-body cleanup must not mask the provider status.
  }
}

async function fetchHunter(endpoint: URL, operation: string): Promise<Response> {
  for (let retryIndex = 0; retryIndex <= hunterMaxRetries; retryIndex += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
    } catch {
      if (retryIndex >= hunterMaxRetries) {
        throw new Error(`${operation} request failed after ${retryIndex + 1} attempts`);
      }
      await waitBeforeRetry(Math.min(hunterRetryBaseDelayMs * (2 ** retryIndex), hunterRetryDelayCapMs));
      continue;
    }

    if (response.ok) return response;
    const retryable = response.status === 429 || transientHunterStatuses.has(response.status);
    if (!retryable || retryIndex >= hunterMaxRetries) {
      await discardResponse(response);
      throw new Error(`${operation} returned HTTP ${response.status}`);
    }
    const retry = retryAfterMs(response, retryIndex);
    await discardResponse(response);
    if (retry.exceedsCap) {
      throw new Error(`${operation} rate limited beyond the local retry window`);
    }
    await waitBeforeRetry(retry.delayMs);
  }
  throw new Error(`${operation} request failed`);
}

function sourceUris(sources: Array<{ uri?: string | null }> | undefined): string[] {
  const uris = new Set<string>();
  for (const source of sources ?? []) {
    const uri = String(source.uri ?? "").trim();
    if (!uri) continue;
    const normalized = normalizePublicHttpUrl(uri);
    if (normalized) uris.add(normalized);
    if (uris.size >= 10) break;
  }
  return [...uris];
}

function evidenceWithSources(summary: string, uris: string[]): string {
  return uris.length > 0
    ? `${summary}; public sources ${uris.length}: ${uris.join(", ")}`
    : `${summary}; public sources 0`;
}

export function reconcileHunterVerification(
  verification: EmailVerificationResult,
  hunter: EnrichedContactEmail,
): EmailVerificationResult {
  const providerStatus = hunter.verificationStatus.toLowerCase();
  const providerEvidence = hunter.evidence.trim();
  const combinedReason = [verification.reason, providerEvidence].filter(Boolean).join("; ");

  if (verification.email.trim().toLowerCase() !== hunter.email.trim().toLowerCase()) {
    return { ...verification, reason: `${combinedReason}; provider result ignored for a different mailbox` };
  }

  if (providerStatus === "invalid" || providerStatus === "disposable") {
    return {
      ...verification,
      status: "INVALID",
      disposableAddress: verification.disposableAddress || providerStatus === "disposable",
      reason: combinedReason,
    };
  }
  if (verification.status === "INVALID" || verification.status === "UNKNOWN") {
    return { ...verification, reason: `${combinedReason}; provider result did not override ${verification.status}` };
  }
  if (providerStatus === "risky" || providerStatus === "webmail") {
    return { ...verification, status: "RISKY", reason: combinedReason };
  }
  if (providerStatus === "accept_all") {
    return {
      ...verification,
      status: "RISKY",
      catchAll: true,
      reason: `${combinedReason}; accept-all domain`,
    };
  }
  if (providerStatus === "valid") {
    const localBlockers = [
      verification.catchAll ? "catch-all" : "",
      verification.roleAddress ? "role" : "",
      verification.disposableAddress ? "disposable" : "",
    ].filter(Boolean);
    if (localBlockers.length > 0) {
      return {
        ...verification,
        status: verification.disposableAddress
          ? "INVALID"
          : verification.catchAll && verification.status === "VALID"
            ? "RISKY"
            : verification.status,
        reason: `${combinedReason}; provider result did not override local ${localBlockers.join("/")} gate`,
      };
    }
    return { ...verification, status: "VALID", reason: combinedReason };
  }
  return { ...verification, reason: combinedReason };
}

export async function verifyHunterEmail(
  rawEmail: string,
  config: AgentConfig,
): Promise<EnrichedContactEmail | null> {
  const email = rawEmail.trim().toLowerCase();
  const apiKey = config.HUNTER_API_KEY.trim();
  if (!apiKey || !email) return null;
  const endpoint = new URL("email-verifier", `${config.HUNTER_BASE_URL.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("email", email);
  endpoint.searchParams.set("api_key", apiKey);
  const cacheKey = hunterCacheKey("verifier", config, email);
  return cachedHunterLookup(cacheKey, async () => {
    const response = await fetchHunter(endpoint, "Hunter Email Verifier");
    const body = await response.json() as {
      data?: {
        email?: string | null;
        status?: string | null;
        score?: number | null;
        accept_all?: boolean | null;
        disposable?: boolean | null;
        sources?: Array<{ uri?: string | null }>;
      };
    };
    const data = body.data;
    if (!data) return null;
    const providerEmail = String(data.email ?? "").trim().toLowerCase();
    if (!providerEmail || providerEmail !== email) return null;
    const rawStatus = String(data.status ?? "unknown").toLowerCase();
    const verificationStatus = data.disposable
      ? "disposable"
      : data.accept_all || rawStatus === "accept_all"
        ? "accept_all"
        : rawStatus;
    if (!supportedVerificationStatuses.has(verificationStatus)) return null;
    const rawConfidence = Number(data.score ?? 0);
    const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
    const publicSourceUris = sourceUris(data.sources);
    return {
      email,
      confidence,
      verificationStatus,
      evidence: evidenceWithSources(
        `Hunter verifier ${verificationStatus}; score ${confidence}`,
        publicSourceUris,
      ),
      sourceUris: publicSourceUris,
    };
  });
}

export async function findHunterEmail(
  name: string,
  domain: string,
  config: AgentConfig,
): Promise<EnrichedContactEmail | null> {
  const apiKey = config.HUNTER_API_KEY.trim();
  const normalizedName = name.trim();
  const requestedDomain = domain.trim().toLowerCase();
  if (!apiKey || !normalizedName || !requestedDomain) return null;
  const endpoint = new URL("email-finder", `${config.HUNTER_BASE_URL.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("domain", requestedDomain);
  endpoint.searchParams.set("full_name", normalizedName);
  endpoint.searchParams.set("api_key", apiKey);
  const requestIdentity = [
    normalizedName.toLowerCase().replace(/\s+/g, " "),
    requestedDomain,
    String(config.HUNTER_MIN_CONFIDENCE),
  ].join("|");
  const cacheKey = hunterCacheKey("finder", config, requestIdentity);
  return cachedHunterLookup(cacheKey, async () => {
    const response = await fetchHunter(endpoint, "Hunter Email Finder");
    const body = await response.json() as {
      data?: {
        email?: string | null;
        score?: number | null;
        verification?: { status?: string | null } | null;
        sources?: Array<{ uri?: string | null }>;
      };
      errors?: Array<{ details?: string }>;
    };
    const email = String(body.data?.email ?? "").trim().toLowerCase();
    const confidence = Number(body.data?.score ?? 0);
    const verificationStatus = String(body.data?.verification?.status ?? "unknown").toLowerCase();
    if (!email || !Number.isFinite(confidence) || confidence < config.HUNTER_MIN_CONFIDENCE) return null;
    const emailDomain = email.split("@").at(-1) ?? "";
    if (!emailDomain || normalizedDomain(emailDomain) !== normalizedDomain(requestedDomain)) return null;
    if (!new Set(["valid", "accept_all"]).has(verificationStatus)) return null;
    const publicSourceUris = sourceUris(body.data?.sources);
    return {
      email,
      confidence,
      verificationStatus,
      evidence: evidenceWithSources(
        `Hunter finder confidence ${confidence}; verifier ${verificationStatus}`,
        publicSourceUris,
      ),
      sourceUris: publicSourceUris,
    };
  });
}
