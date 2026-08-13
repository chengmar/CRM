import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import {
  listFeishuAlertDestinations,
  resolveFeishuJobDestination,
} from "../src/integrations/feishu-destinations.js";
import { JobWorker } from "../src/jobs/worker.js";
import type { DiscoveryProgress, DiscoverySummary } from "../src/search/discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-job-notification-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Condition not met after ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function discoverySummary(campaignId: string): DiscoverySummary {
  return {
    campaignId,
    provider: "fixture",
    orchestrator: "fixture",
    marketSummary: "fixture",
    queries: [],
    roundsCompleted: 1,
    searchResults: 1,
    candidateCompanies: 1,
    domainsAssessed: 1,
    leadsStored: 0,
    companyQualified: 0,
    contactsFound: 0,
    verifiedEmails: 0,
    riskyEmails: 0,
    enrichmentPending: 1,
    eligibleForReview: 0,
    rejected: 0,
    skipped: 0,
    duplicatesSkipped: 0,
    rejectionReasons: {},
    llmCallsUsed: 0,
    llmCallLimit: 1,
    hermesCallsUsed: 0,
    errors: [],
  };
}

describe("job notification destination fallback", () => {
  it("uses only the configured alert chat for an empty destination", () => {
    const db = new AgentDatabase(databasePath());
    const config = loadConfig({
      FEISHU_ALERT_CHAT_ID: "chat-fallback-fixture",
      FEISHU_ALERT_OPEN_IDS: "user-alert-fixture",
    });

    expect(listFeishuAlertDestinations(config, db)).toContain("chat-fallback-fixture");
    expect(resolveFeishuJobDestination(config, db, "  ")).toBe("chat-fallback-fixture");
    expect(resolveFeishuJobDestination(config, db, "chat-request-fixture"))
      .toBe("chat-request-fixture");

    const configWithoutFallback = loadConfig({ FEISHU_ALERT_OPEN_IDS: "user-alert-fixture" });
    expect(resolveFeishuJobDestination(configWithoutFallback, db, "")).toBe("");
    db.close();
  });

  it("delivers discovery progress and completion to the safe fallback and carries it forward", async () => {
    const db = new AgentDatabase(databasePath());
    const config = loadConfig({ FEISHU_ALERT_CHAT_ID: "chat-fallback-fixture" });
    const campaignId = db.createCampaign({
      name: "notification fallback fixture",
      market: "Malaysia",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 1,
      hourlyLimit: 1,
      followupDays: [3],
    });
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async (
      _campaign: unknown,
      onProgress?: (progress: DiscoveryProgress) => Promise<void>,
    ) => {
      await onProgress?.({ stage: "SEARCHING", message: "fixture progress" });
      return discoverySummary(campaignId);
    });
    const worker = new JobWorker(
      config,
      db,
      {
        assertLegacyRuntimeContracts: vi.fn(async () => ({ fixture: true })),
        run,
      } as never,
      {} as never,
      { isConfigured: () => false } as never,
      {} as never,
      { sendText } as never,
      { workerId: "notification-fallback-worker", pollIntervalMs: 10_000 },
    );
    const jobId = db.enqueueJob("DISCOVER_CAMPAIGN", { campaignId, replyChatId: "" });

    worker.start();
    await waitFor(() => db.getJob(jobId)?.status === "COMPLETED");
    await worker.stop();

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls.map(([destination]) => destination))
      .toEqual(["chat-fallback-fixture", "chat-fallback-fixture"]);
    const followup = db.db.prepare(
      "SELECT payload_json FROM jobs WHERE job_type='ENRICH_CONTACTS'",
    ).get() as { payload_json: string };
    expect(JSON.parse(followup.payload_json)).toMatchObject({
      campaignId,
      replyChatId: "chat-fallback-fixture",
      pass: 1,
    });
    db.close();
  });

  it("delivers a terminal job failure to the safe fallback", async () => {
    const db = new AgentDatabase(databasePath());
    const config = loadConfig({ FEISHU_ALERT_CHAT_ID: "chat-fallback-fixture" });
    const sendText = vi.fn(async () => undefined);
    const worker = new JobWorker(
      config,
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { sendText } as never,
      {
        workerId: "notification-failure-worker",
        pollIntervalMs: 10_000,
        executeJob: async () => {
          throw new Error("fixture terminal failure");
        },
      },
    );
    const jobId = db.enqueueJob("DISCOVER_CAMPAIGN", { replyChatId: "" });
    db.db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(jobId);

    worker.start();
    await waitFor(() => db.getJob(jobId)?.status === "FAILED");
    await worker.stop();

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      "chat-fallback-fixture",
      expect.stringContaining("DISCOVER_CAMPAIGN"),
    );
    db.close();
  });
});
