import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import {
  launchAutonomousResearch,
  parseAutonomousResearchLaunchSpec,
} from "../src/acquisition/autonomous-research-launch.js";
import { enqueueAutonomousGroundedMessagesAfterDiscovery } from "../src/acquisition/autonomous-discovery-message-bridge.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-research-"));
  directories.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function spec() {
  return {
    launchKey: "research-tier-b",
    actionId: "research-tier-b-action",
    campaign: {
      name: "Tier B official mailbox research",
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 50,
    },
    brief: {
      schemaVersion: "campaign-brief-v2",
      id: "caller-id",
      version: 4,
      market: "Malaysia",
      productFamily: "sample product application",
      buyerTypes: ["system integrator"],
      industries: ["sample application"],
      roleFamilies: ["engineering"],
      qualificationTracks: ["HIGH_ICP_FIT"],
      requiredSignals: ["documented industrial application"],
      exclusions: ["consumer-only reseller"],
      targetMetric: "ACCOUNTS_RESEARCHED",
      targetCount: 50,
      providerBudget: {
        mode: "CAPPED",
        allowedProviders: ["searxng", "local-public-web"],
        unit: "REQUESTS",
        maxUnits: 100,
        maxAmountUsd: 0,
        requiresSeparateApproval: true,
      },
      llmBudget: {
        mode: "ZERO_COST",
        allowedProviders: ["openai"],
        unit: "TOKENS",
        maxUnits: 0,
        maxAmountUsd: 0,
        requiresSeparateApproval: true,
      },
      offerIds: ["research-placeholder"],
      transport: "NONE",
      deadline: null,
      hypothesis: "Official websites can provide auditable account and company-mailbox evidence.",
    },
    authorization: {
      actor: "workspace-owner",
      source: "THREAD_EXPLICIT_AUTHORIZATION",
      reason: "Research only; no external sending authorization.",
    },
    replyChatId: "",
  } as const;
}

describe("autonomous research-only launch", () => {
  it("queues capped public research without a verifier or any external-send authorization", () => {
    const db = database();
    try {
      const result = launchAutonomousResearch(db, spec());
      expect(result).toMatchObject({ status: "RESEARCH_LAUNCHED", externalSendAuthorized: false });
      expect(db.db.prepare("SELECT count(*) AS count FROM campaign_send_authorizations").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT count(*) AS count FROM campaign_approvals WHERE scope='EXTERNAL_SEND'").get())
        .toEqual({ count: 0 });
      expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get()).toEqual({ count: 0 });
      const job = db.getJob(result.ids.jobId)!;
      const payload = JSON.parse(String(job.payload_json)) as Record<string, unknown>;
      expect(payload).toMatchObject({ researchOnly: true, campaignId: result.ids.campaignId });
      expect(enqueueAutonomousGroundedMessagesAfterDiscovery({ db, discoveryPayload: payload }))
        .toMatchObject({ status: "NOT_AUTONOMOUS", enqueued: 0 });

      const replay = launchAutonomousResearch(db, spec());
      expect(replay).toEqual(result);
      expect(db.db.prepare("SELECT count(*) AS count FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'").get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects SMTP, verifier providers, and unbounded research specs", () => {
    const base = spec();
    expect(() => parseAutonomousResearchLaunchSpec({
      ...base,
      brief: { ...base.brief, transport: "SMTP" },
    })).toThrow(/requires NONE/);
    expect(() => parseAutonomousResearchLaunchSpec({
      ...base,
      brief: {
        ...base.brief,
        providerBudget: {
          ...base.brief.providerBudget,
          allowedProviders: ["searxng", "local-public-web", "hunter"],
        },
      },
    })).toThrow(/permits exactly/);
  });
});
