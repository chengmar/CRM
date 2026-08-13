import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderBudget,
  ProviderRuntime,
  providerRequestHash,
  type AuditedProviderAdapter,
  type ProviderCost,
  type ProviderRunStatus,
} from "../provider-runtime.js";
import {
  ProviderAdapterExecutionSchema,
  ProviderAssertionKindSchema,
  ProviderCostSchema,
  ProviderHealthSchema,
  ProviderManifestSchema,
  ProviderOperationSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  Sha256Schema,
  operationCapability,
  responseAssertionCounts,
  type ProviderAssertionKind,
  type ProviderId,
  type ProviderManifest,
  type ProviderOperation,
  type ProviderRequest,
  type ProviderResponse,
  type StrictProviderAdapter,
} from "./contracts.js";

export const ProviderContractRunStatusSchema = z.enum([
  "SUCCEEDED_SHADOW",
  "SUCCEEDED_LIVE",
  "BLOCKED_DISABLED",
  "BLOCKED_INVALID_INPUT",
  "BLOCKED_INVALID_OUTPUT",
  "BLOCKED_CAPABILITY",
  "BLOCKED_EVIDENCE_INDEPENDENCE",
  "BLOCKED_BUDGET",
  "BLOCKED_UNHEALTHY",
  "TIMED_OUT",
  "FAILED",
]);

export type ProviderContractRunStatus = z.infer<typeof ProviderContractRunStatusSchema>;

export const ProviderBlockReasonSchema = z.enum([
  "NONE",
  "FEATURE_FLAG_DISABLED",
  "NOT_CONFIGURED",
  "USER_AUTHORIZATION_NOT_GRANTED",
  "DISABLED_STUB",
  "INVALID_PROVIDER_MANIFEST",
  "INVALID_REQUEST",
  "UNDECLARED_CAPABILITY",
  "VERIFIER_NOT_INDEPENDENT",
  "PROVIDER_BUDGET_EXHAUSTED",
  "PROVIDER_UNHEALTHY",
  "PROVIDER_TIMEOUT",
  "INVALID_PROVIDER_OUTPUT",
  "PROVIDER_FAILURE",
]);

export type ProviderBlockReason = z.infer<typeof ProviderBlockReasonSchema>;

const AssertionCountsSchema = z.object({
  ACCOUNT_DISCOVERY: z.number().int().nonnegative(),
  CONTACT_IDENTITY: z.number().int().nonnegative(),
  EMPLOYMENT: z.number().int().nonnegative(),
  EMAIL_DISCOVERY: z.number().int().nonnegative(),
  EMAIL_VERIFICATION: z.number().int().nonnegative(),
  WEBSITE_CONTENT: z.number().int().nonnegative(),
  TRANSPORT_DRAFT: z.number().int().nonnegative(),
  TRANSPORT_EVENT: z.number().int().nonnegative(),
  EVIDENCE_REFERENCE: z.number().int().nonnegative(),
}).strict();

export const ProviderAuditEventSchema = z.object({
  eventId: Sha256Schema,
  providerId: z.string().trim().min(1).max(100),
  operation: z.union([ProviderOperationSchema, z.literal("UNKNOWN")]),
  requestHash: Sha256Schema,
  idempotencyKey: Sha256Schema,
  providerRunId: z.string().trim().min(1).max(200).nullable(),
  status: ProviderContractRunStatusSchema,
  reason: ProviderBlockReasonSchema,
  estimatedCost: ProviderCostSchema,
  actualCost: ProviderCostSchema,
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  cacheHit: z.boolean(),
  networkAttempted: z.boolean(),
  externalWriteAttempted: z.boolean(),
  assertionCounts: AssertionCountsSchema,
  validationIssues: z.array(z.string().max(250)).max(50),
}).strict();

export type ProviderAuditEvent = z.infer<typeof ProviderAuditEventSchema>;

export interface ProviderContractResult {
  status: ProviderContractRunStatus;
  reason: ProviderBlockReason;
  response: ProviderResponse | null;
  audit: ProviderAuditEvent;
}

interface RuntimeOptions {
  audit: (event: ProviderAuditEvent) => void;
  now?: () => Date;
}

function zeroCost(): ProviderCost {
  return { costUnits: 0, usd: 0, currency: "USD" };
}

function safeRequestHash(value: unknown): string {
  try {
    return providerRequestHash(value);
  } catch {
    const tag = Object.prototype.toString.call(value);
    return createHash("sha256").update(tag).digest("hex");
  }
}

function hashedIdempotencyKey(providerId: string, operation: string, requestHash: string): string {
  return createHash("sha256").update(`${providerId}:${operation}:${requestHash}`).digest("hex");
}

function validationIssueCodes(result: z.ZodError): string[] {
  return result.issues.slice(0, 50).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}:${issue.code}`.slice(0, 250);
  });
}

function emptyAssertionCounts(): Record<ProviderAssertionKind, number> {
  return Object.fromEntries(
    ProviderAssertionKindSchema.options.map((kind) => [kind, 0]),
  ) as Record<ProviderAssertionKind, number>;
}

function operationFromRaw(value: unknown): ProviderOperation | "UNKNOWN" {
  if (!value || typeof value !== "object" || !("operation" in value)) return "UNKNOWN";
  const result = ProviderOperationSchema.safeParse((value as { operation?: unknown }).operation);
  return result.success ? result.data : "UNKNOWN";
}

function activationBlock(
  manifest: ProviderManifest,
  campaignAuthorizationVerified: boolean,
): ProviderBlockReason | null {
  if (manifest.implementationState === "DISABLED_STUB") return "DISABLED_STUB";
  if (!manifest.activation.featureFlagEnabled) return "FEATURE_FLAG_DISABLED";
  if (!manifest.activation.configured) return "NOT_CONFIGURED";
  if (
    manifest.activation.authorization === "CAMPAIGN_SCOPED" &&
    !campaignAuthorizationVerified
  ) {
    return "USER_AUTHORIZATION_NOT_GRANTED";
  }
  if (
    manifest.implementationState !== "FIXTURE_SHADOW" &&
    manifest.activation.authorization !== "SHADOW_APPROVED" &&
    manifest.activation.authorization !== "CAMPAIGN_SCOPED"
  ) {
    return "USER_AUTHORIZATION_NOT_GRANTED";
  }
  if (
    manifest.implementationState === "FIXTURE_SHADOW" &&
    manifest.activation.authorization !== "NOT_REQUIRED_FIXTURE"
  ) {
    return "USER_AUTHORIZATION_NOT_GRANTED";
  }
  return null;
}

function mappedRuntimeStatus(
  status: ProviderRunStatus,
  errorClass: string | null,
  live: boolean,
): {
  status: ProviderContractRunStatus;
  reason: ProviderBlockReason;
} {
  switch (status) {
    case "SUCCEEDED":
      return { status: live ? "SUCCEEDED_LIVE" : "SUCCEEDED_SHADOW", reason: "NONE" };
    case "DISABLED":
      return { status: "BLOCKED_DISABLED", reason: "FEATURE_FLAG_DISABLED" };
    case "NOT_CONFIGURED":
      return { status: "BLOCKED_DISABLED", reason: "NOT_CONFIGURED" };
    case "BUDGET_EXHAUSTED":
      return { status: "BLOCKED_BUDGET", reason: "PROVIDER_BUDGET_EXHAUSTED" };
    case "UNHEALTHY":
      return { status: "BLOCKED_UNHEALTHY", reason: "PROVIDER_UNHEALTHY" };
    case "TIMED_OUT":
      return { status: "TIMED_OUT", reason: "PROVIDER_TIMEOUT" };
    case "FAILED":
      return errorClass === "ZodError" || errorClass === "ProviderContractOutputError"
        ? { status: "BLOCKED_INVALID_OUTPUT", reason: "INVALID_PROVIDER_OUTPUT" }
        : { status: "FAILED", reason: "PROVIDER_FAILURE" };
  }
}

class ProviderContractOutputError extends Error {
  override readonly name = "ProviderContractOutputError";
}

export class StrictProviderRuntime {
  private readonly runtime: ProviderRuntime;
  private readonly now: () => Date;
  private readonly auditSink: (event: ProviderAuditEvent) => void;
  private eventSequence = 0;

  constructor(options: RuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.auditSink = options.audit;
    this.runtime = new ProviderRuntime(() => undefined, this.now);
  }

  async run(input: {
    adapter: StrictProviderAdapter;
    request: unknown;
    budget: ProviderBudget;
    campaignAuthorizationVerified?: boolean;
    timeoutMs?: number;
    cacheTtlMs?: number;
  }): Promise<ProviderContractResult> {
    const startedAt = this.now().toISOString();
    const manifestResult = ProviderManifestSchema.safeParse(input.adapter.manifest);
    const providerId = manifestResult.success ? manifestResult.data.providerId : "INVALID_PROVIDER";
    const operation = operationFromRaw(input.request);
    const requestHash = safeRequestHash(input.request);
    const idempotencyKey = hashedIdempotencyKey(providerId, operation, requestHash);

    if (!manifestResult.success) {
      return this.blocked({
        providerId,
        operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_DISABLED",
        reason: "INVALID_PROVIDER_MANIFEST",
        issues: validationIssueCodes(manifestResult.error),
      });
    }

    const requestResult = ProviderRequestSchema.safeParse(input.request);
    if (!requestResult.success) {
      return this.blocked({
        providerId,
        operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_INVALID_INPUT",
        reason: "INVALID_REQUEST",
        issues: validationIssueCodes(requestResult.error),
      });
    }

    const request = requestResult.data;
    if (!manifestResult.data.capabilities.includes(operationCapability(request.operation))) {
      return this.blocked({
        providerId,
        operation: request.operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_CAPABILITY",
        reason: "UNDECLARED_CAPABILITY",
      });
    }

    if (
      request.operation === "EMAIL_VERIFICATION" &&
      request.discoveryProviderId === manifestResult.data.providerId
    ) {
      return this.blocked({
        providerId,
        operation: request.operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_EVIDENCE_INDEPENDENCE",
        reason: "VERIFIER_NOT_INDEPENDENT",
      });
    }

    const disabledReason = activationBlock(
      manifestResult.data,
      input.campaignAuthorizationVerified === true,
    );
    if (disabledReason) {
      return this.blocked({
        providerId,
        operation: request.operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_DISABLED",
        reason: disabledReason,
      });
    }

    let estimatedCost: ProviderCost;
    try {
      estimatedCost = ProviderCostSchema.parse(input.adapter.estimateCost(request));
    } catch (error) {
      return this.blocked({
        providerId,
        operation: request.operation,
        requestHash,
        idempotencyKey,
        startedAt,
        status: "BLOCKED_DISABLED",
        reason: "INVALID_PROVIDER_MANIFEST",
        issues: error instanceof z.ZodError ? validationIssueCodes(error) : ["estimateCost:invalid"],
      });
    }

    let networkAttempted = false;
    let externalWriteAttempted = false;
    const runtimeAdapter: AuditedProviderAdapter<ProviderRequest, ProviderResponse> = {
      id: manifestResult.data.providerId,
      enabled: manifestResult.data.activation.featureFlagEnabled,
      configured: manifestResult.data.activation.configured,
      health: async () => ProviderHealthSchema.parse(await input.adapter.health()),
      estimateCost: () => estimatedCost,
      execute: async (validatedRequest, signal) => {
        let rawEnvelope: unknown;
        try {
          rawEnvelope = await input.adapter.execute(validatedRequest, signal);
        } catch (error) {
          if (error && typeof error === "object") {
            const annotated = error as {
              networkAttempted?: unknown;
              externalWriteAttempted?: unknown;
            };
            networkAttempted = annotated.networkAttempted === true;
            externalWriteAttempted = annotated.externalWriteAttempted === true;
          }
          throw error;
        }
        const envelope = ProviderAdapterExecutionSchema.parse(rawEnvelope);
        networkAttempted = envelope.networkAttempted;
        externalWriteAttempted = envelope.externalWriteAttempted;
        if (manifestResult.data.implementationState === "FIXTURE_SHADOW" && networkAttempted) {
          throw new ProviderContractOutputError("Fixture adapters cannot access the network");
        }
        if (externalWriteAttempted && !manifestResult.data.externalWriteAllowed) {
          throw new ProviderContractOutputError("External writes are not authorized");
        }
        const response = ProviderResponseSchema.parse(envelope.response);
        if (
          response.providerId !== manifestResult.data.providerId ||
          response.operation !== validatedRequest.operation
        ) {
          throw new ProviderContractOutputError("Provider response identity or operation mismatch");
        }
        return {
          value: response,
          actualCost: envelope.actualCost,
          upstreamRequestId: envelope.upstreamRequestId,
        };
      },
    };

    const execution = await this.runtime.run({
      adapter: runtimeAdapter,
      operation: request.operation,
      request,
      budget: input.budget,
      timeoutMs: input.timeoutMs,
      cacheTtlMs: input.cacheTtlMs,
    });
    const mapped = mappedRuntimeStatus(
      execution.status,
      execution.errorClass,
      manifestResult.data.implementationState === "OFFICIAL_API_ADAPTER",
    );
    const response = execution.status === "SUCCEEDED" ? execution.value : null;
    const audit = this.emitAudit({
      providerId,
      operation: request.operation,
      requestHash,
      idempotencyKey,
      providerRunId: response?.providerRunId ?? null,
      status: mapped.status,
      reason: mapped.reason,
      estimatedCost: execution.estimatedCost,
      actualCost: execution.actualCost,
      startedAt,
      completedAt: this.now().toISOString(),
      cacheHit: execution.cacheHit,
      networkAttempted,
      externalWriteAttempted,
      assertionCounts: responseAssertionCounts(response),
      validationIssues: [],
    });
    return { status: mapped.status, reason: mapped.reason, response, audit };
  }

  private blocked(input: {
    providerId: ProviderId | "INVALID_PROVIDER";
    operation: ProviderOperation | "UNKNOWN";
    requestHash: string;
    idempotencyKey: string;
    startedAt: string;
    status: ProviderContractRunStatus;
    reason: ProviderBlockReason;
    issues?: string[];
  }): ProviderContractResult {
    const audit = this.emitAudit({
      providerId: input.providerId,
      operation: input.operation,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      providerRunId: null,
      status: input.status,
      reason: input.reason,
      estimatedCost: zeroCost(),
      actualCost: zeroCost(),
      startedAt: input.startedAt,
      completedAt: this.now().toISOString(),
      cacheHit: false,
      networkAttempted: false,
      externalWriteAttempted: false,
      assertionCounts: emptyAssertionCounts(),
      validationIssues: input.issues ?? [],
    });
    return { status: input.status, reason: input.reason, response: null, audit };
  }

  private emitAudit(input: Omit<ProviderAuditEvent, "eventId">): ProviderAuditEvent {
    this.eventSequence += 1;
    const eventId = createHash("sha256")
      .update(`${input.idempotencyKey}:${input.status}:${input.completedAt}:${this.eventSequence}`)
      .digest("hex");
    const event = ProviderAuditEventSchema.parse({ ...input, eventId });
    this.auditSink(event);
    return event;
  }
}
