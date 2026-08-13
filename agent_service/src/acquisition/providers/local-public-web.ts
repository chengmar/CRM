import { z } from "zod";
import type {
  CrawlAccountObservation,
  CrawlAccountRequest,
  CrawlFailureClass,
  CrawlPageObservation,
  CrawlPageRequest,
  CrawlProvider,
  CrawlProviderContext,
} from "../crawl-contracts.js";
import {
  assessWebsite,
  type WebsiteAddressResolver,
} from "../../search/website.js";
import type { WebsiteAssessment } from "../../types.js";

const EmailEvidenceSchema = z.object({
  email: z.string().trim().min(3).max(320),
  context: z.string().max(5_000),
  method: z.enum(["mailto", "cloudflare", "text"]).optional(),
  scopeId: z.string().max(500).optional(),
}).strict();

const WebsitePageSchema = z.object({
  url: z.string().url().max(2_000),
  title: z.string().max(1_000),
  text: z.string().max(300_000),
  emails: z.array(z.string().trim().min(3).max(320)).max(1_000).optional(),
  emailEvidence: z.array(EmailEvidenceSchema).max(1_000).optional(),
  contactContexts: z.array(z.string().max(5_000)).max(1_000).optional(),
  evidenceScopes: z.array(z.object({
    id: z.string().max(500),
    text: z.string().max(20_000),
    ambiguous: z.boolean(),
    emails: z.array(z.object({
      email: z.string().trim().min(3).max(320),
      method: z.enum(["mailto", "cloudflare", "text"]),
    }).strict()).max(1_000),
  }).strict()).max(1_000).optional(),
}).strict();

export const LocalWebsiteAssessmentSchema = z.object({
  url: z.string().url().max(2_000),
  domain: z.string().trim().min(1).max(253),
  reachable: z.boolean(),
  parked: z.boolean(),
  title: z.string().max(1_000),
  text: z.string().max(300_000),
  emails: z.array(z.string().trim().min(3).max(320)).max(1_000),
  phones: z.array(z.string().trim().min(1).max(100)).max(100),
  recentActivityAt: z.string().datetime({ offset: true }).nullable().optional(),
  activitySignals: z.array(z.string().max(500)).max(100),
  activityScore: z.number().finite().min(0),
  pages: z.array(WebsitePageSchema).max(20),
}).strict();

export interface LocalPublicWebsiteProviderOptions {
  enabled: boolean;
  userAgent: string;
  resolver?: WebsiteAddressResolver;
  assessor?: typeof assessWebsite;
}

function failureFromAssessment(assessment: WebsiteAssessment): CrawlFailureClass {
  const evidence = assessment.activitySignals.join(" ").toLowerCase();
  if (evidence.includes("robots.txt disallows")) return "ROBOTS_DENIED";
  if (evidence.includes("unsafe") || evidence.includes("private") || evidence.includes("policy")) {
    return "UNSAFE_TARGET";
  }
  if (evidence.includes("timeout") || evidence.includes("abort")) return "TIMEOUT";
  if (evidence.includes("cross-domain")) return "CROSS_DOMAIN";
  return "NETWORK_ERROR";
}

export class LocalPublicWebsiteProvider implements CrawlProvider {
  readonly id = "LOCAL_PUBLIC_WEB";
  readonly kind = "LOCAL" as const;
  readonly mode = "LIVE" as const;
  readonly configured: boolean;
  private readonly userAgent: string;
  private readonly resolver: WebsiteAddressResolver | undefined;
  private readonly assessor: typeof assessWebsite;

  constructor(readonly enabled: boolean, options: Omit<LocalPublicWebsiteProviderOptions, "enabled">) {
    this.userAgent = String(options.userAgent ?? "").trim();
    this.configured = this.userAgent.length > 0;
    this.resolver = options.resolver;
    this.assessor = options.assessor ?? assessWebsite;
  }

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
    context: CrawlProviderContext,
  ): Promise<CrawlPageObservation> {
    if (context.dryRun || !this.enabled || !this.configured) {
      throw new Error("Local public website live adapter is not active");
    }
    const startedAt = Date.now();
    const maxPages = Math.max(1, Math.min(20, Math.trunc(request.maxPages ?? 1)));
    const assessment = await this.assessor(
      request.requestedUrl,
      this.userAgent,
      maxPages,
      this.resolver,
      context.signal,
    );
    const parsed = LocalWebsiteAssessmentSchema.parse(assessment) as WebsiteAssessment;
    if (!parsed.reachable || parsed.pages.length === 0) {
      const failure = failureFromAssessment(parsed);
      return {
        requestedUrl: request.requestedUrl,
        finalUrl: null,
        canonicalUrl: null,
        httpStatus: null,
        robotsStatus: failure === "ROBOTS_DENIED" ? "DISALLOWED" : request.robots.status,
        contentType: null,
        content: null,
        bytes: 0,
        elapsedMs: Date.now() - startedAt,
        actualCostUnits: 0,
        truncated: false,
        structureRecovered: false,
        timedOut: failure === "TIMEOUT",
        error: { code: failure },
      };
    }
    const finalUrl = parsed.pages[0]?.url ?? parsed.url;
    const content = JSON.stringify(parsed);
    return {
      requestedUrl: request.requestedUrl,
      finalUrl,
      canonicalUrl: finalUrl,
      httpStatus: 200,
      robotsStatus: request.robots.status,
      contentType: "application/json",
      content,
      bytes: Buffer.byteLength(content),
      elapsedMs: Date.now() - startedAt,
      actualCostUnits: 0,
      truncated: false,
      structureRecovered: true,
      timedOut: false,
      error: null,
      finalResolution: request.resolution,
    };
  }

  classifyFailure(_observation: CrawlPageObservation): CrawlFailureClass | null {
    return null;
  }

  estimateCost(_request: CrawlPageRequest | CrawlAccountRequest): { costUnits: number } {
    return { costUnits: 0 };
  }

  supportsContentType(contentType: string): boolean {
    return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  }
}

export function parseLocalWebsiteAssessment(content: string | Uint8Array): WebsiteAssessment {
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  return LocalWebsiteAssessmentSchema.parse(JSON.parse(text)) as WebsiteAssessment;
}
