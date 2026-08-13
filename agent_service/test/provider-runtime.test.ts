import { describe, expect, it, vi } from "vitest";
import {
  ProviderBudget,
  ProviderRuntime,
  type AuditedProviderAdapter,
  type ProviderAttemptAudit,
} from "../src/acquisition/provider-runtime.js";

function adapter(overrides: Partial<AuditedProviderAdapter<{ domain: string }, string>> = {}) {
  return {
    id: "fixture-provider",
    enabled: true,
    configured: true,
    health: async () => ({ state: "HEALTHY" as const, checkedAt: new Date().toISOString(), detail: "fixture" }),
    estimateCost: () => ({ costUnits: 1, usd: 0.05, currency: "USD" as const }),
    execute: vi.fn(async ({ domain }: { domain: string }) => ({
      value: `assertion:${domain}`,
      actualCost: { costUnits: 1, usd: 0.05 },
      upstreamRequestId: "fixture-run",
    })),
    ...overrides,
  } satisfies AuditedProviderAdapter<{ domain: string }, string>;
}

describe("provider runtime safety contract", () => {
  it.each([
    { enabled: false, configured: true, status: "DISABLED" },
    { enabled: true, configured: false, status: "NOT_CONFIGURED" },
  ])("returns $status with zero provider requests", async ({ enabled, configured, status }) => {
    const provider = adapter({ enabled, configured });
    const runtime = new ProviderRuntime(() => undefined);
    const result = await runtime.run({
      adapter: provider,
      operation: "search_people",
      request: { domain: "example.com" },
      budget: new ProviderBudget(10, 10),
    });

    expect(result.status).toBe(status);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(result.actualCost).toMatchObject({ costUnits: 0, usd: 0 });
  });

  it("merges concurrent identical requests and charges the budget once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = adapter({
      execute: vi.fn(async ({ domain }) => {
        await gate;
        return { value: `assertion:${domain}`, actualCost: { costUnits: 1, usd: 0.05 } };
      }),
    });
    const audits: ProviderAttemptAudit[] = [];
    const runtime = new ProviderRuntime((attempt) => audits.push(attempt));
    const budget = new ProviderBudget(2, 1);
    const input = {
      adapter: provider,
      operation: "search_people",
      request: { domain: "example.com" },
      budget,
    };
    const first = runtime.run(input);
    const second = runtime.run(input);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.status).toBe("SUCCEEDED");
    expect(right.status).toBe("SUCCEEDED");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(budget.snapshot()).toMatchObject({ usedCostUnits: 1, usedUsd: 0.05, reservations: 1 });
  });

  it("fails closed before execution when the atomic budget is exhausted", async () => {
    const provider = adapter();
    const runtime = new ProviderRuntime(() => undefined);
    const result = await runtime.run({
      adapter: provider,
      operation: "find_email",
      request: { domain: "example.com" },
      budget: new ProviderBudget(0, 0),
    });

    expect(result).toMatchObject({ status: "BUDGET_EXHAUSTED", errorClass: "PROVIDER_BUDGET_EXHAUSTED" });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("classifies timeouts, releases the reservation, and never reports success", async () => {
    const provider = adapter({
      execute: vi.fn((_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
    });
    const budget = new ProviderBudget(1, 1);
    const runtime = new ProviderRuntime(() => undefined);
    const result = await runtime.run({
      adapter: provider,
      operation: "verify_email",
      request: { domain: "example.com" },
      budget,
      timeoutMs: 5,
    });

    expect(result).toMatchObject({ status: "TIMED_OUT", value: null, errorClass: "PROVIDER_TIMEOUT" });
    expect(budget.snapshot()).toEqual({ usedCostUnits: 0, usedUsd: 0, reservations: 0 });
  });

  it("uses only a hashed canonical request key and serves a bounded cache hit", async () => {
    const provider = adapter();
    const runtime = new ProviderRuntime(() => undefined);
    const budget = new ProviderBudget(10, 10);
    const first = await runtime.run({
      adapter: provider,
      operation: "search_people",
      request: { domain: "example.com" },
      budget,
      cacheTtlMs: 1_000,
    });
    const second = await runtime.run({
      adapter: provider,
      operation: "search_people",
      request: { domain: "example.com" },
      budget,
      cacheTtlMs: 1_000,
    });

    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.idempotencyKey).not.toContain("example.com");
    expect(second.cacheHit).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
});
