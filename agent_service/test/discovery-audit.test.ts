import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import {
  analyzeCompany,
  CampaignPageBudget,
  LlmCallBudget,
  prepareLeadForDiscoveryVerification,
} from "../src/search/discovery.js";
import { DEMAND_POLICY_VERSION, type SearchResult, type WebsiteAssessment } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("auditable discovery persistence", () => {
  it("atomically reserves the campaign page budget across concurrent account work", () => {
    const budget = new CampaignPageBudget(10);
    const first = budget.reserve(8)!;
    const second = budget.reserve(8)!;
    expect(first.limit).toBe(8);
    expect(second.limit).toBe(2);
    expect(budget.reserve(1)).toBeNull();
    expect(budget.snapshot()).toEqual({
      limit: 10,
      consumedPages: 0,
      reservedPages: 10,
      remainingPages: 0,
    });

    first.finalize(3);
    expect(budget.snapshot()).toMatchObject({ consumedPages: 3, reservedPages: 2, remainingPages: 5 });
    const third = budget.reserve(5)!;
    expect(third.limit).toBe(5);
    second.finalize(2);
    third.finalize(9);
    expect(budget.snapshot()).toEqual({
      limit: 10,
      consumedPages: 10,
      reservedPages: 0,
      remainingPages: 0,
    });
  });

  it("restarts an exhausted lead at a clean verification pass during rediscovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-discovery-restart-"));
    dirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "Rediscovery",
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 5,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const leadId = db.upsertLead({
      campaignId,
      company: "Example Engineering",
      domain: "example.invalid",
      website: "https://example.invalid",
      country: "Vietnam",
      buyerType: "integrator",
      product: "sample components",
      fitScore: 30,
      intentScore: 25,
      activityScore: 20,
      contactScore: 0,
      channelScore: 0,
      totalScore: 75,
      grade: "SILVER",
      demandEvidenceQualified: true,
      demandPolicyVersion: DEMAND_POLICY_VERSION,
      demandStage: "RECENT_PROCUREMENT",
      demandEvidence: [{ sourceUrl: "https://example.invalid/rfq" }],
      sendEligible: false,
      eligibilityReasons: ["named contact missing"],
    });
    db.transitionLead(leadId, "VERIFYING", "test", "prepare enrichment");
    db.transitionLead(leadId, "ENRICHING", "test", "prepare enrichment");
    expect(db.completeEnrichmentAttempt(leadId, 0, "2099-01-01T00:00:00.000Z")).toBe(true);
    expect(db.completeEnrichmentAttempt(leadId, 1, "2099-01-02T00:00:00.000Z")).toBe(true);
    expect(db.completeEnrichmentAttempt(leadId, 2, "2099-01-03T00:00:00.000Z")).toBe(true);

    const exhausted = db.getLead(leadId)!;
    prepareLeadForDiscoveryVerification(db, leadId, exhausted.status as never);

    expect(db.getLead(leadId)).toMatchObject({
      status: "VERIFYING",
      enrichment_attempts: 0,
      enrichment_next_at: null,
    });
    db.close();
  });

  it("rejects model citations that were outside the bounded company-analysis prompt", async () => {
    const visibleResults: SearchResult[] = Array.from({ length: 24 }, (_, index) => ({
      title: `Visible source ${index}`,
      url: `https://evidence-${index}.example.com/item`,
      snippet: "Public company evidence",
      sourceType: "search",
      sourceDate: null,
      query: "test",
    }));
    const hiddenResult: SearchResult = {
      title: "Hidden source",
      url: "https://hidden.example.com/item",
      snippet: "This source is beyond the prompt limit",
      sourceType: "search",
      sourceDate: null,
      query: "test",
    };
    const assessment: WebsiteAssessment = {
      url: "https://company.example.com/",
      domain: "example.com",
      reachable: true,
      parked: false,
      title: "Example Company",
      text: "Example Company industrial systems",
      emails: [],
      phones: [],
      activitySignals: ["website reachable"],
      activityScore: 10,
      pages: [],
    };
    const json = vi.fn(async () => ({
      companyName: "Example Company",
      companyType: "integrator",
      fitScore: 30,
      matchedProducts: ["sample components", "sample products"],
      risks: [],
      recommendedOffer: "sample components",
      researchSummary: "Qualified using a hidden citation",
      evidence: [{ claim: "Hidden evidence", sourceUrl: hiddenResult.url }],
    }));

    const analysis = await analyzeCompany(
      {
        company: "Example Company",
        domain: "example.com",
        website: assessment.url,
        results: [...visibleResults, hiddenResult],
        seed: null,
      },
      assessment,
      [...visibleResults, hiddenResult],
      {
        market: "Vietnam",
        productTerms: ["sample components", "sample products"],
        buyerTerms: ["integrator"],
      } as never,
      "sample components",
      { brief: {}, casePatterns: [] } as never,
      { isConfigured: () => true, json } as never,
      {
        MAX_COMPANY_PAGES: 3,
        OPENAI_RESEARCH_MODEL: "",
        OPENAI_MODEL: "test-model",
        COMPANY_ACTIVITY_MAX_AGE_DAYS: 548,
      } as never,
      new LlmCallBudget(1),
    );

    expect(json).toHaveBeenCalledOnce();
    const prompt = JSON.parse(String(json.mock.calls[0]?.[2])) as {
      public_evidence: Array<{ url: string }>;
    };
    expect(prompt.public_evidence).toHaveLength(24);
    expect(prompt.public_evidence.some((item) => item.url === hiddenResult.url)).toBe(false);
    expect(analysis.qualified).toBe(false);
  });

  it("keeps a publicly evidenced broad-ICP company without recent purchase intent", async () => {
    const source: SearchResult = {
      title: "Example Integrator sample solutions",
      url: "https://company.example.com/solutions",
      snippet: "Industrial sample application integration and sample components replacement services.",
      sourceType: "official_website",
      sourceDate: null,
      query: "test",
    };
    const assessment: WebsiteAssessment = {
      url: "https://company.example.com/",
      domain: "example.com",
      reachable: true,
      parked: false,
      title: "Example Integrator",
      text: source.snippet,
      emails: [],
      phones: [],
      activitySignals: [],
      activityScore: 0,
      pages: [{ url: source.url, title: source.title, text: source.snippet }],
    };
    const analysis = await analyzeCompany(
      {
        company: "Example Integrator",
        domain: "example.com",
        website: assessment.url,
        results: [source],
        seed: null,
      },
      assessment,
      [source],
      {
        market: "Vietnam",
        productTerms: ["sample components", "sample products"],
        buyerTerms: ["integrator"],
      } as never,
      "sample components",
      { brief: {}, casePatterns: [] } as never,
      {
        isConfigured: () => true,
        json: vi.fn(async () => ({
          companyName: "Example Integrator",
          companyType: "integrator",
          fitScore: 14,
          matchedProducts: ["sample components"],
          risks: [],
          recommendedOffer: "sample components",
          researchSummary: "Public evidence confirms relevant integration services.",
          evidence: [{ claim: source.snippet, sourceUrl: source.url }],
        })),
      } as never,
      {
        MAX_COMPANY_PAGES: 3,
        OPENAI_RESEARCH_MODEL: "",
        OPENAI_MODEL: "test-model",
        COMPANY_ACTIVITY_MAX_AGE_DAYS: 548,
      } as never,
      new LlmCallBudget(1),
    );

    expect(analysis.qualified).toBe(true);
    expect(analysis.demandEvidenceQualified).toBe(false);
  });

  it.each([
    {
      label: "admits product fit without a buyer-term match or recent intent",
      url: "https://fallback.example.com/solutions",
      text: "sample components, sample products, and sample application systems are available.",
      productTerms: ["sample components", "sample products", "sample application"],
      buyerTerms: ["integrator"],
      expectedFitScore: 12,
      expectedQualified: true,
      expectedProductMatches: 3,
    },
    {
      label: "keeps a low-scoring exact product match in the research inventory",
      url: "https://fallback.example.com/solutions",
      text: "sample components are available for industrial applications.",
      productTerms: ["sample components"],
      buyerTerms: ["integrator"],
      expectedFitScore: 4,
      expectedQualified: true,
      expectedProductMatches: 1,
    },
    {
      label: "rejects a high fit score without a product match",
      url: "https://fallback.example.com/about",
      text: "Distributor, integrator, contractor, and engineering company.",
      productTerms: ["sample components"],
      buyerTerms: ["distributor", "integrator", "contractor", "engineering company"],
      expectedFitScore: 12,
      expectedQualified: false,
      expectedProductMatches: 0,
    },
    {
      label: "rejects a high product fit score without public evidence",
      url: "ftp://fallback.example.com/solutions",
      text: "sample components, sample products, and sample application systems are available.",
      productTerms: ["sample components", "sample products", "sample application"],
      buyerTerms: ["integrator"],
      expectedFitScore: 12,
      expectedQualified: false,
      expectedProductMatches: 3,
    },
  ])("applies the broad-ICP fallback consistently: $label", async ({
    url,
    text,
    productTerms,
    buyerTerms,
    expectedFitScore,
    expectedQualified,
    expectedProductMatches,
  }) => {
    const assessment: WebsiteAssessment = {
      url,
      domain: "example.com",
      reachable: true,
      parked: false,
      title: "Example Co",
      text,
      emails: [],
      phones: [],
      activitySignals: [],
      activityScore: 0,
      pages: url.startsWith("https://") ? [{ url, title: "Example Co", text }] : [],
    };
    const json = vi.fn();

    const analysis = await analyzeCompany(
      {
        company: "Example Co",
        domain: "example.com",
        website: url,
        results: [],
        seed: null,
      },
      assessment,
      [],
      { market: "Vietnam", productTerms, buyerTerms } as never,
      "sample components",
      { brief: {}, casePatterns: [] } as never,
      { isConfigured: () => false, json } as never,
      {
        MAX_COMPANY_PAGES: 3,
        OPENAI_RESEARCH_MODEL: "",
        OPENAI_MODEL: "test-model",
        COMPANY_ACTIVITY_MAX_AGE_DAYS: 548,
      } as never,
      new LlmCallBudget(1),
    );

    expect(json).not.toHaveBeenCalled();
    expect(analysis.fitScore).toBe(expectedFitScore);
    expect(analysis.matchedProducts).toHaveLength(expectedProductMatches);
    expect(analysis.demandEvidenceQualified).toBe(false);
    expect(analysis.qualified).toBe(expectedQualified);
  });

  it("records every candidate stage and updates it without duplication", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-discovery-audit-"));
    dirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const campaignId = db.createCampaign({
      name: "Malaysia sample application",
      market: "Malaysia",
      product: "sample products",
      buyerType: "integrator",
      targetCount: 15,
      createdBy: "test",
      dailyLimit: 50,
      hourlyLimit: 20,
      followupDays: [3, 7, 14],
    });
    db.upsertDiscoveryCandidate({
      campaignId,
      domain: "example.com",
      company: "Example Engineering",
      website: "https://example.com",
      round: 1,
      stage: "WEBSITE_RESEARCH",
      outcome: "IN_PROGRESS",
      reason: "selected",
      sourceCount: 2,
    });
    db.upsertDiscoveryCandidate({
      campaignId,
      domain: "example.com",
      company: "Example Engineering",
      website: "https://example.com",
      round: 1,
      stage: "CONTACT_ENRICHMENT",
      outcome: "ENRICHMENT_PENDING",
      reason: "named contact not found",
      sourceCount: 5,
      fitScore: 28,
      intentScore: 18,
      activityScore: 17,
      buyingLikelihood: "HIGH",
      evidence: {
        demandPolicyVersion: DEMAND_POLICY_VERSION,
        demandEvidenceQualified: true,
        demandStage: "RECENT_PROCUREMENT",
        demandEvidence: [{ sourceUrl: "https://example.com/rfq/1", score: 25 }],
      },
    });
    db.upsertDiscoveryCandidate({
      campaignId,
      domain: "example.com",
      company: "Example Engineering",
      website: "https://example.com",
      round: 4,
      stage: "CONTACT_ENRICHMENT",
      outcome: "ENRICHMENT_PENDING",
      reason: "contact evidence refreshed",
      sourceCount: 6,
      evidence: { contactEvidence: [{ url: "https://example.com/team" }] },
    });
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.listCampaignCandidates(campaignId)).toHaveLength(1);
    expect(db.listCampaignCandidates(campaignId)[0]).toMatchObject({
      outcome: "ENRICHMENT_PENDING",
      buying_likelihood: "HIGH",
      source_count: 6,
    });
    expect(JSON.parse(String(db.listCampaignCandidates(campaignId)[0]?.evidence_json))).toMatchObject({
      demandStage: "RECENT_PROCUREMENT",
      demandEvidenceQualified: true,
      demandEvidence: [{ sourceUrl: "https://example.com/rfq/1", score: 25 }],
      contactEvidence: [{ url: "https://example.com/team" }],
    });
    expect(db.getCampaignDiscoveryStats(campaignId)).toEqual([
      expect.objectContaining({ outcome: "ENRICHMENT_PENDING", count: 1 }),
    ]);
    db.close();
  });
});
