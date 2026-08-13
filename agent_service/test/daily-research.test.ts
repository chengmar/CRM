import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { FeishuIntegration } from "../src/integrations/feishu.js";
import { DailyResearchScheduler } from "../src/jobs/daily-research.js";
import { JobWorker } from "../src/jobs/worker.js";
import { DiscoveryService } from "../src/search/discovery.js";
import {
  launchScheduledDailyResearch,
  selectScheduledDailyResearchPlay,
} from "../src/acquisition/scheduled-research-launch.js";

const tempDirs: string[] = [];
const fixedNow = new Date("2026-07-23T02:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
});

afterEach(() => {
  vi.useRealTimers();
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

function databasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-daily-research-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    DAILY_RESEARCH_ENABLED: "true",
    DAILY_RESEARCH_HOUR: "9",
    DAILY_RESEARCH_TIMEZONE: "Asia/Shanghai",
    DAILY_RESEARCH_MARKETS: "Malaysia,Vietnam",
    DAILY_RESEARCH_TARGET: "15",
    FEISHU_ALERT_OPEN_IDS: "ou_fixture",
    SEARCH_PROVIDER: "searxng",
    SEARXNG_BASE_URL: "http://127.0.0.1:8888/",
    ACQ_SEARXNG_V2_ENABLED: "true",
    SEARXNG_LOCAL_ENDPOINT_ALLOWED: "true",
    ACQ_LOCAL_PUBLIC_WEB_ENABLED: "true",
    MAX_PAGES_PER_CAMPAIGN: "1600",
    ...overrides,
  });
}

function createEligiblePlay(
  db: AgentDatabase,
  key = "daily-my-sample-product",
  options: { market?: string; product?: string; buyerType?: string; share?: number } = {},
) {
  const market = options.market ?? "Malaysia";
  const product = options.product ?? "sample components";
  const buyerType = options.buyerType ?? "SYSTEM_INTEGRATOR_EPC";
  const play = db.upsertPlay({
    key,
    name: `${market} ${product}`,
    country: market,
    buyerArchetype: buyerType,
    application: "sample product application",
    productFamily: product,
    roleFamily: "Engineering and procurement",
    qualificationTrack: "ICP_FIT",
    offer: "RFQ readiness checklist",
    channel: "EMAIL",
    status: "SHADOW",
    approvalPolicy: "REVIEW_ALL",
    definition: { fixture: key },
    createdBy: "test",
  });
  const country = market === "Vietnam" || market === "VN"
    ? "VN"
    : market === "Philippines" || market === "PH"
      ? "PH"
      : market === "Indonesia" || market === "ID"
        ? "ID"
        : market === "Mexico" || market === "MX"
          ? "MX"
          : "MY";
  const evidence = db.saveMarketEvidence({
    idempotencyKey: `${key}:evidence`,
    country,
    period: "2026",
    hsRevision: "HS2022",
    metric: "MARKET_FIT",
    value: 1,
    unit: "score",
    sourceUrl: `https://statistics.example.test/${key}`,
    authority: "GOVERNMENT",
    retrievedAt: "2026-07-20T00:00:00.000Z",
    contentHash: key.padEnd(64, "e").slice(0, 64),
    confidence: 0.9,
    license: "PUBLIC_DOMAIN",
    humanReview: "APPROVED",
    expiresAt: "2027-07-23T00:00:00.000Z",
    createdBy: "market-reviewer",
  });
  const snapshot = db.saveMarketOpportunitySnapshot({
    idempotencyKey: `${key}:snapshot`,
    country,
    productFamily: product,
    period: "2026",
    policyVersion: "market-allocation-v1",
    score: 0.8,
    confidence: 0.9,
    evidenceIds: [evidence.id],
    snapshot: { fixture: key },
    createdBy: "market-reviewer",
  });
  const allocation = db.savePlayAllocationSuggestion({
    idempotencyKey: `${key}:allocation`,
    playId: play.playId,
    snapshotId: snapshot.id,
    policyVersion: "market-allocation-v1",
    recommendedUnits: 20,
    recommendedShare: options.share ?? 0.5,
    recommendation: "EXPLORE",
    reasons: ["fixture"],
    createdBy: "market-reviewer",
  });
  return { ...play, allocationId: allocation.id, snapshotId: snapshot.id };
}

function notifier() {
  return {
    sendText: vi.fn(async () => undefined),
  } as unknown as FeishuIntegration & { sendText: ReturnType<typeof vi.fn> };
}

function enableDailyResearch(db: AgentDatabase, actor = "ou_workspace_owner"): string {
  db.setSetting("daily_research_enabled", "true");
  return db.recordEvent("system", "daily_research", "DAILY_RESEARCH_ENABLED", actor, {});
}

describe("daily research reservation", () => {
  it("creates one allocation-backed campaign and job when two schedulers tick concurrently", async () => {
    const file = databasePath();
    const firstDb = new AgentDatabase(file);
    const play = createEligiblePlay(firstDb);
    const authorizationEventId = enableDailyResearch(firstDb);
    const secondDb = new AgentDatabase(file);
    const feishu = notifier();
    const first = new DailyResearchScheduler(config(), firstDb, feishu, () => fixedNow);
    const second = new DailyResearchScheduler(config(), secondDb, feishu, () => fixedNow);

    await Promise.all([first.tick(), second.tick()]);

    expect(firstDb.listCampaigns(10)).toHaveLength(1);
    const jobs = firstDb.db.prepare(
      "SELECT payload_json FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'",
    ).all() as Array<{ payload_json: string }>;
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]?.payload_json ?? "{}")).toMatchObject({
      researchOnly: true,
      playId: play.playId,
      playVersionId: play.playVersionId,
      allocationId: play.allocationId,
      trigger: "DAILY_SCHEDULE",
      scheduled: true,
      briefId: expect.stringMatching(/^cbrief_/),
      versionId: expect.stringMatching(/^cbriefv_/),
      briefHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(firstDb.getSetting("daily_research_run:2026-07-23")).toMatch(/^cmp_/);
    expect(firstDb.getSetting("daily_research_market_index")).toBeNull();
    const campaignId = String(firstDb.getSetting("daily_research_run:2026-07-23"));
    expect(firstDb.db.prepare(
      "SELECT play_version_id, is_primary FROM campaign_play_links WHERE campaign_id=? AND is_primary=1",
    ).get(campaignId)).toEqual({ play_version_id: play.playVersionId, is_primary: 1 });
    expect(firstDb.db.prepare(
      "SELECT applied, requires_human_approval FROM play_allocations WHERE id=?",
    ).get(play.allocationId)).toEqual({ applied: 0, requires_human_approval: 1 });
    expect(firstDb.db.prepare(
      `SELECT count(*) AS count FROM campaign_approvals
       WHERE scope IN ('SHADOW_PLAN','PROVIDER_BUDGET')`,
    ).get()).toEqual({ count: 2 });
    expect(firstDb.db.prepare(
      "SELECT count(*) AS count FROM campaign_provider_bindings WHERE campaign_id=?",
    ).get(campaignId)).toEqual({ count: 1 });
    expect(firstDb.db.prepare(
      "SELECT approved_by, approved_actor_type, authorization_source FROM campaign_approvals ORDER BY scope LIMIT 1",
    ).get()).toEqual({
      approved_by: "ou_workspace_owner",
      approved_actor_type: "HUMAN",
      authorization_source: `DAILY_RESEARCH_ENABLED_EVENT:${authorizationEventId}`,
    });
    expect(firstDb.db.prepare(
      "SELECT count(*) AS count FROM campaign_approvals WHERE scope='EXTERNAL_SEND'",
    ).get()).toEqual({ count: 0 });
    expect(firstDb.db.prepare("SELECT count(*) AS count FROM campaign_send_authorizations").get())
      .toEqual({ count: 0 });
    expect(firstDb.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toEqual({ count: 0 });
    expect(feishu.sendText).toHaveBeenCalledOnce();
    expect(feishu.sendText).toHaveBeenCalledWith(
      "ou_fixture",
      expect.stringMatching(/^每日自动研究已启动：.*不会生成或发送客户邮件。$/),
    );
    firstDb.close();
    secondDb.close();
  });

  it("passes the scheduled job through the real strict worker Provider preflight", async () => {
    const db = new AgentDatabase(databasePath());
    createEligiblePlay(db);
    enableDailyResearch(db);
    const loaded = config({
      DAILY_RESEARCH_MARKETS: "Malaysia",
      FEISHU_ALERT_OPEN_IDS: "",
    });
    const selection = selectScheduledDailyResearchPlay(db, {
      asOf: fixedNow.toISOString(),
      allowedMarkets: loaded.dailyResearchMarkets,
    });
    expect(selection.status).toBe("SELECTED");
    if (selection.status !== "SELECTED") throw new Error("fixture selection failed");
    const launched = launchScheduledDailyResearch(db, {
      runKey: "daily_research_run:2026-07-23",
      date: "2026-07-23",
      selection,
      allowedMarkets: loaded.dailyResearchMarkets,
      targetCount: 15,
      maxProviderUnits: loaded.MAX_PAGES_PER_CAMPAIGN,
      replyChatId: "",
    });
    if (!launched) throw new Error("fixture launch was not reserved");
    const job = db.getJob(launched.launch.ids.jobId);
    if (!job) throw new Error("fixture discovery job missing");
    const payload = JSON.parse(String(job.payload_json)) as Record<string, unknown>;

    const discovery = new DiscoveryService(
      loaded,
      db,
      { isConfigured: () => false } as never,
    );
    const preflight = vi.spyOn(discovery, "assertLegacyRuntimeContracts");
    const run = vi.spyOn(discovery, "run").mockResolvedValue({ enrichmentPending: 0 } as never);
    const worker = new JobWorker(
      loaded,
      db,
      discovery,
      {} as never,
      { isConfigured: () => false } as never,
      {} as never,
      { sendText: vi.fn(async () => undefined) } as never,
    );
    const executor = worker as unknown as {
      execute(type: string, jobPayload: Record<string, unknown>): Promise<unknown>;
    };

    await expect(executor.execute("DISCOVER_CAMPAIGN", payload)).resolves.toBeTruthy();
    expect(preflight).toHaveBeenCalledWith("DISCOVER_CAMPAIGN", launched.launch.ids.campaignId);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[3]).toMatchObject({
      campaignId: launched.launch.ids.campaignId,
      versionId: launched.launch.ids.versionId,
      searchProviderId: "SEARXNG",
      providerChecks: [expect.objectContaining({ status: "READY_LIVE" })],
      crawl: expect.objectContaining({ status: "READY_LIVE" }),
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_approvals WHERE scope='EXTERNAL_SEND'").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_send_authorizations").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("fails closed and reports missing eligible allocation at most once per day", async () => {
    const file = databasePath();
    const firstDb = new AgentDatabase(file);
    enableDailyResearch(firstDb);
    const secondDb = new AgentDatabase(file);
    const feishu = notifier();

    await Promise.all([
      new DailyResearchScheduler(config(), firstDb, feishu, () => fixedNow).tick(),
      new DailyResearchScheduler(config(), secondDb, feishu, () => fixedNow).tick(),
    ]);

    expect(feishu.sendText).toHaveBeenCalledOnce();
    expect(firstDb.getSetting("daily_research_notice:no_eligible_play:2026-07-23"))
      .toBe(fixedNow.toISOString());
    expect(firstDb.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    expect(firstDb.listCampaigns()).toEqual([]);
    expect(feishu.sendText).toHaveBeenCalledWith(
      "ou_fixture",
      expect.stringMatching(/^每日自动研究未启动：/),
    );
    firstDb.close();
    secondDb.close();
  });

  it("fails closed when configuration is enabled without a persisted human enable action", async () => {
    const db = new AgentDatabase(databasePath());
    createEligiblePlay(db);
    db.setSetting("daily_research_enabled", "true");
    const feishu = notifier();

    await new DailyResearchScheduler(config(), db, feishu, () => fixedNow).tick();

    expect(db.listCampaigns()).toEqual([]);
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    expect(db.getSetting("daily_research_run:2026-07-23")).toBeNull();
    expect(feishu.sendText).toHaveBeenCalledWith(
      "ou_fixture",
      expect.stringContaining("HUMAN_ENABLE_AUTHORIZATION_MISSING"),
    );
    db.close();
  });

  it("rolls back the marker, campaign, primary link and event if job insertion fails", () => {
    const db = new AgentDatabase(databasePath());
    const play = createEligiblePlay(db);
    enableDailyResearch(db);
    const selection = selectScheduledDailyResearchPlay(db, {
      asOf: fixedNow.toISOString(),
      allowedMarkets: config().dailyResearchMarkets,
    });
    expect(selection.status).toBe("SELECTED");
    if (selection.status !== "SELECTED") throw new Error("fixture selection failed");
    db.db.exec(`
      CREATE TRIGGER reject_daily_fixture BEFORE INSERT ON jobs
      BEGIN SELECT RAISE(ABORT, 'fixture job failure'); END;
    `);

    expect(() => launchScheduledDailyResearch(db, {
      runKey: "daily_research_run:2026-07-23",
      date: "2026-07-23",
      selection,
      allowedMarkets: config().dailyResearchMarkets,
      targetCount: 15,
      maxProviderUnits: 1600,
      replyChatId: "",
    })).toThrow("fixture job failure");
    expect(db.getSetting("daily_research_run:2026-07-23")).toBeNull();
    expect(db.listCampaigns(10)).toEqual([]);
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_play_links").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_briefs").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_approvals").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_provider_bindings").get())
      .toEqual({ count: 0 });
    expect(db.db.prepare(
      "SELECT applied, requires_human_approval FROM play_allocations WHERE id=?",
    ).get(play.allocationId)).toEqual({ applied: 0, requires_human_approval: 1 });
    db.close();
  });

  it("rolls back without launching when the selected allocation changes before reservation", () => {
    const db = new AgentDatabase(databasePath());
    const play = createEligiblePlay(db);
    enableDailyResearch(db);
    const loaded = config({ DAILY_RESEARCH_MARKETS: "Malaysia" });
    const selection = selectScheduledDailyResearchPlay(db, {
      asOf: fixedNow.toISOString(),
      allowedMarkets: loaded.dailyResearchMarkets,
    });
    expect(selection.status).toBe("SELECTED");
    if (selection.status !== "SELECTED") throw new Error("fixture selection failed");
    db.savePlayAllocationSuggestion({
      idempotencyKey: "daily-newer-allocation",
      playId: play.playId,
      snapshotId: play.snapshotId,
      policyVersion: "market-allocation-v1",
      recommendedUnits: 30,
      recommendedShare: 0.75,
      recommendation: "INCREASE",
      reasons: ["newer fixture"],
      createdBy: "market-reviewer",
    });

    expect(() => launchScheduledDailyResearch(db, {
      runKey: "daily_research_run:2026-07-23",
      date: "2026-07-23",
      selection,
      allowedMarkets: loaded.dailyResearchMarkets,
      targetCount: 15,
      maxProviderUnits: loaded.MAX_PAGES_PER_CAMPAIGN,
      replyChatId: "",
    })).toThrow(/changed before launch/);
    expect(db.getSetting("daily_research_run:2026-07-23")).toBeNull();
    expect(db.listCampaigns()).toEqual([]);
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_briefs").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    db.close();
  });

  it("exports filterable candidates and uses prior real reservations to preserve exploration", () => {
    const db = new AgentDatabase(databasePath());
    const malaysia = createEligiblePlay(db, "daily-my-play", { market: "Malaysia", share: 0.5 });
    const vietnam = createEligiblePlay(db, "daily-vn-play", { market: "Vietnam", share: 0.5 });

    expect(db.listDailyResearchPlayCandidates(fixedNow.toISOString(), { market: "MY" }))
      .toEqual([expect.objectContaining({ playId: malaysia.playId })]);
    expect(db.listDailyResearchPlayCandidates(fixedNow.toISOString(), { market: "Vietnam" }))
      .toEqual([expect.objectContaining({ playId: vietnam.playId })]);
    for (let index = 0; index < 3; index += 1) {
      db.recordEvent("system", "daily_research", "DAILY_RESEARCH_RESERVED", "test", {
        playId: malaysia.playId,
      });
    }

    const decision = db.selectDailyResearchPlay({ asOf: fixedNow.toISOString() });
    expect(decision.status).toBe("SELECTED");
    if (decision.status !== "SELECTED") throw new Error("fixture selection failed");
    expect(decision.selected.playId).toBe(vietnam.playId);
    expect(decision.weights.find((row) => row.playId === malaysia.playId)?.priorDailySelections).toBe(3);
    db.close();
  });

  it("matches Indonesia and Mexico play filters by country name or code", () => {
    const db = new AgentDatabase(databasePath());
    const indonesia = createEligiblePlay(db, "daily-id-play", { market: "ID" });
    const mexico = createEligiblePlay(db, "daily-mx-play", { market: "Mexico" });

    expect(db.listDailyResearchPlayCandidates(fixedNow.toISOString(), { market: "Indonesia" }))
      .toEqual([expect.objectContaining({ playId: indonesia.playId })]);
    expect(db.listDailyResearchPlayCandidates(fixedNow.toISOString(), { market: "MX" }))
      .toEqual([expect.objectContaining({ playId: mexico.playId })]);
    db.close();
  });

  it("treats configured markets as an allow-list while retaining weighted selection", async () => {
    const db = new AgentDatabase(databasePath());
    const allowed = createEligiblePlay(db, "daily-allowed-my", { market: "Malaysia", share: 0.05 });
    createEligiblePlay(db, "daily-unconfigured-id", { market: "Indonesia", share: 0.95 });
    enableDailyResearch(db);
    const feishu = notifier();

    await new DailyResearchScheduler(
      config({ DAILY_RESEARCH_MARKETS: "MY" }),
      db,
      feishu,
      () => fixedNow,
    ).tick();

    const payloadRow = db.db.prepare(
      "SELECT payload_json FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'",
    ).get() as { payload_json: string };
    expect(JSON.parse(payloadRow.payload_json)).toMatchObject({
      playId: allowed.playId,
      playVersionId: allowed.playVersionId,
      allocationId: allowed.allocationId,
    });
    expect(db.listCampaigns(10)[0]).toMatchObject({ market: "Malaysia" });
    db.close();
  });

  it("changes the selected play when persisted research outcomes improve", () => {
    const db = new AgentDatabase(databasePath());
    const strong = createEligiblePlay(db, "daily-strong-play", { share: 0.5 });
    const weak = createEligiblePlay(db, "daily-weak-play", { share: 0.5 });
    for (let index = 0; index < 3; index += 1) {
      const accountId = db.upsertAccount({
        domain: `strong-${index}.example`,
        displayName: `Strong outcome ${index}`,
        countryCode: "MY",
      });
      db.enrollAccountInPlay({
        accountId,
        playVersionId: strong.playVersionId,
        status: "QUALIFIED",
        qualificationTrack: "ICP_FIT",
        source: "test",
        idempotencyKey: `strong-enrollment-${index}`,
      });
    }
    db.db.prepare(
      `INSERT INTO resource_usage(
         id, play_version_id, resource_type, operation, units, cost_micros,
         currency, idempotency_key, occurred_at, metadata_json, created_at
       ) VALUES (?, ?, 'research_hours', 'account_research', 1, 0, 'USD', ?, ?, '{}', ?)`,
    ).run(
      "usage-strong-research",
      strong.playVersionId,
      "usage-strong-research",
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:00.000Z",
    );

    const candidates = db.listDailyResearchPlayCandidates(fixedNow.toISOString());
    expect(candidates.find((row) => row.playId === strong.playId)?.performance).toMatchObject({
      researchedAccounts: 3,
      qualifiedAccounts: 3,
      researchHours: 1,
    });
    expect(candidates.find((row) => row.playId === weak.playId)?.performance.qualifiedAccounts).toBe(0);
    const decision = db.selectDailyResearchPlay({ asOf: fixedNow.toISOString() });
    expect(decision.status).toBe("SELECTED");
    if (decision.status !== "SELECTED") throw new Error("fixture selection failed");
    expect(decision.selected.playId).toBe(strong.playId);
    db.close();
  });
});
