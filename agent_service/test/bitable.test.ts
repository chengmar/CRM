import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { upsertEnvFile } from "../src/env-file.js";
import { normalizePublicHttpUrl } from "../src/http-url.js";
import {
  CAMPAIGN_BRIEFS_TABLE_FIELDS,
  COMMERCIAL_REPORT_TABLE_FIELDS,
  EVENTS_TABLE_FIELDS,
  FeishuBitableSync,
  isOperationalBitableEvent,
  LEADS_TABLE_FIELDS,
  MARKET_ALLOCATIONS_TABLE_FIELDS,
  SALES_TASKS_TABLE_FIELDS,
  type BitableFieldDefinition,
  type BitableSyncResult,
} from "../src/integrations/bitable.js";
import {
  normalizePhoneField,
  recordsForCommercialReport,
} from "../src/integrations/bitable/field-mapping.js";
import { listFeishuAlertDestinations } from "../src/integrations/feishu-destinations.js";
import type { CommercialFunnelReport } from "../src/reporting/commercial-funnel.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

interface FakeField extends BitableFieldDefinition {
  field_id: string;
  is_primary?: boolean;
}

interface FakeRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

interface FakeTable {
  table_id: string;
  name: string;
  fields: FakeField[];
  records: FakeRecord[];
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFakeFeishuApi(options: {
  rejectFirstUrlBatch?: boolean;
  customerControlNameCollision?: boolean;
  concurrentCreateKeyField?: string;
  failCreateAfterPersistKeyField?: string;
} = {}): {
  tables: Map<string, FakeTable>;
  appCreates: () => number;
  urlConversionFailures: () => number;
  duplicateDeletes: () => number;
} {
  const tables = new Map<string, FakeTable>();
  let appCreateCount = 0;
  let fieldCounter = 0;
  let tableCounter = 0;
  let recordCounter = 0;
  let urlConversionFailures = 0;
  let duplicateDeleteCount = 0;
  let concurrentCreateInjected = false;
  let createFailureInjected = false;

  const rejectInvalidUrlValues = (
    table: FakeTable,
    records: Array<{ fields: Record<string, unknown> }>,
  ): Response | null => {
    const urlFields = new Set(table.fields.filter((field) => field.type === 15).map((field) => field.field_name));
    const hasUrlValue = records.some((record) =>
      [...urlFields].some((field) => record.fields[field] !== undefined),
    );
    if (options.rejectFirstUrlBatch && hasUrlValue && urlConversionFailures === 0) {
      urlConversionFailures += 1;
      return json({ code: 1254068, msg: "URLFieldConvFail" });
    }
    const invalid = records.some((record) =>
      [...urlFields].some((field) => {
        const value = record.fields[field];
        if (value === undefined) return false;
        if (!value || typeof value !== "object") return true;
        const url = value as Record<string, unknown>;
        return typeof url.link !== "string" || typeof url.text !== "string";
      }),
    );
    if (!invalid) return null;
    urlConversionFailures += 1;
    return json({ code: 1254068, msg: "URLFieldConvFail" });
  };

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) {
      return json({ code: 0, msg: "ok", tenant_access_token: "tenant_test" });
    }
    if (url.pathname === "/open-apis/bitable/v1/apps" && method === "POST") {
      appCreateCount += 1;
      tables.set("tbl_default", {
        table_id: "tbl_default",
        name: "数据表",
        fields: [
          {
            field_id: "fld_default",
            field_name: "文本",
            type: 1,
            ui_type: "Text",
            is_primary: true,
          },
          {
            field_id: "fld_generated_select",
            field_name: "单选",
            type: 3,
            ui_type: "SingleSelect",
          },
          {
            field_id: "fld_generated_date",
            field_name: "日期",
            type: 5,
            ui_type: "DateTime",
          },
          {
            field_id: "fld_generated_attachment",
            field_name: "附件",
            type: 17,
            ui_type: "Text",
          },
        ],
        records: [],
      });
      if (options.customerControlNameCollision) {
        tables.set("tbl_customer_campaign", {
          table_id: "tbl_customer_campaign",
          name: "Agent Campaign Briefs",
          fields: [{
            field_id: "fld_customer_primary",
            field_name: "customer_owned_key",
            type: 1,
            ui_type: "Text",
            is_primary: true,
          }],
          records: [],
        });
      }
      return json({
        code: 0,
        msg: "ok",
        data: {
          app: {
            app_token: "app_test",
            default_table_id: "tbl_default",
            url: "https://example.feishu.cn/base/app_test",
          },
        },
      });
    }

    const tableList = url.pathname.match(/^\/open-apis\/bitable\/v1\/apps\/app_test\/tables$/);
    if (tableList && method === "GET") {
      return json({
        code: 0,
        msg: "ok",
        data: {
          has_more: false,
          items: [...tables.values()].map(({ table_id, name }) => ({ table_id, name })),
        },
      });
    }
    if (tableList && method === "POST") {
      const definition = (body.table ?? {}) as {
        name?: string;
        fields?: BitableFieldDefinition[];
      };
      const tableId = `tbl_${++tableCounter}`;
      const fields = (definition.fields ?? []).map((field, index) => ({
        ...field,
        field_id: `fld_${++fieldCounter}`,
        is_primary: index === 0,
      }));
      tables.set(tableId, {
        table_id: tableId,
        name: definition.name ?? "Table",
        fields,
        records: [],
      });
      return json({ code: 0, msg: "ok", data: { table_id: tableId } });
    }

    const tablePath = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)$/,
    );
    if (tablePath && method === "PATCH") {
      const table = tables.get(tablePath[1]!);
      if (!table) throw new Error("Fake table not found");
      table.name = String(body.name ?? table.name);
      return json({ code: 0, msg: "ok", data: { name: table.name } });
    }

    const fieldsPath = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/fields$/,
    );
    if (fieldsPath && method === "GET") {
      return json({ code: 0, msg: "ok", data: { items: tables.get(fieldsPath[1]!)?.fields ?? [] } });
    }
    if (fieldsPath && method === "POST") {
      const table = tables.get(fieldsPath[1]!);
      if (!table) throw new Error("Fake table not found");
      const field = {
        ...(body as unknown as BitableFieldDefinition),
        field_id: `fld_${++fieldCounter}`,
      };
      table.fields.push(field);
      return json({ code: 0, msg: "ok", data: { field } });
    }

    const fieldPath = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/fields\/([^/]+)$/,
    );
    if (fieldPath && method === "PUT") {
      const table = tables.get(fieldPath[1]!);
      const index = table?.fields.findIndex((field) => field.field_id === fieldPath[2]) ?? -1;
      if (!table || index < 0) throw new Error("Fake field not found");
      table.fields[index] = {
        ...(body as unknown as BitableFieldDefinition),
        field_id: fieldPath[2]!,
        is_primary: table.fields[index]?.is_primary,
      };
      return json({ code: 0, msg: "ok", data: { field: table.fields[index] } });
    }
    if (fieldPath && method === "DELETE") {
      const table = tables.get(fieldPath[1]!);
      if (!table) throw new Error("Fake table not found");
      table.fields = table.fields.filter((field) => field.field_id !== fieldPath[2]);
      return json({ code: 0, msg: "ok", data: { deleted: true } });
    }

    const recordsPath = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/records$/,
    );
    if (recordsPath && method === "GET") {
      const records = tables.get(recordsPath[1]!)?.records ?? [];
      return json({
        code: 0,
        msg: "ok",
        data: { has_more: false, items: records, total: records.length },
      });
    }

    const batchCreate = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/records\/batch_create$/,
    );
    if (batchCreate && method === "POST") {
      const table = tables.get(batchCreate[1]!);
      if (!table) throw new Error("Fake table not found");
      const inputRecords = (body.records ?? []) as Array<{ fields: Record<string, unknown> }>;
      const rejected = rejectInvalidUrlValues(table, inputRecords);
      if (rejected) return rejected;
      if (!concurrentCreateInjected && options.concurrentCreateKeyField &&
        table.fields.some((field) => field.field_name === options.concurrentCreateKeyField) &&
        inputRecords[0]) {
        concurrentCreateInjected = true;
        table.records.push({
          record_id: `rec_${++recordCounter}`,
          fields: { ...inputRecords[0].fields },
        });
      }
      const records = inputRecords.map(
        (record) => ({ record_id: `rec_${++recordCounter}`, fields: record.fields }),
      );
      table.records.push(...records);
      if (!createFailureInjected && options.failCreateAfterPersistKeyField &&
        table.fields.some((field) => field.field_name === options.failCreateAfterPersistKeyField)) {
        createFailureInjected = true;
        return json({ code: 999999, msg: "ambiguous create result" });
      }
      return json({ code: 0, msg: "ok", data: { records } });
    }

    const batchUpdate = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/records\/batch_update$/,
    );
    if (batchUpdate && method === "POST") {
      const table = tables.get(batchUpdate[1]!);
      if (!table) throw new Error("Fake table not found");
      const updates = (body.records ?? []) as FakeRecord[];
      const rejected = rejectInvalidUrlValues(table, updates);
      if (rejected) return rejected;
      for (const update of updates) {
        const record = table.records.find((item) => item.record_id === update.record_id);
        if (record) record.fields = { ...record.fields, ...update.fields };
      }
      return json({ code: 0, msg: "ok", data: {} });
    }

    const batchDelete = url.pathname.match(
      /^\/open-apis\/bitable\/v1\/apps\/app_test\/tables\/([^/]+)\/records\/batch_delete$/,
    );
    if (batchDelete && method === "POST") {
      const table = tables.get(batchDelete[1]!);
      if (!table) throw new Error("Fake table not found");
      const ids = new Set((body.records ?? []) as string[]);
      const before = table.records.length;
      table.records = table.records.filter((record) => !ids.has(record.record_id));
      duplicateDeleteCount += before - table.records.length;
      return json({ code: 0, msg: "ok", data: { deleted: before - table.records.length } });
    }
    throw new Error(`Unhandled fake Feishu request: ${method} ${url.pathname}`);
  });
  return {
    tables,
    appCreates: () => appCreateCount,
    urlConversionFailures: () => urlConversionFailures,
    duplicateDeletes: () => duplicateDeleteCount,
  };
}

function createLead(db: AgentDatabase): string {
  const campaignId = db.createCampaign({
    name: "bitable-test",
    market: "Vietnam",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: "Bitable Test Company",
    domain: "bitable-test.invalid",
    website: "https://bitable-test.invalid",
    country: "Vietnam",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.upsertContact({
    leadId,
    name: "Named Buyer",
    title: "Procurement Manager",
    email: "buyer@bitable-test.invalid",
    linkedin: "https://linkedin.example/named-buyer",
    sourceUrl: "https://bitable-test.invalid/team",
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "test",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  return leadId;
}

function createAcquisitionControlRows(db: AgentDatabase): void {
  db.saveCampaignDraft({
    briefKey: "bitable-control-brief",
    brief: {
      market: "MY",
      productFamily: "sample product application",
      buyerTypes: ["Sample application integrator"],
      industries: ["sample requirement", "Metal fabrication"],
      roleFamilies: ["Engineering", "Procurement"],
      qualificationTracks: ["ICP_FIT"],
      requiredSignals: ["Public product-control project evidence"],
      exclusions: ["DNC", "Existing customer"],
      targetMetric: "VALID_CONTACTS",
      targetCount: 20,
      providerBudget: { mode: "CAPPED", maxUnits: 20 },
      llmBudget: { mode: "CAPPED", maxUnits: 100000 },
      offerIds: ["offer-rfq-checklist"],
      transport: "NONE",
      deadline: "2026-08-20T00:00:00.000Z",
      hypothesis: "A grounded checklist will increase qualified replies.",
    },
    createdBy: "bitable-fixture",
  });
  const play = db.upsertPlay({
    key: "bitable-control-play",
    name: "MY sample application integrators",
    country: "MY",
    buyerArchetype: "SYSTEM_INTEGRATOR",
    application: "sample application",
    productFamily: "sample product application",
    roleFamily: "PROCUREMENT",
    qualificationTrack: "ICP_FIT",
    offer: "RFQ checklist",
    channel: "EMAIL",
    createdBy: "bitable-fixture",
    definition: { fixture: true },
  });
  db.savePlayAllocationSuggestion({
    idempotencyKey: "bitable-control-allocation",
    playId: play.playId,
    policyVersion: "market-allocation-v1",
    recommendedUnits: 20,
    recommendedShare: 0.2,
    recommendation: "EXPLORE",
    reasons: ["SMALL_SAMPLE_EXPLORATION_PRESERVED"],
    createdBy: "bitable-fixture",
  });
  const accountId = db.upsertAccount({
    domain: "bitable-control.example",
    displayName: "Bitable Control Account",
    countryCode: "MY",
    source: "fixture",
  });
  const enrollment = db.enrollAccountInPlay({
    accountId,
    playVersionId: play.playVersionId,
    qualificationTrack: "ICP_FIT",
    source: "fixture",
    idempotencyKey: "bitable-control-enrollment",
  });
  const opportunity = db.createOrGetOpportunity({
    idempotencyKey: "bitable-control-opportunity",
    source: "MANUAL",
    accountId,
    enrollmentId: enrollment.id,
    stage: "INQUIRY_QUALIFIED",
    owner: "sales-fixture",
  });
  db.createOrGetSalesTask({
    idempotencyKey: "bitable-control-task",
    taskType: "CALL",
    accountId,
    playId: play.playId,
    enrollmentId: enrollment.id,
    opportunityId: opportunity.id,
    owner: "sales-fixture",
    dueAt: "2026-07-22T00:00:00.000Z",
    sourceSignal: "fixture-signal",
  });
}

function multiCurrencyCommercialReport(): CommercialFunnelReport {
  const counts = {
    deliveredCohorts: 4,
    deliveredAccounts: 4,
    deliveredMessages: 5,
    qualifiedAccounts: 4,
    namedCurrentContactAccounts: 4,
    validContactAccounts: 4,
    readyAccounts: 4,
    approvedAccounts: 4,
    hardBounceAccounts: 0,
    negativeAccounts: 0,
    unsubscribeAccounts: 0,
    p1Accounts: 1,
    p2Accounts: 1,
    referralAccounts: 0,
    inquiries: 2,
    quoteOpportunities: 2,
    deals: 1,
  };
  return {
    generatedAt: "2026-07-25T00:00:00.000Z",
    cohort: {
      basis: "delivered_evidence",
      unit: "account_play_enrollment_or_legacy_lead",
      acceptedEvidence: ["MESSAGE_DELIVERED_EVENT", "DELIVERED_STATUS", "REPLIED_STATUS"],
      explicitlyExcludedStatus: "SENT",
      startAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-08-01T00:00:00.000Z",
    },
    overall: {
      key: "all",
      label: "All delivered cohorts",
      counts,
      rates: {} as CommercialFunnelReport["overall"]["rates"],
      money: {
        revenueMinorByCurrency: { EUR: 120_000, USD: 250_000 },
        grossMarginMinorByCurrency: { EUR: 30_000, USD: 75_000 },
        costMicrosByCurrency: { EUR: 2_000_000, USD: 3_000_000 },
        costPerValidMicrosByCurrency: {},
        costPerInquiryMicrosByCurrency: {},
        costPerQuoteMicrosByCurrency: {},
        costPerDealMicrosByCurrency: {},
      },
    },
    byDimension: {
      market: [],
      play: [],
      qualificationTrack: [],
      provider: [],
      channel: [],
      offer: [],
      experiment: [],
    },
    touchpointAttribution: {} as CommercialFunnelReport["touchpointAttribution"],
    unresolved: { intakes: 0, opportunities: 0, resourceUsage: 0 },
    notes: [],
  };
}

describe("Feishu Bitable production control plane", () => {
  it("coalesces concurrent full sync requests in one process", async () => {
    const bitable = new FeishuBitableSync({} as never, {} as never);
    let release!: (value: BitableSyncResult) => void;
    const pending = new Promise<BitableSyncResult>((resolve) => { release = resolve; });
    const perform = vi.spyOn(
      bitable as unknown as { performSyncAll: () => Promise<BitableSyncResult> },
      "performSyncAll",
    ).mockReturnValue(pending);
    const result: BitableSyncResult = {
      leads: { created: 0, updated: 1 },
      events: { created: 0, skipped: 1 },
      controls: {
        enabled: false,
        campaignBriefs: { created: 0, updated: 0 },
        marketAllocations: { created: 0, updated: 0 },
        salesTasks: { created: 0, updated: 0 },
        commercialReport: { created: 0, updated: 0 },
      },
    };

    const first = bitable.syncAll();
    const second = bitable.syncAll();
    release(result);

    await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("keeps high-volume telemetry out of operational Events", () => {
    expect(isOperationalBitableEvent("PROVIDER_RUN_STARTED")).toBe(false);
    expect(isOperationalBitableEvent("PROVIDER_RUN_SUCCEEDED")).toBe(false);
    expect(isOperationalBitableEvent("CRAWL_STRICT_AUDIT")).toBe(false);
    expect(isOperationalBitableEvent("LEAD_REVERIFIED")).toBe(false);
    expect(isOperationalBitableEvent("MESSAGE_SENT")).toBe(true);
    expect(isOperationalBitableEvent("INBOUND_PROCESSED")).toBe(true);
  });

  it("filters high-volume telemetry in SQLite before Bitable serialization", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-event-filter-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    db.recordEvent("provider_run", "provider_fixture", "PROVIDER_RUN_STARTED", "test", {
      payload: "large telemetry payload",
    });
    db.recordEvent("outbound_message", "message_fixture", "MESSAGE_SENT", "test", {});

    const events = db.listEventsForSync([" provider_run_started "]);

    expect(events.some((event) => event.event_type === "PROVIDER_RUN_STARTED")).toBe(false);
    expect(events.some((event) => event.event_type === "MESSAGE_SENT")).toBe(true);
    db.close();
  });

  it("keeps valid international numbers and omits descriptive or malformed WhatsApp text", () => {
    expect(normalizePhoneField("+86 138-0000-0000")).toBe("+8613800000000");
    expect(normalizePhoneField("0086 138 0000 0000")).toBe("+8613800000000");
    expect(normalizePhoneField("Public WhatsApp route on site")).toBeUndefined();
    expect(normalizePhoneField("123")).toBeUndefined();
  });

  it("normalizes safe public URLs and rejects non-URL model output", () => {
    expect(normalizePublicHttpUrl("example.com/team")).toBe("https://example.com/team");
    expect(normalizePublicHttpUrl("<https://example.com/team>")).toBe("https://example.com/team");
    expect(normalizePublicHttpUrl("N/A")).toBeNull();
    expect(normalizePublicHttpUrl("official website contact page")).toBeNull();
    expect(normalizePublicHttpUrl("https://one.example https://two.example")).toBeNull();
    expect(normalizePublicHttpUrl("mailto:buyer@example.com")).toBeNull();
  });

  it("separates funnel counts from each currency money row", () => {
    const records = recordsForCommercialReport(multiCurrencyCommercialReport());
    expect(records).toHaveLength(3);
    const counts = records.filter((record) => record.fields.row_kind === "FUNNEL_COUNTS");
    const money = records.filter((record) => record.fields.row_kind === "CURRENCY_MONEY");
    expect(counts).toHaveLength(1);
    expect(counts[0]?.fields).toMatchObject({
      delivered: 4,
      delivered_messages: 5,
      inquiries: 2,
      revenue_minor: null,
      gross_margin_minor: null,
      cost_micros: null,
    });
    expect(money).toHaveLength(2);
    expect(money.map((record) => record.fields.currency).sort()).toEqual(["EUR", "USD"]);
    for (const record of money) {
      expect(record.fields.delivered).toBeNull();
      expect(record.fields.inquiries).toBeNull();
    }
    expect(money.find((record) => record.fields.currency === "EUR")?.fields).toMatchObject({
      revenue_minor: 120_000,
      gross_margin_minor: 30_000,
      cost_micros: 2_000_000,
    });
  });

  it("performs no Bitable request when the integration is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-disabled-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createAcquisitionControlRows(db);
    const bitable = new FeishuBitableSync(loadConfig({}), db);

    await expect(bitable.syncAll({ generatedAt: "2026-07-25T00:00:00.000Z" })).resolves.toEqual({
      leads: { created: 0, updated: 0 },
      events: { created: 0, skipped: 0 },
      controls: {
        enabled: false,
        campaignBriefs: { created: 0, updated: 0 },
        marketAllocations: { created: 0, updated: 0 },
        salesTasks: { created: 0, updated: 0 },
        commercialReport: { created: 0, updated: 0 },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it("keeps legacy Leads and Events sync healthy with control export disabled and tables absent", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-legacy-upgrade-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createLead(db);
    createAcquisitionControlRows(db);
    const bootstrapConfig = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bootstrapSync = new FeishuBitableSync(bootstrapConfig, db);
    const bootstrap = await bootstrapSync.bootstrapProductionBase();
    for (const tableId of Object.values(bootstrap.controlTableIds)) fake.tables.delete(tableId);

    const legacyConfig = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });
    const legacySync = new FeishuBitableSync(legacyConfig, db);
    await expect(legacySync.validateSchema()).resolves.toMatchObject({
      ok: true,
      controlSyncEnabled: false,
      tables: {
        campaignBriefs: { ok: true, skipped: true },
        marketAllocations: { ok: true, skipped: true },
        salesTasks: { ok: true, skipped: true },
        commercialReport: { ok: true, skipped: true },
      },
    });
    const result = await legacySync.syncAll({ generatedAt: "2026-07-25T00:00:00.000Z" });
    expect(result.leads.created).toBe(1);
    expect(result.events.created).toBeGreaterThan(0);
    expect(result.controls).toEqual({
      enabled: false,
      campaignBriefs: { created: 0, updated: 0 },
      marketAllocations: { created: 0, updated: 0 },
      salesTasks: { created: 0, updated: 0 },
      commercialReport: { created: 0, updated: 0 },
    });
    db.close();
  });

  it("rejects control opt-in before any request when IDs and ownership markers are absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-control-unowned-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_BITABLE_APP_TOKEN: "app_test",
      FEISHU_BITABLE_LEADS_TABLE_ID: "tbl_leads",
      FEISHU_BITABLE_EVENTS_TABLE_ID: "tbl_events",
      FEISHU_BITABLE_CONTROL_SYNC_ENABLED: "true",
    });
    const bitable = new FeishuBitableSync(config, db);
    await expect(bitable.syncAcquisitionControls()).rejects.toThrow(/explicit table IDs or ownership markers/i);
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it("never claims or mutates an unowned customer table with the managed display name", async () => {
    const fake = installFakeFeishuApi({ customerControlNameCollision: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-table-ownership-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    const customerTable = fake.tables.get("tbl_customer_campaign");
    expect(bootstrap.controlTableIds.campaignBriefs).not.toBe("tbl_customer_campaign");
    expect(customerTable?.fields.map((field) => field.field_name)).toEqual(["customer_owned_key"]);
    expect([...fake.tables.values()].filter((table) => table.name === "Agent Campaign Briefs"))
      .toHaveLength(2);

    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });
    const second = await bitable.bootstrapProductionBase();
    expect(second.controlTableIds).toEqual(bootstrap.controlTableIds);
    expect(customerTable?.fields.map((field) => field.field_name)).toEqual(["customer_owned_key"]);
    db.close();
  });

  it("bootstraps and idempotently mirrors every acquisition control table from SQLite", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-controls-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createAcquisitionControlRows(db);
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
      FEISHU_BITABLE_CONTROL_SYNC_ENABLED: true,
    });

    const expectedSchemas = {
      campaignBriefs: CAMPAIGN_BRIEFS_TABLE_FIELDS,
      marketAllocations: MARKET_ALLOCATIONS_TABLE_FIELDS,
      salesTasks: SALES_TASKS_TABLE_FIELDS,
      commercialReport: COMMERCIAL_REPORT_TABLE_FIELDS,
    };
    for (const [key, fields] of Object.entries(expectedSchemas) as Array<
      [keyof typeof expectedSchemas, BitableFieldDefinition[]]
    >) {
      expect(fake.tables.get(bootstrap.controlTableIds[key])?.fields).toHaveLength(fields.length);
    }

    const first = await bitable.syncAcquisitionControls({
      generatedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(first).toEqual({
      enabled: true,
      campaignBriefs: { created: 1, updated: 0 },
      marketAllocations: { created: 1, updated: 0 },
      salesTasks: { created: 1, updated: 0 },
      commercialReport: { created: 1, updated: 0 },
    });
    const briefTable = fake.tables.get(bootstrap.controlTableIds.campaignBriefs);
    const allocationTable = fake.tables.get(bootstrap.controlTableIds.marketAllocations);
    const taskTable = fake.tables.get(bootstrap.controlTableIds.salesTasks);
    const reportTable = fake.tables.get(bootstrap.controlTableIds.commercialReport);
    expect(briefTable?.records[0]?.fields).toMatchObject({
      market: "MY",
      product_family: "sample product application",
      buyer_types: "Sample application integrator",
      industries: "sample requirement; Metal fabrication",
      role_families: "Engineering; Procurement",
      required_signals: "Public product-control project evidence",
      exclusions: "DNC; Existing customer",
      target_metric: "VALID_CONTACTS",
      target_count: 20,
      provider_budget: JSON.stringify({ maxUnits: 20, mode: "CAPPED" }),
      research_budget: JSON.stringify({ maxUnits: 100000, mode: "CAPPED" }),
      offer_ids: "offer-rfq-checklist",
      transport: "NONE",
      deadline: new Date("2026-08-20T00:00:00.000Z").getTime(),
      hypothesis: "A grounded checklist will increase qualified replies.",
      external_send_authorized: false,
    });
    expect(allocationTable?.records[0]?.fields).toMatchObject({
      country: "MY",
      recommendation: "EXPLORE",
      applied: false,
      requires_human_approval: true,
    });
    expect(taskTable?.records[0]?.fields).toMatchObject({
      task_type: "CALL",
      status: "OPEN",
      owner: "sales-fixture",
    });
    expect(String(taskTable?.records[0]?.fields.enrollment_id)).toMatch(/^enroll_/);
    expect(String(taskTable?.records[0]?.fields.opportunity_id)).toMatch(/^opp_/);
    expect(reportTable?.records[0]?.fields).toMatchObject({
      period: "BEGIN..OPEN",
      row_kind: "FUNNEL_COUNTS",
      dimension: "overall",
      delivered: 0,
      delivered_messages: 0,
      cost_micros: null,
      attribution_mode: "DESCRIPTIVE_FIRST_LAST_ASSIST",
      generated_at: new Date("2026-07-25T00:00:00.000Z").getTime(),
    });

    if (briefTable?.records[0]) briefTable.records[0].fields.market = "REMOTE_TAMPER";
    db.saveCampaignDraft({
      briefKey: "bitable-control-brief",
      brief: {
        market: "MY",
        productFamily: "sample product application",
        qualificationTracks: ["ICP_FIT"],
        transport: "NONE",
      },
      createdBy: "bitable-fixture",
    });
    const second = await bitable.syncAcquisitionControls({
      generatedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(second).toEqual({
      enabled: true,
      campaignBriefs: { created: 0, updated: 1 },
      marketAllocations: { created: 0, updated: 1 },
      salesTasks: { created: 0, updated: 1 },
      commercialReport: { created: 0, updated: 1 },
    });
    expect(briefTable?.records).toHaveLength(1);
    expect(briefTable?.records[0]?.fields.market).toBe("MY");
    expect(briefTable?.records[0]?.fields.target_count).toBeNull();
    expect(briefTable?.records[0]?.fields.buyer_types).toBe("");
    expect(briefTable?.records[0]?.fields.deadline).toBeNull();
    expect(allocationTable?.records).toHaveLength(1);
    expect(taskTable?.records).toHaveLength(1);
    expect(reportTable?.records).toHaveLength(1);
    expect(reportTable?.records[0]?.fields.generated_at)
      .toBe(new Date("2026-07-26T00:00:00.000Z").getTime());

    allocationTable?.records.splice(0);
    const afterRemoteDeletion = await bitable.syncAcquisitionControls({
      generatedAt: "2026-07-27T00:00:00.000Z",
    });
    expect(afterRemoteDeletion.marketAllocations).toEqual({ created: 1, updated: 0 });
    expect(allocationTable?.records).toHaveLength(1);
    expect(allocationTable?.records[0]?.fields.recommendation).toBe("EXPLORE");

    if (briefTable?.records[0]) briefTable.records[0].fields.brief_id = "tampered-remote-key";
    await expect(bitable.syncAcquisitionControls({
      generatedAt: "2026-07-28T00:00:00.000Z",
    })).rejects.toThrow(/unknown remote keys.*tampered-remote-key/i);
    db.close();
  });

  it("reconciles concurrent and ambiguous control creates without leaving duplicate keys", async () => {
    const fake = installFakeFeishuApi({
      concurrentCreateKeyField: "brief_id",
      failCreateAfterPersistKeyField: "brief_id",
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-create-reconcile-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createAcquisitionControlRows(db);
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
      FEISHU_BITABLE_CONTROL_SYNC_ENABLED: true,
    });

    await expect(bitable.syncAcquisitionControls({
      generatedAt: "2026-07-25T00:00:00.000Z",
    })).resolves.toMatchObject({
      enabled: true,
      campaignBriefs: { created: 1, updated: 0 },
    });
    const records = fake.tables.get(bootstrap.controlTableIds.campaignBriefs)?.records ?? [];
    expect(records).toHaveLength(1);
    expect(new Set(records.map((record) => record.fields.brief_id)).size).toBe(1);
    expect(fake.duplicateDeletes()).toBe(1);
    db.close();
  });

  it("rejects legacy Commercial Report row keys instead of mixing report layouts", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-commercial-legacy-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
      FEISHU_BITABLE_CONTROL_SYNC_ENABLED: true,
    });
    fake.tables.get(bootstrap.controlTableIds.commercialReport)?.records.push({
      record_id: "rec_legacy_commercial",
      fields: { report_row_id: "BEGIN..OPEN:overall:all:NO_CURRENCY" },
    });

    await expect(bitable.syncAcquisitionControls({
      generatedAt: "2026-07-25T00:00:00.000Z",
    })).rejects.toThrow(/Commercial Report contains legacy or unknown rows/i);
    db.close();
  });

  it("omits malformed historical URL fields without failing the lead sync", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-urls-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const leadId = createLead(db);
    db.upsertContact({
      leadId,
      name: "Named Buyer",
      title: "Procurement Manager",
      email: "buyer@bitable-test.invalid",
      linkedin: "not available",
      sourceUrl: "bitable-test.invalid/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "test",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
    });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });

    await expect(bitable.syncLeads()).resolves.toEqual({ created: 1, updated: 0 });
    const record = fake.tables.get(bootstrap.leadsTableId)?.records[0];
    expect(record?.fields.linkedin).toBeUndefined();
    expect(record?.fields.contact_source_url).toEqual({
      link: "https://bitable-test.invalid/team",
      text: "https://bitable-test.invalid/team",
    });
    db.close();
  });

  it("retries a Feishu URL conversion failure without dropping the lead", async () => {
    const fake = installFakeFeishuApi({ rejectFirstUrlBatch: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-url-fallback-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createLead(db);
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });

    await expect(bitable.syncLeads()).resolves.toEqual({ created: 1, updated: 0 });
    expect(fake.urlConversionFailures()).toBe(1);
    const record = fake.tables.get(bootstrap.leadsTableId)?.records[0];
    expect(record?.fields.company).toBe("Bitable Test Company");
    expect(record?.fields.website).toBeUndefined();
    expect(record?.fields.linkedin).toBeUndefined();
    expect(record?.fields.contact_source_url).toBeUndefined();
    db.close();
  });

  it("bootstraps exact schemas and keeps Leads updatable while Events remain append-only", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createLead(db);
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
    });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    expect(bootstrap.schema.ok).toBe(true);
    expect(fake.appCreates()).toBe(1);
    expect(fake.tables.get(bootstrap.leadsTableId)?.fields).toHaveLength(LEADS_TABLE_FIELDS.length);
    expect(fake.tables.get(bootstrap.eventsTableId)?.fields).toHaveLength(EVENTS_TABLE_FIELDS.length);

    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });
    const first = await bitable.syncAll();
    expect(first.leads).toEqual({ created: 1, updated: 0 });
    expect(first.events.created).toBeGreaterThanOrEqual(2);
    const eventCount = fake.tables.get(bootstrap.eventsTableId)?.records.length;

    const secondBootstrap = await bitable.bootstrapProductionBase();
    expect(secondBootstrap.createdApp).toBe(false);
    expect(fake.appCreates()).toBe(1);
    const second = await bitable.syncAll();
    expect(second.leads).toEqual({ created: 0, updated: 1 });
    expect(second.events.created).toBe(0);
    expect(fake.tables.get(bootstrap.leadsTableId)?.records).toHaveLength(1);
    expect(fake.tables.get(bootstrap.eventsTableId)?.records).toHaveLength(eventCount ?? 0);
    db.close();
  });

  it("rolls operational Events into a new table without deleting the full legacy table", async () => {
    const fake = installFakeFeishuApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-bitable-rollover-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    createLead(db);
    db.recordEvent("outbound_message", "message_fixture", "MESSAGE_SENT", "test", {});
    db.recordEvent("provider_run", "provider_fixture", "PROVIDER_RUN_SUCCEEDED", "test", {});
    const config = loadConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test" });
    const bitable = new FeishuBitableSync(config, db);
    const bootstrap = await bitable.bootstrapProductionBase();
    Object.assign(config, {
      FEISHU_BITABLE_APP_TOKEN: bootstrap.appToken,
      FEISHU_BITABLE_LEADS_TABLE_ID: bootstrap.leadsTableId,
      FEISHU_BITABLE_EVENTS_TABLE_ID: bootstrap.eventsTableId,
    });
    const legacy = fake.tables.get(bootstrap.eventsTableId)!;
    legacy.records.push(...Array.from({ length: 19_000 }, (_, index) => ({
      record_id: `legacy_${index}`,
      fields: { event_id: `legacy_event_${index}` },
    })));

    await expect(bitable.syncEvents()).resolves.toMatchObject({ created: expect.any(Number) });
    expect(legacy.records).toHaveLength(19_000);
    const rollover = [...fake.tables.values()].find((table) => table.name.startsWith("Agent Events "));
    expect(rollover).toBeDefined();
    expect(rollover?.records.length).toBeGreaterThan(0);
    expect(rollover?.records.some((record) => record.fields.event_type === "PROVIDER_RUN_SUCCEEDED"))
      .toBe(false);
    const marker = db.db.prepare(
      "SELECT value FROM settings WHERE key LIKE 'bitable-events-active:v1:%'",
    ).get() as { value: string };
    expect(JSON.parse(marker.value)).toMatchObject({
      owner: "export-ai-agent",
      tableKind: "operational-events",
      tableId: rollover?.table_id,
    });
    db.close();
  });

  it("registers paired users and groups as alert destinations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-alerts-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({ FEISHU_ALERT_OPEN_IDS: "ou_static" });
    db.setSetting("feishu_user:ou_paired", "true");
    db.setSetting("feishu_alert_chat:oc_sales", "true");
    expect(listFeishuAlertDestinations(config, db)).toEqual([
      "ou_static",
      "oc_sales",
      "ou_paired",
    ]);
    db.close();
  });

  it("updates only requested private env keys while preserving existing settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-env-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "OUTBOUND_ENABLED=false\nFEISHU_BITABLE_APP_TOKEN=old\n", "utf8");
    upsertEnvFile(envPath, {
      FEISHU_BITABLE_APP_TOKEN: "new",
      FEISHU_BITABLE_LEADS_TABLE_ID: "tbl_leads",
      FEISHU_BITABLE_EVENTS_TABLE_ID: "tbl_events",
    });
    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toContain("OUTBOUND_ENABLED=false");
    expect(content).toContain("FEISHU_BITABLE_APP_TOKEN=new");
    expect(content).toContain("FEISHU_BITABLE_LEADS_TABLE_ID=tbl_leads");
    expect(content).toContain("FEISHU_BITABLE_EVENTS_TABLE_ID=tbl_events");
  });
});
