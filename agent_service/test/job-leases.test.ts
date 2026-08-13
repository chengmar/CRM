import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroundedMessageJobResult } from "../src/acquisition/grounded-message-workflow.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { FeishuIntegration } from "../src/integrations/feishu.js";
import {
  JobWorker,
  jobLaneConcurrencyFromConfig,
  type JobWorkerOptions,
} from "../src/jobs/worker.js";

const tempDirs: string[] = [];

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met after ${timeoutMs}ms`);
    await delay(5);
  }
}

function createWorker(
  db: AgentDatabase,
  executeJob: NonNullable<JobWorkerOptions["executeJob"]>,
  options: Omit<JobWorkerOptions, "executeJob"> = {},
): JobWorker {
  return new JobWorker(
    {} as never,
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { executeJob, ...options },
  );
}

describe("leased priority jobs", () => {
  it("compacts duplicate queued Bitable sync jobs while preserving one runnable job", () => {
    const db = new AgentDatabase(databasePath("export-agent-job-sync-compact-"));
    const jobs = Array.from({ length: 5 }, (_, index) =>
      db.enqueueJob("SYNC_BITABLE", { source: index }));

    expect(db.supersedeDuplicateQueuedJobs("SYNC_BITABLE", "sync-bitable")).toBe(4);
    const active = db.db.prepare(
      "SELECT id, dedupe_key FROM jobs WHERE job_type='SYNC_BITABLE' AND status IN ('QUEUED','RUNNING')",
    ).all();
    expect(active).toEqual([{ id: jobs[0], dedupe_key: "sync-bitable" }]);
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM jobs WHERE job_type='SYNC_BITABLE' AND status='SUPERSEDED'",
    ).get()).toEqual({ count: 4 });
    db.close();
  });

  it("atomically gives a queued job to only one database worker", async () => {
    const file = databasePath("export-agent-job-claim-");
    const first = new AgentDatabase(file);
    const second = new AgentDatabase(file);
    const jobId = first.enqueueJob("SYNC_BITABLE", { probe: true });

    const [firstClaim, secondClaim] = await Promise.all([
      Promise.resolve().then(() => first.claimDueJob({
        workerId: "worker-a",
        lane: "OPERATIONS",
        leaseDurationMs: 60_000,
      })),
      Promise.resolve().then(() => second.claimDueJob({
        workerId: "worker-b",
        lane: "OPERATIONS",
        leaseDurationMs: 60_000,
      })),
    ]);

    const claims = [firstClaim, secondClaim].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe(jobId);
    expect(first.getJob(jobId)).toMatchObject({ status: "RUNNING", attempts: 1 });
    first.close();
    second.close();
  });

  it("orders a lane by priority before due time and creation order", () => {
    const db = new AgentDatabase(databasePath("export-agent-job-priority-"));
    const lowId = db.enqueueJob("LOW_OPERATION", {}, undefined, {
      lane: "OPERATIONS",
      priority: 1,
    });
    const highId = db.enqueueJob("HIGH_OPERATION", {}, undefined, {
      lane: "OPERATIONS",
      priority: 99,
    });

    const high = db.claimDueJob({
      workerId: "priority-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    });
    expect(high?.id).toBe(highId);
    expect(db.completeJob(high!.id, "priority-worker", high!.lease_token, {})).toBe(true);
    expect(db.claimDueJob({
      workerId: "priority-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })?.id).toBe(lowId);
    db.close();
  });

  it("keeps a live lease, recovers an expired lease once, and rejects the old owner", () => {
    const file = databasePath("export-agent-job-recovery-");
    const first = new AgentDatabase(file);
    const second = new AgentDatabase(file);
    const jobId = first.enqueueJob("SYNC_BITABLE", {});
    const oldClaim = first.claimDueJob({
      workerId: "old-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })!;

    expect(second.recoverExpiredJobs()).toBe(0);
    first.db
      .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", jobId);
    expect(second.recoverExpiredJobs()).toBe(1);
    expect(first.recoverExpiredJobs()).toBe(0);

    const newClaim = second.claimDueJob({
      workerId: "new-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })!;
    expect(newClaim.id).toBe(jobId);
    expect(first.completeJob(jobId, "old-worker", oldClaim.lease_token, { stale: true })).toBe(false);
    expect(first.failJob(jobId, "old-worker", oldClaim.lease_token, "stale failure")).toBeNull();
    expect(second.completeJob(jobId, "new-worker", newClaim.lease_token, { fresh: true })).toBe(true);
    expect(first.getJob(jobId)).toMatchObject({ status: "COMPLETED", attempts: 2 });
    first.close();
    second.close();
  });

  it("fails an expired job at max attempts instead of replaying it forever", () => {
    const db = new AgentDatabase(databasePath("export-agent-job-max-attempts-"));
    const jobId = db.enqueueJob("SYNC_BITABLE", {});
    const claim = db.claimDueJob({
      workerId: "crashing-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })!;
    db.db.prepare(
      "UPDATE jobs SET attempts=max_attempts, lease_expires_at=? WHERE id=?",
    ).run("2000-01-01T00:00:00.000Z", jobId);

    expect(db.recoverExpiredJobs()).toBe(1);
    expect(db.getJob(jobId)).toMatchObject({
      status: "FAILED",
      attempts: 3,
      last_error: "job lease expired at maximum attempts",
    });
    expect(db.claimDueJob({
      workerId: "next-worker",
      lane: "OPERATIONS",
      leaseDurationMs: 60_000,
    })).toBeNull();
    expect(db.completeJob(jobId, "crashing-worker", claim.lease_token, {})).toBe(false);
    db.close();
  });

  it("atomically deduplicates follow-up jobs when duplicate parents complete", () => {
    const db = new AgentDatabase(databasePath("export-agent-job-followup-"));
    const firstId = db.enqueueJob("LEGACY_ENRICH_PARENT", { campaignId: "campaign_dedupe" });
    const secondId = db.enqueueJob("LEGACY_ENRICH_PARENT", { campaignId: "campaign_dedupe" });
    const first = db.claimDueJob({ workerId: "worker-a", lane: "RESEARCH", leaseDurationMs: 60_000 })!;
    const second = db.claimDueJob({ workerId: "worker-b", lane: "RESEARCH", leaseDurationMs: 60_000 })!;
    expect(new Set([first.id, second.id])).toEqual(new Set([firstId, secondId]));
    const followup = {
      jobType: "ENRICH_CONTACTS",
      payload: { campaignId: "campaign_dedupe", pass: 2 },
      runAfter: "2099-01-01T00:00:00.000Z",
      options: { dedupeKey: "contact-enrichment:campaign_dedupe" },
    };

    const firstCompletion = db.completeJobWithFollowup(
      first.id,
      "worker-a",
      first.lease_token,
      { parent: "a" },
      { ...followup, payload: { campaignId: "campaign_dedupe", pass: 3 } },
    );
    const secondCompletion = db.completeJobWithFollowup(
      second.id,
      "worker-b",
      second.lease_token,
      { parent: "b" },
      followup,
    );

    expect(firstCompletion.completed).toBe(true);
    expect(secondCompletion.completed).toBe(true);
    expect(secondCompletion.followupJobId).toBe(firstCompletion.followupJobId);
    const active = db.db.prepare(
      "SELECT * FROM jobs WHERE dedupe_key=? AND status IN ('QUEUED','RUNNING')",
    ).all("contact-enrichment:campaign_dedupe");
    expect(active).toHaveLength(1);
    db.close();
  });

  it("atomically replaces a completed enrichment job with a same-campaign follow-up", () => {
    const db = new AgentDatabase(databasePath("export-agent-job-followup-replacement-"));
    const dedupeKey = "contact-enrichment:campaign_replacement";
    const parentId = db.enqueueJob(
      "ENRICH_CONTACTS",
      { campaignId: "campaign_replacement", pass: 1 },
    );
    expect(db.enqueueJob(
      "ENRICH_CONTACTS",
      { campaignId: "campaign_replacement", pass: 3 },
      undefined,
      { dedupeKey: "caller-supplied-key-is-ignored" },
    )).toBe(parentId);
    expect(() => db.enqueueJob("ENRICH_CONTACTS", { pass: 1 })).toThrow(
      "ENRICH_CONTACTS requires a campaign id",
    );
    const parent = db.claimDueJob({
      workerId: "replacement-worker",
      lane: "RESEARCH",
      leaseDurationMs: 60_000,
    })!;

    const completion = db.completeJobWithFollowup(
      parent.id,
      "replacement-worker",
      parent.lease_token,
      { pass: 1 },
      {
        jobType: "ENRICH_CONTACTS",
        payload: { campaignId: "campaign_replacement", pass: 2 },
        runAfter: "2099-01-01T00:00:00.000Z",
        options: { dedupeKey },
      },
    );

    expect(completion.completed).toBe(true);
    expect(completion.followupJobId).not.toBe(parentId);
    expect(db.getJob(parentId)).toMatchObject({ status: "COMPLETED" });
    expect(db.db.prepare(
      "SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('QUEUED','RUNNING')",
    ).all(dedupeKey)).toEqual([{ id: completion.followupJobId }]);
    db.close();
  });

  it("starts realtime work while research is still running and renews the research lease", async () => {
    const file = databasePath("export-agent-job-lanes-");
    const db = new AgentDatabase(file);
    const observer = new AgentDatabase(file);
    const researchStarted = deferred();
    const releaseResearch = deferred();
    const realtimeStarted = deferred();
    const researchId = db.enqueueJob("DISCOVER_CAMPAIGN", {});
    const worker = createWorker(
      db,
      async (jobType) => {
        if (jobType === "DISCOVER_CAMPAIGN") {
          researchStarted.resolve();
          await releaseResearch.promise;
          return { research: true };
        }
        if (jobType === "PROCESS_WHATSAPP_WEBHOOK") {
          realtimeStarted.resolve();
          return { realtime: true };
        }
        throw new Error(`Unexpected job type: ${jobType}`);
      },
      {
        workerId: "lane-worker",
        pollIntervalMs: 10_000,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
      },
    );

    worker.start();
    await within(researchStarted.promise);
    await delay(1_250);
    expect(observer.recoverExpiredJobs()).toBe(0);
    expect(observer.claimDueJob({
      workerId: "observer",
      lane: "RESEARCH",
      leaseDurationMs: 1000,
    })).toBeNull();

    const realtimeId = db.enqueueJob("PROCESS_WHATSAPP_WEBHOOK", {});
    await worker.tick();
    await within(realtimeStarted.promise, 300);
    expect(db.getJob(researchId)?.status).toBe("RUNNING");
    await waitFor(() => db.getJob(realtimeId)?.status === "COMPLETED");

    releaseResearch.resolve();
    await worker.stop();
    expect(db.getJob(researchId)?.status).toBe("COMPLETED");
    db.close();
    observer.close();
  });

  it("starts two research jobs with the configured production lane capacity", async () => {
    const db = new AgentDatabase(databasePath("export-agent-job-research-capacity-"));
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();
    let started = 0;
    const firstId = db.enqueueJob("RESEARCH_ALPHA", {});
    const secondId = db.enqueueJob("RESEARCH_BETA", {});
    const config = loadConfig({ JOB_WORKER_RESEARCH_CONCURRENCY: "2" });
    const worker = createWorker(
      db,
      async () => {
        started += 1;
        (started === 1 ? firstStarted : secondStarted).resolve();
        await release.promise;
        return { completed: true };
      },
      {
        workerId: "configured-research-worker",
        pollIntervalMs: 10_000,
        laneConcurrency: jobLaneConcurrencyFromConfig(config),
      },
    );

    worker.start();
    await within(Promise.all([firstStarted.promise, secondStarted.promise]));
    expect(db.getJob(firstId)?.status).toBe("RUNNING");
    expect(db.getJob(secondId)?.status).toBe("RUNNING");

    release.resolve();
    await worker.stop();
    expect(db.getJob(firstId)?.status).toBe("COMPLETED");
    expect(db.getJob(secondId)?.status).toBe("COMPLETED");
    db.close();
  });

  it("propagates lease loss into enrichment before post-research writes", async () => {
    const file = databasePath("export-agent-enrichment-lease-guard-");
    const db = new AgentDatabase(file);
    const observer = new AgentDatabase(file);
    const started = deferred();
    const release = deferred();
    let guardedWrites = 0;
    const discovery = {
      assertLegacyRuntimeContracts: vi.fn(async () => ({ fixture: true })),
      enrichPendingContacts: vi.fn(async (
        _campaignId: string,
        _limit: number,
        _progress: unknown,
        assertActive: () => void,
      ) => {
        started.resolve();
        await release.promise;
        assertActive();
        guardedWrites += 1;
        return {};
      }),
    };
    const jobId = db.enqueueJob("ENRICH_CONTACTS", {
      campaignId: "campaign_guard",
      pass: 1,
    });
    const worker = new JobWorker(
      {} as never,
      db,
      discovery as never,
      {} as never,
      { isConfigured: () => false } as never,
      {} as never,
      { sendText: vi.fn(async () => undefined) } as never,
      {
        workerId: "old-enrichment-worker",
        pollIntervalMs: 10_000,
        leaseDurationMs: 100,
        heartbeatIntervalMs: 40,
      },
    );

    worker.start();
    await within(started.promise);
    db.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", jobId);
    expect(observer.recoverExpiredJobs()).toBe(1);
    const newClaim = observer.claimDueJob({
      workerId: "new-enrichment-worker",
      lane: "RESEARCH",
      leaseDurationMs: 60_000,
    })!;
    release.resolve();
    await worker.stop();

    expect(guardedWrites).toBe(0);
    expect(observer.getJob(jobId)).toMatchObject({ status: "RUNNING", worker_id: "new-enrichment-worker" });
    expect(observer.completeJob(jobId, "new-enrichment-worker", newClaim.lease_token, {})).toBe(true);
    db.close();
    observer.close();
  });

  it("drains active work before stop resolves and leaves no heartbeat after database close", async () => {
    const db = new AgentDatabase(databasePath("export-agent-job-stop-"));
    const started = deferred();
    const release = deferred();
    const renewSpy = vi.spyOn(db, "renewJobLease");
    const jobId = db.enqueueJob("SYNC_BITABLE", {});
    const worker = createWorker(
      db,
      async () => {
        started.resolve();
        await release.promise;
        return { drained: true };
      },
      {
        workerId: "drain-worker",
        pollIntervalMs: 10_000,
        leaseDurationMs: 80,
        heartbeatIntervalMs: 10,
      },
    );

    worker.start();
    await within(started.promise);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await delay(30);
    expect(stopped).toBe(false);
    expect(renewSpy.mock.calls.length).toBeGreaterThan(0);

    release.resolve();
    await stopping;
    expect(db.getJob(jobId)?.status).toBe("COMPLETED");
    const renewalsAtClose = renewSpy.mock.calls.length;
    db.close();
    await delay(40);
    expect(renewSpy).toHaveBeenCalledTimes(renewalsAtClose);
  });

  it("atomically outboxes grounded review cards, retries delivery, and rejects payload destinations", async () => {
    const db = new AgentDatabase(databasePath("export-agent-grounded-job-"));
    const config = loadConfig({ FEISHU_MESSAGE_REVIEW_DESTINATIONS: "chat-review" });
    const result: GroundedMessageJobResult = {
      status: "PENDING_APPROVAL",
      qualificationRunId: "qualification-1",
      experimentAssignmentId: null,
      experimentArm: null,
      planId: "plan-1",
      messageVersionId: "message-version-1",
      planVersion: 1,
      messageVersion: 1,
      reviewHash: "a".repeat(64),
      reviewCardId: "review-card-1",
      reviewExpiresAt: "2026-07-21T00:00:00.000Z",
      lint: {
        passed: true,
        status: "PENDING_APPROVAL",
        blockers: [],
        warnings: [],
        referencedFactIds: ["fact-1"],
      },
      qualification: null,
      externalSendAuthorized: false,
      review: {
        accountId: "account-1",
        leadId: "lead-1",
        contactId: "contact-1",
        qualificationTrack: "ICP_FIT",
        locale: "en-MY",
        destination: "buyer@example.test",
        subject: "Grounded subject",
        body: "Grounded body",
        referencedFactIds: ["fact-1"],
      },
    };
    const stageGroundedMessage = vi.fn(() => result);
    const sendCard = vi.fn(async () => undefined);
    const worker = new JobWorker(
      config,
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { sendCard, sendText: vi.fn(async () => undefined) } as never,
      {
        workerId: "grounded-worker",
        pollIntervalMs: 10_000,
        stageGroundedMessage,
        now: () => new Date("2026-07-20T00:00:00.000Z"),
      },
    );
    const jobId = db.enqueueJob("STAGE_GROUNDED_MESSAGE", {
      replyChatId: "chat-review",
      plan: { id: "opaque-fixture" },
    });

    worker.start();
    await waitFor(() => db.getJob(jobId)?.status === "COMPLETED");
    await worker.stop();

    expect(stageGroundedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ replyChatId: "chat-review" }),
      new Date("2026-07-20T00:00:00.000Z"),
    );
    expect(sendCard).not.toHaveBeenCalled();
    expect(db.listPendingNotifications()).toEqual([
      expect.objectContaining({
        event_type: "GROUNDED_MESSAGE_REVIEW",
        destination: "chat-review",
        status: "PENDING",
      }),
    ]);
    expect(JSON.parse(String(db.getJob(jobId)?.result_json))).toMatchObject({
      status: "PENDING_APPROVAL",
      externalSendAuthorized: false,
      review: { subject: "Grounded subject" },
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toEqual({ count: 0 });

    const delivery = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Feishu failure"))
      .mockResolvedValueOnce(undefined);
    const integration = new FeishuIntegration(config, db);
    (integration as unknown as { channel: { send: typeof delivery } }).channel = { send: delivery };
    const queuedAt = String(db.listPendingNotifications()[0]?.next_attempt_at);
    await integration.flushPendingNotifications(new Date(Date.parse(queuedAt) + 1_000));
    expect(db.listPendingNotifications()).toEqual([
      expect.objectContaining({ status: "PENDING", attempts: 1 }),
    ]);
    const retryAt = String(db.listPendingNotifications()[0]?.next_attempt_at);
    await integration.flushPendingNotifications(new Date(Date.parse(retryAt) - 1));
    expect(delivery).toHaveBeenCalledTimes(1);
    await integration.flushPendingNotifications(new Date(retryAt));
    expect(db.listPendingNotifications()).toEqual([]);
    expect(delivery).toHaveBeenCalledTimes(2);
    const cardJson = JSON.stringify(delivery.mock.calls[1]?.[1]);
    expect(cardJson).toContain("证据化邮件内容审核");
    expect(cardJson).toContain("Grounded body");
    expect(cardJson).toContain("批准邮件内容");
    expect(cardJson).toContain("需要重写");

    const attackerJob = db.enqueueJob("STAGE_GROUNDED_MESSAGE", {
      replyChatId: "attacker-controlled-chat",
      plan: { id: "opaque-attacker-fixture" },
    });
    const attackerWorker = new JobWorker(
      config,
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { sendCard, sendText: vi.fn(async () => undefined) } as never,
      {
        workerId: "grounded-attacker-worker",
        pollIntervalMs: 10_000,
        stageGroundedMessage,
        now: () => new Date("2026-07-20T00:00:00.000Z"),
      },
    );
    attackerWorker.start();
    await waitFor(() => db.getJob(attackerJob)?.status === "COMPLETED");
    await attackerWorker.stop();
    expect(db.db.prepare("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1 });
    expect(sendCard).not.toHaveBeenCalled();
    db.close();
  });
});
