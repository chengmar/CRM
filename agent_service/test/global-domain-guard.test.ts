import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase, type LeadInput } from "../src/db.js";
import { DiscoveryService } from "../src/search/discovery.js";
import { DEMAND_POLICY_VERSION, type SearchResult, type WebsiteAssessment } from "../src/types.js";

const databases: AgentDatabase[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createCampaign(db: AgentDatabase, name: string): string {
  return db.createCampaign({
    name,
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 5,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
}

function directLead(campaignId: string | null, domain: string, company = "Direct Guard Company"): LeadInput {
  return {
    campaignId,
    company,
    domain,
    website: `https://${domain.toLowerCase()}/`,
    country: "Vietnam",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 20,
    activityScore: 15,
    contactScore: 0,
    channelScore: 0,
    totalScore: 65,
    grade: "BRONZE",
    demandEvidenceQualified: false,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "INDUSTRY_FIT",
    demandEvidence: [],
    sendEligible: false,
    eligibilityReasons: ["fixture"],
  };
}

const result: SearchResult = {
  title: "Global Guard Company",
  url: "https://global-guard.example/",
  snippet: "Global Guard Company supplies sample components and sample products to integrators.",
  sourceType: "search",
  sourceDate: "2026-07-20T00:00:00.000Z",
  query: "fixture",
};

function assessment(): WebsiteAssessment {
  return {
    url: result.url,
    domain: "global-guard.example",
    reachable: true,
    parked: false,
    title: result.title,
    text: result.snippet,
    emails: [],
    phones: [],
    recentActivityAt: result.sourceDate,
    activitySignals: ["website reachable"],
    activityScore: 20,
    pages: [{
      url: result.url,
      title: result.title,
      text: result.snippet,
      evidenceScopes: [],
      contactContexts: [],
    }],
  };
}

function llmFixture() {
  return {
    isConfigured: () => true,
    json: async (purpose: string) => {
      if (purpose === "market_research_plan") {
        return {
          market: "Vietnam",
          productTerms: ["sample components", "sample products"],
          buyerTerms: ["integrator"],
          queries: ["global guard candidate query"],
        };
      }
      if (purpose === "search_result_company_extraction") return { candidates: [] };
      if (purpose === "company_due_diligence") {
        return {
          companyName: "Global Guard Company",
          companyType: "integrator",
          fitScore: 30,
          matchedProducts: ["sample components", "sample products"],
          risks: [],
          recommendedOffer: "sample components",
          researchSummary: "Qualified fixture",
          evidence: [{ claim: "Official company evidence", sourceUrl: result.url }],
        };
      }
      if (purpose === "decision_maker_enrichment") return { contacts: [] };
      return {};
    },
  };
}

describe("campaign-scoped domain isolation", () => {
  it("keeps same-campaign upserts idempotent while allowing an isolated lead in another campaign", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-global-domain-api-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "agent.db");
    const firstDb = new AgentDatabase(databasePath);
    const secondDb = new AgentDatabase(databasePath);
    databases.push(firstDb, secondDb);
    const firstCampaignId = createCampaign(firstDb, "Direct first campaign");
    const secondCampaignId = createCampaign(secondDb, "Direct second campaign");

    const leadId = firstDb.upsertLead(directLead(firstCampaignId, "direct-guard.example"));
    expect(firstDb.upsertLead(directLead(
      firstCampaignId,
      "DIRECT-GUARD.EXAMPLE",
      "Updated Direct Guard Company",
    ))).toBe(leadId);

    const secondLeadId = secondDb.upsertLead(directLead(
      secondCampaignId,
      "DIRECT-GUARD.EXAMPLE",
      "Second Campaign Company",
    ));
    expect(secondLeadId).not.toBe(leadId);
    expect(firstDb.db.prepare(
      "SELECT id, campaign_id FROM leads WHERE domain=? COLLATE NOCASE",
    ).all("direct-guard.example")).toEqual([
      { id: leadId, campaign_id: firstCampaignId },
      { id: secondLeadId, campaign_id: secondCampaignId },
    ]);
    const accountLinks = firstDb.db.prepare(
      `SELECT lead_id, account_id FROM lead_account_links
       WHERE lead_id IN (?, ?) ORDER BY lead_id`,
    ).all(leadId, secondLeadId) as Array<{ lead_id: string; account_id: string }>;
    expect(accountLinks).toHaveLength(2);
    expect(new Set(accountLinks.map((row) => row.account_id)).size).toBe(1);

    secondDb.upsertContact({
      leadId: secondLeadId,
      name: "Second Campaign Contact",
      title: "Engineering Manager",
      email: "second@direct-guard.example",
      sourceUrl: "https://direct-guard.example/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "fixture",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    secondDb.db.prepare("UPDATE leads SET human_takeover=1 WHERE id=?").run(secondLeadId);
    expect(firstDb.getLead(leadId)).toMatchObject({ company: "Updated Direct Guard Company" });
    expect(firstDb.getLead(leadId)).toMatchObject({ human_takeover: 0 });
    expect(firstDb.listContactsForLead(leadId)).toEqual([]);
    expect(secondDb.listContactsForLead(secondLeadId)).toHaveLength(1);
  });

  it("allows an unassigned lead and a campaign lead to share only the canonical account", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-global-domain-null-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "agent.db");
    const firstDb = new AgentDatabase(databasePath);
    const secondDb = new AgentDatabase(databasePath);
    databases.push(firstDb, secondDb);
    const campaignId = createCampaign(secondDb, "Campaign after unassigned lead");

    const leadId = firstDb.upsertLead(directLead(null, "unassigned-guard.example"));
    const campaignLeadId = secondDb.upsertLead(directLead(
      campaignId,
      "UNASSIGNED-GUARD.EXAMPLE",
    ));
    expect(firstDb.db.prepare(
      "SELECT id, campaign_id FROM leads WHERE domain=? COLLATE NOCASE",
    ).all("unassigned-guard.example")).toEqual([
      { id: leadId, campaign_id: null },
      { id: campaignLeadId, campaign_id: campaignId },
    ]);
    const accountIds = firstDb.db.prepare(
      "SELECT account_id FROM lead_account_links WHERE lead_id IN (?, ?)",
    ).all(leadId, campaignLeadId) as Array<{ account_id: string }>;
    expect(new Set(accountIds.map((row) => row.account_id)).size).toBe(1);
  });

  it("lets concurrent campaigns research the same domain without cross-campaign deduplication", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-global-domain-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "agent.db");
    const businessDir = path.join(dir, "business");
    fs.mkdirSync(businessDir, { recursive: true });
    fs.writeFileSync(path.join(businessDir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: Guard Fixture Seller",
      "  website: https://seller.example",
      "product:",
      "  name_en: sample components",
      "  models_or_specs:",
      "    - configurable sample components",
    ].join("\n"), "utf8");
    const config = loadConfig({
      AGENT_DB_PATH: databasePath,
      BUSINESS_DATA_DIR: businessDir,
      SEARCH_PROVIDER: "none",
      MAX_DISCOVERY_ROUNDS: "1",
      MAX_DISCOVERY_CONCURRENCY: "1",
      MAX_SEARCH_CONCURRENCY: "1",
      MAX_COMPANY_PAGES: "2",
      MAX_LLM_CALLS_PER_JOB: "20",
      DISCOVERY_PROGRESS_INTERVAL: "100",
      HERMES_RESEARCH_ENABLED: "false",
      LEAD_SEND_SCORE_MIN: "90",
    });
    const firstDb = new AgentDatabase(databasePath);
    const secondDb = new AgentDatabase(databasePath);
    databases.push(firstDb, secondDb);
    const firstCampaignId = createCampaign(firstDb, "First campaign");
    const secondCampaignId = createCampaign(secondDb, "Second campaign");

    const bothAtWebsiteAssessment = deferred();
    let assessorsWaiting = 0;
    const assessWebsite = async () => {
      assessorsWaiting += 1;
      if (assessorsWaiting === 2) bothAtWebsiteAssessment.resolve();
      await bothAtWebsiteAssessment.promise;
      return assessment();
    };
    const service = (db: AgentDatabase) => new DiscoveryService(
      config,
      db,
      llmFixture() as never,
      undefined,
      {
        assessWebsite,
        createSearchProvider: () => ({
          name: "fixture",
          search: async () => [result],
        }),
      },
    );

    const summaries = await Promise.all([
      service(firstDb).run({
        id: firstCampaignId,
        market: "Vietnam",
        product: "sample components",
        buyerType: "integrator",
        targetCount: 5,
      }),
      service(secondDb).run({
        id: secondCampaignId,
        market: "Vietnam",
        product: "sample components",
        buyerType: "integrator",
        targetCount: 5,
      }),
    ]);

    expect(assessorsWaiting).toBe(2);
    expect(summaries.reduce((sum, summary) => sum + summary.leadsStored, 0)).toBe(2);
    expect(summaries.reduce((sum, summary) => sum + summary.companyQualified, 0)).toBe(2);
    expect(summaries.reduce((sum, summary) => sum + summary.duplicatesSkipped, 0)).toBe(0);
    expect(summaries.flatMap((summary) => summary.errors)).toEqual([]);
    const rows = firstDb.db.prepare(
      `SELECT l.campaign_id, l.domain, lal.account_id
       FROM leads l JOIN lead_account_links lal ON lal.lead_id=l.id
       WHERE l.domain=? COLLATE NOCASE ORDER BY l.campaign_id`,
    ).all("global-guard.example") as Array<{ campaign_id: string; domain: string; account_id: string }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.campaign_id))).toEqual(new Set([firstCampaignId, secondCampaignId]));
    expect(new Set(rows.map((row) => row.account_id)).size).toBe(1);
  });
});
