import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchAutonomousPilot,
  parseAutonomousPilotLaunchCliArgs,
  parseAutonomousPilotLaunchSpec,
  readAutonomousPilotLaunchSpec,
} from "../src/acquisition/autonomous-pilot-launch.js";
import { AgentDatabase } from "../src/db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-pilot-launch-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function sellerKnowledge(): Record<string, unknown> {
  return {
    schemaVersion: "seller-knowledge-v2",
    factSetId: "seller-facts-sample-product",
    factSetVersion: 1,
    profile: {
      schemaVersion: "seller-profile-v2",
      id: "seller-sample-product",
      version: 1,
      status: "APPROVED",
      legalNameEn: "Northstar manufacturing Ltd.",
      brandNameEn: "Northstar Example",
      website: "https://northstar-example.test",
      sender: { name: "Alex Chen", email: "alex@northstar-example.test" },
      postalAddress: {
        line1: "18 Industrial Road",
        city: "Nanjing",
        postalCode: "210000",
        country: "China",
      },
      unsubscribe: { method: "REPLY", instruction: "Reply unsubscribe to opt out." },
      products: [{
        id: "product-sample-product",
        name: "sample products",
        modelsOrSpecifications: ["Application-specific configuration"],
        publicApproved: true,
      }],
      quoteBoundaries: {
        moq: "MOQ requires manual confirmation.",
        leadTime: "Lead time requires manual confirmation.",
        pricing: "Pricing requires a human-issued quotation.",
        payment: "Payment terms require commercial approval.",
        oem: "OEM requires engineering approval.",
        packaging: "Packaging requires manual confirmation.",
        installation: "Installation requires manual confirmation.",
        requiresHumanApproval: true,
      },
      prohibitedClaims: ["zero maintenance"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
    },
    facts: [{
      schemaVersion: "seller-fact-v2",
      id: "seller-fact-sample-product",
      profileId: "seller-sample-product",
      factSetVersion: 1,
      subject: "Northstar Example",
      predicate: "product family",
      value: "Sample Products is an approved product family.",
      unit: null,
      source: {
        type: "PRODUCT_SHEET",
        url: "https://northstar-example.test/products/sample-product",
        documentId: "product-sheet-sample-product",
        contentHash: "a".repeat(64),
      },
      publicApproved: true,
      status: "ACTIVE",
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
      confidentiality: "PUBLIC",
      version: 1,
    }],
    offers: [{
      schemaVersion: "seller-offer-v2",
      id: "offer-approved-sample-product",
      profileId: "seller-sample-product",
      profileVersion: 1,
      version: 1,
      productId: "product-sample-product",
      text: "We can share approved product material for sample products.",
      sellerFactIds: ["seller-fact-sample-product"],
      status: "ACTIVE",
      publicApproved: true,
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2099-01-01T00:00:00.000Z",
    }],
    privateCases: [{
      id: "private-case-one",
      confidentiality: "INTERNAL_ONLY",
      customerName: "Confidential Customer",
      location: null,
      result: null,
      metrics: [],
      derivedApplicationTags: ["sample requirement"],
    }],
  };
}

function spec(): Record<string, unknown> {
  const providerBudget = {
    mode: "CAPPED",
    allowedProviders: ["searxng", "local-public-web", "hunter"],
    unit: "REQUESTS",
    maxUnits: 100,
    maxAmountUsd: 25,
    requiresSeparateApproval: true,
  };
  const llmBudget = {
    mode: "CAPPED",
    allowedProviders: ["openai"],
    unit: "TOKENS",
    maxUnits: 100_000,
    maxAmountUsd: 20,
    requiresSeparateApproval: true,
  };
  return {
    launchKey: ["malaysia", "sample-product", "2030", "01"].join("-"),
    actionId: "thread-authorization-2030-01",
    campaign: {
      name: "Malaysia sample product application pilot",
      market: "Malaysia",
      product: "sample product application",
      buyerType: "system integrator",
      targetCount: 8,
    },
    brief: {
      schemaVersion: "campaign-brief-v2",
      id: "caller-supplied-id-is-not-trusted",
      version: 99,
      market: "Malaysia",
      productFamily: "sample product application",
      buyerTypes: ["system integrator"],
      industries: ["sample product application"],
      roleFamilies: ["procurement", "engineering"],
      qualificationTracks: ["ACTIVE_INTENT", "HIGH_ICP_FIT"],
      requiredSignals: ["active sample application project", "system integration capability"],
      exclusions: ["consumer-only reseller"],
      targetMetric: "VALID_CONTACTS",
      targetCount: 8,
      providerBudget,
      llmBudget,
      offerIds: ["offer-approved-sample-product"],
      transport: "SMTP",
      deadline: "2030-01-31T00:00:00.000Z",
      hypothesis: "Evidence-backed integrators are more likely to request a technical quotation.",
    },
    sellerKnowledge: sellerKnowledge(),
    provider: {
      providerKey: "SEARXNG",
      operation: "EVIDENCE_SEARCH",
    },
    authorization: {
      actor: "workspace-owner",
      source: "THREAD_EXPLICIT_AUTHORIZATION",
      reason: "One bounded autonomous acquisition pilot",
    },
    validFrom: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-02-01T00:00:00.000Z",
    limits: { total: 5, daily: 3, hourly: 1 },
  };
}

function count(db: AgentDatabase, table: string): number {
  return Number((db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

describe("launch-autonomous-pilot", () => {
  it("atomically records bounded authorization and queues research without external action", () => {
    const db = database();
    db.setSetting("outbound_paused", "false");
    db.setSetting("daily_research_enabled", "true");

    const result = launchAutonomousPilot(db, spec());

    expect(result).toMatchObject({
      status: "LAUNCHED",
      limits: { total: 5, daily: 3, hourly: 1, maximumSequenceIndex: 0 },
    });
    expect(Object.keys(result)).toEqual(["ids", "status", "limits"]);
    expect(count(db, "campaigns")).toBe(1);
    expect(count(db, "campaign_briefs")).toBe(1);
    expect(count(db, "campaign_versions")).toBe(1);
    expect(count(db, "campaign_approvals")).toBe(3);
    expect(count(db, "campaign_provider_bindings")).toBe(1);
    expect(count(db, "campaign_send_authorizations")).toBe(1);
    expect(count(db, "jobs")).toBe(1);
    expect(count(db, "provider_runs")).toBe(0);
    expect(count(db, "provider_attempts")).toBe(0);
    expect(count(db, "outbound_messages")).toBe(0);
    expect(count(db, "campaign_message_authorizations")).toBe(0);
    expect(count(db, "notifications")).toBe(0);
    expect(db.getSetting("outbound_paused")).toBe("false");
    expect(db.getSetting("daily_research_enabled")).toBe("true");

    const campaign = db.db.prepare("SELECT * FROM campaigns WHERE id=?")
      .get(result.ids.campaignId) as Record<string, unknown>;
    expect(campaign).toMatchObject({
      status: "QUEUED",
      target_count: 8,
      daily_limit: 3,
      hourly_limit: 1,
      followup_days_json: "[]",
    });
    const storedBrief = db.db.prepare("SELECT brief_json FROM campaign_versions WHERE id=?")
      .get(result.ids.versionId) as { brief_json: string };
    expect(JSON.parse(storedBrief.brief_json)).toMatchObject({
      id: "autonomous-pilot:malaysia-sample-product-2030-01",
      version: 1,
      providerBudget: {
        mode: "CAPPED",
        allowedProviders: ["searxng", "local-public-web", "hunter"],
      },
      llmBudget: { mode: "CAPPED", allowedProviders: ["openai"] },
    });
    const approvals = db.db.prepare(
      "SELECT scope, approved_actor_type, approved_by, authorization_source, reason FROM campaign_approvals ORDER BY scope",
    ).all() as Array<Record<string, unknown>>;
    expect(approvals.map((approval) => approval.scope).sort()).toEqual([
      "EXTERNAL_SEND",
      "PROVIDER_BUDGET",
      "SHADOW_PLAN",
    ]);
    expect(approvals.every((approval) => approval.approved_actor_type === "HUMAN")).toBe(true);
    expect(approvals.every((approval) => approval.approved_by === "workspace-owner")).toBe(true);
    expect(approvals.every((approval) => approval.authorization_source === "THREAD_EXPLICIT_AUTHORIZATION"))
      .toBe(true);

    const sendAuthorization = db.db.prepare("SELECT * FROM campaign_send_authorizations WHERE id=?")
      .get(result.ids.sendAuthorizationId) as Record<string, unknown>;
    expect(sendAuthorization).toMatchObject({
      total_limit: 5,
      daily_limit: 3,
      hourly_limit: 1,
      maximum_sequence_index: 0,
      authorized_actor_type: "HUMAN",
      external_send_authorized: 1,
    });
    const job = db.getJob(result.ids.jobId)!;
    expect(job).toMatchObject({ job_type: "DISCOVER_CAMPAIGN", status: "QUEUED", lane: "RESEARCH" });
    expect(JSON.parse(String(job.payload_json))).toMatchObject({
      campaignId: result.ids.campaignId,
      briefId: result.ids.briefId,
      versionId: result.ids.versionId,
      replyChatId: "",
      maximumSequenceIndex: 0,
      provider: { providerKey: "SEARXNG", operation: "EVIDENCE_SEARCH" },
      allowedOfferIds: ["offer-approved-sample-product"],
      sellerKnowledge: { privateCases: [] },
      sellerKnowledgeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(String(job.payload_json)).not.toContain("Confidential Customer");
    db.close();
  });

  it("returns identical IDs on replay and rejects changed material for the same launch key", () => {
    const db = database();
    const original = spec();
    const first = launchAutonomousPilot(db, original);
    const second = launchAutonomousPilot(db, structuredClone(original));
    expect(second).toEqual(first);
    expect(count(db, "campaigns")).toBe(1);
    expect(count(db, "campaign_versions")).toBe(1);
    expect(count(db, "campaign_approvals")).toBe(3);
    expect(count(db, "jobs")).toBe(1);

    const changed = structuredClone(original) as ReturnType<typeof spec> & {
      limits: { total: number; daily: number; hourly: number };
    };
    changed.limits.total = 6;
    expect(() => launchAutonomousPilot(db, changed)).toThrow(/launch key was reused with different spec material/i);
    expect(count(db, "campaigns")).toBe(1);
    expect(count(db, "campaign_versions")).toBe(1);
    expect(count(db, "campaign_approvals")).toBe(3);
    expect(count(db, "jobs")).toBe(1);
    expect(count(db, "outbound_messages")).toBe(0);
    db.close();
  });

  it("rolls back all launch material when provider authorization fails", () => {
    const db = database();
    db.db.prepare("UPDATE provider_registry SET status='DISABLED' WHERE provider_key='searxng'").run();
    expect(() => launchAutonomousPilot(db, spec())).toThrow(/missing, stale, disabled, or unauthorized/i);
    expect(count(db, "campaigns")).toBe(0);
    expect(count(db, "campaign_briefs")).toBe(0);
    expect(count(db, "campaign_versions")).toBe(0);
    expect(count(db, "campaign_approvals")).toBe(0);
    expect(count(db, "campaign_send_authorizations")).toBe(0);
    expect(count(db, "jobs")).toBe(0);
    expect(count(db, "provider_runs")).toBe(0);
    expect(count(db, "outbound_messages")).toBe(0);
    db.close();
  });

  it("requires exact v1 provider, coherent budgets, bounded dates and strict JSON fields", () => {
    const wrongProvider = spec() as Record<string, unknown> & { provider: Record<string, unknown> };
    wrongProvider.provider = { providerKey: "EXA", operation: "EVIDENCE_SEARCH" };
    expect(() => parseAutonomousPilotLaunchSpec(wrongProvider)).toThrow(/providerKey/i);

    const wrongBudget = spec() as Record<string, unknown> & {
      brief: { providerBudget: Record<string, unknown> };
    };
    wrongBudget.brief.providerBudget = {
      mode: "ZERO_COST",
      allowedProviders: ["searxng", "local-public-web", "hunter"],
      unit: "REQUESTS",
      maxUnits: 0,
      maxAmountUsd: 0,
      requiresSeparateApproval: true,
    };
    expect(() => parseAutonomousPilotLaunchSpec(wrongBudget)).toThrow(/positive CAPPED budget/i);

    const missingVerifier = spec() as Record<string, unknown> & {
      brief: { providerBudget: { allowedProviders: string[] } };
    };
    missingVerifier.brief.providerBudget.allowedProviders = ["searxng", "local-public-web"];
    expect(() => parseAutonomousPilotLaunchSpec(missingVerifier)).toThrow(/exactly one independent email verifier/i);

    const bothVerifiers = spec() as Record<string, unknown> & {
      brief: { providerBudget: { allowedProviders: string[] } };
    };
    bothVerifiers.brief.providerBudget.allowedProviders = [
      "searxng",
      "local-public-web",
      "hunter",
      "bouncer",
    ];
    expect(() => parseAutonomousPilotLaunchSpec(bothVerifiers)).toThrow(/exactly one independent email verifier/i);

    const bouncerOnly = spec() as Record<string, unknown> & {
      brief: { providerBudget: { allowedProviders: string[] } };
    };
    bouncerOnly.brief.providerBudget.allowedProviders = ["searxng", "local-public-web", "bouncer"];
    expect(parseAutonomousPilotLaunchSpec(bouncerOnly).brief.providerBudget.allowedProviders)
      .toEqual(["searxng", "local-public-web", "bouncer"]);

    const wrongOffer = spec() as Record<string, unknown> & { brief: { offerIds: string[] } };
    wrongOffer.brief.offerIds = ["offer-not-approved"];
    expect(() => parseAutonomousPilotLaunchSpec(wrongOffer)).toThrow(/active public-approved EMAIL offer/i);

    expect(() => parseAutonomousPilotLaunchSpec({ ...spec(), unknown: true })).toThrow(/unrecognized key/i);
    expect(() => parseAutonomousPilotLaunchSpec({
      ...spec(),
      validFrom: "2030-02-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })).toThrow(/later than validFrom/i);
  });

  it("preflights the verifier selected by the exact approved provider budget", () => {
    const db = database();
    const bouncerSpec = spec() as Record<string, unknown> & {
      brief: { providerBudget: { allowedProviders: string[] } };
    };
    bouncerSpec.brief.providerBudget.allowedProviders = ["searxng", "local-public-web", "bouncer"];

    db.db.prepare(
      "UPDATE provider_registry SET capabilities_json='[]' WHERE provider_key='bouncer'",
    ).run();
    expect(() => launchAutonomousPilot(db, bouncerSpec)).toThrow(
      /bouncer provider registry does not authorize EMAIL_VERIFICATION/i,
    );
    expect(count(db, "campaigns")).toBe(0);
    expect(count(db, "jobs")).toBe(0);
    db.close();
  });

  it("requires explicit CLI confirmation and reads only a strict JSON spec file", () => {
    expect(() => parseAutonomousPilotLaunchCliArgs(["pilot.json"])).toThrow(/confirm-launch/i);
    expect(parseAutonomousPilotLaunchCliArgs(["--spec", "pilot.json", "--confirm-launch"]))
      .toEqual({ specPath: "pilot.json", confirmed: true });
    expect(parseAutonomousPilotLaunchCliArgs(["pilot.json", "--confirm-launch"]))
      .toEqual({ specPath: "pilot.json", confirmed: true });
    expect(() => parseAutonomousPilotLaunchCliArgs([
      "--spec", "pilot.json", "--confirm-launch", "--send-now",
    ])).toThrow(/unknown launch option/i);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-pilot-spec-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "pilot.json");
    fs.writeFileSync(filePath, JSON.stringify(spec()), "utf8");
    expect(readAutonomousPilotLaunchSpec(filePath)).toMatchObject({
      launchKey: ["malaysia", "sample-product", "2030", "01"].join("-"),
      replyChatId: "",
    });
    expect(() => readAutonomousPilotLaunchSpec(path.join(directory, "pilot.txt"))).toThrow(/\.json file/i);
  });
});
