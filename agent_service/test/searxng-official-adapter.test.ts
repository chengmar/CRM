import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBudget } from "../src/acquisition/provider-runtime.js";
import { ProviderRequestSchema } from "../src/acquisition/providers/contracts.js";
import { SearxngOfficialAdapter } from "../src/acquisition/providers/searxng-official.js";
import { StrictProviderRuntime, type ProviderAuditEvent } from "../src/acquisition/providers/strict-runtime.js";

const observedAt = new Date("2026-07-20T00:00:00.000Z");

function request(query = "sample products Malaysia", limit = 10) {
  return ProviderRequestSchema.parse({
    operation: "EVIDENCE_SEARCH",
    accountId: "campaign-1",
    query,
    limit,
    publicSourcesOnly: true,
    localFetchValidationRequired: true,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SearxngOfficialAdapter", () => {
  it("requires both the feature flag and campaign-scoped authorization before DNS or fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolveAddresses = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const disabled = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: false,
      fetchImpl,
      resolveAddresses,
      now: () => observedAt,
    });
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });

    const disabledResult = await runtime.run({
      adapter: disabled,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(disabledResult).toMatchObject({
      status: "BLOCKED_DISABLED",
      reason: "FEATURE_FLAG_DISABLED",
    });

    const enabled = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: true,
      fetchImpl,
      resolveAddresses,
      now: () => observedAt,
    });
    const unauthorized = await runtime.run({
      adapter: enabled,
      request: request(),
      budget: new ProviderBudget(0, 0),
    });
    expect(unauthorized).toMatchObject({
      status: "BLOCKED_DISABLED",
      reason: "USER_AUTHORIZATION_NOT_GRANTED",
    });
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a DNS-pinned no-redirect request, validates output, and caches an exact replay", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (target, init) => {
      const endpoint = new URL(String(target));
      expect(endpoint.origin).toBe("https://search.example.test");
      expect(endpoint.pathname).toBe("/search");
      expect(endpoint.searchParams.get("q")).toBe("sample products Malaysia");
      expect(endpoint.searchParams.get("format")).toBe("json");
      expect(endpoint.searchParams.get("categories")).toBe("general");
      expect(endpoint.searchParams.get("safesearch")).toBe("0");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeTruthy();
      return jsonResponse({
        query: "sample products Malaysia",
        results: [
          {
            title: "Buyer Engineering",
            url: "https://buyer.example/products/product-control",
            content: "Buyer Engineering supplies sample product-control systems.",
          },
          {
            title: "Duplicate",
            url: "https://buyer.example/products/product-control",
            content: "This duplicate must not create a second assertion.",
          },
          {
            title: "Unsafe literal",
            url: "http://127.0.0.1/private",
            content: "This result must be discarded.",
          },
        ],
      }, { headers: { "x-request-id": "searx-request-1" } });
    });
    const resolveAddresses = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: true,
      fetchImpl,
      resolveAddresses,
      now: () => observedAt,
    });
    const audits: ProviderAuditEvent[] = [];
    const runtime = new StrictProviderRuntime({
      audit: (event) => audits.push(event),
      now: () => observedAt,
    });
    const budget = new ProviderBudget(0, 0);

    const first = await runtime.run({
      adapter,
      request: request(),
      budget,
      campaignAuthorizationVerified: true,
      cacheTtlMs: 60_000,
    });
    const replay = await runtime.run({
      adapter,
      request: request(),
      budget,
      campaignAuthorizationVerified: true,
      cacheTtlMs: 60_000,
    });

    expect(first.status).toBe("SUCCEEDED_LIVE");
    expect(first.response?.assertions).toHaveLength(1);
    expect(first.response?.assertions[0]).toMatchObject({
      kind: "EVIDENCE_REFERENCE",
      sourceUrl: "https://buyer.example/products/product-control",
      localFetchVerified: false,
      evidenceEffect: "REQUIRES_LOCAL_FETCH",
      creditUnits: 0,
      estimatedUsd: 0,
    });
    expect(first.audit).toMatchObject({
      actualCost: { costUnits: 0, usd: 0, currency: "USD" },
      networkAttempted: true,
      externalWriteAttempted: false,
    });
    expect(replay.status).toBe("SUCCEEDED_LIVE");
    expect(replay.audit.cacheHit).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resolveAddresses).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toEqual({ usedCostUnits: 0, usedUsd: 0, reservations: 1 });
    expect(audits).toHaveLength(2);
  });

  it("rejects a truncated query echo and filters only generic first-term noise", async () => {
    const responses = [
      jsonResponse({ query: "industrial" , results: [] }),
      jsonResponse({
        query: "sample products Malaysia",
        results: [
          {
            title: "Industrial property market update",
            url: "https://noise.example/property",
            content: "Industrial estates and office leasing report.",
          },
          {
            title: "sample products engineering company",
            url: "https://buyer.example/sample-product-catalog",
            content: "sample products design for process plants.",
          },
          {
            title: "Sample Product A",
            url: "https://synonym.example/sample-product",
            content: "Sample Product A for process plants.",
          },
        ],
      }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: true,
      fetchImpl,
      resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => observedAt,
    });
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });

    const truncated = await runtime.run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(truncated).toMatchObject({
      status: "FAILED",
      reason: "PROVIDER_FAILURE",
    });

    const filtered = await runtime.run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(filtered.status).toBe("SUCCEEDED_LIVE");
    expect(filtered.response?.assertions.map((item) => item.sourceUrl)).toEqual([
      "https://buyer.example/sample-product-catalog",
      "https://synonym.example/sample-product",
    ]);
  });

  it("allows only an explicitly enabled fixed-port loopback production endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (target, init) => {
      const endpoint = new URL(String(target));
      expect(endpoint.origin).toBe("http://127.0.0.1:8888");
      expect(endpoint.pathname).toBe("/search");
      expect(init?.redirect).toBe("manual");
      return jsonResponse({
        results: [{
          title: "Public buyer",
          url: "https://public-buyer.example/about",
          content: "Public company evidence.",
        }],
      });
    });
    const resolveAddresses = vi.fn(async () => {
      throw new Error("Loopback literals must never use DNS resolution");
    });
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "http://127.0.0.1:8888/",
      enabled: true,
      allowLoopbackHttp: true,
      fetchImpl,
      resolveAddresses,
      now: () => observedAt,
    });
    const result = await new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt }).run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });

    expect(result.status).toBe("SUCCEEDED_LIVE");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resolveAddresses).not.toHaveBeenCalled();

    expect(new SearxngOfficialAdapter({
      baseUrl: "http://[::1]:8888/",
      enabled: true,
      allowLoopbackHttp: true,
      fetchImpl,
      resolveAddresses,
      now: () => observedAt,
    }).manifest.activation.configured).toBe(true);

    for (const baseUrl of [
      "http://127.0.0.1/",
      "http://127.0.0.2:8888/",
      "http://192.168.1.5:8888/",
      "http://localhost:8888/",
      "http://search.example.test:8888/",
    ]) {
      const blocked = new SearxngOfficialAdapter({
        baseUrl,
        enabled: true,
        allowLoopbackHttp: true,
        fetchImpl,
        resolveAddresses,
        now: () => observedAt,
      });
      const blockedResult = await new StrictProviderRuntime({ audit: () => undefined }).run({
        adapter: blocked,
        request: request(),
        budget: new ProviderBudget(0, 0),
        campaignAuthorizationVerified: true,
      });
      expect(blockedResult).toMatchObject({ status: "BLOCKED_DISABLED", reason: "NOT_CONFIGURED" });
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["http endpoint", "http://search.example.test/", [{ address: "8.8.8.8", family: 4 as const }]],
    ["private literal", "https://127.0.0.1/", [{ address: "127.0.0.1", family: 4 as const }]],
  ])("fails closed for an unsafe %s", async (_label, baseUrl, addresses) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new SearxngOfficialAdapter({
      baseUrl,
      enabled: true,
      fetchImpl,
      resolveAddresses: async () => addresses,
      now: () => observedAt,
    });
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });
    const result = await runtime.run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(result).toMatchObject({ status: "BLOCKED_DISABLED", reason: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to any private address before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: true,
      fetchImpl,
      resolveAddresses: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      now: () => observedAt,
    });
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });
    const result = await runtime.run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(result).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(result.audit.errorClass).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects and malformed provider output", async () => {
    const redirects = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }));
    const resolveAddresses = async () => [{ address: "8.8.8.8", family: 4 as const }];
    const runtime = new StrictProviderRuntime({ audit: () => undefined, now: () => observedAt });
    const redirected = await runtime.run({
      adapter: new SearxngOfficialAdapter({
        baseUrl: "https://search.example.test/",
        enabled: true,
        fetchImpl: redirects,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(redirected).toMatchObject({ status: "FAILED", reason: "PROVIDER_FAILURE" });

    const malformedFetch = vi.fn<typeof fetch>(async () => jsonResponse({ results: "not-an-array" }));
    const malformed = await runtime.run({
      adapter: new SearxngOfficialAdapter({
        baseUrl: "https://search.example.test/",
        enabled: true,
        fetchImpl: malformedFetch,
        resolveAddresses,
        now: () => observedAt,
      }),
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
    });
    expect(malformed).toMatchObject({
      status: "BLOCKED_INVALID_OUTPUT",
      reason: "INVALID_PROVIDER_OUTPUT",
    });
  });

  it("honors the strict runtime timeout signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_target, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const adapter = new SearxngOfficialAdapter({
      baseUrl: "https://search.example.test/",
      enabled: true,
      fetchImpl,
      resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => observedAt,
    });
    const runtime = new StrictProviderRuntime({ audit: () => undefined });
    const result = await runtime.run({
      adapter,
      request: request(),
      budget: new ProviderBudget(0, 0),
      campaignAuthorizationVerified: true,
      timeoutMs: 5,
    });
    expect(result).toMatchObject({ status: "TIMED_OUT", reason: "PROVIDER_TIMEOUT" });
  });
});
