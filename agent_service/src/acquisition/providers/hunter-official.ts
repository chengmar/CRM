import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { getDomain } from "tldts";
import { Agent } from "undici";
import { z } from "zod";
import type { ProviderCost, ProviderHealth } from "../provider-runtime.js";
import {
  EmailVerificationRequestSchema,
  ProviderCostSchema,
  ProviderManifestSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  WorkEmailDiscoveryRequestSchema,
  WorkEmailSchema,
  type ProviderAdapterExecution,
  type ProviderManifest,
  type ProviderRequest,
  type StrictProviderAdapter,
} from "./contracts.js";

export const HUNTER_OFFICIAL_BASE_URL = "https://api.hunter.io/v2/";

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

const HunterMailboxStatusSchema = z.enum([
  "valid",
  "invalid",
  "accept_all",
  "disposable",
  "risky",
  "unknown",
  "webmail",
  "blocked",
]);

const NullableBooleanSchema = z.boolean().nullable().optional();
const NullableStatusSchema = HunterMailboxStatusSchema.nullable().optional();

const HunterFinderApiResponseSchema = z.object({
  data: z.object({
    email: z.string().trim().max(320).nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(),
    score: z.number().finite().min(0).max(100).nullable().optional(),
    accept_all: NullableBooleanSchema,
    disposable: NullableBooleanSchema,
    verification: z.object({
      status: NullableStatusSchema,
    }).nullable().optional(),
  }).nullable(),
});

const HunterVerifierApiResponseSchema = z.object({
  data: z.object({
    email: z.string().trim().max(320).nullable().optional(),
    status: NullableStatusSchema,
    score: z.number().finite().min(0).max(100).nullable().optional(),
    accept_all: NullableBooleanSchema,
    disposable: NullableBooleanSchema,
    webmail: NullableBooleanSchema,
    block: NullableBooleanSchema,
  }).nullable(),
});

type HunterOperation = "WORK_EMAIL_DISCOVERY" | "EMAIL_VERIFICATION";
type HunterCostByOperation = Record<HunterOperation, ProviderCost>;

export interface HunterResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HunterAddressResolver = (hostname: string) => Promise<HunterResolvedAddress[]>;

export interface HunterOfficialAdapterOptions {
  enabled: boolean;
  apiKey: string;
  minFinderConfidence?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  assertionTtlMs?: number;
  costByOperation?: Partial<HunterCostByOperation>;
  fetchImpl?: typeof fetch;
  resolveAddresses?: HunterAddressResolver;
  now?: () => Date;
}

export class HunterOfficialAdapterError extends Error {
  override readonly name: string = "HunterOfficialAdapterError";
}

export class HunterRateLimitError extends HunterOfficialAdapterError {
  override readonly name = "HunterRateLimitError";

  constructor(readonly retryAfterSeconds: number | null) {
    super("Hunter official API rate limit reached");
  }
}

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

const roleMailboxLocalParts = new Set([
  "admin",
  "billing",
  "contact",
  "customerservice",
  "hello",
  "help",
  "info",
  "inquiries",
  "inquiry",
  "marketing",
  "office",
  "orders",
  "sales",
  "service",
  "support",
  "team",
]);

const defaultResolver: HunterAddressResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((item): HunterResolvedAddress[] =>
    item.family === 4 || item.family === 6
      ? [{ address: item.address, family: item.family }]
      : []);
};

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  if (isIP(normalized) !== family) return false;
  return family === 4
    ? !unsafeIpv4.check(normalized, "ipv4")
    : !unsafeIpv6.check(normalized, "ipv6");
}

async function resolveOfficialEndpoint(resolver: HunterAddressResolver): Promise<HunterResolvedAddress[]> {
  const hostname = new URL(HUNTER_OFFICIAL_BASE_URL).hostname;
  let resolved: HunterResolvedAddress[];
  try {
    resolved = await resolver(hostname);
  } catch {
    throw new HunterOfficialAdapterError("Hunter official endpoint DNS resolution failed");
  }
  const unique = [...new Map(resolved.map((item) => [
    `${item.family}:${item.address.toLowerCase()}`,
    item,
  ])).values()];
  if (unique.length === 0 || unique.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new HunterOfficialAdapterError("Hunter official endpoint resolved to an unsafe address");
  }
  return unique;
}

function pinnedAgent(addresses: HunterResolvedAddress[]): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : null;
    const eligible = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      callback(Object.assign(new Error("No validated Hunter address for requested family"), {
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
    throw new HunterOfficialAdapterError("Hunter response exceeded the configured byte limit");
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
      throw new HunterOfficialAdapterError("Hunter response exceeded the configured byte limit");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(86_400, Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000)));
}

function registeredEmailDomain(email: string): string | null {
  const domain = email.split("@").at(-1)?.toLowerCase().replace(/\.$/, "") ?? "";
  return getDomain(domain, { allowPrivateDomains: false }) ?? null;
}

function isRoleMailbox(email: string): boolean {
  const localPart = email.split("@", 1)[0]?.toLowerCase().split("+", 1)[0] ?? "";
  return roleMailboxLocalParts.has(localPart);
}

function normalizedEmail(value: string | null | undefined): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return WorkEmailSchema.safeParse(email).success ? email : null;
}

function safeUpstreamRequestId(response: Response): string | null {
  const raw = response.headers.get("x-request-id")?.trim();
  return raw ? `hunter-${sha256(raw).slice(0, 40)}` : null;
}

function safeCost(value: ProviderCost | undefined, fallback: ProviderCost): ProviderCost {
  return ProviderCostSchema.parse(value ?? fallback);
}

function requestFingerprint(request: z.infer<typeof WorkEmailDiscoveryRequestSchema> | z.infer<typeof EmailVerificationRequestSchema>): string {
  if (request.operation === "WORK_EMAIL_DISCOVERY") {
    return sha256({
      operation: request.operation,
      accountId: request.accountId,
      canonicalDomain: request.canonicalDomain,
      personRef: request.person.personRef,
      fullNameHash: sha256(request.person.fullName.trim().toLowerCase()),
    });
  }
  return sha256({
    operation: request.operation,
    accountId: request.accountId,
    personRef: request.personRef,
    emailHash: sha256(request.email),
    discoveryAssertionId: request.discoveryAssertionId,
    discoveryProviderId: request.discoveryProviderId,
  });
}

export class HunterOfficialAdapter implements StrictProviderAdapter {
  readonly requestSchema = ProviderRequestSchema;
  readonly responseSchema = ProviderResponseSchema;
  readonly manifest: ProviderManifest;
  readonly recommendedCacheTtlMs = 0;
  private readonly enabled: boolean;
  private readonly apiKey: string;
  private readonly minFinderConfidence: number;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly assertionTtlMs: number;
  private readonly costByOperation: HunterCostByOperation;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: HunterAddressResolver;
  private readonly now: () => Date;

  constructor(options: HunterOfficialAdapterOptions) {
    this.enabled = options.enabled === true;
    this.apiKey = options.apiKey.trim();
    this.minFinderConfidence = Math.max(0, Math.min(100, options.minFinderConfidence ?? 80));
    this.requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 20_000, 60_000));
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? 1_000_000, 5_000_000));
    this.assertionTtlMs = Math.max(60_000, Math.min(options.assertionTtlMs ?? 30 * 24 * 60 * 60_000, 90 * 24 * 60 * 60_000));
    this.costByOperation = {
      WORK_EMAIL_DISCOVERY: safeCost(options.costByOperation?.WORK_EMAIL_DISCOVERY, {
        costUnits: 1,
        usd: 0,
        currency: "USD",
      }),
      EMAIL_VERIFICATION: safeCost(options.costByOperation?.EMAIL_VERIFICATION, {
        costUnits: 1,
        usd: 0,
        currency: "USD",
      }),
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveAddresses = options.resolveAddresses ?? defaultResolver;
    this.now = options.now ?? (() => new Date());
    this.manifest = ProviderManifestSchema.parse({
      providerId: "HUNTER",
      displayName: "Hunter official Email Finder and Verifier API",
      capabilities: ["WORK_EMAIL_DISCOVERY", "EMAIL_VERIFICATION"],
      implementationState: "OFFICIAL_API_ADAPTER",
      featureFlag: "ACQ_HUNTER_V2_ENABLED",
      activation: {
        featureFlagEnabled: this.enabled,
        configured: this.apiKey.length > 0,
        authorization: "CAMPAIGN_SCOPED",
      },
      networkPolicy: "OFFICIAL_API_ONLY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: ["PUBLIC_PERSON_IDENTITY", "B2B_WORK_EMAIL", "HASHED_EMAIL"],
        prohibitedFields,
        personalEmailAllowed: false,
        phoneAllowed: false,
      },
    });
  }

  async health(): Promise<ProviderHealth> {
    if (!this.enabled) {
      return {
        state: "DISABLED",
        checkedAt: this.now().toISOString(),
        detail: "Hunter feature flag is disabled",
      };
    }
    if (!this.apiKey) {
      return {
        state: "NOT_CONFIGURED",
        checkedAt: this.now().toISOString(),
        detail: "Hunter API credential is not configured",
      };
    }
    return {
      state: "HEALTHY",
      checkedAt: this.now().toISOString(),
      detail: "Configuration is valid; health is checked only during an authorized campaign call",
    };
  }

  estimateCost(request: ProviderRequest): ProviderCost {
    if (request.operation === "WORK_EMAIL_DISCOVERY" || request.operation === "EMAIL_VERIFICATION") {
      return this.costByOperation[request.operation];
    }
    return { costUnits: 0, usd: 0, currency: "USD" };
  }

  async execute(request: ProviderRequest, signal: AbortSignal): Promise<ProviderAdapterExecution> {
    if (!this.enabled || !this.apiKey) {
      throw new HunterOfficialAdapterError("Hunter feature flag and API credential are both required");
    }
    if (request.operation === "WORK_EMAIL_DISCOVERY") {
      return this.executeFinder(WorkEmailDiscoveryRequestSchema.parse(request), signal);
    }
    if (request.operation === "EMAIL_VERIFICATION") {
      const verifiedRequest = EmailVerificationRequestSchema.parse(request);
      if (verifiedRequest.discoveryProviderId === "HUNTER") {
        throw new HunterOfficialAdapterError("Hunter cannot independently verify its own discovery assertion");
      }
      return this.executeVerifier(verifiedRequest, signal);
    }
    throw new HunterOfficialAdapterError("Hunter supports only work-email discovery and verification");
  }

  private async executeFinder(
    request: z.infer<typeof WorkEmailDiscoveryRequestSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAdapterExecution> {
    const endpoint = new URL("email-finder", HUNTER_OFFICIAL_BASE_URL);
    endpoint.searchParams.set("domain", request.canonicalDomain);
    endpoint.searchParams.set("full_name", request.person.fullName);
    endpoint.searchParams.set("api_key", this.apiKey);
    const raw = await this.fetchJson(endpoint, signal);
    const parsed = HunterFinderApiResponseSchema.parse(raw.body);
    const rawPayloadHash = sha256(raw.body);
    const email = normalizedEmail(parsed.data?.email);
    const providerDomain = parsed.data?.domain
      ? getDomain(parsed.data.domain.toLowerCase(), { allowPrivateDomains: false })
      : request.canonicalDomain;
    const status = parsed.data?.verification?.status ?? "unknown";
    const catchAll = parsed.data?.accept_all === true || status === "accept_all";
    const disposable = parsed.data?.disposable === true || status === "disposable";
    const score = parsed.data?.score ?? 0;
    const allowed = email !== null
      && registeredEmailDomain(email) === request.canonicalDomain
      && providerDomain === request.canonicalDomain
      && !isRoleMailbox(email)
      && !catchAll
      && !disposable
      && status !== "webmail"
      && status !== "invalid"
      && status !== "blocked"
      && score >= this.minFinderConfidence;
    const response = allowed
      ? this.discoveryResponse(request, email, score, status, rawPayloadHash)
      : this.emptyResponse(request, rawPayloadHash);
    return {
      response,
      actualCost: this.costByOperation.WORK_EMAIL_DISCOVERY,
      upstreamRequestId: raw.upstreamRequestId,
      networkAttempted: true,
      externalWriteAttempted: false,
    };
  }

  private async executeVerifier(
    request: z.infer<typeof EmailVerificationRequestSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAdapterExecution> {
    const endpoint = new URL("email-verifier", HUNTER_OFFICIAL_BASE_URL);
    endpoint.searchParams.set("email", request.email);
    endpoint.searchParams.set("api_key", this.apiKey);
    const raw = await this.fetchJson(endpoint, signal);
    const parsed = HunterVerifierApiResponseSchema.parse(raw.body);
    const rawPayloadHash = sha256(raw.body);
    const email = normalizedEmail(parsed.data?.email);
    if (
      !email ||
      email !== request.email ||
      registeredEmailDomain(email) !== request.expectedDomain
    ) {
      return {
        response: this.emptyResponse(request, rawPayloadHash),
        actualCost: this.costByOperation.EMAIL_VERIFICATION,
        upstreamRequestId: raw.upstreamRequestId,
        networkAttempted: true,
        externalWriteAttempted: false,
      };
    }
    const status = parsed.data?.status ?? "unknown";
    const catchAll = parsed.data?.accept_all === true || status === "accept_all";
    const disposable = parsed.data?.disposable === true || status === "disposable";
    const roleMailbox = isRoleMailbox(email);
    let providerMailboxVerdict: "VALID_ASSERTION" | "INVALID_ASSERTION" | "RISKY_ASSERTION" | "UNKNOWN_ASSERTION";
    if (disposable || status === "invalid" || status === "blocked" || parsed.data?.block === true) {
      providerMailboxVerdict = "INVALID_ASSERTION";
    } else if (catchAll || roleMailbox || status === "risky" || status === "webmail" || parsed.data?.webmail === true) {
      providerMailboxVerdict = "RISKY_ASSERTION";
    } else if (
      status === "valid" &&
      parsed.data?.accept_all === false &&
      parsed.data?.disposable === false
    ) {
      providerMailboxVerdict = "VALID_ASSERTION";
    } else {
      providerMailboxVerdict = "UNKNOWN_ASSERTION";
    }
    const observedAt = this.now();
    const fingerprint = requestFingerprint(request);
    const providerRunId = `hunter-verify-${fingerprint.slice(0, 40)}`;
    const cost = this.costByOperation.EMAIL_VERIFICATION;
    const response = ProviderResponseSchema.parse({
      providerId: "HUNTER",
      providerRunId,
      operation: request.operation,
      result: "ASSERTIONS_RETURNED",
      assertions: [{
        assertionId: `hunter-verification-${sha256(
          `${fingerprint}:${rawPayloadHash}:${observedAt.toISOString()}`,
        ).slice(0, 40)}`,
        providerId: "HUNTER",
        providerRunId,
        accountId: request.accountId,
        sourceUri: "https://hunter.io/email-verifier",
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + this.assertionTtlMs).toISOString(),
        confidence: (parsed.data?.score ?? 0) / 100,
        rawPayloadHash,
        creditUnits: cost.costUnits,
        estimatedUsd: cost.usd,
        kind: "EMAIL_VERIFICATION",
        personRef: request.personRef,
        emailHash: sha256(email),
        discoveryAssertionId: request.discoveryAssertionId,
        discoveryProviderId: request.discoveryProviderId,
        verificationProviderId: "HUNTER",
        providerMailboxVerdict,
        catchAll,
        disposable,
        roleMailbox,
        localMailboxVerdict: "UNCHANGED",
      }],
      rawPayloadHash,
      retryAfterSeconds: null,
    });
    return {
      response,
      actualCost: cost,
      upstreamRequestId: raw.upstreamRequestId,
      networkAttempted: true,
      externalWriteAttempted: false,
    };
  }

  private discoveryResponse(
    request: z.infer<typeof WorkEmailDiscoveryRequestSchema>,
    email: string,
    score: number,
    status: z.infer<typeof HunterMailboxStatusSchema>,
    rawPayloadHash: string,
  ) {
    const observedAt = this.now();
    const fingerprint = requestFingerprint(request);
    const providerRunId = `hunter-find-${fingerprint.slice(0, 40)}`;
    const cost = this.costByOperation.WORK_EMAIL_DISCOVERY;
    return ProviderResponseSchema.parse({
      providerId: "HUNTER",
      providerRunId,
      operation: request.operation,
      result: "ASSERTIONS_RETURNED",
      assertions: [{
        assertionId: `hunter-discovery-${sha256(`${fingerprint}:${rawPayloadHash}`).slice(0, 40)}`,
        providerId: "HUNTER",
        providerRunId,
        accountId: request.accountId,
        sourceUri: "https://hunter.io/email-finder",
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + this.assertionTtlMs).toISOString(),
        confidence: score / 100,
        rawPayloadHash,
        creditUnits: cost.costUnits,
        estimatedUsd: cost.usd,
        kind: "EMAIL_DISCOVERY",
        personRef: request.person.personRef,
        email,
        emailDomain: request.canonicalDomain,
        emailType: "WORK",
        providerStatus: status === "valid"
          ? "PROVIDER_VALID_ASSERTION"
          : status === "risky"
            ? "PROVIDER_RISKY_ASSERTION"
            : "PROVIDER_UNKNOWN",
        localMailboxVerdict: "NOT_VERIFIED",
      }],
      rawPayloadHash,
      retryAfterSeconds: null,
    });
  }

  private emptyResponse(
    request: z.infer<typeof WorkEmailDiscoveryRequestSchema> | z.infer<typeof EmailVerificationRequestSchema>,
    rawPayloadHash: string,
  ) {
    const operationTag = request.operation === "WORK_EMAIL_DISCOVERY" ? "find" : "verify";
    return ProviderResponseSchema.parse({
      providerId: "HUNTER",
      providerRunId: `hunter-${operationTag}-${requestFingerprint(request).slice(0, 40)}`,
      operation: request.operation,
      result: "NO_MATCH",
      assertions: [],
      rawPayloadHash,
      retryAfterSeconds: null,
    });
  }

  private async fetchJson(endpoint: URL, signal: AbortSignal): Promise<{
    body: unknown;
    upstreamRequestId: string | null;
  }> {
    const addresses = await resolveOfficialEndpoint(this.resolveAddresses);
    const dispatcher = pinnedAgent(addresses);
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: combinedSignal,
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new HunterOfficialAdapterError("Hunter redirects are not allowed");
      }
      if (response.status === 429) {
        const retryAfter = retryAfterSeconds(response);
        await response.body?.cancel();
        throw new HunterRateLimitError(retryAfter);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HunterOfficialAdapterError(`Hunter official API returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel();
        throw new HunterOfficialAdapterError("Hunter returned a non-JSON response");
      }
      return {
        body: await readBoundedJson(response, this.maxResponseBytes),
        upstreamRequestId: safeUpstreamRequestId(response),
      };
    } finally {
      await dispatcher.close();
    }
  }
}
