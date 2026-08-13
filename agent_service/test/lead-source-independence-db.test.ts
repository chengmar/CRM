import { afterEach, describe, expect, it } from "vitest";
import { DEMAND_POLICY_VERSION } from "../src/types.js";
import { AgentDatabase } from "../src/db.js";

const databases: AgentDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(): { db: AgentDatabase; leadId: string } {
  const db = new AgentDatabase(":memory:");
  databases.push(db);
  const campaignId = db.createCampaign({
    name: "source independence",
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
    company: "Independent Source Fixture",
    domain: "buyer.example",
    website: "https://buyer.example/",
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
  });
  return { db, leadId };
}

function setPublisher(db: AgentDatabase, sourceUrl: string, publisherDomain: string): void {
  db.db.prepare("UPDATE account_sources SET publisher_domain=? WHERE source_url=?")
    .run(publisherDomain, sourceUrl);
}

function setOriginalDocument(db: AgentDatabase, sourceUrl: string, key: string): void {
  db.db.prepare(
    `UPDATE source_documents
     SET metadata_json=json_set(metadata_json, '$.originalDocumentKey', ?)
     WHERE source_url=?`,
  ).run(key, sourceUrl);
}

describe("database independent lead source count", () => {
  it("persists exact official mailbox text when an official summary already owns the URL", () => {
    const { db, leadId } = fixture();
    const sourceUrl = "https://buyer.example/contact";
    const summary = "Contact Buyer Example through the form on this page.";
    const exactText = "Sales enquiries: sales@buyer.example";
    const observedAt = "2026-07-23T06:30:00.000Z";
    db.addLeadSource(leadId, sourceUrl, "official_website", null, summary);

    const persisted = db.persistOfficialMailboxEvidence(leadId, {
      sourceUrl,
      exactText,
      observedAt,
    });
    const repeated = db.persistOfficialMailboxEvidence(leadId, {
      sourceUrl,
      exactText,
      observedAt,
    });

    expect(persisted).toEqual({
      sourceUrl,
      exactText: `${summary}\n\n${exactText}`,
      observedAt,
    });
    expect(repeated).toEqual(persisted);
    expect(db.listLeadSources(leadId)).toEqual([
      expect.objectContaining({
        source_url: sourceUrl,
        source_type: "official_website",
        evidence: persisted.exactText,
        created_at: observedAt,
      }),
    ]);
    expect(db.listSourceMetrics()).toEqual([
      expect.objectContaining({ source_type: "official_website", leads: 1 }),
    ]);
  });

  it("upgrades search and activity URL collisions without losing their metrics or unrelated sources", () => {
    const { db, leadId } = fixture();
    const observedAt = "2026-07-23T06:35:00.000Z";
    const collisions = [
      {
        sourceUrl: "https://buyer.example/contact-search",
        sourceType: "search_index",
        summary: "Search result summary for the contact page.",
        exactText: "Export enquiries: export@buyer.example",
      },
      {
        sourceUrl: "https://buyer.example/contact-activity",
        sourceType: "activity_signal",
        summary: "Recent contact-page activity signal.",
        exactText: "Sales enquiries: sales@buyer.example",
      },
    ] as const;
    for (const collision of collisions) {
      db.addLeadSource(leadId, collision.sourceUrl, collision.sourceType, null, collision.summary);
      expect(db.persistOfficialMailboxEvidence(leadId, {
        sourceUrl: collision.sourceUrl,
        exactText: collision.exactText,
        observedAt,
      })).toMatchObject({
        sourceUrl: collision.sourceUrl,
        exactText: `${collision.summary}\n\n${collision.exactText}`,
        observedAt,
      });
    }
    db.addLeadSource(
      leadId,
      "https://expo.example/buyer",
      "trade_show",
      null,
      "Unrelated exhibitor evidence.",
    );

    const sources = db.listLeadSources(leadId);
    expect(sources.filter((source) => source.source_type === "official_website")).toHaveLength(2);
    expect(sources).toContainEqual(expect.objectContaining({
      source_url: "https://expo.example/buyer",
      source_type: "trade_show",
      evidence: "Unrelated exhibitor evidence.",
    }));
    const metrics = new Map(db.listSourceMetrics().map((row) => [String(row.source_type), Number(row.leads)]));
    expect(Object.fromEntries(metrics)).toMatchObject({
      search_index: 1,
      activity_signal: 1,
      official_website: 1,
      trade_show: 1,
    });
  });

  it("collapses publisher domains and syndicated originals on every lead read surface", () => {
    const { db, leadId } = fixture();
    const sources = [
      ["https://buyer.example/about", "official_website"],
      ["https://news.buyer.example/project", "media"],
      ["https://registry.example/record/42", "registry"],
      ["https://trade-news.example/releases/42", "media"],
      ["https://regional-news.example/releases/42", "directory"],
      ["https://search.example/result", "search_index"],
      ["https://verifier.example/email", "email_verification"],
    ] as const;
    for (const [url, type] of sources) db.addLeadSource(leadId, url, type, null, "fixture evidence");

    setPublisher(db, sources[0][0], "buyer.example");
    setPublisher(db, sources[1][0], "news.buyer.example");
    setPublisher(db, sources[2][0], "registry.example");
    setPublisher(db, sources[3][0], "trade-news.example");
    setPublisher(db, sources[4][0], "regional-news.example");
    setOriginalDocument(db, sources[3][0], "release-42");
    setOriginalDocument(db, sources[4][0], "release-42");

    expect(db.countLeadSources(leadId)).toBe(7);
    expect(db.countIndependentLeadSources(leadId)).toBe(3);
    expect(db.getLead(leadId)).toMatchObject({ source_count: 3 });
    expect(db.getLeadDetails(leadId)).toMatchObject({ source_count: 3 });
    expect(db.listLeadsForSync()).toEqual([
      expect.objectContaining({ id: leadId, source_count: 3 }),
    ]);
  });

  it("derives a missing publisher from the registered source URL domain", () => {
    const { db, leadId } = fixture();
    db.addLeadSource(leadId, "https://www.example.org/a", "media", null, "a");
    db.addLeadSource(leadId, "https://news.example.org/b", "directory", null, "b");

    expect(db.countIndependentLeadSources(leadId)).toBe(1);
  });
});
