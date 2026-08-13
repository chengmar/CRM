import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BouncerOfficialAdapter } from "../src/acquisition/providers/bouncer-official.js";
import {
  CampaignApprovedEmailVerifier,
  type CampaignEmailVerificationInput,
} from "../src/acquisition/providers/campaign-runtime.js";
import { HunterOfficialAdapter } from "../src/acquisition/providers/hunter-official.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-bouncer-v16-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function authorizedCampaign(db: AgentDatabase, suffix: string, verifier: "hunter" | "bouncer") {
  const campaignId = db.createCampaign({
    name: `approved-verifier-${suffix}`,
    market: "Malaysia",
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 10,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [3, 7, 14],
  });
  const providerBudget = {
    mode: "CAPPED" as const,
    allowedProviders: ["searxng", "local-public-web", verifier],
    unit: "REQUESTS",
    maxUnits: 10,
    maxAmountUsd: 1,
    requiresSeparateApproval: true,
  };
  const saved = db.saveCampaignDraft({
    briefKey: `approved-verifier:${suffix}`,
    brief: {
      market: "Malaysia",
      productFamily: "sample product application",
      qualificationTracks: ["ICP_FIT"],
      transport: "NONE",
      providerBudget,
      llmBudget: null,
    },
    createdBy: "fixture",
  });
  db.saveCampaignScopedApproval({
    briefId: saved.briefId,
    versionId: saved.versionId,
    scope: "SHADOW_PLAN",
    actionId: `shadow:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
  }, { actor: "campaign-approver", actorType: "HUMAN", roles: ["CAMPAIGN_APPROVER"] });
  db.saveCampaignScopedApproval({
    briefId: saved.briefId,
    versionId: saved.versionId,
    scope: "PROVIDER_BUDGET",
    actionId: `budget:${suffix}`,
    authorizationSource: "EXPLICIT_FEISHU_ACTION",
    budgetHash: hash({ providerBudget, llmBudget: null }),
  }, { actor: "budget-approver", actorType: "HUMAN", roles: ["BUDGET_APPROVER"] });
  db.bindProviderCampaign({
    campaignId,
    briefId: saved.briefId,
    versionId: saved.versionId,
    briefHash: saved.briefHash,
    createdBy: "fixture",
  });
  return { campaignId, versionId: saved.versionId };
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    ACQ_HUNTER_V2_ENABLED: "true",
    HUNTER_API_KEY: "hunter-test-secret",
    HUNTER_REQUEST_TIMEOUT_MS: "1000",
    HUNTER_CACHE_TTL_SECONDS: "3600",
    HUNTER_EMAIL_VERIFICATION_COST_UNITS: "1",
    HUNTER_EMAIL_VERIFICATION_COST_MICROS: "25000",
    ACQ_BOUNCER_V2_ENABLED: "true",
    BOUNCER_API_KEY: "bouncer-test-secret",
    BOUNCER_REQUEST_TIMEOUT_MS: "1000",
    BOUNCER_CACHE_TTL_SECONDS: "3600",
    BOUNCER_EMAIL_VERIFICATION_COST_UNITS: "1",
    BOUNCER_EMAIL_VERIFICATION_COST_MICROS: "50000",
    ...overrides,
  });
}

function bouncerResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    email: "jane1@buyer.com",
    status: "deliverable",
    reason: "accepted_email",
    domain: {
      name: "buyer.com",
      acceptAll: "no",
      disposable: "no",
      free: "no",
    },
    account: {
      role: "no",
      disabled: "no",
      fullMailbox: "no",
    },
    score: 98,
    toxicity: 1,
    ...overrides,
  }), { headers: { "content-type": "application/json" } });
}

function hunterResponse(): Response {
  return new Response(JSON.stringify({
    data: {
      email: "jane1@buyer.com",
      status: "valid",
      score: 98,
      accept_all: false,
      disposable: false,
      webmail: false,
      block: false,
    },
  }), { headers: { "content-type": "application/json" } });
}

function verifier(
  db: AgentDatabase,
  scope: { campaignId: string; versionId: string },
  hunterFetch: typeof fetch,
  bouncerFetch: typeof fetch,
  configOverrides: Record<string, string> = {},
  bouncerOptions: { now?: () => Date; assertionTtlMs?: number } = {},
) {
  const loaded = config(configOverrides);
  const hunterAdapter = new HunterOfficialAdapter({
    enabled: loaded.ACQ_HUNTER_V2_ENABLED,
    apiKey: loaded.HUNTER_API_KEY,
    requestTimeoutMs: loaded.HUNTER_REQUEST_TIMEOUT_MS,
    fetchImpl: hunterFetch,
    resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
    costByOperation: {
      WORK_EMAIL_DISCOVERY: { costUnits: 1, usd: 0.025, currency: "USD" },
      EMAIL_VERIFICATION: { costUnits: 1, usd: 0.025, currency: "USD" },
    },
  });
  const bouncerAdapter = new BouncerOfficialAdapter({
    enabled: loaded.ACQ_BOUNCER_V2_ENABLED,
    apiKey: loaded.BOUNCER_API_KEY,
    requestTimeoutMs: loaded.BOUNCER_REQUEST_TIMEOUT_MS,
    fetchImpl: bouncerFetch,
    resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
    verificationCost: { costUnits: 1, usd: 0.05, currency: "USD" },
    ...bouncerOptions,
  });
  return new CampaignApprovedEmailVerifier({
    db,
    scope,
    config: loaded,
    hunterAdapter,
    bouncerAdapter,
  });
}

function request(): CampaignEmailVerificationInput {
  const email = "jane1@buyer.com";
  return {
    email,
    expectedDomain: "buyer.com",
    personRef: "person-1",
    discoveryAssertionId: "public-web-discovery-1",
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    discoverySourceUrl: "https://buyer.com/team",
    discoveryEvidenceHash: hash({ emailHash: hash(email), source: "https://buyer.com/team" }),
  };
}

function addContact(db: AgentDatabase, campaignId: string, email: string) {
  const leadId = db.upsertLead({
    campaignId,
    company: "Buyer Engineering",
    domain: "buyer.com",
    website: "https://buyer.com/",
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 30,
    activityScore: 10,
    contactScore: 20,
    channelScore: 5,
    totalScore: 95,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "ACTIVE_PROJECT",
    demandEvidence: [],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const contactId = db.upsertContact({
    leadId,
    name: "Jane Buyer",
    title: "Procurement Manager",
    email,
    sourceUrl: "https://buyer.com/team",
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "Bouncer verifier valid",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
    verificationNotes: "public fixture",
  });
  return contactId;
}

describe("campaign-bound approved email verifier v16", () => {
  it("uses only Bouncer from the approved brief, persists Bouncer lineage, and caches cost idempotently", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "bouncer", "bouncer");
    const hunterFetch = vi.fn<typeof fetch>(async () => hunterResponse());
    const bouncerFetch = vi.fn<typeof fetch>(async () => bouncerResponse());
    const bridge = verifier(db, scope, hunterFetch, bouncerFetch);

    const first = await bridge.verify(request());
    const second = await bridge.verify(request());

    expect(first).toMatchObject({
      status: "VALID",
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey: "BOUNCER",
      independentlyVerified: true,
      providerMailboxVerdict: "VALID_ASSERTION",
    });
    expect(second).toEqual(first);
    expect(bouncerFetch).toHaveBeenCalledOnce();
    expect(hunterFetch).not.toHaveBeenCalled();
    expect(db.db.prepare(
      `SELECT count(*) AS count, sum(units) AS units, sum(cost_micros) AS cost
       FROM resource_usage usage JOIN provider_runs run ON run.id=usage.provider_run_id
       WHERE run.campaign_id=? AND run.campaign_version_id=?`,
    ).get(scope.campaignId, scope.versionId)).toMatchObject({ count: 1, units: 1, cost: 50_000 });

    const contactId = addContact(db, scope.campaignId, request().email);
    expect(db.persistIndependentEmailVerification({
      contactId,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
      providerRunId: first!.providerRunId,
      discoveryAssertionId: first!.discoveryAssertionId,
      verificationAssertionId: first!.verificationAssertionId,
      emailHash: first!.emailHash,
      discoverySourceKey: first!.discoverySourceKey,
      verifierSourceKey: first!.verifierSourceKey,
      discoverySourceUrl: first!.discoverySourceUrl,
      discoveryEvidenceHash: first!.discoveryEvidenceHash,
      providerMailboxVerdict: first!.providerMailboxVerdict,
      catchAll: first!.catchAll,
      disposable: first!.disposable,
      roleMailbox: first!.roleMailbox,
      confidence: first!.confidence,
      rawPayloadHash: first!.rawPayloadHash,
      observedAt: first!.observedAt,
      expiresAt: first!.expiresAt,
      creditUnits: first!.creditUnits,
      estimatedCostMicros: first!.estimatedCostMicros,
    })).toEqual({ discoveryCreated: true, verificationCreated: true });
    expect(db.getIndependentValidEmailVerification({
      contactId,
      email: request().email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toMatchObject({ verifierSourceKey: "BOUNCER", independentlyVerified: true });
    db.close();
  });

  it("refreshes expired discovery and verification assertions after a new live check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    const db = database();
    const scope = authorizedCampaign(db, "refresh", "bouncer");
    const hunterFetch = vi.fn<typeof fetch>();
    const bouncerFetch = vi.fn<typeof fetch>(async () => bouncerResponse());
    const bridge = verifier(
      db,
      scope,
      hunterFetch,
      bouncerFetch,
      { BOUNCER_CACHE_TTL_SECONDS: "1" },
      { now: () => new Date(), assertionTtlMs: 1_000 },
    );
    const contactId = addContact(db, scope.campaignId, request().email);
    const persist = (verified: NonNullable<Awaited<ReturnType<typeof bridge.verify>>>) =>
      db.persistIndependentEmailVerification({
        contactId,
        campaignId: scope.campaignId,
        versionId: scope.versionId,
        providerRunId: verified.providerRunId,
        discoveryAssertionId: verified.discoveryAssertionId,
        verificationAssertionId: verified.verificationAssertionId,
        emailHash: verified.emailHash,
        discoverySourceKey: verified.discoverySourceKey,
        verifierSourceKey: verified.verifierSourceKey,
        discoverySourceUrl: verified.discoverySourceUrl,
        discoveryEvidenceHash: verified.discoveryEvidenceHash,
        providerMailboxVerdict: verified.providerMailboxVerdict,
        catchAll: verified.catchAll,
        disposable: verified.disposable,
        roleMailbox: verified.roleMailbox,
        confidence: verified.confidence,
        rawPayloadHash: verified.rawPayloadHash,
        observedAt: verified.observedAt,
        expiresAt: verified.expiresAt,
        creditUnits: verified.creditUnits,
        estimatedCostMicros: verified.estimatedCostMicros,
      });

    const first = await bridge.verify(request());
    if (!first) throw new Error("First Bouncer verification was unavailable");
    expect(persist(first)).toEqual({ discoveryCreated: true, verificationCreated: true });

    vi.setSystemTime(new Date("2026-07-20T00:00:02.000Z"));
    const second = await bridge.verify(request());
    if (!second) throw new Error("Refreshed Bouncer verification was unavailable");
    expect(second.verificationAssertionId).not.toBe(first.verificationAssertionId);
    expect(persist(second)).toEqual({ discoveryCreated: true, verificationCreated: true });
    expect(db.getIndependentValidEmailVerification({
      contactId,
      email: request().email,
      campaignId: scope.campaignId,
      versionId: scope.versionId,
    })).toMatchObject({ verificationAssertionId: second.verificationAssertionId });
    expect(bouncerFetch).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("preserves Hunter selection when a Bouncer credential also exists", async () => {
    const db = database();
    const scope = authorizedCampaign(db, "hunter", "hunter");
    const hunterFetch = vi.fn<typeof fetch>(async () => hunterResponse());
    const bouncerFetch = vi.fn<typeof fetch>(async () => bouncerResponse());

    const result = await verifier(db, scope, hunterFetch, bouncerFetch).verify(request());

    expect(result).toMatchObject({ status: "VALID", verifierSourceKey: "HUNTER" });
    expect(hunterFetch).toHaveBeenCalledOnce();
    expect(bouncerFetch).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ["feature disabled", { ACQ_BOUNCER_V2_ENABLED: "false" }],
    ["missing key", { BOUNCER_API_KEY: "" }],
  ])("makes zero network calls and returns no VALID result when selected Bouncer has %s", async (
    label,
    overrides,
  ) => {
    const db = database();
    const scope = authorizedCampaign(db, `blocked-${label.replaceAll(" ", "-")}`, "bouncer");
    const hunterFetch = vi.fn<typeof fetch>();
    const bouncerFetch = vi.fn<typeof fetch>();

    const result = await verifier(db, scope, hunterFetch, bouncerFetch, overrides).verify(request());

    expect(result).toBeNull();
    expect(hunterFetch).not.toHaveBeenCalled();
    expect(bouncerFetch).not.toHaveBeenCalled();
    expect(db.db.prepare(
      "SELECT count(*) AS count FROM provider_runs WHERE campaign_id=?",
    ).get(scope.campaignId)).toMatchObject({ count: 0 });
    db.close();
  });

  it.each([
    ["catch-all", { domain: { name: "buyer.com", acceptAll: "yes", disposable: "no", free: "no" } }, "RISKY"],
    ["risky", { status: "risky", reason: "low_deliverability" }, "RISKY"],
    ["invalid", { status: "undeliverable", reason: "rejected_email" }, "INVALID"],
  ] as const)("never upgrades a Bouncer %s result to VALID", async (_label, response, status) => {
    const db = database();
    const scope = authorizedCampaign(db, `non-valid-${_label}`, "bouncer");
    const hunterFetch = vi.fn<typeof fetch>();
    const bouncerFetch = vi.fn<typeof fetch>(async () => bouncerResponse(response));

    const result = await verifier(db, scope, hunterFetch, bouncerFetch).verify(request());

    expect(result).toMatchObject({ status, verifierSourceKey: "BOUNCER" });
    expect(result?.status).not.toBe("VALID");
    expect(hunterFetch).not.toHaveBeenCalled();
    expect(bouncerFetch).toHaveBeenCalledOnce();
    db.close();
  });
});
