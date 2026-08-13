import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { jobLaneConcurrencyFromConfig } from "../src/jobs/worker.js";

describe("research capacity defaults", () => {
  it("can deeply assess at least 200 companies at the configured per-company page cap", () => {
    const config = loadConfig({});

    expect(config.MAX_PAGES_PER_CAMPAIGN).toBe(1_600);
    expect(config.MAX_PAGES_PER_CAMPAIGN / config.MAX_COMPANY_PAGES).toBeGreaterThanOrEqual(200);
  });

  it("runs two research jobs by default without changing the other lane limits", () => {
    const config = loadConfig({});

    expect(jobLaneConcurrencyFromConfig(config)).toEqual({
      REALTIME: 2,
      OPERATIONS: 1,
      RESEARCH: 2,
    });
  });

  it("loads explicit job lane concurrency overrides", () => {
    const config = loadConfig({
      JOB_WORKER_REALTIME_CONCURRENCY: "3",
      JOB_WORKER_OPERATIONS_CONCURRENCY: "2",
      JOB_WORKER_RESEARCH_CONCURRENCY: "4",
    });

    expect(jobLaneConcurrencyFromConfig(config)).toEqual({
      REALTIME: 3,
      OPERATIONS: 2,
      RESEARCH: 4,
    });
  });
});
