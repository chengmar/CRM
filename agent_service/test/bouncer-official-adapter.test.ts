import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBudget } from "../src/acquisition/provider-runtime.js";
import { ProviderRequestSchema } from "../src/acquisition/providers/contracts.js";
import {
  BOUNCER_OFFICIAL_VERIFY_URL,
  BouncerOfficialAdapter,
} from "../src/acquisition/providers/bouncer-official.js";
import { StrictProviderRuntime } from "../src/acquisition/providers/strict-runtime.js";

const observedAt = new Date("2026-07-20T00:00:00.000Z");
const publicResolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);

function verificationRequest(overrides: Record<string, unknown> = {}) {
  return ProviderRequestSchema.parse({
    operation: "EMAIL_VERIFICATION",
    accountId: "account-1",
    personRef: "person-1",
    email: "jane@buyer.com",
    expectedDomain: "buyer.com",
    discoveryAssertionId: "public-web-discovery-1",
    discoveryProviderId: "LOCAL_PUBLIC_WEB",
    independentVerificationRequired: true,
    ...overrides,
  });
}

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    email: "jane@buyer.com",
    status: "deliverable",
    reason: "accepted_email",
    domain: {
      name: "buyer.com",
      acceptAll: "no",
      disposable: "no",
      free: "no",
    },
    account: {
      role: "no",
      disabled: "no",
      fullMailbox: "no",
    },
    score: 98,
    toxicity: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function adapter(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof BouncerOfficialAdapter>[0]> = {},
) {
  return new BouncerOfficialAdapter({
    enabled: true,
    apiKey: "bouncer-test-secret",
    fetchImpl,
    resolveAddresses: publicResolver,
    now: () => observedAt,
    verificationCost: { costUnits: 1, usd: 0.05, currency: "USD" },
    ...overrides,
  });
}

async function run(fetchImpl: typeof fetch, request = verificationRequest()) {
  return await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
    adapter: adapter(fetchImpl),
    request,
    budget: new ProviderBudget(2, 1),
    campaignAuthorizationVerified: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  publicResolver.mockClear();
});

describe("BouncerOfficialAdapter", () => {
  it("issues a fresh verification assertion after a new live observation", async () => {
    let current = observedAt;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(validResponse()));
    const official = adapter(fetchImpl, { now: () => current });

    const first = await official.execute(verificationRequest(), new AbortController().signal);
    current = new Date("2026-07-21T00:00:00.000Z");
    const second = await official.execute(verificationRequest(), new AbortController().signal);

    expect(first.response.assertions[0]?.assertionId)
      .not.toBe(second.response.assertions[0]?.assertionId);
    expect(first.response.assertions[0]?.rawPayloadHash)
      .toBe(second.response.assertions[0]?.rawPayloadHash);
  });

  it("requires both the feature flag and API key before DNS or fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolveAddresses = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });

    const disabled = await runtime.run({
      adapter: new BouncerOfficialAdapter({
        enabled: false,
        apiKey: "configured-but-disabled",
        fetchImpl,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: verificationRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(disabled).toMatchObject({ status: "BLOCKED_DISABLED", reason: "FEATURE_FLAG_DISABLED" });

    const missingKey = await runtime.run({
      adapter: new BouncerOfficialAdapter({
        enabled: true,
        apiKey: "",
        fetchImpl,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: verificationRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(missingKey).toMatchObject({ status: "BLOCKED_DISABLED", reason: "NOT_CONFIGURED" });
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses only the fixed official endpoint and keeps the key in the header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (target, init) => {
      const endpoint = new URL(String(target));
      const official = new URL(BOUNCER_OFFICIAL_VERIFY_URL);
      expect(endpoint.origin).toBe(official.origin);
      expect(endpoint.pathname).toBe(official.pathname);
      expect(endpoint.searchParams.get("email")).toBe("jane@buyer.com");
      expect(endpoint.searchParams.has("api_key")).toBe(false);
      expect(endpoint.searchParams.has("key")).toBe(false);
      expect(String(target)).not.toContain("bouncer-test-secret");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("bouncer-test-secret");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeTruthy();
      return jsonResponse(validResponse(), { headers: { "x-request-id": "raw-request-id" } });
    });
    const audits: unknown[] = [];
    const result = await new StrictProviderRuntime({
      audit: (event) => audits.push(event),
      now: () => observedAt,
    }).run({
      adapter: adapter(fetchImpl),
      request: verificationRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });

    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(result.response?.assertions[0]).toMatchObject({
      kind: "EMAIL_VERIFICATION",
      sourceUri: BOUNCER_OFFICIAL_VERIFY_URL,
      verificationProviderId: "BOUNCER",
      providerMailboxVerdict: "VALID_ASSERTION",
      catchAll: false,
      disposable: false,
      roleMailbox: false,
      creditUnits: 1,
      estimatedUsd: 0.05,
    });
    expect(result.response?.assertions[0]).toHaveProperty("emailHash");
    expect(JSON.stringify(result)).not.toContain("jane@buyer.com");
    expect(JSON.stringify(result)).not.toContain("bouncer-test-secret");
    expect(JSON.stringify(audits)).not.toContain("bouncer-test-secret");
    expect(result.audit.upstreamRequestId).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("requires exact response email and domain", async () => {
    const wrongEmail = await run(
      vi.fn<typeof fetch>(async () => jsonResponse(validResponse({ email: "other@buyer.com" }))),
    );
    expect(wrongEmail.response).toMatchObject({ result: "NO_MATCH", assertions: [] });

    const wrongDomain = await run(
      vi.fn<typeof fetch>(async () => jsonResponse(validResponse({
        domain: {
          name: "other.com",
          acceptAll: "no",
          disposable: "no",
          free: "no",
        },
      }))),
    );
    expect(wrongDomain.response).toMatchObject({ result: "NO_MATCH", assertions: [] });
  });

  it.each([
    ["unknown flag", { domain: { name: "buyer.com", acceptAll: "unknown", disposable: "no", free: "no" } }],
    ["missing flag", { account: { role: "no", disabled: "no" } }],
    ["free mailbox", { domain: { name: "buyer.com", acceptAll: "no", disposable: "no", free: "yes" } }],
    ["role mailbox", { account: { role: "yes", disabled: "no", fullMailbox: "no" } }],
    ["catch-all", { domain: { name: "buyer.com", acceptAll: "yes", disposable: "no", free: "no" } }],
    ["disposable", { domain: { name: "buyer.com", acceptAll: "no", disposable: "yes", free: "no" } }],
    ["low score", { score: 89 }],
    ["high toxicity", { toxicity: 4 }],
    ["unknown status", { status: "unknown" }],
    ["wrong reason", { reason: "unknown" }],
    ["missing score", { score: null }],
    ["missing toxicity", { toxicity: null }],
  ])("never upgrades %s to VALID", async (_label, override) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(validResponse(override)));
    const result = await run(fetchImpl, verificationRequest({
      discoveryAssertionId: `case-${String(_label).replaceAll(" ", "-")}`,
    }));
    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(result.response?.assertions[0]).toMatchObject({ kind: "EMAIL_VERIFICATION" });
    expect(result.response?.assertions[0]).not.toMatchObject({
      providerMailboxVerdict: "VALID_ASSERTION",
    });
  });

  it("maps an undeliverable result to INVALID", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(validResponse({
      status: "undeliverable",
      reason: "rejected_email",
    })));
    const result = await run(fetchImpl);
    expect(result.response?.assertions[0]).toMatchObject({
      providerMailboxVerdict: "INVALID_ASSERTION",
    });
  });

  it("rejects same-provider verification before DNS or fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await run(fetchImpl, verificationRequest({ discoveryProviderId: "BOUNCER" }));
    expect(result).toMatchObject({
      status: "BLOCKED_EVIDENCE_INDEPENDENCE",
      reason: "VERIFIER_NOT_INDEPENDENT",
    });
    expect(publicResolver).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([402, 429, 500, 503])("fails closed on HTTP %s without retrying or charging", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("sensitive-upstream-body", {
      status,
      headers: status === 429 ? { "retry-after": "60" } : undefined,
    }));
    const budget = new ProviderBudget(2, 1);
    const result = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(fetchImpl),
      request: verificationRequest({ discoveryAssertionId: `http-${status}` }),
      budget,
      campaignAuthorizationVerified: true,
    });
    expect(result).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(JSON.stringify(result)).not.toContain("sensitive-upstream-body");
    expect(JSON.stringify(result)).not.toContain("bouncer-test-secret");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toEqual({ usedCostUnits: 0, usedUsd: 0, reservations: 0 });
  });

  it("blocks unsafe DNS, redirects, and oversized responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const unsafeDns = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(fetchImpl, {
        resolveAddresses: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
      request: verificationRequest({ discoveryAssertionId: "unsafe-dns" }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(unsafeDns).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirectFetch = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }));
    const redirected = await run(redirectFetch, verificationRequest({ discoveryAssertionId: "redirect" }));
    expect(redirected).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });

    const oversizedFetch = vi.fn<typeof fetch>(async () => jsonResponse(validResponse(), {
      headers: { "content-length": "2048" },
    }));
    const oversized = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(oversizedFetch, { maxResponseBytes: 1_024 }),
      request: verificationRequest({ discoveryAssertionId: "oversized" }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(oversized).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
  });

  it("honors cancellation and rejects non-JSON responses", async () => {
    const hangingFetch = vi.fn<typeof fetch>(async (_target, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const timedOut = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(hangingFetch),
      request: verificationRequest({ discoveryAssertionId: "timeout" }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
      timeoutMs: 5,
    });
    expect(timedOut).toMatchObject({ status: "TIMED_OUT", reason: "PROVIDER_TIMEOUT" });

    const nonJsonFetch = vi.fn<typeof fetch>(async () => new Response("not json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    const nonJson = await run(nonJsonFetch, verificationRequest({ discoveryAssertionId: "non-json" }));
    expect(nonJson).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
  });
});
