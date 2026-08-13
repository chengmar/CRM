import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("WO-07 campaign command draft", () => {
  it("persists FIND as a signed draft card before any research job starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-command-draft-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({ DEFAULT_PRODUCT: "sample products" });
    const llm = { isConfigured: () => false } as unknown as AgentLlm;
    const dispatcher = {} as OutboundDispatcher;
    const service = new CommandService(config, db, llm, dispatcher);

    const result = await service.handleText({
      text: "开发越南工业设备集成商20家",
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "message-fixture",
    });

    expect(result).toHaveProperty("card");
    expect(JSON.stringify(result)).toContain("按已批准模板开始研究（不发邮件）");
    expect(JSON.stringify(result)).toContain("start_research_from_approved_template");
    expect(db.db.prepare("SELECT count(*) AS count FROM campaigns").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_briefs").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare(
      "SELECT event_type, payload_json FROM events WHERE entity_type='campaign_brief' AND event_type='CAMPAIGN_PLAN_NEEDS_INPUT'",
    ).get()).toMatchObject({ event_type: "CAMPAIGN_PLAN_NEEDS_INPUT" });
    const payload = JSON.parse(String((db.db.prepare(
      "SELECT payload_json FROM events WHERE entity_type='campaign_brief' AND event_type='CAMPAIGN_PLAN_NEEDS_INPUT'",
    ).get() as { payload_json: string }).payload_json)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "PLAN_NEEDS_INPUT",
      draft: { transport: "NONE" },
      externalActionsAuthorized: false,
    });
    expect(payload.missingFields).toEqual(expect.arrayContaining([
      "targetMetric",
      "roleFamilies",
      "qualificationTracks",
      "providerBudget",
      "offerIds",
    ]));
    db.close();
  });

  it("explains the missing approved research template without creating a campaign", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-command-no-template-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const service = new CommandService(
      loadConfig({
        DEFAULT_PRODUCT: "sample products",
        FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ "owner-fixture": ["SALES_MANAGER"] }),
      }),
      db,
      { isConfigured: () => false } as unknown as AgentLlm,
      {} as OutboundDispatcher,
    );
    await service.handleText({
      text: "开发越南工业设备集成商20家",
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "missing-template",
    });
    const draft = db.db.prepare(
      `SELECT brief.id, brief.current_version_id, version.brief_hash
       FROM campaign_briefs brief
       JOIN campaign_versions version ON version.id=brief.current_version_id`,
    ).get() as { id: string; current_version_id: string; brief_hash: string };

    const response = await service.handleAction({
      action: {
        intent: "start_research_from_approved_template",
        briefId: draft.id,
        versionId: draft.current_version_id,
        briefHash: draft.brief_hash,
      },
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "missing-template-action",
    });

    expect(response).toContain("当前没有与该市场和产品匹配的可执行研究模板");
    expect(db.db.prepare("SELECT count(*) AS count FROM campaigns").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    db.close();
  });

  it("starts one real research-only campaign from an approved current-evidence play", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-command-research-launch-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const service = new CommandService(
      loadConfig({
        DEFAULT_PRODUCT: "sample products",
        MAX_PAGES_PER_CAMPAIGN: "1600",
        FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ "owner-fixture": ["SALES_MANAGER"] }),
      }),
      db,
      { isConfigured: () => false } as unknown as AgentLlm,
      {} as OutboundDispatcher,
    );
    const play = db.upsertPlay({
      key: "vn-sample-application-integrator-approved",
      name: "Vietnam sample application integrators",
      country: "VN",
      buyerArchetype: "SYSTEM_INTEGRATOR_EPC",
      application: "sample product application",
      productFamily: "sample products",
      roleFamily: "PROCUREMENT_ENGINEERING",
      qualificationTrack: "ICP_FIT",
      offer: "sample application review",
      channel: "EMAIL",
      status: "APPROVED",
      approvalPolicy: "REVIEW_ALL",
      definition: { approvedResearchTemplate: true },
      createdBy: "market-reviewer",
    });
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const evidence = db.saveMarketEvidence({
      idempotencyKey: "manual-launch-vn-evidence",
      country: "VN",
      period: "2026",
      hsRevision: "HS2022",
      metric: "PUBLIC_MARKET_SIGNAL",
      value: 1,
      unit: "INDEX",
      sourceUrl: "https://statistics.example.test/vn-sample-application",
      authority: "GOVERNMENT",
      retrievedAt: observedAt,
      contentHash: "d".repeat(64),
      confidence: 0.9,
      license: "PUBLIC_DOMAIN",
      humanReview: "APPROVED",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdBy: "market-reviewer",
    });
    const snapshot = db.saveMarketOpportunitySnapshot({
      idempotencyKey: "manual-launch-vn-snapshot",
      country: "VN",
      productFamily: "sample products",
      period: "2026",
      policyVersion: "market-allocation-v1",
      score: 0.8,
      confidence: 0.8,
      evidenceIds: [evidence.id],
      snapshot: { approvedResearchTemplate: true },
      createdBy: "market-reviewer",
    });
    const allocation = db.savePlayAllocationSuggestion({
      idempotencyKey: "manual-launch-vn-allocation",
      playId: play.playId,
      snapshotId: snapshot.id,
      policyVersion: "market-allocation-v1",
      recommendedUnits: 100,
      recommendedShare: 1,
      recommendation: "EXPLORE",
      reasons: ["APPROVED_RESEARCH_EXPLORATION"],
      createdBy: "market-reviewer",
    });
    await service.handleText({
      text: "开发越南工业设备集成商20家",
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "approved-template",
    });
    const draft = db.db.prepare(
      `SELECT brief.id, brief.current_version_id, version.brief_hash
       FROM campaign_briefs brief
       JOIN campaign_versions version ON version.id=brief.current_version_id
       WHERE brief.brief_key='feishu:approved-template'`,
    ).get() as { id: string; current_version_id: string; brief_hash: string };
    const action = {
      intent: "start_research_from_approved_template",
      briefId: draft.id,
      versionId: draft.current_version_id,
      briefHash: draft.brief_hash,
    };

    const first = await service.handleAction({
      action,
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "approved-template-action",
    });
    const second = await service.handleAction({
      action,
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "approved-template-action-replay",
    });

    expect(first).toContain("获客研究已正式启动");
    expect(second).toContain("已经启动，不会重复创建任务");
    expect(db.db.prepare("SELECT count(*) AS count FROM campaigns").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'").get())
      .toEqual({ count: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_play_links WHERE play_version_id=?")
      .get(play.playVersionId)).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT applied, requires_human_approval FROM play_allocations WHERE id=?")
      .get(allocation.id)).toMatchObject({ applied: 0, requires_human_approval: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_send_authorizations").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get()).toEqual({ count: 0 });
    expect(db.getSetting("outbound_paused")).toBe("true");
    const job = db.db.prepare("SELECT payload_json FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'").get() as {
      payload_json: string;
    };
    expect(JSON.parse(job.payload_json)).toMatchObject({
      researchOnly: true,
      maximumSequenceIndex: 0,
    });
    db.close();
  });

  it("records only an exact signed shadow-scope card approval and performs no external action", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-command-approval-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const service = new CommandService(
      loadConfig({
        FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ "campaign-owner": ["CAMPAIGN_APPROVER"] }),
      }),
      db,
      { isConfigured: () => false } as unknown as AgentLlm,
      {} as OutboundDispatcher,
    );
    const saved = db.saveCampaignDraft({
      briefKey: "campaign-card-fixture",
      brief: {
        market: "Malaysia",
        productFamily: "sample product application",
        providerBudget: { mode: "ZERO_COST", maxUnits: 0 },
        llmBudget: { mode: "ZERO_COST", maxUnits: 0 },
        transport: "NONE",
      },
      createdBy: "fixture",
    });
    const action = {
      intent: "approve_campaign_scope",
      briefId: saved.briefId,
      versionId: saved.versionId,
      scope: "SHADOW_PLAN",
      briefHash: saved.briefHash,
    };
    const result = await service.handleAction({
      action,
      senderId: "campaign-owner",
      chatId: "chat-fixture",
      messageId: "signed-card-action-1",
    });
    expect(result).toContain("SHADOW_PLAN 已批准");
    expect(db.getCurrentCampaignBrief(saved.briefId)).toMatchObject({
      shadow_authorized: 1,
      provider_budget_authorized: 0,
      external_send_authorized: 0,
      content_publish_authorized: 0,
    });
    expect(await service.handleAction({
      action,
      senderId: "campaign-owner",
      chatId: "chat-fixture",
      messageId: "signed-card-action-1",
    })).toContain("已经批准");
    expect(await service.handleAction({
      action: { ...action, scope: "EXTERNAL_SEND" },
      senderId: "campaign-owner",
      chatId: "chat-fixture",
      messageId: "signed-card-action-2",
    })).toContain("不能授权客户外发");
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toMatchObject({ count: 0 });
    db.close();
  });
});
