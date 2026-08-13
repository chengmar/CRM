import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { DiscoveryService } from "../src/search/discovery.js";

const databases: AgentDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("discovery business context gate", () => {
  it("fails closed before search when the seller brief is missing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-context-gate-"));
    directories.push(directory);
    const config = loadConfig({
      AGENT_DB_PATH: path.join(directory, "agent.db"),
      BUSINESS_DATA_DIR: path.join(directory, "missing-business-data"),
      SEARCH_PROVIDER: "none",
      HERMES_RESEARCH_ENABLED: "false",
    });
    const db = new AgentDatabase(config.AGENT_DB_PATH);
    databases.push(db);
    const campaignId = db.createCampaign({
      name: "Strict context gate fixture",
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 5,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const search = vi.fn(async () => []);
    const service = new DiscoveryService(
      config,
      db,
      { isConfigured: () => false } as never,
      undefined,
      { createSearchProvider: () => ({ name: "fixture", search }) },
    );

    await expect(service.run({
      id: campaignId,
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 5,
    })).rejects.toThrow(/BUSINESS_CONTEXT_NOT_READY/);
    expect(search).not.toHaveBeenCalled();
    expect(db.getCampaign(campaignId)).toMatchObject({ status: "DRAFT" });
  });
});
