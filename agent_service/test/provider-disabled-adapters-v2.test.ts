import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBudget, type ProviderCost, type ProviderHealth } from "../src/acquisition/provider-runtime.js";
import {
  ProviderManifestSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  type ProviderAdapterExecution,
  type ProviderCapability,
  type ProviderRequest,
  type StrictProviderAdapter,
} from "../src/acquisition/providers/contracts.js";
import { createDisabledProviderRegistry } from "../src/acquisition/providers/disabled-adapters.js";
import { StrictProviderRuntime, type ProviderAuditEvent } from "../src/acquisition/providers/strict-runtime.js";

const hash = "b".repeat(64);
const observedAt = "2026-07-20T00:00:00.000Z";

function requestFor(operation: ProviderCapability): ProviderRequest {
  switch (operation) {
    case "ACCOUNT_DISCOVERY":
      return ProviderRequestSchema.parse({
        operation,
        country: "Malaysia",
        localities: ["Penang"],
        buyerTypes: ["SYSTEM_INTEGRATOR"],
        keywords: ["sample application"],
        limit: 30,
        budgetId: "budget-1",
        sourceMode: "OFFICIAL_API_ONLY",
        personalDataAllowed: false,
      });
    case "CONTACT_SEARCH":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        displayName: "Example Industrial",
        canonicalDomain: "example.com",
        buyerType: "SYSTEM_INTEGRATOR",
        roleFamilies: ["ENGINEERING", "PROCUREMENT"],
        limit: 2,
        dataPolicy: "B2B_WORK_ONLY",
      });
    case "PERSON_ENRICHMENT":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        canonicalDomain: "example.com",
        person: { personRef: "person-1", providerPersonId: "provider-person-1", fullName: "Jane Doe" },
        requestedAssertions: ["EMPLOYMENT"],
        personalEmailAllowed: false,
        phoneAllowed: false,
      });
    case "WORK_EMAIL_DISCOVERY":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        canonicalDomain: "example.com",
        person: { personRef: "person-1", providerPersonId: "provider-person-1", fullName: "Jane Doe" },
        roleFamily: "ENGINEERING",
        personalEmailAllowed: false,
        roleMailboxAllowed: false,
      });
    case "EMAIL_VERIFICATION":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        personRef: "person-1",
        email: "jane.doe@example.com",
        expectedDomain: "example.com",
        discoveryAssertionId: "discovery-1",
        discoveryProviderId: "WIZA",
        independentVerificationRequired: true,
      });
    case "WEBSITE_CRAWL":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        canonicalDomain: "example.com",
        url: "https://example.com/products",
        escalationReason: "PARTIAL",
        maxPages: 5,
        obeyRobots: true,
        allowCrossDomain: false,
        allowPrivateNetworks: false,
      });
    case "OUTREACH_DRAFT":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        leadId: "lead-1",
        contactId: "contact-1",
        messageIds: ["message-1"],
        recipientWorkEmail: "jane.doe@example.com",
        subject: "Fixture subject",
        body: "Fixture approved body.",
        reviewHash: hash,
        dossierVersion: 1,
        experimentArm: "arm-a",
        contentHash: hash,
        approvalState: "APPROVED",
        transportMode: "PAUSED_DRAFT",
        openTrackingEnabled: false,
        clickTrackingEnabled: false,
        replyStopEnabled: true,
        companyStopEnabled: true,
        dncCheckedAt: observedAt,
        riskyMailbox: false,
        humanTakeover: false,
        alreadyReplied: false,
      });
    case "OUTREACH_RECONCILE":
      return ProviderRequestSchema.parse({
        operation,
        externalDraftId: "draft-1",
        localCampaignId: "campaign-1",
        originalIdempotencyKey: hash,
      });
    case "OUTREACH_CANCEL":
      return ProviderRequestSchema.parse({
        operation,
        leadId: "lead-1",
        externalDraftId: "draft-1",
        reason: "REPLY",
      });
    case "EVIDENCE_SEARCH":
      return ProviderRequestSchema.parse({
        operation,
        accountId: "account-1",
        query: "Example sample product application",
        publicSourcesOnly: true,
        localFetchValidationRequired: true,
      });
  }
}

const prohibitedFields = [
  "API_CREDENTIAL",
  "DNC_DATABASE",
  "REPLY_BODY",
  "PRIVATE_CASE",
  "QUOTE",
  "CUSTOMER_NOTE",
  "UNPUBLISHED_PRODUCT_DATA",
  "FULL_CRM",
  "PERSONAL_EMAIL",
  "PHONE_NUMBER",
] as const;

function fixtureAdapter(executeOverride?: StrictProviderAdapter["execute"]): StrictProviderAdapter {
  const execute = executeOverride ?? vi.fn(async (): Promise<ProviderAdapterExecution> => ({
    response: {
      providerId: "HUNTER",
      providerRunId: "fixture-run-1",
      operation: "WORK_EMAIL_DISCOVERY",
      result: "ASSERTIONS_RETURNED",
      assertions: [{
        assertionId: "email-discovery-1",
        providerId: "HUNTER",
        providerRunId: "fixture-run-1",
        accountId: "account-1",
        sourceUri: "https://example.com/team",
        observedAt,
        expiresAt: "2026-08-19T00:00:00.000Z",
        confidence: 0.9,
        rawPayloadHash: hash,
        creditUnits: 1,
        estimatedUsd: 0.2,
        kind: "EMAIL_DISCOVERY",
        personRef: "person-1",
        email: "jane.doe@example.com",
        emailDomain: "example.com",
        emailType: "WORK",
        providerStatus: "PROVIDER_VALID_ASSERTION",
        localMailboxVerdict: "NOT_VERIFIED",
      }],
      rawPayloadHash: hash,
      retryAfterSeconds: null,
    },
    actualCost: { costUnits: 1, usd: 0.2, currency: "USD" },
    upstreamRequestId: "fixture-upstream-1",
    networkAttempted: false,
    externalWriteAttempted: false,
  }));
  return {
    manifest: ProviderManifestSchema.parse({
      providerId: "HUNTER",
      displayName: "Hunter offline fixture",
      capabilities: ["WORK_EMAIL_DISCOVERY"],
      implementationState: "FIXTURE_SHADOW",
      featureFlag: "ACQ_HUNTER_FIXTURE_ENABLED",
      activation: {
        featureFlagEnabled: true,
        configured: true,
        authorization: "NOT_REQUIRED_FIXTURE",
      },
      networkPolicy: "DENY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: ["PUBLIC_PERSON_IDENTITY", "B2B_WORK_EMAIL"],
        prohibitedFields,
        personalEmailAllowed: false,
        phoneAllowed: false,
      },
    }),
    requestSchema: ProviderRequestSchema,
    responseSchema: ProviderResponseSchema,
    health: async (): Promise<ProviderHealth> => ({
      state: "HEALTHY",
      checkedAt: observedAt,
      detail: "offline fixture",
    }),
    estimateCost: (): ProviderCost => ({ costUnits: 1, usd: 0.2, currency: "USD" }),
    execute,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default-disabled provider registry", () => {
  it("contains every required candidate as a no-network, fail-closed stub", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const registry = createDisabledProviderRegistry();
    expect([...registry.keys()].sort()).toEqual([
      "ANYMAIL_FINDER",
      "APIFY_PLACES",
      "APIFY_WEBSITE",
      "APOLLO_OFFICIAL",
      "CLAY",
      "EXA",
      "GOOGLE_PLACES",
      "HUNTER",
      "INSTANTLY",
      "LEMLIST",
      "PERPLEXITY_EVIDENCE",
      "SEARXNG",
      "SERPER",
      "WIZA",
    ]);

    const audits: ProviderAuditEvent[] = [];
    const runtime = new StrictProviderRuntime({ audit: (event) => audits.push(event) });
    for (const adapter of registry.values()) {
      const executeSpy = vi.spyOn(adapter, "execute");
      const operation = adapter.manifest.capabilities[0]!;
      const result = await runtime.run({
        adapter,
        request: requestFor(operation),
        budget: new ProviderBudget(100, 100),
      });

      expect(result.status).toBe("BLOCKED_DISABLED");
      expect(result.response).toBeNull();
      expect(result.audit.actualCost).toEqual({ costUnits: 0, usd: 0, currency: "USD" });
      expect(result.audit.networkAttempted).toBe(false);
      expect(result.audit.externalWriteAttempted).toBe(false);
      expect(result.audit.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.audit.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(result.audit.idempotencyKey).not.toContain("example.com");
      expect(executeSpy).not.toHaveBeenCalled();
      expect(adapter.manifest.activation).toEqual({
        featureFlagEnabled: false,
        configured: false,
        authorization: "NOT_GRANTED",
      });
      expect(adapter.manifest.networkPolicy).toBe("DENY");
      expect(adapter.manifest.externalWriteAllowed).toBe(false);
    }
    expect(audits).toHaveLength(registry.size);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed input before checking a disabled provider", async () => {
    const adapter = createDisabledProviderRegistry().get("APOLLO_OFFICIAL")!;
    const runtime = new StrictProviderRuntime({ audit: () => undefined });
    const result = await runtime.run({
      adapter,
      request: { operation: "ACCOUNT_DISCOVERY", apiKey: "must-never-be-consumed" },
      budget: new ProviderBudget(10, 10),
    });

    expect(result.status).toBe("BLOCKED_INVALID_INPUT");
    expect(result.reason).toBe("INVALID_REQUEST");
    expect(result.audit.validationIssues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.audit)).not.toContain("must-never-be-consumed");
  });

  it("blocks a verifier that also discovered the mailbox", async () => {
    const adapter = createDisabledProviderRegistry().get("HUNTER")!;
    const runtime = new StrictProviderRuntime({ audit: () => undefined });
    const request = requestFor("EMAIL_VERIFICATION");
    const result = await runtime.run({
      adapter,
      request: { ...request, discoveryProviderId: "HUNTER" },
      budget: new ProviderBudget(10, 10),
    });

    expect(result.status).toBe("BLOCKED_EVIDENCE_INDEPENDENCE");
    expect(result.reason).toBe("VERIFIER_NOT_INDEPENDENT");
  });
});

describe("strict fixture-only provider execution", () => {
  it("validates output, records cost/audit, and caches the idempotent request", async () => {
    const adapter = fixtureAdapter();
    const executeSpy = vi.spyOn(adapter, "execute");
    const audits: ProviderAuditEvent[] = [];
    const runtime = new StrictProviderRuntime({ audit: (event) => audits.push(event) });
    const budget = new ProviderBudget(10, 10);
    const request = requestFor("WORK_EMAIL_DISCOVERY");
    const first = await runtime.run({ adapter, request, budget, cacheTtlMs: 60_000 });
    const second = await runtime.run({ adapter, request, budget, cacheTtlMs: 60_000 });

    expect(first.status).toBe("SUCCEEDED_SHADOW");
    expect(first.response?.assertions[0]?.kind).toBe("EMAIL_DISCOVERY");
    expect(first.response?.assertions[0]).not.toHaveProperty("localMailboxVerdict", "VALID");
    expect(first.audit.actualCost).toEqual({ costUnits: 1, usd: 0.2, currency: "USD" });
    expect(first.audit.assertionCounts.EMAIL_DISCOVERY).toBe(1);
    expect(second.status).toBe("SUCCEEDED_SHADOW");
    expect(second.audit.cacheHit).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({ usedCostUnits: 1, usedUsd: 0.2 });
    expect(audits).toHaveLength(2);
  });

  it("fails closed and releases budget when an adapter returns a non-strict payload", async () => {
    const valid = fixtureAdapter();
    const adapter = fixtureAdapter(async (request, signal) => {
      const result = await valid.execute(request, signal);
      return {
        ...result,
        response: { ...(result.response as object), untrustedExtraField: true },
      };
    });
    const budget = new ProviderBudget(10, 10);
    const runtime = new StrictProviderRuntime({ audit: () => undefined });
    const result = await runtime.run({
      adapter,
      request: requestFor("WORK_EMAIL_DISCOVERY"),
      budget,
    });

    expect(result.status).toBe("BLOCKED_INVALID_OUTPUT");
    expect(result.response).toBeNull();
    expect(budget.snapshot()).toEqual({ usedCostUnits: 0, usedUsd: 0, reservations: 0 });
  });
});
