import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { JobWorker } from "../src/jobs/worker.js";
import { LegacyDiscoveryRuntimeBlockedError } from "../src/search/legacy-discovery-runtime.js";

describe("JobWorker legacy discovery runtime boundary", () => {
  it.each(["DISCOVER_CAMPAIGN", "ENRICH_CONTACTS"] as const)(
    "fails %s before the legacy discovery implementation can run",
    async (jobType) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-discovery-worker-contract-"));
      const db = new AgentDatabase(path.join(dir, "agent.db"));
      try {
        const campaignId = db.createCampaign({
          name: "runtime contract fixture",
          market: "Malaysia",
          product: "sample products",
          buyerType: "system integrator",
          targetCount: 5,
          createdBy: "fixture",
          dailyLimit: 5,
          hourlyLimit: 2,
          followupDays: [3, 7, 14],
        });
        const preflight = vi.fn(async () => {
          throw new LegacyDiscoveryRuntimeBlockedError(
            "PROVIDER_CONTRACT_BLOCKED",
            "SERPER",
            "BLOCKED_DISABLED",
            "DISABLED_STUB",
          );
        });
        const run = vi.fn();
        const enrichPendingContacts = vi.fn();
        const worker = new JobWorker(
          {} as never,
          db,
          {
            assertLegacyRuntimeContracts: preflight,
            run,
            enrichPendingContacts,
          } as never,
          {} as never,
          { isConfigured: () => false } as never,
          {} as never,
          {} as never,
        );
        const executor = worker as unknown as {
          execute(type: string, payload: Record<string, unknown>): Promise<unknown>;
        };

        await expect(executor.execute(jobType, { campaignId })).rejects.toMatchObject({
          code: "PROVIDER_CONTRACT_BLOCKED",
          providerId: "SERPER",
        });
        expect(preflight).toHaveBeenCalledOnce();
        expect(preflight).toHaveBeenCalledWith(jobType, campaignId);
        expect(run).not.toHaveBeenCalled();
        expect(enrichPendingContacts).not.toHaveBeenCalled();
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["DISCOVER_CAMPAIGN", "ENRICH_CONTACTS"] as const)(
    "passes the exact authorized runtime material into %s execution",
    async (jobType) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-discovery-worker-authorized-"));
      const db = new AgentDatabase(path.join(dir, "agent.db"));
      try {
        const campaignId = db.createCampaign({
          name: "authorized runtime fixture",
          market: "Malaysia",
          product: "sample products",
          buyerType: "system integrator",
          targetCount: 5,
          createdBy: "fixture",
          dailyLimit: 5,
          hourlyLimit: 2,
          followupDays: [3, 7, 14],
        });
        const report = {
          campaignId,
          versionId: "campaign-version-1",
          searchProviderId: "SEARXNG",
          providerChecks: [{
            providerId: "SEARXNG",
            operation: "EVIDENCE_SEARCH",
            status: "READY_LIVE",
            reason: "NONE",
          }],
          crawl: { providerId: "LOCAL_PUBLIC_WEB", status: "READY_LIVE", mode: "LIVE" },
        } as const;
        const preflight = vi.fn(async () => report);
        const run = vi.fn(async () => ({ enrichmentPending: 0 }));
        const enrichPendingContacts = vi.fn(async () => ({
          pass: 1,
          remainingEligible: 0,
          nextPass: null,
          nextRunAt: null,
        }));
        const worker = new JobWorker(
          {} as never,
          db,
          { assertLegacyRuntimeContracts: preflight, run, enrichPendingContacts } as never,
          {} as never,
          { isConfigured: () => false } as never,
          {} as never,
          {} as never,
        );
        const executor = worker as unknown as {
          execute(type: string, payload: Record<string, unknown>): Promise<unknown>;
        };

        await expect(executor.execute(jobType, { campaignId })).resolves.toBeTruthy();
        expect(preflight).toHaveBeenCalledWith(jobType, campaignId);
        if (jobType === "DISCOVER_CAMPAIGN") {
          expect(run).toHaveBeenCalledOnce();
          expect(run.mock.calls[0]?.[3]).toBe(report);
          expect(enrichPendingContacts).not.toHaveBeenCalled();
        } else {
          expect(enrichPendingContacts).toHaveBeenCalledOnce();
          expect(enrichPendingContacts.mock.calls[0]?.[4]).toBe(report);
          expect(run).not.toHaveBeenCalled();
        }
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
