import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
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
  CrawlRouteResult,
} from "./crawl-contracts.js";
import { CrawlBudgetLedger, CrawlRouter } from "./crawl-router.js";

class ShadowFixtureProvider implements CrawlProvider {
  readonly mode: CrawlProviderMode = "SHADOW";
  readonly calls: string[] = [];

  constructor(
    readonly id: string,
    readonly kind: CrawlProviderKind,
    readonly enabled: boolean,
    readonly configured: boolean,
    private readonly fixtures: ReadonlyMap<string, CrawlPageObservation>,
    private readonly costUnits: number,
  ) {}

  async crawlAccount(
    request: CrawlAccountRequest,
    context: CrawlProviderContext,
  ): Promise<CrawlAccountObservation> {
    const pages: CrawlPageObservation[] = [];
    for (const page of request.pages) pages.push(await this.crawlPage(page, context));
    return { pages, cursor: null };
  }

  async crawlPage(
    request: CrawlPageRequest,
    _context: CrawlProviderContext,
  ): Promise<CrawlPageObservation> {
    this.calls.push(request.requestedUrl);
    const fixture = this.fixtures.get(new URL(request.requestedUrl).pathname);
    if (!fixture) {
      return {
        requestedUrl: request.requestedUrl,
        robotsStatus: request.robots.status,
        error: { code: "FIXTURE_NOT_FOUND" },
        actualCostUnits: 0,
      };
    }
    return structuredClone(fixture);
  }

  classifyFailure(_observation: CrawlPageObservation): CrawlFailureClass | null {
    return null;
  }

  estimateCost(_request: CrawlPageRequest | CrawlAccountRequest): { costUnits: number } {
    return { costUnits: this.costUnits };
  }

  supportsContentType(contentType: string): boolean {
    return ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]
      .includes(contentType.split(";", 1)[0]!.toLowerCase());
  }
}

export interface CrawlShadowCaseResult {
  id: string;
  status: CrawlRouteResult["status"];
  source: CrawlRouteResult["source"];
  failureClass: CrawlRouteResult["failureClass"];
  fallbackUsed: boolean;
  fallbackBlockReason: CrawlRouteResult["fallbackBlockReason"];
  fetchAttempts: number;
  shouldProcess: boolean;
}

export interface CrawlShadowReport {
  fixtureSet: "WO-08-crawl-router-v1";
  generatedAt: string;
  syntheticFixtures: true;
  cases: CrawlShadowCaseResult[];
  totals: {
    cases: number;
    localCalls: number;
    fallbackCalls: number;
    fallbackSuccesses: number;
    blockedOrFailed: number;
    downstreamProcessCalls: number;
    duplicateContentSuppressions: number;
    auditDecisions: number;
  };
  safety: {
    networkCalls: 0;
    paidProviderCalls: 0;
    externalWrites: 0;
    liveProvidersEnabled: false;
  };
  verdict: "HOLD";
  verdictReason: string;
}

const publicResolution = {
  hostname: "alpha.example.com",
  addresses: [{ address: "8.8.8.8", family: 4 as const }],
  checkedAt: "2026-07-20T00:00:00.000Z",
};

function request(id: string, robotsStatus: CrawlPageRequest["robots"]["status"] = "ALLOWED"): CrawlPageRequest {
  const requestedUrl = `https://alpha.example.com/${id}`;
  return {
    campaignId: "shadow-campaign-wo08",
    accountId: "shadow-account-alpha",
    runId: `shadow-run-${id}`,
    requestedUrl,
    officialBaseUrl: "https://alpha.example.com/",
    pageType: "OTHER",
    robots: {
      status: robotsStatus,
      checkedUrl: "https://alpha.example.com/robots.txt",
      checkedAt: "2026-07-20T00:00:00.000Z",
    },
    resolution: publicResolution,
  };
}

function successfulPage(path: string, content: string): CrawlPageObservation {
  return {
    requestedUrl: `https://alpha.example.com/${path}`,
    finalUrl: `https://alpha.example.com/${path}`,
    canonicalUrl: `https://alpha.example.com/${path}`,
    httpStatus: 200,
    robotsStatus: "ALLOWED",
    contentType: "text/html; charset=utf-8",
    content,
    bytes: Buffer.byteLength(content),
    elapsedMs: 5,
    actualCostUnits: 0,
    structureRecovered: true,
  };
}

function caseResult(id: string, result: CrawlRouteResult): CrawlShadowCaseResult {
  return {
    id,
    status: result.status,
    source: result.source,
    failureClass: result.failureClass,
    fallbackUsed: result.fallbackUsed,
    fallbackBlockReason: result.fallbackBlockReason,
    fetchAttempts: result.snapshots.length,
    shouldProcess: result.shouldProcess,
  };
}

export async function runCrawlRoutingShadow(
  now: () => Date = () => new Date(),
): Promise<CrawlShadowReport> {
  const duplicateBody = "<html><body>Same public company profile content.</body></html>";
  const jsShell = "<html><body><div id='root'></div><script src='/a.js'></script><script src='/b.js'></script></body></html>";
  const local = new ShadowFixtureProvider(
    "local-shadow",
    "LOCAL",
    true,
    true,
    new Map([
      ["/local-ok", successfulPage("local-ok", "<html><body>Official public company profile and product catalogue.</body></html>")],
      ["/js-required", successfulPage("js-required", jsShell)],
      ["/access-blocked", {
        requestedUrl: "https://alpha.example.com/access-blocked",
        finalUrl: "https://alpha.example.com/access-blocked",
        httpStatus: 403,
        robotsStatus: "ALLOWED",
        contentType: "text/html",
        content: null,
        elapsedMs: 3,
        actualCostUnits: 0,
      }],
      ["/rate-limited", {
        requestedUrl: "https://alpha.example.com/rate-limited",
        finalUrl: "https://alpha.example.com/rate-limited",
        httpStatus: 429,
        robotsStatus: "ALLOWED",
        contentType: "text/html",
        content: null,
        elapsedMs: 3,
        actualCostUnits: 0,
      }],
      ["/duplicate-a", successfulPage("duplicate-a", duplicateBody)],
      ["/duplicate-b", successfulPage("duplicate-b", duplicateBody)],
      ["/policy-disabled", successfulPage("policy-disabled", jsShell)],
    ]),
    0,
  );
  const fallback = new ShadowFixtureProvider(
    "external-shadow",
    "EXTERNAL",
    true,
    true,
    new Map([
      ["/js-required", successfulPage(
        "js-required",
        "<html><body>Rendered official profile with sample use-case projects.</body></html>",
      )],
      ["/access-blocked", successfulPage(
        "access-blocked",
        "<html><body>Recovered public product and project information.</body></html>",
      )],
    ]),
    1,
  );
  const audits: CrawlDecisionAudit[] = [];
  const budgetLimits = {
    maxPagesPerCampaign: 20,
    maxPagesPerAccount: 20,
    maxFetchAttemptsPerCampaign: 20,
    maxProviderCostUnitsPerCampaign: 10,
    maxProviderCostUnitsPerAccount: 10,
  };
  const router = new CrawlRouter({
    localProvider: local,
    fallbackProvider: fallback,
    budget: new CrawlBudgetLedger(budgetLimits),
    policy: { allowExternalFallback: true, allowLiveNetwork: false },
    audit: (decision) => audits.push(decision),
    now,
  });

  const cases: CrawlShadowCaseResult[] = [];
  for (const id of [
    "local-ok",
    "js-required",
    "access-blocked",
    "rate-limited",
    "robots-denied",
    "duplicate-a",
    "duplicate-b",
  ]) {
    const result = await router.routePage(request(id, id === "robots-denied" ? "DISALLOWED" : "ALLOWED"));
    cases.push(caseResult(id, result));
  }

  const safeDefaultRouter = new CrawlRouter({
    localProvider: local,
    fallbackProvider: fallback,
    budget: new CrawlBudgetLedger(budgetLimits),
    audit: (decision) => audits.push(decision),
    now,
  });
  cases.push(caseResult("policy-disabled", await safeDefaultRouter.routePage(request("policy-disabled"))));

  return {
    fixtureSet: "WO-08-crawl-router-v1",
    generatedAt: now().toISOString(),
    syntheticFixtures: true,
    cases,
    totals: {
      cases: cases.length,
      localCalls: local.calls.length,
      fallbackCalls: fallback.calls.length,
      fallbackSuccesses: cases.filter((item) => item.source === "EXTERNAL" && item.status === "SUCCEEDED").length,
      blockedOrFailed: cases.filter((item) => item.status === "BLOCKED" || item.status === "FAILED").length,
      downstreamProcessCalls: cases.filter((item) => item.shouldProcess).length,
      duplicateContentSuppressions: cases.filter((item) =>
        item.status === "SUCCEEDED" && !item.shouldProcess).length,
      auditDecisions: audits.length,
    },
    safety: {
      networkCalls: 0,
      paidProviderCalls: 0,
      externalWrites: 0,
      liveProvidersEnabled: false,
    },
    verdict: "HOLD",
    verdictReason: "Synthetic routing controls pass, but the required three-market business sample is not authorized or measured.",
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const report = await runCrawlRoutingShadow();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
