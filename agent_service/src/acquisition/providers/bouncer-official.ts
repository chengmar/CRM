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
  WorkEmailSchema,
  type ProviderAdapterExecution,
  type ProviderManifest,
  type ProviderRequest,
  type StrictProviderAdapter,
} from "./contracts.js";

export const BOUNCER_OFFICIAL_BASE_URL = "https://api.usebouncer.com/v1.1/";
export const BOUNCER_OFFICIAL_VERIFY_URL = new URL(
  "email/verify",
  BOUNCER_OFFICIAL_BASE_URL,
).toString();

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

const BouncerStatusSchema = z.enum([
  "deliverable",
  "risky",
  "undeliverable",
  "unknown",
]);

const BouncerFlagSchema = z.enum(["yes", "no", "unknown"]);
const NullableFlagSchema = BouncerFlagSchema.nullable().optional();

const BouncerApiResponseSchema = z.object({
  email: z.string().max(320).nullable().optional(),
  status: BouncerStatusSchema.nullable().optional(),
  reason: z.string().max(100).nullable().optional(),
  domain: z.object({
    name: z.string().max(253).nullable().optional(),
    acceptAll: NullableFlagSchema,
    disposable: NullableFlagSchema,
    free: NullableFlagSchema,
  }).nullable().optional(),
  account: z.object({
    role: NullableFlagSchema,
    disabled: NullableFlagSchema,
    fullMailbox: NullableFlagSchema,
  }).nullable().optional(),
  score: z.number().finite().min(0).max(100).nullable().optional(),
  toxicity: z.number().finite().min(0).max(100).nullable().optional(),
});

export interface BouncerResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type BouncerAddressResolver = (hostname: string) => Promise<BouncerResolvedAddress[]>;

type BouncerCostByOperation = Record<"EMAIL_VERIFICATION", ProviderCost>;

export interface BouncerOfficialAdapterOptions {
  enabled: boolean;
  apiKey: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  assertionTtlMs?: number;
  verificationCost?: ProviderCost;
  costByOperation?: Partial<BouncerCostByOperation>;
  fetchImpl?: typeof fetch;
  resolveAddresses?: BouncerAddressResolver;
  now?: () => Date;
}

export class BouncerOfficialAdapterError extends Error {
  override readonly name: string = "BouncerOfficialAdapterError";
}

export class BouncerPaymentRequiredError extends BouncerOfficialAdapterError {
  override readonly name = "BouncerPaymentRequiredError";

  constructor() {
    super("Bouncer verification credits are unavailable");
  }
}

export class BouncerRateLimitError extends BouncerOfficialAdapterError {
  override readonly name = "BouncerRateLimitError";

  constructor(readonly retryAfterSeconds: number | null) {
    super("Bouncer official API rate limit reached");
  }
}

export class BouncerServiceUnavailableError extends BouncerOfficialAdapterError {
  override readonly name = "BouncerServiceUnavailableError";

  constructor(readonly status: number) {
    super(`Bouncer official API is unavailable (HTTP ${status})`);
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

const defaultResolver: BouncerAddressResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((item): BouncerResolvedAddress[] =>
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

async function resolveOfficialEndpoint(
  resolver: BouncerAddressResolver,
): Promise<BouncerResolvedAddress[]> {
  const hostname = new URL(BOUNCER_OFFICIAL_VERIFY_URL).hostname;
  let resolved: BouncerResolvedAddress[];
  try {
    resolved = await resolver(hostname);
  } catch {
    throw new BouncerOfficialAdapterError("Bouncer official endpoint DNS resolution failed");
  }
  const unique = [...new Map(resolved.map((item) => [
    `${item.family}:${item.address.toLowerCase()}`,
    item,
  ])).values()];
  if (unique.length === 0 || unique.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new BouncerOfficialAdapterError("Bouncer official endpoint resolved to an unsafe address");
  }
  return unique;
}

function pinnedAgent(addresses: BouncerResolvedAddress[]): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : null;
    const eligible = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      callback(Object.assign(new Error("No validated Bouncer address for requested family"), {
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

function parseJson(bytes: Uint8Array[]): unknown {
  try {
    return JSON.parse(Buffer.concat(bytes.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new BouncerOfficialAdapterError("Bouncer returned invalid JSON");
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new BouncerOfficialAdapterError("Bouncer response exceeded the configured byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new BouncerOfficialAdapterError("Bouncer response exceeded the configured byte limit");
    }
    return parseJson([body]);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new BouncerOfficialAdapterError("Bouncer response exceeded the configured byte limit");
    }
    chunks.push(next.value);
  }
  return parseJson(chunks);
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

function safeUpstreamRequestId(response: Response): string | null {
  const raw = response.headers.get("x-request-id")?.trim();
  return raw ? `bouncer-${sha256(raw).slice(0, 40)}` : null;
}

function safeCost(value: ProviderCost | undefined): ProviderCost {
  return ProviderCostSchema.parse(value ?? { costUnits: 1, usd: 0, currency: "USD" });
}

function requestFingerprint(request: z.infer<typeof EmailVerificationRequestSchema>): string {
  return sha256({
    operation: request.operation,
    accountId: request.accountId,
    personRef: request.personRef,
    emailHash: sha256(request.email),
    discoveryAssertionId: request.discoveryAssertionId,
    discoveryProviderId: request.discoveryProviderId,
  });
}

export class BouncerOfficialAdapter implements StrictProviderAdapter {
  readonly requestSchema = ProviderRequestSchema;
  readonly responseSchema = ProviderResponseSchema;
  readonly manifest: ProviderManifest;
  readonly recommendedCacheTtlMs = 0;
  private readonly enabled: boolean;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly assertionTtlMs: number;
  private readonly verificationCost: ProviderCost;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: BouncerAddressResolver;
  private readonly now: () => Date;

  constructor(options: BouncerOfficialAdapterOptions) {
    this.enabled = options.enabled === true;
    this.apiKey = options.apiKey.trim();
    this.requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 20_000, 60_000));
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? 1_000_000, 5_000_000));
    this.assertionTtlMs = Math.max(
      60_000,
      Math.min(options.assertionTtlMs ?? 30 * 24 * 60 * 60_000, 90 * 24 * 60 * 60_000),
    );
    this.verificationCost = safeCost(
      options.verificationCost ?? options.costByOperation?.EMAIL_VERIFICATION,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveAddresses = options.resolveAddresses ?? defaultResolver;
    this.now = options.now ?? (() => new Date());
    this.manifest = ProviderManifestSchema.parse({
      providerId: "BOUNCER",
      displayName: "Bouncer official Email Verification API",
      capabilities: ["EMAIL_VERIFICATION"],
      implementationState: "OFFICIAL_API_ADAPTER",
      featureFlag: "ACQ_BOUNCER_V2_ENABLED",
      activation: {
        featureFlagEnabled: this.enabled,
        configured: this.apiKey.length > 0,
        authorization: "CAMPAIGN_SCOPED",
      },
      networkPolicy: "OFFICIAL_API_ONLY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: ["B2B_WORK_EMAIL", "HASHED_EMAIL"],
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
        detail: "Bouncer feature flag is disabled",
      };
    }
    if (!this.apiKey) {
      return {
        state: "NOT_CONFIGURED",
        checkedAt: this.now().toISOString(),
        detail: "Bouncer API credential is not configured",
      };
    }
    return {
      state: "HEALTHY",
      checkedAt: this.now().toISOString(),
      detail: "Configuration is valid; health is checked only during an authorized campaign call",
    };
  }

  estimateCost(request: ProviderRequest): ProviderCost {
    return request.operation === "EMAIL_VERIFICATION"
      ? this.verificationCost
      : { costUnits: 0, usd: 0, currency: "USD" };
  }

  async execute(request: ProviderRequest, signal: AbortSignal): Promise<ProviderAdapterExecution> {
    if (!this.enabled || !this.apiKey) {
      throw new BouncerOfficialAdapterError(
        "Bouncer feature flag and API credential are both required",
      );
    }
    if (request.operation !== "EMAIL_VERIFICATION") {
      throw new BouncerOfficialAdapterError("Bouncer supports only email verification");
    }
    const verifiedRequest = EmailVerificationRequestSchema.parse(request);
    if (verifiedRequest.discoveryProviderId === "BOUNCER") {
      throw new BouncerOfficialAdapterError(
        "Bouncer cannot independently verify its own discovery assertion",
      );
    }
    return this.executeVerifier(verifiedRequest, signal);
  }

  private async executeVerifier(
    request: z.infer<typeof EmailVerificationRequestSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAdapterExecution> {
    const endpoint = new URL(BOUNCER_OFFICIAL_VERIFY_URL);
    endpoint.searchParams.set("email", request.email);
    const raw = await this.fetchJson(endpoint, signal);
    const parsedResult = BouncerApiResponseSchema.safeParse(raw.body);
    if (!parsedResult.success) {
      throw new BouncerOfficialAdapterError("Bouncer returned an invalid response");
    }
    const parsed = parsedResult.data;
    const rawPayloadHash = sha256(raw.body);
    const email = parsed.email ?? "";
    const domain = parsed.domain?.name ?? "";
    if (
      email !== request.email ||
      !WorkEmailSchema.safeParse(email).success ||
      registeredEmailDomain(email) !== request.expectedDomain ||
      domain !== request.expectedDomain
    ) {
      return {
        response: this.emptyResponse(request, rawPayloadHash),
        actualCost: this.verificationCost,
        upstreamRequestId: raw.upstreamRequestId,
        networkAttempted: true,
        externalWriteAttempted: false,
      };
    }

    const flags = [
      parsed.domain?.acceptAll,
      parsed.domain?.disposable,
      parsed.domain?.free,
      parsed.account?.role,
      parsed.account?.disabled,
      parsed.account?.fullMailbox,
    ];
    const allFlagsExplicitNo = flags.every((flag) => flag === "no");
    const hasUnknownFlag = flags.some((flag) => flag === undefined || flag === null || flag === "unknown");
    const hasRiskFlag = flags.some((flag) => flag === "yes");
    const catchAll = parsed.domain?.acceptAll === "yes";
    const disposable = parsed.domain?.disposable === "yes";
    const roleMailbox = parsed.account?.role === "yes" || isRoleMailbox(email);
    const score = parsed.score;
    const toxicity = parsed.toxicity;
    const valid = parsed.status === "deliverable"
      && parsed.reason === "accepted_email"
      && allFlagsExplicitNo
      && !roleMailbox
      && score !== undefined
      && score !== null
      && score >= 90
      && toxicity !== undefined
      && toxicity !== null
      && toxicity < 4;

    let providerMailboxVerdict:
      | "VALID_ASSERTION"
      | "INVALID_ASSERTION"
      | "RISKY_ASSERTION"
      | "UNKNOWN_ASSERTION";
    if (valid) {
      providerMailboxVerdict = "VALID_ASSERTION";
    } else if (parsed.status === "undeliverable" || parsed.account?.disabled === "yes") {
      providerMailboxVerdict = "INVALID_ASSERTION";
    } else if (
      parsed.status === "risky" ||
      hasRiskFlag ||
      roleMailbox ||
      (score !== undefined && score !== null && score < 90) ||
      (toxicity !== undefined && toxicity !== null && toxicity >= 4)
    ) {
      providerMailboxVerdict = "RISKY_ASSERTION";
    } else if (hasUnknownFlag) {
      providerMailboxVerdict = "UNKNOWN_ASSERTION";
    } else {
      providerMailboxVerdict = "UNKNOWN_ASSERTION";
    }

    const observedAt = this.now();
    const fingerprint = requestFingerprint(request);
    const providerRunId = `bouncer-verify-${fingerprint.slice(0, 40)}`;
    const response = ProviderResponseSchema.parse({
      providerId: "BOUNCER",
      providerRunId,
      operation: request.operation,
      result: "ASSERTIONS_RETURNED",
      assertions: [{
        assertionId: `bouncer-verification-${sha256(
          `${fingerprint}:${rawPayloadHash}:${observedAt.toISOString()}`,
        ).slice(0, 40)}`,
        providerId: "BOUNCER",
        providerRunId,
        accountId: request.accountId,
        sourceUri: BOUNCER_OFFICIAL_VERIFY_URL,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + this.assertionTtlMs).toISOString(),
        confidence: (score ?? 0) / 100,
        rawPayloadHash,
        creditUnits: this.verificationCost.costUnits,
        estimatedUsd: this.verificationCost.usd,
        kind: "EMAIL_VERIFICATION",
        personRef: request.personRef,
        emailHash: sha256(email),
        discoveryAssertionId: request.discoveryAssertionId,
        discoveryProviderId: request.discoveryProviderId,
        verificationProviderId: "BOUNCER",
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
      actualCost: this.verificationCost,
      upstreamRequestId: raw.upstreamRequestId,
      networkAttempted: true,
      externalWriteAttempted: false,
    };
  }

  private emptyResponse(
    request: z.infer<typeof EmailVerificationRequestSchema>,
    rawPayloadHash: string,
  ) {
    return ProviderResponseSchema.parse({
      providerId: "BOUNCER",
      providerRunId: `bouncer-verify-${requestFingerprint(request).slice(0, 40)}`,
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
        headers: {
          Accept: "application/json",
          "x-api-key": this.apiKey,
        },
        redirect: "manual",
        signal: combinedSignal,
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new BouncerOfficialAdapterError("Bouncer redirects are not allowed");
      }
      if (response.status === 402) {
        await response.body?.cancel();
        throw new BouncerPaymentRequiredError();
      }
      if (response.status === 429) {
        const retryAfter = retryAfterSeconds(response);
        await response.body?.cancel();
        throw new BouncerRateLimitError(retryAfter);
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new BouncerServiceUnavailableError(response.status);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BouncerOfficialAdapterError(
          `Bouncer official API returned HTTP ${response.status}`,
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel();
        throw new BouncerOfficialAdapterError("Bouncer returned a non-JSON response");
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
