import { createHash } from "node:crypto";

export type ProviderHealthState = "HEALTHY" | "DEGRADED" | "NOT_CONFIGURED" | "DISABLED";
export type ProviderRunStatus =
  | "SUCCEEDED"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "BUDGET_EXHAUSTED"
  | "UNHEALTHY"
  | "TIMED_OUT"
  | "FAILED";

export interface ProviderCost {
  costUnits: number;
  usd: number;
  currency: "USD";
}

export interface ProviderHealth {
  state: ProviderHealthState;
  checkedAt: string;
  detail: string;
}

export interface AuditedProviderAdapter<Request, Response> {
  readonly id: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  health(): Promise<ProviderHealth>;
  estimateCost(request: Request): ProviderCost;
  execute(request: Request, signal: AbortSignal): Promise<{
    value: Response;
    actualCost?: Partial<ProviderCost>;
    upstreamRequestId?: string | null;
  }>;
}

export interface ProviderAttemptAudit {
  providerId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  status: ProviderRunStatus;
  estimatedCost: ProviderCost;
  actualCost: ProviderCost;
  startedAt: string;
  completedAt: string;
  cacheHit: boolean;
  upstreamRequestId: string | null;
  errorClass: string | null;
}

export interface ProviderExecutionResult<Response> {
  status: ProviderRunStatus;
  value: Response | null;
  requestHash: string;
  idempotencyKey: string;
  cacheHit: boolean;
  estimatedCost: ProviderCost;
  actualCost: ProviderCost;
  errorClass: string | null;
}

interface Reservation extends ProviderCost {
  idempotencyKey: string;
  finalized: boolean;
}

export class ProviderBudget {
  private readonly reservations = new Map<string, Reservation>();
  private usedCostUnits = 0;
  private usedUsd = 0;

  constructor(
    readonly maxCostUnits: number,
    readonly maxUsd: number,
  ) {
    if (!Number.isFinite(maxCostUnits) || maxCostUnits < 0 || !Number.isFinite(maxUsd) || maxUsd < 0) {
      throw new Error("Provider budget limits must be finite and non-negative");
    }
  }

  reserve(idempotencyKey: string, estimate: ProviderCost): boolean {
    const existing = this.reservations.get(idempotencyKey);
    if (existing) return true;
    const costUnits = nonNegative(estimate.costUnits);
    const usd = nonNegative(estimate.usd);
    if (this.usedCostUnits + costUnits > this.maxCostUnits || this.usedUsd + usd > this.maxUsd) {
      return false;
    }
    this.usedCostUnits += costUnits;
    this.usedUsd += usd;
    this.reservations.set(idempotencyKey, {
      idempotencyKey,
      costUnits,
      usd,
      currency: "USD",
      finalized: false,
    });
    return true;
  }

  finalize(idempotencyKey: string, actual: ProviderCost): void {
    const reservation = this.reservations.get(idempotencyKey);
    if (!reservation || reservation.finalized) return;
    const actualUnits = nonNegative(actual.costUnits);
    const actualUsd = nonNegative(actual.usd);
    this.usedCostUnits += actualUnits - reservation.costUnits;
    this.usedUsd += actualUsd - reservation.usd;
    reservation.costUnits = actualUnits;
    reservation.usd = actualUsd;
    reservation.finalized = true;
  }

  release(idempotencyKey: string): void {
    const reservation = this.reservations.get(idempotencyKey);
    if (!reservation || reservation.finalized) return;
    this.usedCostUnits -= reservation.costUnits;
    this.usedUsd -= reservation.usd;
    this.reservations.delete(idempotencyKey);
  }

  snapshot(): { usedCostUnits: number; usedUsd: number; reservations: number } {
    return {
      usedCostUnits: this.usedCostUnits,
      usedUsd: this.usedUsd,
      reservations: this.reservations.size,
    };
  }
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function providerRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

interface CacheEntry<Response> {
  expiresAt: number;
  result: ProviderExecutionResult<Response>;
}

export class ProviderRuntime {
  private readonly inFlight = new Map<string, Promise<ProviderExecutionResult<unknown>>>();
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly audit: (attempt: ProviderAttemptAudit) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<Request, Response>(input: {
    adapter: AuditedProviderAdapter<Request, Response>;
    operation: string;
    request: Request;
    budget: ProviderBudget;
    timeoutMs?: number;
    cacheTtlMs?: number;
  }): Promise<ProviderExecutionResult<Response>> {
    const requestHash = providerRequestHash(input.request);
    const idempotencyKey = `${input.adapter.id}:${input.operation}:${requestHash}`;
    const estimatedCost = normalizeCost(input.adapter.estimateCost(input.request));
    const empty = (status: ProviderRunStatus, errorClass: string | null): ProviderExecutionResult<Response> => ({
      status,
      value: null,
      requestHash,
      idempotencyKey,
      cacheHit: false,
      estimatedCost,
      actualCost: { costUnits: 0, usd: 0, currency: "USD" },
      errorClass,
    });

    if (!input.adapter.enabled) return empty("DISABLED", "PROVIDER_DISABLED");
    if (!input.adapter.configured) return empty("NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED");

    const nowMs = this.now().getTime();
    const cached = this.cache.get(idempotencyKey) as CacheEntry<Response> | undefined;
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.result, cacheHit: true };
    }
    if (cached) this.cache.delete(idempotencyKey);

    const existing = this.inFlight.get(idempotencyKey) as Promise<ProviderExecutionResult<Response>> | undefined;
    if (existing) return existing;
    const execution = this.execute({ ...input, requestHash, idempotencyKey, estimatedCost });
    this.inFlight.set(idempotencyKey, execution as Promise<ProviderExecutionResult<unknown>>);
    try {
      const result = await execution;
      if (result.status === "SUCCEEDED" && (input.cacheTtlMs ?? 0) > 0) {
        this.cache.set(idempotencyKey, {
          expiresAt: this.now().getTime() + Math.max(1, input.cacheTtlMs ?? 0),
          result,
        });
      }
      return result;
    } finally {
      this.inFlight.delete(idempotencyKey);
    }
  }

  private async execute<Request, Response>(input: {
    adapter: AuditedProviderAdapter<Request, Response>;
    operation: string;
    request: Request;
    budget: ProviderBudget;
    timeoutMs?: number;
    requestHash: string;
    idempotencyKey: string;
    estimatedCost: ProviderCost;
  }): Promise<ProviderExecutionResult<Response>> {
    const startedAt = this.now().toISOString();
    const health = await input.adapter.health();
    if (health.state !== "HEALTHY") {
      return this.finish(input, startedAt, "UNHEALTHY", null, zeroCost(), "PROVIDER_UNHEALTHY", null);
    }
    if (!input.budget.reserve(input.idempotencyKey, input.estimatedCost)) {
      return this.finish(input, startedAt, "BUDGET_EXHAUSTED", null, zeroCost(), "PROVIDER_BUDGET_EXHAUSTED", null);
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1, input.timeoutMs ?? 30_000);
    const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
    try {
      const response = await input.adapter.execute(input.request, controller.signal);
      const actualCost = normalizeCost({
        costUnits: response.actualCost?.costUnits ?? input.estimatedCost.costUnits,
        usd: response.actualCost?.usd ?? input.estimatedCost.usd,
        currency: "USD",
      });
      input.budget.finalize(input.idempotencyKey, actualCost);
      return this.finish(
        input,
        startedAt,
        "SUCCEEDED",
        response.value,
        actualCost,
        null,
        response.upstreamRequestId ?? null,
      );
    } catch (error) {
      input.budget.release(input.idempotencyKey);
      const timedOut = controller.signal.aborted;
      return this.finish(
        input,
        startedAt,
        timedOut ? "TIMED_OUT" : "FAILED",
        null,
        zeroCost(),
        timedOut ? "PROVIDER_TIMEOUT" : errorClass(error),
        null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private finish<Request, Response>(
    input: {
      adapter: AuditedProviderAdapter<Request, Response>;
      operation: string;
      requestHash: string;
      idempotencyKey: string;
      estimatedCost: ProviderCost;
    },
    startedAt: string,
    status: ProviderRunStatus,
    value: Response | null,
    actualCost: ProviderCost,
    error: string | null,
    upstreamRequestId: string | null,
  ): ProviderExecutionResult<Response> {
    const completedAt = this.now().toISOString();
    this.audit({
      providerId: input.adapter.id,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status,
      estimatedCost: input.estimatedCost,
      actualCost,
      startedAt,
      completedAt,
      cacheHit: false,
      upstreamRequestId,
      errorClass: error,
    });
    return {
      status,
      value,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      cacheHit: false,
      estimatedCost: input.estimatedCost,
      actualCost,
      errorClass: error,
    };
  }
}

function normalizeCost(cost: ProviderCost): ProviderCost {
  return { costUnits: nonNegative(cost.costUnits), usd: nonNegative(cost.usd), currency: "USD" };
}

function zeroCost(): ProviderCost {
  return { costUnits: 0, usd: 0, currency: "USD" };
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name?: unknown }).name || "PROVIDER_ERROR").slice(0, 100);
  }
  return "PROVIDER_ERROR";
}
