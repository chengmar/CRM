import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { z } from "zod";
import type { AgentConfig } from "../../config.js";
import { normalizePublicHttpUrl } from "../../http-url.js";
import {
  isSearxngResultRelevant,
  searxngEchoMatches,
} from "../../search/searxng-query-quality.js";
import type { SearchResult } from "../../types.js";
import type { ProviderCost, ProviderHealth } from "../provider-runtime.js";
import {
  ProviderManifestSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  type ProviderAdapterExecution,
  type ProviderManifest,
  type ProviderRequest,
  type ProviderResponse,
  type StrictProviderAdapter,
} from "./contracts.js";

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

const SearxngResultSchema = z.object({
  title: z.unknown().optional(),
  url: z.unknown().optional(),
  content: z.unknown().optional(),
  publishedDate: z.unknown().optional(),
}).passthrough();

const SearxngResponseSchema = z.object({
  query: z.string().max(500).optional(),
  results: z.array(SearxngResultSchema).max(1_000).optional().default([]),
}).passthrough();

export interface SearxngResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type SearxngAddressResolver = (hostname: string) => Promise<SearxngResolvedAddress[]>;

export interface SearxngOfficialAdapterOptions {
  baseUrl: string;
  enabled: boolean;
  allowLoopbackHttp?: boolean;
  fetchImpl?: typeof fetch;
  resolveAddresses?: SearxngAddressResolver;
  now?: () => Date;
  maxResponseBytes?: number;
}

export class SearxngEndpointPolicyError extends Error {
  override readonly name = "SearxngEndpointPolicyError";
}

function networkFailure(error: unknown): Error & {
  networkAttempted: true;
  externalWriteAttempted: false;
} {
  const failure = error instanceof Error ? error : new Error("SearXNG request failed");
  return Object.assign(failure, {
    networkAttempted: true as const,
    externalWriteAttempted: false as const,
  });
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function compact(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  if (isIP(normalized) !== family) return false;
  return family === 4
    ? !unsafeIpv4.check(normalized, "ipv4")
    : !unsafeIpv6.check(normalized, "ipv6");
}

function parseEndpoint(rawBaseUrl: string, allowLoopbackHttp: boolean): {
  url: URL;
  mode: "PUBLIC_HTTPS" | "LOOPBACK_HTTP";
} | null {
  try {
    const url = new URL(rawBaseUrl.trim());
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.username || url.password || url.hash || !hostname) return null;
    const loopback = hostname === "127.0.0.1" || hostname === "::1";
    if (loopback) {
      if (!allowLoopbackHttp || url.protocol !== "http:" || !url.port) return null;
      return { url, mode: "LOOPBACK_HTTP" };
    }
    if (url.protocol !== "https:") return null;
    const literalFamily = isIP(hostname);
    if ((literalFamily === 4 || literalFamily === 6) && !isPublicAddress(hostname, literalFamily)) {
      return null;
    }
    return { url, mode: "PUBLIC_HTTPS" };
  } catch {
    return null;
  }
}

const defaultResolver: SearxngAddressResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((item): SearxngResolvedAddress[] =>
    item.family === 4 || item.family === 6
      ? [{ address: item.address, family: item.family }]
      : []);
};

async function resolvePublicEndpoint(
  endpoint: URL,
  resolver: SearxngAddressResolver,
): Promise<SearxngResolvedAddress[]> {
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literalFamily = isIP(hostname);
  let resolved: SearxngResolvedAddress[];
  try {
    resolved = literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await resolver(hostname);
  } catch {
    throw new SearxngEndpointPolicyError("SearXNG endpoint DNS resolution failed");
  }
  const unique = [...new Map(resolved.map((item) => [
    `${item.family}:${item.address.toLowerCase()}`,
    item,
  ])).values()];
  if (unique.length === 0 || unique.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new SearxngEndpointPolicyError("SearXNG endpoint resolved to a private or reserved address");
  }
  return unique;
}

function pinnedAgent(addresses: SearxngResolvedAddress[]): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : null;
    const eligible = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      callback(Object.assign(new Error("No validated SearXNG address for requested family"), {
        code: "ENOTFOUND",
      }), "", 0);
      return;
    }
    if (options.all) {
      callback(null, eligible.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, eligible[0]!.address, eligible[0]!.family);
  };
  return new Agent({ connect: { lookup } });
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new SearxngEndpointPolicyError("SearXNG response exceeded the configured byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse(await response.text());
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new SearxngEndpointPolicyError("SearXNG response exceeded the configured byte limit");
    }
    chunks.push(next.value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return JSON.parse(body);
}

function resultUrl(raw: unknown): string | null {
  const normalized = normalizePublicHttpUrl(raw);
  if (!normalized) return null;
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if ((family === 4 || family === 6) && !isPublicAddress(hostname, family)) return null;
  return normalized;
}

export class SearxngOfficialAdapter implements StrictProviderAdapter {
  readonly requestSchema = ProviderRequestSchema;
  readonly responseSchema = ProviderResponseSchema;
  readonly manifest: ProviderManifest;
  private readonly endpoint: URL | null;
  private readonly endpointMode: "PUBLIC_HTTPS" | "LOOPBACK_HTTP" | null;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: SearxngAddressResolver;
  private readonly now: () => Date;
  private readonly maxResponseBytes: number;

  constructor(options: SearxngOfficialAdapterOptions) {
    const endpoint = parseEndpoint(options.baseUrl, options.allowLoopbackHttp === true);
    this.endpoint = endpoint?.url ?? null;
    this.endpointMode = endpoint?.mode ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveAddresses = options.resolveAddresses ?? defaultResolver;
    this.now = options.now ?? (() => new Date());
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? 2_000_000, 5_000_000));
    this.manifest = ProviderManifestSchema.parse({
      providerId: "SEARXNG",
      displayName: "SearXNG official JSON API",
      capabilities: ["EVIDENCE_SEARCH"],
      implementationState: "OFFICIAL_API_ADAPTER",
      featureFlag: "ACQ_SEARXNG_V2_ENABLED",
      activation: {
        featureFlagEnabled: options.enabled === true,
        configured: this.endpoint !== null,
        authorization: "CAMPAIGN_SCOPED",
      },
      networkPolicy: "OFFICIAL_API_ONLY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
        prohibitedFields,
        personalEmailAllowed: false,
        phoneAllowed: false,
      },
    });
  }

  async health(): Promise<ProviderHealth> {
    return {
      state: this.endpoint ? "HEALTHY" : "NOT_CONFIGURED",
      checkedAt: this.now().toISOString(),
      detail: this.endpoint
        ? "Configuration is valid; network health is checked only inside an authorized campaign call"
        : "A public HTTPS SearXNG base URL is required",
    };
  }

  estimateCost(_request: ProviderRequest): ProviderCost {
    return { costUnits: 0, usd: 0, currency: "USD" };
  }

  async execute(request: ProviderRequest, signal: AbortSignal): Promise<ProviderAdapterExecution> {
    if (request.operation !== "EVIDENCE_SEARCH") {
      throw new SearxngEndpointPolicyError("SearXNG adapter only supports evidence search");
    }
    if (!this.endpoint) throw new SearxngEndpointPolicyError("SearXNG endpoint is not configured");
    const base = this.endpoint.toString().endsWith("/")
      ? this.endpoint
      : new URL(`${this.endpoint.toString()}/`);
    const endpoint = new URL("search", base);
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("language", "all");
    endpoint.searchParams.set("categories", "general");
    endpoint.searchParams.set("safesearch", "0");
    const addresses = this.endpointMode === "LOOPBACK_HTTP"
      ? [{
          address: endpoint.hostname.replace(/^\[|\]$/g, ""),
          family: isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) as 4 | 6,
        }]
      : await resolvePublicEndpoint(endpoint, this.resolveAddresses);
    const dispatcher = pinnedAgent(addresses);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal,
          dispatcher,
        } as RequestInit & { dispatcher: Agent });
      } catch (error) {
        throw networkFailure(error);
      }
      try {
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SearxngEndpointPolicyError("SearXNG redirects are not allowed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SearXNG returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel();
        throw new SearxngEndpointPolicyError("SearXNG returned a non-JSON response");
      }
      const rawBody = await readBoundedJson(response, this.maxResponseBytes);
      const parsed = SearxngResponseSchema.parse(rawBody);
      if (parsed.query !== undefined && !searxngEchoMatches(request.query, parsed.query)) {
        throw new SearxngEndpointPolicyError("SearXNG did not preserve the complete search query");
      }
      const observedAt = this.now();
      const expiresAt = new Date(observedAt.getTime() + 24 * 60 * 60_000).toISOString();
      const requestHash = sha256({
        accountId: request.accountId,
        query: request.query,
        limit: request.limit,
      });
      const providerRunId = `searxng-${requestHash.slice(0, 48)}`;
      const rawPayloadHash = sha256(rawBody);
      const seen = new Set<string>();
      const assertions = parsed.results.flatMap((item, index) => {
        if (seen.size >= request.limit) return [];
        if (!isSearxngResultRelevant(request.query, item)) return [];
        const sourceUrl = resultUrl(item.url);
        if (!sourceUrl || seen.has(sourceUrl)) return [];
        const title = compact(item.title, 300) || new URL(sourceUrl).hostname;
        const quotedText = compact(item.content, 5_000) || title;
        seen.add(sourceUrl);
        return [{
          assertionId: `searxng-result-${sha256(`${requestHash}:${index}:${sourceUrl}`).slice(0, 40)}`,
          providerId: "SEARXNG" as const,
          providerRunId,
          accountId: request.accountId,
          sourceUri: sourceUrl,
          observedAt: observedAt.toISOString(),
          expiresAt,
          confidence: 0.5,
          rawPayloadHash,
          creditUnits: 0,
          estimatedUsd: 0,
          kind: "EVIDENCE_REFERENCE" as const,
          subject: title,
          sourceUrl,
          quotedText,
          localFetchVerified: false as const,
          evidenceEffect: "REQUIRES_LOCAL_FETCH" as const,
        }];
      });
      const strictResponse = ProviderResponseSchema.parse({
        providerId: "SEARXNG",
        providerRunId,
        operation: request.operation,
        result: assertions.length > 0 ? "ASSERTIONS_RETURNED" : "NO_MATCH",
        assertions,
        rawPayloadHash,
        retryAfterSeconds: null,
      });
      const upstreamRequestId = compact(response.headers.get("x-request-id"), 200) || null;
      return {
        response: strictResponse,
        actualCost: { costUnits: 0, usd: 0, currency: "USD" },
        upstreamRequestId,
        networkAttempted: true,
        externalWriteAttempted: false,
      };
      } catch (error) {
        throw networkFailure(error);
      }
    } finally {
      await dispatcher.close();
    }
  }
}

export function createSearxngOfficialAdapter(
  config: Pick<
    AgentConfig,
    "SEARXNG_BASE_URL" | "ACQ_SEARXNG_V2_ENABLED" | "SEARXNG_LOCAL_ENDPOINT_ALLOWED"
  >,
): SearxngOfficialAdapter {
  return new SearxngOfficialAdapter({
    baseUrl: config.SEARXNG_BASE_URL,
    enabled: config.ACQ_SEARXNG_V2_ENABLED,
    allowLoopbackHttp: config.SEARXNG_LOCAL_ENDPOINT_ALLOWED,
  });
}

export function searxngResponseToSearchResults(
  response: ProviderResponse,
  query: string,
  limit: number,
): SearchResult[] {
  if (response.providerId !== "SEARXNG" || response.operation !== "EVIDENCE_SEARCH") {
    throw new SearxngEndpointPolicyError("Unexpected provider response for SearXNG search projection");
  }
  return response.assertions.flatMap((assertion): SearchResult[] => {
    if (assertion.kind !== "EVIDENCE_REFERENCE") return [];
    return [{
      title: assertion.subject,
      url: assertion.sourceUrl,
      snippet: assertion.quotedText,
      sourceType: "search",
      sourceDate: null,
      query,
    }];
  }).slice(0, Math.max(0, Math.trunc(limit)));
}
