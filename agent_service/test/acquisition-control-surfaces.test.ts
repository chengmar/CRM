import { describe, expect, it } from "vitest";
import {
  ACQUISITION_CONTROL_TABLE_SCHEMAS,
  CAMPAIGN_BRIEFS_TABLE_FIELDS,
  COMMERCIAL_REPORT_TABLE_FIELDS,
  MARKET_ALLOCATIONS_TABLE_FIELDS,
  SALES_TASKS_TABLE_FIELDS,
} from "../src/integrations/bitable.js";
import {
  campaignBriefCard,
  commercialReportCard,
  manualSalesTaskCard,
  marketAllocationCard,
} from "../src/integrations/feishu/cards.js";

function fieldNames(fields: Array<{ field_name: string }>): string[] {
  return fields.map((field) => field.field_name);
}

describe("acquisition control surfaces", () => {
  it("exposes the required Campaign, allocation, task, and commercial Bitable dimensions", () => {
    expect(fieldNames(CAMPAIGN_BRIEFS_TABLE_FIELDS)).toEqual(expect.arrayContaining([
      "brief_id",
      "version_id",
      "brief_hash",
      "provider_budget_hash",
      "buyer_types",
      "industries",
      "role_families",
      "required_signals",
      "exclusions",
      "provider_budget",
      "research_budget",
      "offer_ids",
      "deadline",
      "hypothesis",
      "shadow_authorized",
      "provider_budget_authorized",
      "external_send_authorized",
      "content_publish_authorized",
    ]));
    expect(fieldNames(MARKET_ALLOCATIONS_TABLE_FIELDS)).toEqual(expect.arrayContaining([
      "play_id",
      "recommended_units",
      "recommended_share",
      "applied",
      "requires_human_approval",
    ]));
    expect(fieldNames(SALES_TASKS_TABLE_FIELDS)).toEqual(expect.arrayContaining([
      "account_id",
      "person_id",
      "enrollment_id",
      "opportunity_id",
      "task_type",
      "owner",
      "due_at",
      "outcome",
    ]));
    expect(fieldNames(COMMERCIAL_REPORT_TABLE_FIELDS)).toEqual(expect.arrayContaining([
      "market",
      "play",
      "qualification_track",
      "provider",
      "channel",
      "offer",
      "experiment",
      "currency",
      "row_kind",
      "delivered",
      "delivered_messages",
      "inquiries",
      "quotes",
      "wins",
      "revenue_minor",
      "gross_margin_minor",
      "cost_minor",
      "cost_micros",
      "attribution_mode",
    ]));
    expect(Object.keys(ACQUISITION_CONTROL_TABLE_SCHEMAS)).toEqual([
      "campaignBriefs",
      "marketAllocations",
      "salesTasks",
      "commercialReport",
    ]);
  });

  it("keeps Campaign approvals scoped and omits external-send and publication callbacks", () => {
    const shadow = campaignBriefCard({
      briefId: "brief-1",
      versionId: "briefv-1",
      status: "PLAN_DRAFT",
      briefHash: "a".repeat(64),
      brief: {
        market: "Malaysia",
        productFamily: "sample product application",
        targetMetric: "VALID_CONTACTS",
        targetCount: 20,
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
      },
    });
    const budget = campaignBriefCard({
      briefId: "brief-1",
      versionId: "briefv-1",
      status: "PLAN_APPROVED",
      briefHash: "a".repeat(64),
      providerBudgetHash: "b".repeat(64),
      brief: {
        market: "Malaysia",
        productFamily: "sample product application",
        targetMetric: "VALID_CONTACTS",
        targetCount: 20,
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
      },
    });
    const shadowJson = JSON.stringify(shadow);
    const budgetJson = JSON.stringify(budget);
    expect(shadowJson).toContain('"scope":"SHADOW_PLAN"');
    expect(budgetJson).toContain('"scope":"PROVIDER_BUDGET"');
    for (const serialized of [shadowJson, budgetJson]) {
      expect(serialized).not.toContain('"scope":"EXTERNAL_SEND"');
      expect(serialized).not.toContain("CONTENT_PUBLICATION");
      expect(serialized).not.toContain('"intent":"send"');
      expect(serialized).not.toContain('"intent":"publish"');
    }
  });

  it("renders allocation, manual task, and commercial reports as local read-only cards", () => {
    const allocation = marketAllocationCard({
      policyVersion: "market-allocation-v1",
      totalResearchUnits: 100,
      explorationShare: 0.2,
      rows: [{ country: "MY", playId: "play-1", recommendation: "EXPLORE", recommendedUnits: 20, recommendedShare: 0.2 }],
      applied: false,
      requiresHumanApproval: true,
      automaticKills: 0,
    });
    const task = manualSalesTaskCard({
      task: { task_type: "LINKEDIN_REVIEW", status: "OPEN", owner: "sales-1", due_at: "2026-07-21T00:00:00.000Z" },
      account: { display_name: "Fixture Buyer" },
      evidence: [{ exact_quote: "Public role evidence." }],
    });
    const report = commercialReportCard({
      title: "Delivered cohort",
      dimensions: { market: "MY", play: "play-1" },
      delivered: 20,
      positiveReplies: 2,
      inquiries: 1,
      quotes: 1,
      wins: 0,
      revenueMinor: 0,
      grossMarginMinor: 0,
      costMinor: 500,
      attributionMode: "DESCRIPTIVE_FIRST_LAST_ASSIST",
    });
    for (const card of [allocation, task, report]) {
      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain('"tag":"action"');
      expect(serialized).not.toContain('"tag":"button"');
      expect(serialized).not.toContain('"intent":');
    }
  });
});
