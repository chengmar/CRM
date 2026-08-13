import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleContinuousAcquisition } from "../src/acquisition/continuous-operations.js";
import { AgentDatabase } from "../src/db.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "continuous-operations-"));
  directories.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

describe("continuous acquisition scheduling", () => {
  it("does not build an unbounded discovery queue", () => {
    const db = database();
    const jobId = db.enqueueJob("DISCOVER_CAMPAIGN", { campaignId: "existing" });

    expect(scheduleContinuousAcquisition(db)).toEqual({
      status: "BUSY",
      campaignId: null,
      jobId,
    });
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM jobs WHERE job_type='DISCOVER_CAMPAIGN'",
    ).get()).toEqual({ count: 1 });
    db.close();
  });

  it("fails closed when no authorized under-target campaign exists", () => {
    const db = database();
    db.createCampaign({
      name: "unapproved campaign",
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 50,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 1,
      followupDays: [3, 7, 14],
    });

    expect(scheduleContinuousAcquisition(db)).toEqual({
      status: "NO_ELIGIBLE_CAMPAIGN",
      campaignId: null,
      jobId: null,
    });
    db.close();
  });

  it("enqueues the selected authorized campaign with a stable dedupe key", () => {
    const prepare = vi.fn()
      .mockReturnValueOnce({ get: () => undefined })
      .mockReturnValueOnce({ get: () => ({ id: "campaign-authorized" }) });
    const enqueueJob = vi.fn(() => "job-new");
    const recordEvent = vi.fn();
    const db = { db: { prepare }, enqueueJob, recordEvent } as unknown as AgentDatabase;

    expect(scheduleContinuousAcquisition(db, new Date("2026-07-24T00:00:00.000Z"))).toEqual({
      status: "ENQUEUED",
      campaignId: "campaign-authorized",
      jobId: "job-new",
    });
    expect(enqueueJob).toHaveBeenCalledWith(
      "DISCOVER_CAMPAIGN",
      { campaignId: "campaign-authorized", trigger: "CONTINUOUS_OPERATIONS" },
      undefined,
      { dedupeKey: "continuous-discovery:campaign-authorized" },
    );
    expect(recordEvent).toHaveBeenCalledWith(
      "system",
      "continuous_acquisition",
      "CONTINUOUS_DISCOVERY_SCHEDULED",
      "system",
      { campaignId: "campaign-authorized", jobId: "job-new" },
    );
  });
});
