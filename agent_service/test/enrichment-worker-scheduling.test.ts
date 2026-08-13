import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { JobWorker } from "../src/jobs/worker.js";
import type { ContactEnrichmentSummary } from "../src/search/discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-enrichment-worker-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.db");
}

function summary(
  overrides: Partial<ContactEnrichmentSummary>,
): ContactEnrichmentSummary {
  return {
    campaignId: "campaign_test",
    pass: 1,
    attempted: 25,
    contactsFound: 0,
    verifiedEmails: 0,
    riskyEmails: 0,
    readyForReview: 0,
    stillPending: 25,
    nextPass: 1,
    remainingInPass: 14,
    remainingEligible: 39,
    nextRunAt: new Date().toISOString(),
    hermesCallsUsed: 0,
    errors: [],
    ...overrides,
  };
}

describe("contact enrichment worker scheduling", () => {
  it("continues the same pass immediately, then delays the next persisted pass", async () => {
    const db = new AgentDatabase(databasePath());
    const samePassAt = new Date().toISOString();
    const nextPassAt = "2099-07-20T01:00:00.000Z";
    const enrichPendingContacts = vi.fn()
      .mockResolvedValueOnce(summary({ nextRunAt: samePassAt }))
      .mockResolvedValueOnce(summary({
        attempted: 14,
        pass: 1,
        nextPass: 2,
        remainingInPass: 39,
        nextRunAt: nextPassAt,
      }))
      .mockResolvedValueOnce(summary({
        attempted: 39,
        pass: 3,
        nextPass: null,
        remainingInPass: 0,
        remainingEligible: 0,
        nextRunAt: null,
      }));
    const worker = new JobWorker(
      {} as never,
      db,
      {
        assertLegacyRuntimeContracts: vi.fn(async () => ({ fixture: true })),
        enrichPendingContacts,
      } as never,
      {} as never,
      { isConfigured: () => false } as never,
      {} as never,
      {} as never,
    );
    const executor = worker as unknown as {
      execute(jobType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    const samePass = await executor.execute("ENRICH_CONTACTS", {
      campaignId: "campaign_test",
      pass: 99,
      enrichmentContext: "preserve-me",
    });
    expect(samePass).toMatchObject({
      pass: 1,
      nextSchedule: "same_pass",
      autonomousMessageBridge: { status: "NOT_AUTONOMOUS" },
    });
    const samePassControl = (samePass as { __jobControl: { followup: Record<string, unknown> } }).__jobControl;
    expect(samePassControl.followup).toMatchObject({
      jobType: "ENRICH_CONTACTS",
      runAfter: samePassAt,
      payload: { pass: 1, enrichmentContext: "preserve-me" },
      options: { dedupeKey: "contact-enrichment:campaign_test" },
    });

    const nextPass = await executor.execute("ENRICH_CONTACTS", {
      campaignId: "campaign_test",
      pass: 1,
    });
    expect(nextPass).toMatchObject({ pass: 1, nextSchedule: "next_pass" });
    const nextPassControl = (nextPass as { __jobControl: { followup: Record<string, unknown> } }).__jobControl;
    expect(nextPassControl.followup).toMatchObject({
      jobType: "ENRICH_CONTACTS",
      runAfter: nextPassAt,
      payload: { pass: 2 },
      options: { dedupeKey: "contact-enrichment:campaign_test" },
    });

    const finished = await executor.execute("ENRICH_CONTACTS", {
      campaignId: "campaign_test",
      pass: 3,
    });
    expect(finished).toMatchObject({
      pass: 3,
      nextSchedule: null,
      __jobControl: { followup: null },
    });
    expect(enrichPendingContacts).toHaveBeenCalledTimes(3);
    db.close();
  });

  it("creates the initial enrichment job only when discovery completion commits", async () => {
    const db = new AgentDatabase(databasePath());
    const campaignId = db.createCampaign({
      name: "atomic discovery follow-up",
      market: "Vietnam",
      product: "sample components",
      buyerType: "integrator",
      targetCount: 10,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const run = vi.fn(async () => ({ enrichmentPending: 3 }));
    const worker = new JobWorker(
      {} as never,
      db,
      {
        assertLegacyRuntimeContracts: vi.fn(async () => ({ fixture: true })),
        run,
      } as never,
      {} as never,
      { isConfigured: () => false } as never,
      {} as never,
      {} as never,
    );
    const executor = worker as unknown as {
      execute(jobType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    const result = await executor.execute("DISCOVER_CAMPAIGN", {
      campaignId,
      enrichmentContext: "preserve-from-discovery",
    });
    const control = (result as {
      __jobControl: { followup: Record<string, unknown>; notification: null };
    }).__jobControl;
    expect(control.followup).toMatchObject({
      jobType: "ENRICH_CONTACTS",
      payload: { campaignId, pass: 1, enrichmentContext: "preserve-from-discovery" },
      options: { dedupeKey: `contact-enrichment:${campaignId}` },
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });

    const parentId = db.enqueueJob("DISCOVER_CAMPAIGN", { campaignId });
    const parent = db.claimDueJob({
      workerId: "discovery-worker",
      lane: "RESEARCH",
      leaseDurationMs: 60_000,
    })!;
    expect(parent.id).toBe(parentId);
    const { __jobControl: _, ...persistedResult } = result as Record<string, unknown> & {
      __jobControl: unknown;
    };
    const completion = db.completeJobWithFollowup(
      parent.id,
      "discovery-worker",
      parent.lease_token,
      persistedResult,
      control.followup as never,
    );
    expect(completion.completed).toBe(true);
    expect(db.getJob(String(completion.followupJobId))).toMatchObject({
      status: "QUEUED",
      job_type: "ENRICH_CONTACTS",
      dedupe_key: `contact-enrichment:${campaignId}`,
    });
    db.close();
  });
});
