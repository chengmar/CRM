import { describe, expect, it } from "vitest";
import type {
  CrawlAccountObservation,
  CrawlAccountRequest,
  CrawlDecisionAudit,
  CrawlFailureClass,
  CrawlPageObservation,
  CrawlPageRequest,
  CrawlProvider,
  CrawlProviderContext,
  CrawlProviderKind,
  CrawlProviderMode,
} from "../src/acquisition/crawl-contracts.js";
import {
  CrawlBudgetLedger,
  CrawlRouter,
  classifyCrawlFailure,
  prioritizeOfficialCrawlPages,
  validateCrawlTarget,
} from "../src/acquisition/crawl-router.js";
import { runCrawlRoutingShadow } from "../src/acquisition/crawl-shadow.js";

const checkedAt = "2026-07-20T00:00:00.000Z";

class FixtureProvider implements CrawlProvider {
  calls = 0;

  constructor(
    readonly id: string,
    readonly kind: CrawlProviderKind,
    readonly mode: CrawlProviderMode,
    readonly enabled: boolean,
    readonly configured: boolean,
    private readonly execute: (
      request: CrawlPageRequest,
      context: CrawlProviderContext,
    ) => Promise<CrawlPageObservation>,
    private readonly supportedTypes: readonly string[] = ["text/html", "text/plain", "text/markdown"],
    private readonly costUnits = 0,
  ) {}

  async crawlPage(request: CrawlPageRequest, context: CrawlProviderContext): Promise<CrawlPageObservation> {
    this.calls += 1;
    return this.execute(request, context);
  }

  async crawlAccount(
    request: CrawlAccountRequest,
    context: CrawlProviderContext,
  ): Promise<CrawlAccountObservation> {
    return { pages: await Promise.all(request.pages.map((page) => this.crawlPage(page, context))) };
  }

  classifyFailure(_observation: CrawlPageObservation): CrawlFailureClass | null {
    return null;
  }

  estimateCost(_request: CrawlPageRequest | CrawlAccountRequest): { costUnits: number } {
    return { costUnits: this.costUnits };
  }

  supportsContentType(contentType: string): boolean {
    return this.supportedTypes.includes(contentType.split(";", 1)[0]!.toLowerCase());
  }
}

function request(path = "about", overrides: Partial<CrawlPageRequest> = {}): CrawlPageRequest {
  const requestedUrl = `https://buyer.example.com/${path}`;
  return {
    campaignId: "campaign-1",
    accountId: "account-1",
    runId: `run-${path}`,
    requestedUrl,
    officialBaseUrl: "https://buyer.example.com/",
    pageType: "ABOUT",
    robots: {
      status: "ALLOWED",
      checkedUrl: "https://buyer.example.com/robots.txt",
      checkedAt,
    },
    resolution: {
      hostname: "buyer.example.com",
      addresses: [{ address: "8.8.8.8", family: 4 }],
      checkedAt,
    },
    ...overrides,
  };
}

function success(input: CrawlPageRequest, overrides: Partial<CrawlPageObservation> = {}): CrawlPageObservation {
  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.requestedUrl,
    canonicalUrl: input.requestedUrl,
    httpStatus: 200,
    robotsStatus: "ALLOWED",
    contentType: "text/html",
    content: "<html><body>Public official company information and industrial projects.</body></html>",
    structureRecovered: true,
    actualCostUnits: 0,
    ...overrides,
  };
}

function limits(overrides: Partial<ConstructorParameters<typeof CrawlBudgetLedger>[0]> = {}) {
  return {
    maxPagesPerCampaign: 100,
    maxPagesPerAccount: 100,
    maxFetchAttemptsPerCampaign: 100,
    maxProviderCostUnitsPerCampaign: 100,
    maxProviderCostUnitsPerAccount: 100,
    ...overrides,
  };
}

function provider(
  kind: CrawlProviderKind,
  execute: (request: CrawlPageRequest, context: CrawlProviderContext) => Promise<CrawlPageObservation>,
  options: {
    id?: string;
    mode?: CrawlProviderMode;
    enabled?: boolean;
    configured?: boolean;
    supportedTypes?: readonly string[];
    costUnits?: number;
  } = {},
) {
  return new FixtureProvider(
    options.id ?? `${kind.toLowerCase()}-fixture`,
    kind,
    options.mode ?? "SHADOW",
    options.enabled ?? true,
    options.configured ?? true,
    execute,
    options.supportedTypes,
    options.costUnits,
  );
}

describe("crawl target policy", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://service.internal/",
    "file:///etc/passwd",
    "https://user:password@buyer.example.com/",
    "https://buyer.example.com:8443/",
  ])("rejects unsafe target %s", (url) => {
    expect(validateCrawlTarget(url)).toMatchObject({ ok: false });
  });

  it("rejects public-looking hosts whose resolution contains any private address", () => {
    expect(validateCrawlTarget("https://buyer.example.com/", {
      resolution: {
        hostname: "buyer.example.com",
        addresses: [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.4", family: 4 },
        ],
        checkedAt,
      },
    })).toMatchObject({ ok: false, failureClass: "UNSAFE_TARGET" });
  });

  it("prioritizes official pages and excludes directory assertions from another domain", () => {
    const resolution = request().resolution;
    const plan = prioritizeOfficialCrawlPages({
      officialBaseUrl: "https://buyer.example.com/",
      maxPages: 3,
      candidates: [
        { url: "https://directory.example.net/buyer", resolution: {
          ...resolution,
          hostname: "directory.example.net",
        }, pageType: "ABOUT", source: "DIRECTORY_ASSERTION" },
        { url: "https://buyer.example.com/news", resolution, pageType: "NEWS", source: "SEARCH_ASSERTION" },
        { url: "https://buyer.example.com/procurement", resolution, pageType: "PROCUREMENT", source: "OFFICIAL_LINK" },
        { url: "https://buyer.example.com/", resolution, pageType: "ABOUT", source: "OFFICIAL_BASE" },
      ],
    });

    expect(plan.accepted.map((item) => item.url)).toEqual([
      "https://buyer.example.com/",
      "https://buyer.example.com/procurement",
      "https://buyer.example.com/news",
    ]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toContain("official domain");
  });

  it("blocks an unsafe request before any provider invocation", async () => {
    const local = provider("LOCAL", async (input) => success(input));
    const unsafeRequest = request("metadata", {
      requestedUrl: "http://169.254.169.254/latest/meta-data",
      officialBaseUrl: "https://buyer.example.com/",
      resolution: {
        hostname: "169.254.169.254",
        addresses: [{ address: "169.254.169.254", family: 4 }],
        checkedAt,
      },
    });
    const result = await new CrawlRouter({
      localProvider: local,
      budget: new CrawlBudgetLedger(limits()),
    }).routePage(unsafeRequest);

    expect(result).toMatchObject({ status: "BLOCKED", failureClass: "UNSAFE_TARGET" });
    expect(local.calls).toBe(0);
  });
});

describe("crawl failure classification and fallback routing", () => {
  it.each([
    ["robots", { requestedUrl: "https://buyer.example.com/x", robotsStatus: "DISALLOWED" }, "ROBOTS_DENIED"],
    ["429", { requestedUrl: "https://buyer.example.com/x", robotsStatus: "ALLOWED", httpStatus: 429 }, "RATE_LIMITED"],
    ["403", { requestedUrl: "https://buyer.example.com/x", robotsStatus: "ALLOWED", httpStatus: 403 }, "ACCESS_BLOCKED"],
    ["timeout", { requestedUrl: "https://buyer.example.com/x", robotsStatus: "ALLOWED", timedOut: true }, "TIMEOUT"],
    ["JS shell", {
      requestedUrl: "https://buyer.example.com/x",
      robotsStatus: "ALLOWED",
      httpStatus: 200,
      contentType: "text/html",
      content: "<div id='root'></div><script src='/a.js'></script><script src='/b.js'></script>",
    }, "JS_REQUIRED"],
  ] as const)("classifies %s deterministically", (_name, observation, expected) => {
    expect(classifyCrawlFailure(observation)).toBe(expected);
  });

  it.each([
    ["JS_REQUIRED", (input: CrawlPageRequest) => success(input, {
      content: "<div id='root'></div><script src='/a.js'></script><script src='/b.js'></script>",
    })],
    ["PARTIAL_CONTENT", (input: CrawlPageRequest) => success(input, { content: "partial", truncated: true })],
    ["ACCESS_BLOCKED", (input: CrawlPageRequest) => success(input, { httpStatus: 403, content: null })],
    ["UNSUPPORTED_DOCUMENT", (input: CrawlPageRequest) => success(input, {
      contentType: "application/pdf",
      content: new Uint8Array([1, 2, 3]),
    })],
    ["STRUCTURE_UNRECOVERABLE", (input: CrawlPageRequest) => success(input, {
      structureRecovered: false,
    })],
  ] as const)("uses fallback only for allowed failure %s", async (expectedFailure, localResult) => {
    const local = provider("LOCAL", async (input) => localResult(input));
    const external = provider("EXTERNAL", async (input) => success(input, {
      content: `<html><body>Recovered ${expectedFailure} fixture with public content.</body></html>`,
    }), { supportedTypes: ["text/html", "application/pdf"], costUnits: 1 });
    const audits: CrawlDecisionAudit[] = [];
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true },
      audit: (decision) => audits.push(decision),
    }).routePage(request(expectedFailure.toLowerCase()));

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      source: "EXTERNAL",
      fallbackEligible: true,
      fallbackUsed: true,
      fallbackBlockReason: "USED",
      shouldProcess: true,
    });
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]).toMatchObject({ failureClass: expectedFailure, outcome: "FAILURE" });
    expect(result.snapshots[1]).toMatchObject({ failureClass: null, outcome: "SUCCESS" });
    expect(external.calls).toBe(1);
    expect(audits.at(-1)).toMatchObject({ localFailureClass: expectedFailure, fallbackUsed: true });
  });

  it.each([
    ["RATE_LIMITED", (input: CrawlPageRequest) => success(input, { httpStatus: 429, content: null })],
    ["TIMEOUT", (input: CrawlPageRequest) => success(input, { timedOut: true, content: null })],
    ["HTTP_ERROR", (input: CrawlPageRequest) => success(input, { httpStatus: 500, content: null })],
  ] as const)("does not use fallback for stop class %s", async (expectedFailure, localResult) => {
    const local = provider("LOCAL", async (input) => localResult(input));
    const external = provider("EXTERNAL", async (input) => success(input));
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true },
    }).routePage(request(expectedFailure.toLowerCase()));

    expect(result).toMatchObject({
      status: "FAILED",
      failureClass: expectedFailure,
      fallbackEligible: false,
      fallbackUsed: false,
      fallbackBlockReason: "FAILURE_NOT_ELIGIBLE",
    });
    expect(external.calls).toBe(0);
  });

  it("never invokes either provider when robots are disallowed", async () => {
    const local = provider("LOCAL", async (input) => success(input));
    const external = provider("EXTERNAL", async (input) => success(input));
    const blocked = request("robots-blocked");
    blocked.robots.status = "DISALLOWED";
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true },
    }).routePage(blocked);

    expect(result).toMatchObject({ status: "BLOCKED", failureClass: "ROBOTS_DENIED" });
    expect(local.calls).toBe(0);
    expect(external.calls).toBe(0);
  });

  it("keeps fallback blocked by default even when the local failure is eligible", async () => {
    const local = provider("LOCAL", async (input) => success(input, {
      content: "<div id='root'></div><script src='/a.js'></script><script src='/b.js'></script>",
    }));
    const external = provider("EXTERNAL", async (input) => success(input));
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
    }).routePage(request("safe-default"));

    expect(result).toMatchObject({
      status: "BLOCKED",
      failureClass: "JS_REQUIRED",
      fallbackEligible: true,
      fallbackBlockReason: "POLICY_DISABLED",
    });
    expect(external.calls).toBe(0);
  });

  it("does not invoke fallback when local crawling succeeds", async () => {
    const local = provider("LOCAL", async (input) => success(input));
    const external = provider("EXTERNAL", async (input) => success(input));
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true },
    }).routePage(request("local-success"));

    expect(result).toMatchObject({ status: "SUCCEEDED", source: "LOCAL", fallbackUsed: false });
    expect(external.calls).toBe(0);
  });

  it("rejects a provider cross-domain final URL and does not route around it", async () => {
    const local = provider("LOCAL", async (input) => success(input, {
      finalUrl: "https://directory.example.net/copied-profile",
      canonicalUrl: "https://directory.example.net/copied-profile",
    }));
    const external = provider("EXTERNAL", async (input) => success(input));
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true },
    }).routePage(request("cross-domain"));

    expect(result).toMatchObject({ status: "FAILED", failureClass: "CROSS_DOMAIN" });
    expect(external.calls).toBe(0);
  });
});

describe("crawl budgets, idempotency, audit, and content deduplication", () => {
  it("atomically caps 20 concurrent pages at 10 actual fetch attempts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const local = provider("LOCAL", async (input) => {
      await gate;
      return success(input);
    });
    const budget = new CrawlBudgetLedger(limits({ maxFetchAttemptsPerCampaign: 10 }));
    const router = new CrawlRouter({ localProvider: local, budget });
    const pending = Array.from({ length: 20 }, (_, index) => router.routePage(request(`page-${index}`)));
    release();
    const results = await Promise.all(pending);

    expect(local.calls).toBe(10);
    expect(budget.campaignSnapshot("campaign-1").fetchAttempts).toBe(10);
    expect(results.filter((item) => item.status === "SUCCEEDED")).toHaveLength(10);
    expect(results.filter((item) => item.status === "BUDGET_EXHAUSTED")).toHaveLength(10);
  });

  it("performs zero provider calls when the campaign fetch budget is zero", async () => {
    const local = provider("LOCAL", async (input) => success(input));
    const router = new CrawlRouter({
      localProvider: local,
      budget: new CrawlBudgetLedger(limits({ maxFetchAttemptsPerCampaign: 0 })),
    });
    const result = await router.routePage(request("zero-budget"));

    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(local.calls).toBe(0);
  });

  it("blocks an external fallback before invocation when either provider cost budget is zero", async () => {
    const local = provider("LOCAL", async (input) => success(input, {
      content: "<div id='root'></div><script src='/a.js'></script><script src='/b.js'></script>",
    }));
    const external = provider("EXTERNAL", async (input) => success(input), { costUnits: 1 });
    const router = new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits({
        maxProviderCostUnitsPerCampaign: 0,
        maxProviderCostUnitsPerAccount: 0,
      })),
      policy: { allowExternalFallback: true },
    });
    const result = await router.routePage(request("zero-cost-budget"));

    expect(result).toMatchObject({
      status: "BUDGET_EXHAUSTED",
      failureClass: "BUDGET_EXHAUSTED",
      fallbackBlockReason: "BUDGET_EXHAUSTED",
    });
    expect(local.calls).toBe(1);
    expect(external.calls).toBe(0);
  });

  it("enforces distinct campaign and account page budgets", async () => {
    const local = provider("LOCAL", async (input) => success(input));
    const budget = new CrawlBudgetLedger(limits({ maxPagesPerCampaign: 3, maxPagesPerAccount: 2 }));
    const router = new CrawlRouter({ localProvider: local, budget });
    const results = await Promise.all([
      router.routePage(request("one")),
      router.routePage(request("two")),
      router.routePage(request("three")),
    ]);

    expect(results.filter((item) => item.status === "SUCCEEDED")).toHaveLength(2);
    expect(results.filter((item) => item.status === "BUDGET_EXHAUSTED")).toHaveLength(1);
    expect(local.calls).toBe(2);
  });

  it("coalesces an identical request and emits a stable hash-only replay audit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const local = provider("LOCAL", async (input) => {
      await gate;
      return success(input);
    });
    const audits: CrawlDecisionAudit[] = [];
    const router = new CrawlRouter({
      localProvider: local,
      budget: new CrawlBudgetLedger(limits()),
      audit: (decision) => audits.push(decision),
    });
    const input = request("same-request");
    const first = router.routePage(input);
    const second = router.routePage({ ...input });
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.idempotencyKey).toBe(right.idempotencyKey);
    expect(left.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(left.idempotencyKey).not.toContain("buyer.example.com");
    expect(local.calls).toBe(1);
    expect(right.replayed).toBe(true);
    expect(right.snapshots).toEqual([]);
    expect(audits.map((item) => item.status).sort()).toEqual(["REPLAYED", "SUCCEEDED"]);
  });

  it("suppresses downstream processing for the same content hash on a second URL", async () => {
    const body = "<html><body>Identical official profile.</body></html>";
    const local = provider("LOCAL", async (input) => success(input, { content: body }));
    const router = new CrawlRouter({
      localProvider: local,
      budget: new CrawlBudgetLedger(limits()),
    });
    const first = await router.routePage(request("copy-a"));
    const second = await router.routePage(request("copy-b"));

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.shouldProcess).toBe(true);
    expect(second.shouldProcess).toBe(false);
    expect(second.snapshots[0]).toMatchObject({ duplicateContent: true, outcome: "SUCCESS" });
  });

  it("creates failure snapshots for 429 and a stable replay without a second fetch", async () => {
    const local = provider("LOCAL", async (input) => success(input, { httpStatus: 429, content: null }));
    const router = new CrawlRouter({
      localProvider: local,
      budget: new CrawlBudgetLedger(limits()),
    });
    const input = request("rate-replay");
    const first = await router.routePage(input);
    const second = await router.routePage(input);

    expect(first.snapshots[0]).toMatchObject({
      outcome: "FAILURE",
      httpStatus: 429,
      failureClass: "RATE_LIMITED",
    });
    expect(second.replayed).toBe(true);
    expect(local.calls).toBe(1);
  });

  it("classifies an enforced provider timeout and never invokes fallback", async () => {
    const local = provider("LOCAL", (_input, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    }));
    const external = provider("EXTERNAL", async (input) => success(input));
    const result = await new CrawlRouter({
      localProvider: local,
      fallbackProvider: external,
      budget: new CrawlBudgetLedger(limits()),
      policy: { allowExternalFallback: true, timeoutMs: 5 },
    }).routePage(request("real-timeout"));

    expect(result).toMatchObject({ status: "FAILED", failureClass: "TIMEOUT", fallbackUsed: false });
    expect(external.calls).toBe(0);
  });
});

describe("executable WO-08 crawl shadow", () => {
  it("reports deterministic stub-only routing with no network, paid calls, or writes", async () => {
    const report = await runCrawlRoutingShadow(() => new Date(checkedAt));

    expect(report).toMatchObject({
      fixtureSet: "WO-08-crawl-router-v1",
      syntheticFixtures: true,
      safety: {
        networkCalls: 0,
        paidProviderCalls: 0,
        externalWrites: 0,
        liveProvidersEnabled: false,
      },
      verdict: "HOLD",
    });
    expect(report.totals).toMatchObject({
      cases: 8,
      fallbackCalls: 2,
      fallbackSuccesses: 2,
      duplicateContentSuppressions: 1,
      auditDecisions: 8,
    });
    expect(report.cases.find((item) => item.id === "rate-limited")).toMatchObject({
      failureClass: "RATE_LIMITED",
      fallbackUsed: false,
    });
    expect(report.cases.find((item) => item.id === "policy-disabled")).toMatchObject({
      status: "BLOCKED",
      fallbackBlockReason: "POLICY_DISABLED",
    });
  });
});
