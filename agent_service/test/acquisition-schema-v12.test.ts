import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDatabase,
  LATEST_SCHEMA_VERSION,
  type PlayInput,
  type WorkflowAuthorization,
} from "../src/db.js";

const tempDirs: string[] = [];
const now = "2026-07-20T08:00:00.000Z";
const agent: WorkflowAuthorization = { actor: "fixture-agent", actorType: "AGENT" };
const campaignApprover: WorkflowAuthorization = {
  actor: "campaign-owner@example.test",
  actorType: "HUMAN",
  roles: ["CAMPAIGN_APPROVER"],
};
const budgetApprover: WorkflowAuthorization = {
  actor: "budget-owner@example.test",
  actorType: "HUMAN",
  roles: ["BUDGET_APPROVER"],
};
const salesperson: WorkflowAuthorization = {
  actor: "sales@example.test",
  actorType: "HUMAN",
  roles: ["SALES"],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
});

function databasePath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function seedMinimalV11(file: string): void {
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, name, applied_at) VALUES
      (1,'v1','${now}'),(2,'v2','${now}'),(3,'v3','${now}'),(4,'v4','${now}'),
      (5,'v5','${now}'),(6,'v6','${now}'),(7,'v7','${now}'),(8,'v8','${now}'),
      (9,'v9','${now}'),(10,'v10','${now}'),(11,'v11','${now}');
    CREATE TABLE legacy_sentinel(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO legacy_sentinel VALUES ('legacy-row', 'preserve-me');
  `);
  legacy.close();
}

function createPlay(db: AgentDatabase): { accountId: string; playId: string } {
  const accountId = db.upsertAccount({
    domain: "v12-fixture.example",
    displayName: "V12 Fixture Manufacturing",
    countryCode: "MY",
    accountType: "END_USER",
  });
  const play: PlayInput = {
    key: ["v12", "my", "industrial", "product"].join("-"),
    name: "V12 Malaysia sample product",
    country: "Malaysia",
    buyerArchetype: "Industrial end user",
    application: "Sample application",
    productFamily: "Sample Products",
    roleFamily: "Engineering",
    qualificationTrack: "ICP_FIT",
    offer: "Product selection checklist",
    channel: "EMAIL",
    definition: { fixture: true },
    createdBy: "fixture",
  };
  return { accountId, playId: db.upsertPlay(play).playId };
}

const requiredTables = [
  "campaign_briefs",
  "campaign_versions",
  "campaign_approvals",
  "campaign_forecasts",
  "budget_reservations",
  "parse_feedback",
  "market_opportunity_snapshots",
  "market_evidence",
  "hs_code_candidates",
  "regulatory_requirements",
  "offer_playbooks",
  "play_allocations",
  "personalization_plans",
  "message_versions",
  "message_fact_links",
  "experiments",
  "experiment_assignments",
  "experiment_outcomes",
  "signal_observations",
  "rule_versions",
  "manual_engagement_events",
];

describe("acquisition schema v12", () => {
  it("upgrades an intentionally minimal v11 snapshot without removing legacy data", () => {
    const file = databasePath("export-agent-schema-v12-minimal-");
    seedMinimalV11(file);
    let db = new AgentDatabase(file);
    expect(LATEST_SCHEMA_VERSION).toBe(19);
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const tables = new Set(
      (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    expect(requiredTables.every((table) => tables.has(table))).toBe(true);
    expect(db.db.prepare("SELECT payload FROM legacy_sentinel WHERE id='legacy-row'").get())
      .toMatchObject({ payload: "preserve-me" });
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=12").get())
      .toMatchObject({ count: 1 });
    db.close();

    db = new AgentDatabase(file);
    expect(db.getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=12").get())
      .toMatchObject({ count: 1 });
    db.close();
  });

  it("versions campaign drafts, invalidates old approvals, and leaves external scopes unauthorized by default", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v12-campaign-"));
    const draftOne = db.saveCampaignDraft({
      briefKey: "my-sample-product-shadow",
      brief: {
        market: "Malaysia",
        productFamily: "sample components",
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
        providerBudget: { credits: 0 },
      },
      parserVersion: "campaign-brief-v2",
      sourceTextHash: "a".repeat(64),
      createdBy: "fixture-agent",
    });
    expect(db.saveCampaignDraft({
      briefKey: "my-sample-product-shadow",
      brief: {
        market: "Malaysia",
        productFamily: "sample components",
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
        providerBudget: { credits: 0 },
      },
      parserVersion: "campaign-brief-v2",
      sourceTextHash: "a".repeat(64),
      createdBy: "fixture-agent",
    })).toEqual({ ...draftOne, created: false });
    expect(db.getCurrentCampaignBrief(draftOne.briefId)).toMatchObject({
      current_version_id: draftOne.versionId,
      shadow_authorized: 0,
      provider_budget_authorized: 0,
      external_send_authorized: 0,
      content_publish_authorized: 0,
    });
    expect(() => db.saveCampaignScopedApproval({
      briefId: draftOne.briefId,
      versionId: draftOne.versionId,
      scope: "SHADOW_PLAN",
      actionId: "approve-shadow-v1",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
    }, agent)).toThrow(/authorized human/i);
    const approval = db.saveCampaignScopedApproval({
      briefId: draftOne.briefId,
      versionId: draftOne.versionId,
      scope: "SHADOW_PLAN",
      actionId: "approve-shadow-v1",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
    }, campaignApprover);
    expect(approval.created).toBe(true);
    expect(db.saveCampaignScopedApproval({
      briefId: draftOne.briefId,
      versionId: draftOne.versionId,
      scope: "SHADOW_PLAN",
      actionId: "approve-shadow-v1",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
    }, campaignApprover)).toEqual({ ...approval, created: false });
    expect(db.getCurrentCampaignBrief(draftOne.briefId)).toMatchObject({
      status: "PLAN_APPROVED",
      shadow_authorized: 1,
      provider_budget_authorized: 0,
      external_send_authorized: 0,
      content_publish_authorized: 0,
    });

    const draftTwo = db.saveCampaignDraft({
      briefKey: "my-sample-product-shadow",
      brief: {
        market: "Malaysia",
        productFamily: "sample components",
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
        providerBudget: { credits: 10 },
      },
      parserVersion: "campaign-brief-v2",
      sourceTextHash: "b".repeat(64),
      createdBy: "fixture-agent",
    });
    expect(draftTwo.versionNumber).toBe(2);
    expect(db.getCurrentCampaignBrief(draftTwo.briefId)).toMatchObject({
      current_version_id: draftTwo.versionId,
      status: "PLAN_DRAFT",
      shadow_authorized: 0,
      provider_budget_authorized: 0,
      external_send_authorized: 0,
      content_publish_authorized: 0,
    });
    expect(() => db.saveCampaignScopedApproval({
      briefId: draftOne.briefId,
      versionId: draftOne.versionId,
      scope: "EXTERNAL_SEND",
      actionId: "stale-send-action",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
    }, { actor: "manager@example.test", actorType: "HUMAN", roles: ["SALES_MANAGER"] }))
      .toThrow(/stale/i);
    expect(() => db.saveCampaignScopedApproval({
      briefId: draftTwo.briefId,
      versionId: draftTwo.versionId,
      scope: "PROVIDER_BUDGET",
      actionId: "wrong-budget-hash",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
      budgetHash: "f".repeat(64),
    }, budgetApprover)).toThrow(/does not match/i);
    const budgetHash = createHash("sha256").update(JSON.stringify({
      llmBudget: null,
      providerBudget: { credits: 10 },
    })).digest("hex");
    expect(db.saveCampaignScopedApproval({
      briefId: draftTwo.briefId,
      versionId: draftTwo.versionId,
      scope: "PROVIDER_BUDGET",
      actionId: "correct-budget-hash",
      authorizationSource: "EXPLICIT_FEISHU_ACTION",
      budgetHash,
    }, budgetApprover)).toMatchObject({ created: true, scope: "PROVIDER_BUDGET" });
    expect(() => db.db.prepare("UPDATE campaign_versions SET brief_hash=? WHERE id=?")
      .run("f".repeat(64), draftTwo.versionId)).toThrow(/immutable/i);
    expect(db.db.prepare("SELECT count(*) AS count FROM budget_reservations WHERE authorized=1").get())
      .toMatchObject({ count: 0 });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("persists evidence-backed market snapshots and never applies allocation suggestions", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v12-market-"));
    const { playId } = createPlay(db);
    const evidence = db.saveMarketEvidence({
      idempotencyKey: "market-evidence:my:imports:2025",
      country: "MY",
      period: "2025",
      hsRevision: "HS2022",
      metric: "IMPORT_DEPENDENCY",
      value: 42,
      unit: "percent",
      sourceUrl: "https://statistics.example.test/my-imports",
      authority: "GOVERNMENT",
      retrievedAt: now,
      contentHash: "c".repeat(64),
      confidence: 0.9,
      license: "PUBLIC_DOMAIN",
      humanReview: "APPROVED",
      expiresAt: "2027-07-20T08:00:00.000Z",
      createdBy: "market-reviewer",
    });
    expect(db.saveMarketEvidence({
      idempotencyKey: "market-evidence:my:imports:2025",
      country: "MY",
      period: "2025",
      hsRevision: "HS2022",
      metric: "IMPORT_DEPENDENCY",
      value: 42,
      unit: "percent",
      sourceUrl: "https://statistics.example.test/my-imports",
      authority: "GOVERNMENT",
      retrievedAt: now,
      contentHash: "c".repeat(64),
      confidence: 0.9,
      license: "PUBLIC_DOMAIN",
      humanReview: "APPROVED",
      expiresAt: "2027-07-20T08:00:00.000Z",
      createdBy: "market-reviewer",
    })).toEqual({ ...evidence, created: false });
    const snapshot = db.saveMarketOpportunitySnapshot({
      idempotencyKey: "market-snapshot:my:sample-products:2025:v1",
      country: "MY",
      productFamily: "Sample Products",
      period: "2025",
      policyVersion: "market-allocation-v1",
      score: 0.73,
      confidence: 0.8,
      evidenceIds: [evidence.id],
      snapshot: { components: { importDependency: 42 }, unknown: ["competition"] },
      createdBy: "market-shadow",
    });
    const allocation = db.savePlayAllocationSuggestion({
      idempotencyKey: "allocation:my:sample-products:2025:v1",
      playId,
      snapshotId: snapshot.id,
      policyVersion: "market-allocation-v1",
      recommendedUnits: 20,
      recommendedShare: 0.2,
      recommendation: "EXPLORE",
      reasons: ["SMALL_SAMPLE_EXPLORATION_PRESERVED"],
      createdBy: "market-shadow",
    });
    expect(db.db.prepare("SELECT applied, requires_human_approval FROM play_allocations WHERE id=?")
      .get(allocation.id)).toMatchObject({ applied: 0, requires_human_approval: 1 });
    expect(db.db.prepare("SELECT publication_authorized FROM market_opportunity_snapshots WHERE id=?")
      .get(snapshot.id)).toMatchObject({ publication_authorized: 0 });
    expect(() => db.db.prepare("UPDATE play_allocations SET applied=1 WHERE id=?").run(allocation.id))
      .toThrow(/cannot be applied automatically/i);
    expect(() => db.db.prepare("UPDATE market_evidence SET value=99 WHERE id=?").run(evidence.id))
      .toThrow(/immutable/i);
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("binds conservative forecasts to the exact immutable Campaign Brief version", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v12-forecast-"));
    const brief = {
      id: "forecast-brief",
      version: 1,
      market: "Malaysia",
      productFamily: "sample product application",
      targetMetric: "VALID_CONTACTS",
      targetCount: 20,
    };
    const saved = db.saveCampaignDraft({
      briefKey: brief.id,
      brief,
      createdBy: "forecast-test",
    });
    const forecast = {
      briefId: brief.id,
      briefVersion: brief.version,
      briefHash: saved.briefHash,
      status: "NO_RELIABLE_FORECAST",
      ranges: {
        accountsResearched: null,
        namedContacts: null,
        validContacts: null,
        readyForReview: null,
        costUsd: null,
      },
    };
    const stored = db.saveCampaignForecast({
      idempotencyKey: "forecast:brief:1",
      versionId: saved.versionId,
      forecast,
      basis: ["NO_COMPARABLE_HISTORY"],
      sampleSize: 0,
      uncertainty: "HIGH",
      reliable: false,
      createdBy: "forecast-test",
    });
    expect(db.saveCampaignForecast({
      idempotencyKey: "forecast:brief:1",
      versionId: saved.versionId,
      forecast,
      basis: ["NO_COMPARABLE_HISTORY"],
      sampleSize: 0,
      uncertainty: "HIGH",
      reliable: false,
      createdBy: "forecast-test",
    })).toEqual({ ...stored, created: false });
    expect(db.db.prepare("SELECT reliable, sample_size FROM campaign_forecasts WHERE id=?")
      .get(stored.id)).toMatchObject({ reliable: 0, sample_size: 0 });
    expect(() => db.saveCampaignForecast({
      idempotencyKey: "forecast:wrong-brief",
      versionId: saved.versionId,
      forecast: { ...forecast, briefHash: "f".repeat(64) },
      basis: ["NO_COMPARABLE_HISTORY"],
      sampleSize: 0,
      uncertainty: "HIGH",
      reliable: false,
      createdBy: "forecast-test",
    })).toThrow(/exact Campaign Brief/i);
    expect(() => db.db.prepare("UPDATE campaign_forecasts SET reliable=1 WHERE id=?")
      .run(stored.id)).toThrow(/immutable/i);
    db.close();
  });

  it("stores grounded message versions with deterministic review hashes and stable experiment arms", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v12-message-experiment-"));
    const { accountId } = createPlay(db);
    const plan = db.savePersonalizationPlan({
      planKey: "plan:account:v12",
      accountId,
      qualificationTrack: "ICP_FIT",
      qualificationPolicyVersion: "qualification-policy-v2",
      sellerFactSetVersion: "seller-public-v1",
      locale: "en-MY",
      plan: {
        observedFact: { text: "The official site lists sample application.", factIds: ["fact-1"] },
        relevanceHypothesis: { text: "Product selection may be relevant.", factIds: ["fact-1"], hedged: true },
        cta: { type: "QUESTION", text: "Is this relevant to your team?" },
      },
      factIds: ["fact-1"],
      status: "VALID",
      createdBy: "fixture-agent",
    });
    expect(db.savePersonalizationPlan({
      planKey: "plan:account:v12",
      accountId,
      qualificationTrack: "ICP_FIT",
      qualificationPolicyVersion: "qualification-policy-v2",
      sellerFactSetVersion: "seller-public-v1",
      locale: "en-MY",
      plan: {
        observedFact: { text: "The official site lists sample application.", factIds: ["fact-1"] },
        relevanceHypothesis: { text: "Product selection may be relevant.", factIds: ["fact-1"], hedged: true },
        cta: { type: "QUESTION", text: "Is this relevant to your team?" },
      },
      factIds: ["fact-1"],
      status: "VALID",
      createdBy: "fixture-agent",
    })).toEqual({ ...plan, created: false });
    const baseMessage = {
      messageKey: "message:account:v12",
      personalizationPlanId: plan.id,
      subject: "Sample application question",
      body: "Your official site lists sample application. Would a product selection checklist be relevant?",
      destination: "ENGINEER@V12-FIXTURE.EXAMPLE",
      sequenceIndex: 0,
      generationMode: "GROUNDED_PLAN",
      promptVersion: "prompt-v2",
      model: "fixture-model",
      templateVersion: "template-v2",
      lintVersion: "lint-v2",
      lintResult: { passed: true, blockers: [], warnings: [] },
      angle: "technical-checklist",
      locale: "en-MY",
      sellerFactSetVersion: "seller-public-v1",
      factIds: ["fact-1"],
      createdBy: "fixture-agent",
      status: "PENDING_APPROVAL" as const,
    };
    const messageOne = db.saveMessageVersion(baseMessage);
    expect(db.saveMessageVersion(baseMessage)).toEqual({ ...messageOne, created: false });
    const messageTwo = db.saveMessageVersion({ ...baseMessage, body: `${baseMessage.body} Thank you.` });
    expect(messageTwo.versionNumber).toBe(2);
    expect(messageTwo.reviewHash).not.toBe(messageOne.reviewHash);
    expect(() => db.saveMessageVersion({
      ...baseMessage,
      messageKey: "message:hash-mismatch",
      expectedReviewHash: "0".repeat(64),
    })).toThrow(/review hash/i);
    expect(() => db.saveMessageVersion({
      ...baseMessage,
      messageKey: "message:fallback",
      generationMode: "GENERIC_FALLBACK",
    })).toThrow(/non-fallback/i);
    expect(db.db.prepare("SELECT send_authorized FROM message_versions WHERE id=?").get(messageOne.id))
      .toMatchObject({ send_authorized: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM message_fact_links WHERE message_version_id=?")
      .get(messageOne.id)).toMatchObject({ count: 1 });
    expect(() => db.db.prepare("UPDATE message_versions SET subject='changed' WHERE id=?").run(messageOne.id))
      .toThrow(/immutable/i);

    const experimentOne = db.saveExperimentDefinition({
      experimentKey: "subject-line-fixture",
      hypothesis: "A technical subject improves qualified replies.",
      primaryVariable: "SUBJECT",
      arms: ["CONTROL", "TECHNICAL"],
      allocationSalt: "fixture-stable-salt",
      createdBy: "experiment-owner",
    });
    const firstAssignment = db.assignExperimentArm({
      experimentId: experimentOne.id,
      subjectType: "ACCOUNT",
      subjectId: accountId,
    });
    for (let replay = 0; replay < 25; replay += 1) {
      expect(db.assignExperimentArm({
        experimentId: experimentOne.id,
        subjectType: "ACCOUNT",
        subjectId: accountId,
      })).toEqual({ ...firstAssignment, created: false });
    }
    const experimentTwo = db.saveExperimentDefinition({
      experimentKey: "subject-line-fixture",
      hypothesis: "Updated hypothesis with the same single variable.",
      primaryVariable: "SUBJECT",
      arms: ["CONTROL", "TECHNICAL"],
      allocationSalt: "fixture-stable-salt",
      createdBy: "experiment-owner",
    });
    expect(experimentTwo.versionNumber).toBe(2);
    expect(db.assignExperimentArm({
      experimentId: experimentTwo.id,
      subjectType: "ACCOUNT",
      subjectId: accountId,
    })).toEqual({ ...firstAssignment, created: false });
    expect(db.db.prepare("SELECT external_send_authorized FROM experiments WHERE id=?").get(experimentOne.id))
      .toMatchObject({ external_send_authorized: 0 });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("records signals and human channel events without permitting automatic channel writes or unsafe rules", () => {
    const db = new AgentDatabase(databasePath("export-agent-schema-v12-signals-manual-"));
    const { accountId } = createPlay(db);
    const signal = db.saveSignalObservation({
      idempotencyKey: "signal:fixture:expansion:1",
      accountId,
      signalType: "PLANT_EXPANSION",
      sourceUrl: "https://v12-fixture.example/news/expansion",
      exactQuote: "The company announced a new production line.",
      publishedAt: "2026-07-01T00:00:00.000Z",
      observedAt: now,
      expiresAt: "2026-10-01T00:00:00.000Z",
      confidence: 0.8,
      authorityClass: "ACCOUNT_OFFICIAL",
      entityMatch: "MATCHED",
      createdBy: "signal-monitor",
    });
    expect(db.saveSignalObservation({
      idempotencyKey: "signal:fixture:expansion:1",
      accountId,
      signalType: "PLANT_EXPANSION",
      sourceUrl: "https://v12-fixture.example/news/expansion",
      exactQuote: "The company announced a new production line.",
      publishedAt: "2026-07-01T00:00:00.000Z",
      observedAt: now,
      expiresAt: "2026-10-01T00:00:00.000Z",
      confidence: 0.8,
      authorityClass: "ACCOUNT_OFFICIAL",
      entityMatch: "MATCHED",
      createdBy: "signal-monitor",
    })).toEqual({ ...signal, created: false });
    expect(() => db.saveRuleVersion({
      ruleKey: "unsafe-rule",
      condition: { signalType: "PLANT_EXPANSION" },
      actions: ["SEND"],
      createdBy: "fixture-agent",
    })).toThrow(/allowlisted/i);
    const rule = db.saveRuleVersion({
      ruleKey: "expansion-shadow-rule",
      condition: { signalType: "PLANT_EXPANSION" },
      actions: ["ENQUEUE_ACCOUNT_RESEARCH", "NOTIFY_OWNER"],
      createdBy: "fixture-agent",
    });
    expect(rule.created).toBe(true);
    expect(() => db.saveManualEngagementEvent({
      idempotencyKey: "manual-linkedin:fixture:1",
      accountId,
      channel: "LINKEDIN",
      eventType: "PROFILE_OPENED",
      direction: "NONE",
      occurredAt: now,
    }, agent)).toThrow(/authorized human/i);
    const manual = db.saveManualEngagementEvent({
      idempotencyKey: "manual-linkedin:fixture:1",
      accountId,
      channel: "LINKEDIN",
      eventType: "PROFILE_OPENED",
      direction: "NONE",
      occurredAt: now,
      notes: "Recorded after the salesperson opened the public profile manually.",
    }, salesperson);
    expect(db.saveManualEngagementEvent({
      idempotencyKey: "manual-linkedin:fixture:1",
      accountId,
      channel: "LINKEDIN",
      eventType: "PROFILE_OPENED",
      direction: "NONE",
      occurredAt: now,
      notes: "Recorded after the salesperson opened the public profile manually.",
    }, salesperson)).toEqual({ ...manual, created: false });
    expect(db.db.prepare(
      "SELECT actor_type, external_write_performed FROM manual_engagement_events WHERE id=?",
    ).get(manual.id)).toMatchObject({ actor_type: "HUMAN", external_write_performed: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM events WHERE event_type='MANUAL_ENGAGEMENT_RECORDED'")
      .get()).toMatchObject({ count: 1 });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });
});
