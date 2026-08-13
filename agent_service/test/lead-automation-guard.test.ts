import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { DiscoveryService } from "../src/search/discovery.js";
import { DEMAND_POLICY_VERSION, type SearchResult, type WebsiteAssessment } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-lead-guard-"));
  tempDirs.push(dir);
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
    AGENT_DB_PATH: path.join(dir, "agent.db"),
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
  const db = new AgentDatabase(config.AGENT_DB_PATH);
  const campaignId = db.createCampaign({
    name: "Lead guard fixture",
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
    company: "Guard Company",
    domain: "guard.example",
    website: "https://guard.example/",
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
    lastActivityAt: "2026-07-19T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ sourceUrl: "https://guard.example/rfq" }],
    sendEligible: false,
    eligibilityReasons: ["named contact missing"],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "prepare enrichment");
  db.transitionLead(leadId, "ENRICHING", "test", "prepare enrichment");
  return { config, db, campaignId, leadId };
}

function assessment(): WebsiteAssessment {
  return {
    url: "https://guard.example/",
    domain: "guard.example",
    reachable: true,
    parked: false,
    title: "Guard Company",
    text: "Guard Company sample components sample products sample application integrator",
    emails: [],
    phones: [],
    recentActivityAt: "2026-07-19T00:00:00.000Z",
    activitySignals: ["website reachable"],
    activityScore: 20,
    pages: [{
      url: "https://guard.example/",
      title: "Guard Company",
      text: "Guard Company sample components sample products sample application integrator",
      evidenceScopes: [{
        id: "scope_jane",
        text: "Jane Buyer Procurement Manager",
        ambiguous: false,
        emails: [],
      }],
      contactContexts: ["Jane Buyer Procurement Manager"],
    }],
  };
}

function eventCount(db: AgentDatabase, eventType: string): number {
  return Number((db.db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE event_type=?",
  ).get(eventType) as { count: number }).count);
}

describe("transactional lead automation guard", () => {
  it.each(["takeover", "dnc"] as const)(
    "drops enrichment writes when %s commits during website assessment",
    async (stopKind) => {
      const { config, db, campaignId, leadId } = fixture();
      const started = deferred();
      const release = deferred();
      let outboundId: string | null = null;
      if (stopKind === "dnc") {
        const contactId = db.upsertContact({
          leadId,
          name: "Existing Buyer",
          title: "Procurement Manager",
          email: "existing@guard.example",
          sourceUrl: "https://guard.example/team",
          employmentVerifiedAt: new Date().toISOString(),
          emailStatus: "RISKY",
          emailRisk: "fixture",
          roleAddress: false,
          disposableAddress: false,
          catchAll: false,
        });
        outboundId = db.createOutboundMessage({
          campaignId,
          leadId,
          contactId,
          channel: "email",
          destination: "existing@guard.example",
          subject: "Fixture",
          body: "Fixture",
          sequenceIndex: 0,
          status: "DRAFT",
        });
      }
      const baselineSources = db.countLeadSources(leadId);
      const baselineContacts = db.listContactsForLead(leadId).length;
      const service = new DiscoveryService(
        config,
        db,
        { isConfigured: () => false } as never,
        undefined,
        {
          assessWebsite: async () => {
            started.resolve();
            await release.promise;
            if (stopKind === "takeover") throw new Error("fixture assessment failure after takeover");
            return assessment();
          },
          createSearchProvider: () => ({
            name: "fixture",
            search: async () => [],
          }),
        },
      );

      const running = service.enrichPendingContacts(campaignId, 1);
      await started.promise;
      if (stopKind === "takeover") {
        db.setHumanTakeover(leadId, "test", "manual takeover during assessment");
      } else {
        db.addDnc("domain", "guard.example", "fixture DNC", "test");
      }
      release.resolve();
      const summary = await running;

      expect(summary).toMatchObject({
        attempted: 0,
        contactsFound: 0,
        readyForReview: 0,
        stillPending: 0,
        errors: [],
      });
      expect(db.countLeadSources(leadId)).toBe(baselineSources);
      expect(db.listContactsForLead(leadId)).toHaveLength(baselineContacts);
      expect(db.getLead(leadId)).toMatchObject({
        status: stopKind === "takeover" ? "HUMAN_TAKEOVER" : "DO_NOT_CONTACT",
        enrichment_attempts: 0,
      });
      expect(eventCount(db, "CONTACT_ENRICHMENT_COMPLETED")).toBe(0);
      if (outboundId) {
        expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(outboundId))
          .toEqual({ status: "CANCELLED" });
      }
      db.close();
    },
  );

  it("drops post-lock discovery writes and counters when takeover commits during contact research", async () => {
    const { config, db, campaignId, leadId } = fixture();
    const contactResearchStarted = deferred();
    const releaseContactResearch = deferred();
    let companyAnalyzed = false;
    const result: SearchResult = {
      title: "Guard Company",
      url: "https://guard.example/",
      snippet: "Guard Company sample components integrator",
      sourceType: "search",
      sourceDate: "2026-07-19T00:00:00.000Z",
      query: "fixture",
    };
    const llm = {
      isConfigured: () => true,
      json: vi.fn(async (purpose: string) => {
        if (purpose === "market_research_plan") {
          return {
            market: "Vietnam",
            productTerms: ["sample components", "sample products", "sample application"],
            buyerTerms: ["integrator"],
            queries: ["guard candidate query"],
          };
        }
        if (purpose === "search_result_company_extraction") return { candidates: [] };
        if (purpose === "company_due_diligence") {
          companyAnalyzed = true;
          return {
            companyName: "Guard Company",
            companyType: "integrator",
            fitScore: 30,
            matchedProducts: ["sample components", "sample products"],
            risks: [],
            recommendedOffer: "sample components",
            researchSummary: "Qualified fixture",
            evidence: [{ claim: "Official company evidence", sourceUrl: result.url }],
          };
        }
        if (purpose === "decision_maker_enrichment") {
          return {
            contacts: [{
              name: "Jane Buyer",
              title: "Procurement Manager",
              sourceUrl: result.url,
              sourceScopeId: "scope_jane",
              employmentVerified: true,
            }],
          };
        }
        return {};
      }),
    };
    const service = new DiscoveryService(config, db, llm as never, undefined, {
      assessWebsite: async () => assessment(),
      createSearchProvider: () => ({
        name: "fixture",
        search: async () => {
          if (companyAnalyzed) {
            contactResearchStarted.resolve();
            await releaseContactResearch.promise;
          }
          return [result];
        },
      }),
    });

    const running = service.run({
      id: campaignId,
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 5,
    });
    await contactResearchStarted.promise;
    const sourcesAtLock = db.countLeadSources(leadId);
    const scoreAtLock = db.getLead(leadId)?.total_score;
    db.setHumanTakeover(leadId, "test", "takeover during contact research");
    releaseContactResearch.resolve();
    const summary = await running;

    expect(summary).toMatchObject({
      companyQualified: 1,
      leadsStored: 0,
      contactsFound: 0,
      eligibleForReview: 0,
      enrichmentPending: 0,
      errors: [],
    });
    expect(db.countLeadSources(leadId)).toBe(sourcesAtLock);
    expect(db.listContactsForLead(leadId)).toHaveLength(0);
    expect(db.getLead(leadId)).toMatchObject({
      status: "HUMAN_TAKEOVER",
      total_score: scoreAtLock,
    });
    expect(eventCount(db, "DEEP_DISCOVERY_COMPLETED")).toBe(0);
    db.close();
  });

  it("skips a locked same-campaign lead before website research", async () => {
    const { config, db, campaignId, leadId } = fixture();
    db.setHumanTakeover(leadId, "test", "locked before rediscovery");
    const websiteAssessor = vi.fn(async () => assessment());
    const result: SearchResult = {
      title: "Guard Company",
      url: "https://guard.example/",
      snippet: "Guard Company",
      sourceType: "search",
      sourceDate: null,
      query: "fixture",
    };
    const service = new DiscoveryService(
      config,
      db,
      { isConfigured: () => false } as never,
      undefined,
      {
        assessWebsite: websiteAssessor,
        createSearchProvider: () => ({ name: "fixture", search: async () => [result] }),
      },
    );

    const summary = await service.run({
      id: campaignId,
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 5,
    });

    expect(websiteAssessor).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      domainsAssessed: 0,
      leadsStored: 0,
      eligibleForReview: 0,
      enrichmentPending: 0,
      skipped: 1,
      errors: [],
    });
    expect(db.listCampaignCandidates(campaignId)).toEqual([]);
    expect(eventCount(db, "DEEP_DISCOVERY_COMPLETED")).toBe(0);
    db.close();
  });

  it("rolls back guarded writes when enrichment attempt CAS fails", () => {
    const { db, campaignId, leadId } = fixture();

    expect(() => db.withLeadAutomationGuard(leadId, {
      campaignId,
      allowedStatuses: ["ENRICHING"],
      expectedEnrichmentAttempts: 0,
    }, () => {
      db.addLeadSource(
        leadId,
        "https://guard.example/new-source",
        "official_website",
        null,
        "must roll back",
      );
      if (!db.completeEnrichmentAttempt(leadId, 1, "2099-01-01T00:00:00.000Z")) {
        throw new Error("attempt CAS failed");
      }
    })).toThrow("attempt CAS failed");

    expect(db.countLeadSources(leadId)).toBe(0);
    expect(db.getLead(leadId)).toMatchObject({
      status: "ENRICHING",
      enrichment_attempts: 0,
    });
    db.setHumanTakeover(leadId, "test", "lock after rollback");
    expect(db.completeEnrichmentAttempt(leadId, 0, "2099-01-01T00:00:00.000Z")).toBe(false);
    db.close();
  });

  it("rejects an async guard callback before invoking it", () => {
    const { db, campaignId, leadId } = fixture();
    let invoked = false;

    expect(() => db.withLeadAutomationGuard(leadId, {
      campaignId,
      allowedStatuses: ["ENRICHING"],
    }, (async () => {
      invoked = true;
    }) as never)).toThrow("must be synchronous");
    expect(invoked).toBe(false);
    db.close();
  });

  it("does not emit exhaustion when the final attempt succeeds", () => {
    const { db, campaignId, leadId } = fixture();
    db.db.prepare("UPDATE leads SET enrichment_attempts=2 WHERE id=?").run(leadId);

    const result = db.withLeadAutomationGuard(leadId, {
      campaignId,
      allowedStatuses: ["ENRICHING"],
      expectedEnrichmentAttempts: 2,
    }, () => {
      expect(db.completeEnrichmentAttempt(
        leadId,
        2,
        "2099-01-01T00:00:00.000Z",
        3,
        false,
      )).toBe(true);
      db.transitionLead(leadId, "VERIFYING", "test", "successful final attempt");
    });

    expect(result.applied).toBe(true);
    expect(db.getLead(leadId)).toMatchObject({
      status: "VERIFYING",
      enrichment_attempts: 3,
      enrichment_next_at: null,
    });
    expect(eventCount(db, "CONTACT_ENRICHMENT_EXHAUSTED")).toBe(0);
    db.close();
  });

  it("blocks a guarded create when the target domain is already DNC", () => {
    const { db, campaignId } = fixture();
    db.addDnc("domain", "blocked.example", "fixture", "test");
    let invoked = false;

    const result = db.withLeadAutomationGuard({
      campaignId,
      domain: "blocked.example",
      allowMissing: true,
    }, {
      campaignId,
      allowedStatuses: ["NEW"],
    }, () => {
      invoked = true;
    });

    expect(result).toEqual({ applied: false, reason: "dnc" });
    expect(invoked).toBe(false);
    expect(db.findLeadByDomain("blocked.example")).toBeNull();
    db.close();
  });
});
