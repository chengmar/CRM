import { describe, expect, it } from "vitest";
import {
  CampaignApprovalSchema,
  CampaignBriefSchema,
  campaignBriefHash,
  createScopedCampaignApproval,
  reviseCampaignBrief,
  validateCampaignApproval,
  validateCampaignBriefDraft,
  type CampaignBrief,
} from "../src/acquisition/campaign-brief.js";
import {
  createCampaignForecast,
  type HistoricalFunnelSample,
} from "../src/acquisition/campaign-forecast.js";
import { auditN8nWorkflow } from "../src/acquisition/n8n-audit.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function briefDraft(): Record<string, unknown> {
  return {
    id: "brief-malaysia-sample-product",
    version: 1,
    market: "Malaysia",
    productFamily: "Sample Product A",
    buyerTypes: ["Sample application integrator"],
    industries: ["sample requirement", "Metal fabrication"],
    roleFamilies: ["Engineering", "Procurement"],
    qualificationTracks: ["ACTIVE_INTENT", "HIGH_ICP_FIT"],
    requiredSignals: ["Publicly evidenced product-control project or application fit"],
    exclusions: ["Existing customer", "Active opportunity", "DNC"],
    targetMetric: "VALID_CONTACTS",
    targetCount: 12,
    providerBudget: {
      mode: "CAPPED",
      allowedProviders: ["apollo-official"],
      unit: "CREDITS",
      maxUnits: 60,
      maxAmountUsd: 30,
      requiresSeparateApproval: true,
    },
    llmBudget: {
      mode: "CAPPED",
      allowedProviders: ["configured-llm"],
      unit: "TOKENS",
      maxUnits: 200_000,
      maxAmountUsd: 10,
      requiresSeparateApproval: true,
    },
    offerIds: ["offer-application-checklist"],
    deadline: "2026-08-20T00:00:00.000Z",
    hypothesis: "A grounded application checklist will earn more qualified replies than a generic catalog offer.",
  };
}

function brief(): CampaignBrief {
  const result = validateCampaignBriefDraft(briefDraft());
  if (!result.brief) throw new Error(result.blockers.join("; "));
  return result.brief;
}

const APPROVER = { id: "owner-1", name: "Campaign Owner", human: true as const };

describe("campaign brief v2", () => {
  it("rejects an ambiguous budget that selects both official email verifiers", () => {
    const value = briefDraft();
    (value.providerBudget as Record<string, unknown>).allowedProviders = [
      "searxng",
      "local-public-web",
      "hunter",
      "bouncer",
    ];

    const result = validateCampaignBriefDraft(value);
    expect(result.status).toBe("PLAN_NEEDS_INPUT");
    expect(result.blockers.some((blocker) =>
      blocker.includes("at most one independent email verifier"))).toBe(true);
  });

  it("returns PLAN_NEEDS_INPUT for every critical missing planning field", () => {
    for (const field of ["targetMetric", "roleFamilies", "qualificationTracks", "providerBudget", "llmBudget"]) {
      const value = briefDraft();
      delete value[field];
      const result = validateCampaignBriefDraft(value);
      expect(result.status, field).toBe("PLAN_NEEDS_INPUT");
      expect(result.missingFields, field).toContain(field);
      expect(result.brief, field).toBeNull();
    }
  });

  it("defaults transport to NONE and never treats a complete draft as authorization", () => {
    const result = validateCampaignBriefDraft(briefDraft());
    expect(result).toMatchObject({
      status: "PLAN_DRAFT",
      missingFields: [],
      blockers: [],
    });
    expect(result.brief?.transport).toBe("NONE");
    expect(result.briefHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on unknown fields and ambiguous multi-stage targets", () => {
    const value = briefDraft();
    delete value.targetMetric;
    value.targetMetrics = [
      { metric: "VALID_CONTACTS", count: 12 },
      { metric: "DELIVERED", count: 12 },
    ];
    const result = validateCampaignBriefDraft(value);
    expect(result.status).toBe("PLAN_NEEDS_INPUT");
    expect(result.brief).toBeNull();
    expect(result.blockers.join("\n")).toContain("CAMPAIGN_BRIEF_DRAFT_INVALID");
  });

  it("creates a new version and hash for every accepted edit", () => {
    const current = brief();
    const originalHash = campaignBriefHash(current);
    const revision = reviseCampaignBrief({
      currentBrief: current,
      patch: { targetCount: 18 },
    });
    expect(revision.status).toBe("PLAN_DRAFT");
    expect(revision.previousVersion).toBe(1);
    expect(revision.brief?.version).toBe(2);
    expect(revision.briefHash).not.toBe(originalHash);
  });

  it("invalidates prior approval after a version or content change", () => {
    const current = brief();
    const approvalResult = createScopedCampaignApproval({
      id: "approval-shadow-v1",
      actionId: "action-shadow-v1",
      scope: "SHADOW_PLAN",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: [APPROVER.id],
      approvedAt: NOW,
    });
    expect(approvalResult.approval).not.toBeNull();

    const revision = reviseCampaignBrief({ currentBrief: current, patch: { targetCount: 18 } });
    expect(validateCampaignApproval({
      approval: approvalResult.approval,
      currentBrief: revision.brief,
    })).toMatchObject({ valid: false });
    expect(validateCampaignApproval({
      approval: approvalResult.approval,
      currentBrief: revision.brief,
    }).blockers).toContain("CAMPAIGN_APPROVAL_VERSION_STALE");

    const sameVersionMutation = CampaignBriefSchema.parse({
      ...current,
      hypothesis: "A materially changed hypothesis must invalidate the old approval hash.",
    });
    expect(validateCampaignApproval({
      approval: approvalResult.approval,
      currentBrief: sameVersionMutation,
    }).blockers).toContain("CAMPAIGN_APPROVAL_HASH_STALE");
  });

  it("keeps shadow, provider budget and external-send approvals mutually separate", () => {
    const current = brief();
    const shadow = createScopedCampaignApproval({
      id: "approval-shadow",
      actionId: "action-shadow",
      scope: "SHADOW_PLAN",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: [APPROVER.id],
      approvedAt: NOW,
    });
    expect(shadow).toMatchObject({
      status: "PLAN_APPROVED",
      approval: {
        scope: "SHADOW_PLAN",
        shadowAuthorized: true,
        providerBudgetAuthorized: false,
        externalSendAuthorized: false,
      },
    });
    expect(CampaignApprovalSchema.safeParse({
      ...shadow.approval,
      providerBudgetAuthorized: true,
      externalSendAuthorized: true,
    }).success).toBe(false);

    const budget = createScopedCampaignApproval({
      id: "approval-budget",
      actionId: "action-budget",
      scope: "PROVIDER_BUDGET",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: [APPROVER.id],
      approvedAt: NOW,
    });
    expect(budget).toMatchObject({
      status: "BUDGET_APPROVED",
      approval: {
        shadowAuthorized: false,
        providerBudgetAuthorized: true,
        externalSendAuthorized: false,
      },
    });
    expect(createScopedCampaignApproval({
      id: "approval-send",
      actionId: "action-send",
      scope: "EXTERNAL_SEND",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: [APPROVER.id],
      approvedAt: NOW,
    })).toMatchObject({
      status: "REJECTED",
      approval: null,
      blockers: ["CAMPAIGN_EXTERNAL_SEND_TRANSPORT_NONE"],
    });
  });

  it("rejects unauthorized approval and treats action replay as idempotent", () => {
    const current = brief();
    expect(createScopedCampaignApproval({
      id: "approval-unauthorized",
      actionId: "action-unauthorized",
      scope: "SHADOW_PLAN",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: ["someone-else"],
    }).blockers).toContain("CAMPAIGN_APPROVER_UNAUTHORIZED");
    expect(createScopedCampaignApproval({
      id: "approval-replay",
      actionId: "action-replay",
      scope: "SHADOW_PLAN",
      brief: current,
      approver: APPROVER,
      authorizedApproverIds: [APPROVER.id],
      processedActionIds: ["action-replay"],
    })).toEqual({ status: "IDEMPOTENT_REPLAY", approval: null, blockers: [] });
  });
});

describe("conservative campaign forecast", () => {
  it("returns no numeric prediction when comparable history is absent", () => {
    const result = createCampaignForecast({ brief: brief(), history: [], now: NOW });
    expect(result.blockers).toEqual([]);
    expect(result.forecast).toMatchObject({
      status: "NO_RELIABLE_FORECAST",
      sampleCount: 0,
      historicalAccounts: 0,
      uncertainty: "HIGH",
      ranges: {
        accountsResearched: null,
        namedContacts: null,
        validContacts: null,
        readyForReview: null,
        costUsd: null,
      },
    });
    expect(result.forecast?.message).toContain("无可靠预测");
  });

  it("uses only sufficient same-market, same-product history and exposes uncertainty", () => {
    const history: HistoricalFunnelSample[] = [
      ["h1", 20, 12, 16, 10, 8, 6, 20],
      ["h2", 20, 11, 15, 9, 7, 5, 24],
      ["h3", 20, 13, 17, 11, 9, 7, 22],
    ].map(([id, accounts, qualified, named, valid, ready, delivered, cost]) => ({
      id: String(id),
      market: "Malaysia",
      productFamily: "Sample Product A",
      observedAt: "2026-07-01T00:00:00.000Z",
      accountsResearched: Number(accounts),
      qualifiedAccounts: Number(qualified),
      namedContacts: Number(named),
      validContacts: Number(valid),
      readyForReview: Number(ready),
      delivered: Number(delivered),
      costUsd: Number(cost),
    }));
    const result = createCampaignForecast({ brief: brief(), history, now: NOW });
    expect(result.blockers).toEqual([]);
    expect(result.forecast?.status).toBe("HISTORICAL_RANGE");
    expect(result.forecast?.sampleCount).toBe(3);
    expect(result.forecast?.historicalAccounts).toBe(60);
    expect(result.forecast?.ranges.accountsResearched?.min).toBeGreaterThan(0);
    expect(result.forecast?.message).toContain("不承诺");
  });
});

function node(
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, type, typeVersion: 1, position: [0, 0], parameters };
}

function workflow(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { name: "Static audit fixture", nodes, connections: {}, active: false };
}

const POLICY = {
  allowedHttpTargets: [{
    origin: "http://127.0.0.1:3000",
    pathPrefixes: ["/internal/n8n/candidates", "/internal/n8n/status"],
    methods: ["GET", "POST"],
  }],
  allowedOfficialNodePrefixes: ["n8n-nodes-base.", "@n8n/n8n-nodes-langchain."],
  maximumBytes: 1_000_000,
};

describe("n8n static workflow audit", () => {
  it("allows only an inactive, allowlisted internal-API workflow into shadow", () => {
    const report = auditN8nWorkflow({
      workflow: workflow([
        node("Manual", "n8n-nodes-base.manualTrigger"),
        node("Submit candidate", "n8n-nodes-base.httpRequest", {
          url: "http://127.0.0.1:3000/internal/n8n/candidates",
          method: "POST",
          idempotencyKey: "={{$execution.id}}",
        }),
      ]),
      policy: POLICY,
    });
    expect(report).toMatchObject({
      status: "SHADOW_ONLY_ALLOWED",
      shadowImportAllowed: true,
      productionImportAllowed: false,
      findings: [],
    });
  });

  it.each([
    ["unknown endpoint", node("Unknown HTTP", "n8n-nodes-base.httpRequest", {
      url: "https://unknown.example.test/collect",
      method: "POST",
    }), "N8N_UNKNOWN_HTTP_ENDPOINT"],
    ["send node", node("Send email", "n8n-nodes-base.emailSend"), "N8N_SEND_NODE"],
    ["direct SQLite", node("Write SQLite", "n8n-nodes-base.sqlite", {
      operation: "executeQuery",
      query: "INSERT INTO leads VALUES (?)",
      database: "agent.db",
    }), "N8N_DIRECT_SQLITE_ACCESS"],
    ["code node", node("Run code", "n8n-nodes-base.code", {
      jsCode: "return items;",
    }), "N8N_CODE_NODE"],
    ["community node", node("Community scraper", "n8n-nodes-community.scraper"), "N8N_COMMUNITY_NODE"],
  ])("blocks %s", (_label, riskyNode, code) => {
    const report = auditN8nWorkflow({ workflow: workflow([riskyNode]), policy: POLICY });
    expect(report.status).toBe("BLOCKED");
    expect(report.shadowImportAllowed).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(code);
  });

  it("blocks and redacts plaintext credentials while inventorying safe credential references", () => {
    const unsafe = node("Unsafe HTTP", "n8n-nodes-base.httpRequest", {
      url: "http://127.0.0.1:3000/internal/n8n/status",
      method: "GET",
      headerParameters: {
        parameters: [{ name: "Authorization", value: "Bearer live-secret-value" }],
      },
    });
    unsafe.credentials = { httpHeaderAuth: { id: "cred-1", name: "Internal API credential" } };
    const report = auditN8nWorkflow({ workflow: workflow([unsafe]), policy: POLICY });
    expect(report.status).toBe("BLOCKED");
    expect(report.findings.map((finding) => finding.code)).toContain("N8N_PLAINTEXT_CREDENTIAL");
    expect(report.inventory.credentialReferences).toEqual([{
      nodeName: "Unsafe HTTP",
      credentialType: "httpHeaderAuth",
      credentialId: "cred-1",
      credentialName: "Internal API credential",
    }]);
    expect(JSON.stringify(report)).not.toContain("Bearer live-secret-value");
  });

  it("fails closed for malformed or schema-unknown workflow JSON", () => {
    expect(auditN8nWorkflow({ workflow: "{not-json", policy: POLICY }).findings[0]?.code)
      .toBe("N8N_WORKFLOW_JSON_INVALID");
    expect(auditN8nWorkflow({
      workflow: { ...workflow([node("Manual", "n8n-nodes-base.manualTrigger")]), unknownRoot: true },
      policy: POLICY,
    }).findings[0]?.code).toBe("N8N_WORKFLOW_SCHEMA_INVALID");
  });
});
