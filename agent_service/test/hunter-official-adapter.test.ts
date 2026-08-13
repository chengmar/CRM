import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBudget } from "../src/acquisition/provider-runtime.js";
import { ProviderRequestSchema } from "../src/acquisition/providers/contracts.js";
import {
  HUNTER_OFFICIAL_BASE_URL,
  HunterOfficialAdapter,
} from "../src/acquisition/providers/hunter-official.js";
import { StrictProviderRuntime } from "../src/acquisition/providers/strict-runtime.js";

const observedAt = new Date("2026-07-20T00:00:00.000Z");
const publicResolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);

function discoveryRequest(fullName = "Jane Buyer") {
  return ProviderRequestSchema.parse({
    operation: "WORK_EMAIL_DISCOVERY",
    accountId: "account-1",
    canonicalDomain: "buyer.com",
    person: { personRef: "person-1", providerPersonId: null, fullName },
    roleFamily: "ENGINEERING",
    personalEmailAllowed: false,
    roleMailboxAllowed: false,
  });
}

function verificationRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation: "EMAIL_VERIFICATION",
    accountId: "account-1",
    personRef: "person-1",
    email: "jane@buyer.com",
    expectedDomain: "buyer.com",
    discoveryAssertionId: "public-web-discovery-1",
    discoveryProviderId: "LOCAL_PUBLIC_WEB",
    independentVerificationRequired: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function adapter(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof HunterOfficialAdapter>[0]> = {}) {
  return new HunterOfficialAdapter({
    enabled: true,
    apiKey: "hunter-test-secret",
    fetchImpl,
    resolveAddresses: publicResolver,
    now: () => observedAt,
    costByOperation: {
      WORK_EMAIL_DISCOVERY: { costUnits: 1, usd: 0.12, currency: "USD" },
      EMAIL_VERIFICATION: { costUnits: 0.5, usd: 0.06, currency: "USD" },
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  publicResolver.mockClear();
});

describe("HunterOfficialAdapter", () => {
  it("issues a fresh verification assertion after a new live observation", async () => {
    let current = observedAt;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      data: {
        email: "jane@buyer.com",
        status: "valid",
        score: 98,
        accept_all: false,
        disposable: false,
        webmail: false,
        block: false,
      },
    }));
    const official = adapter(fetchImpl, { now: () => current });
    const request = ProviderRequestSchema.parse(verificationRequest());

    const first = await official.execute(request, new AbortController().signal);
    current = new Date("2026-07-21T00:00:00.000Z");
    const second = await official.execute(request, new AbortController().signal);

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
      adapter: new HunterOfficialAdapter({
        enabled: false,
        apiKey: "configured-but-disabled",
        fetchImpl,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: discoveryRequest(),
      budget: new ProviderBudget(10, 10),
      campaignAuthorizationVerified: true,
    });
    expect(disabled).toMatchObject({ status: "BLOCKED_DISABLED", reason: "FEATURE_FLAG_DISABLED" });

    const missingKey = await runtime.run({
      adapter: new HunterOfficialAdapter({
        enabled: true,
        apiKey: "",
        fetchImpl,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: discoveryRequest(),
      budget: new ProviderBudget(10, 10),
      campaignAuthorizationVerified: true,
    });
    expect(missingKey).toMatchObject({ status: "BLOCKED_DISABLED", reason: "NOT_CONFIGURED" });
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns only an unverified Finder assertion from the fixed official endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (target, init) => {
      const endpoint = new URL(String(target));
      expect(endpoint.origin).toBe(new URL(HUNTER_OFFICIAL_BASE_URL).origin);
      expect(endpoint.pathname).toBe("/v2/email-finder");
      expect(endpoint.searchParams.get("domain")).toBe("buyer.com");
      expect(endpoint.searchParams.get("full_name")).toBe("Jane Buyer");
      expect(endpoint.searchParams.get("api_key")).toBe("hunter-test-secret");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeTruthy();
      return jsonResponse({
        data: {
          email: "jane@buyer.com",
          domain: "buyer.com",
          score: 96,
          accept_all: false,
          disposable: false,
          verification: { status: "valid" },
          phone_number: "must be discarded from the controlled payload",
        },
        meta: { api_key: "must never leave the raw response scope" },
      }, { headers: { "x-request-id": "raw-upstream-id" } });
    });
    const audits: unknown[] = [];
    const result = await new StrictProviderRuntime({
      audit: (event) => audits.push(event),
      now: () => observedAt,
    }).run({
      adapter: adapter(fetchImpl),
      request: discoveryRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });

    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(result.response?.assertions).toHaveLength(1);
    expect(result.response?.assertions[0]).toMatchObject({
      kind: "EMAIL_DISCOVERY",
      email: "jane@buyer.com",
      providerStatus: "PROVIDER_VALID_ASSERTION",
      localMailboxVerdict: "NOT_VERIFIED",
      creditUnits: 1,
      estimatedUsd: 0.12,
    });
    expect(result.audit.actualCost).toEqual({ costUnits: 1, usd: 0.12, currency: "USD" });
    expect(JSON.stringify(audits)).not.toContain("jane@buyer.com");
    expect(JSON.stringify(audits)).not.toContain("hunter-test-secret");
    expect(result.audit.providerRunId).not.toContain("jane");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("independently verifies a public-web discovery without retaining raw email in the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      data: {
        email: "jane@buyer.com",
        status: "valid",
        score: 98,
        accept_all: false,
        disposable: false,
        webmail: false,
        block: false,
      },
    }));
    const result = await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
      adapter: adapter(fetchImpl),
      request: verificationRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });

    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(result.response?.assertions[0]).toMatchObject({
      kind: "EMAIL_VERIFICATION",
      discoveryProviderId: "LOCAL_PUBLIC_WEB",
      verificationProviderId: "HUNTER",
      providerMailboxVerdict: "VALID_ASSERTION",
      catchAll: false,
      disposable: false,
      roleMailbox: false,
      creditUnits: 0.5,
      estimatedUsd: 0.06,
    });
    expect(result.response?.assertions[0]).toHaveProperty("emailHash");
    expect(JSON.stringify(result.response)).not.toContain("jane@buyer.com");
    expect(result.audit.actualCost).toEqual({ costUnits: 0.5, usd: 0.06, currency: "USD" });
  });

  it("rejects same-provider verification before DNS or fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
      adapter: adapter(fetchImpl),
      request: verificationRequest({ discoveryProviderId: "HUNTER" }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });

    expect(result).toMatchObject({
      status: "BLOCKED_EVIDENCE_INDEPENDENCE",
      reason: "VERIFIER_NOT_INDEPENDENT",
    });
    expect(publicResolver).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-domain", { email: "jane@other.com", domain: "other.com", score: 99, accept_all: false, disposable: false, verification: { status: "valid" } }],
    ["role mailbox", { email: "sales@buyer.com", domain: "buyer.com", score: 99, accept_all: false, disposable: false, verification: { status: "valid" } }],
    ["catch-all", { email: "jane@buyer.com", domain: "buyer.com", score: 99, accept_all: true, disposable: false, verification: { status: "accept_all" } }],
    ["disposable", { email: "jane@buyer.com", domain: "buyer.com", score: 99, accept_all: false, disposable: true, verification: { status: "disposable" } }],
  ])("intercepts a %s Finder result", async (_label, data) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data }));
    const result = await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
      adapter: adapter(fetchImpl),
      request: discoveryRequest(String(_label)),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(result.response).toMatchObject({ result: "NO_MATCH", assertions: [] });
  });

  it.each([
    ["catch-all", { status: "valid", accept_all: true, disposable: false }, "RISKY_ASSERTION"],
    ["disposable", { status: "disposable", accept_all: false, disposable: true }, "INVALID_ASSERTION"],
    ["missing risk flags", { status: "valid" }, "UNKNOWN_ASSERTION"],
  ])("never upgrades a %s Verifier result to VALID", async (_label, fields, expectedVerdict) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      data: { email: "jane@buyer.com", score: 95, ...fields },
    }));
    const result = await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
      adapter: adapter(fetchImpl),
      request: verificationRequest({ discoveryAssertionId: `case-${_label}` }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(result.response?.assertions[0]).toMatchObject({
      kind: "EMAIL_VERIFICATION",
      providerMailboxVerdict: expectedVerdict,
    });
  });

  it("blocks role-mailbox verification before provider access and drops a cross-domain response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      data: {
        email: "jane@other.com",
        status: "valid",
        score: 99,
        accept_all: false,
        disposable: false,
      },
    }));
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });
    const role = await runtime.run({
      adapter: adapter(fetchImpl),
      request: verificationRequest({ email: "sales@buyer.com" }),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(role).toMatchObject({ status: "BLOCKED_INVALID_INPUT", reason: "INVALID_REQUEST" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const crossDomain = await runtime.run({
      adapter: adapter(fetchImpl),
      request: verificationRequest(),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(crossDomain.response).toMatchObject({ result: "NO_MATCH", assertions: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("honors timeout cancellation and fails closed on 429 without retrying", async () => {
    const hangingFetch = vi.fn<typeof fetch>(async (_target, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const timedOut = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(hangingFetch),
      request: discoveryRequest("Timeout Buyer"),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
      timeoutMs: 5,
    });
    expect(timedOut).toMatchObject({ status: "TIMED_OUT", reason: "PROVIDER_TIMEOUT" });

    const rateLimitedFetch = vi.fn<typeof fetch>(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "60" },
    }));
    const budget = new ProviderBudget(2, 1);
    const rateLimited = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(rateLimitedFetch),
      request: discoveryRequest("Rate Limited Buyer"),
      budget,
      campaignAuthorizationVerified: true,
    });
    expect(rateLimited).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(rateLimitedFetch).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toEqual({ usedCostUnits: 0, usedUsd: 0, reservations: 0 });
  });

  it("blocks unsafe DNS, redirects, and oversized responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const unsafeDns = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(fetchImpl, {
        resolveAddresses: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
      request: discoveryRequest("Unsafe DNS"),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(unsafeDns).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirectFetch = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }));
    const redirected = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(redirectFetch),
      request: discoveryRequest("Redirect Buyer"),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(redirected).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });

    const oversizedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ data: null }, {
      headers: { "content-length": "2048" },
    }));
    const oversized = await new StrictProviderRuntime({ audit: () => undefined }).run({
      adapter: adapter(oversizedFetch, { maxResponseBytes: 1_024 }),
      request: discoveryRequest("Oversized Buyer"),
      budget: new ProviderBudget(2, 1),
      campaignAuthorizationVerified: true,
    });
    expect(oversized).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
  });
});
