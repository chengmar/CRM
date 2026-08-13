import crypto from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import { logger } from "../logger.js";
import {
  fieldsForCampaignBrief,
  fieldsForEvent,
  fieldsForLead,
  fieldsForMarketAllocation,
  fieldsForSalesTask,
  recordsForCommercialReport,
  scalarText,
} from "./bitable/field-mapping.js";
import {
  CAMPAIGN_BRIEFS_TABLE_FIELDS,
  COMMERCIAL_REPORT_TABLE_FIELDS,
  EVENTS_TABLE_FIELDS,
  LEADS_TABLE_FIELDS,
  MARKET_ALLOCATIONS_TABLE_FIELDS,
  SALES_TASKS_TABLE_FIELDS,
  type BitableFieldDefinition,
} from "./bitable/schema.js";
import {
  isPhoneFieldConversionError,
  isUrlFieldConversionError,
  withoutPhoneFields,
  withoutUrlFields,
} from "./bitable/url-fallback.js";
import {
  buildCommercialFunnelReport,
  type CommercialReportOptions,
} from "../reporting/commercial-funnel.js";

export {
  ACQUISITION_CONTROL_TABLE_SCHEMAS,
  CAMPAIGN_BRIEFS_TABLE_FIELDS,
  COMMERCIAL_REPORT_TABLE_FIELDS,
  EVENTS_TABLE_FIELDS,
  LEADS_TABLE_FIELDS,
  MARKET_ALLOCATIONS_TABLE_FIELDS,
  SALES_TASKS_TABLE_FIELDS,
  type BitableFieldDefinition,
} from "./bitable/schema.js";

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
}

interface RemoteField {
  field_name: string;
  field_id?: string;
  type: number;
  ui_type?: string;
  is_primary?: boolean;
}

interface TableSchemaValidation {
  ok: boolean;
  missing: string[];
  mismatched: string[];
  fields: string[];
  skipped?: boolean;
}

export type AcquisitionControlTableKey =
  | "campaignBriefs"
  | "marketAllocations"
  | "salesTasks"
  | "commercialReport";

export interface BitableControlTableIds {
  campaignBriefs: string;
  marketAllocations: string;
  salesTasks: string;
  commercialReport: string;
}

const CONTROL_TABLE_SPECS: Record<AcquisitionControlTableKey, {
  name: string;
  keyField: string;
  fields: BitableFieldDefinition[];
  configField:
    | "FEISHU_BITABLE_CAMPAIGN_BRIEFS_TABLE_ID"
    | "FEISHU_BITABLE_MARKET_ALLOCATIONS_TABLE_ID"
    | "FEISHU_BITABLE_SALES_TASKS_TABLE_ID"
    | "FEISHU_BITABLE_COMMERCIAL_REPORT_TABLE_ID";
}> = {
  campaignBriefs: {
    name: "Agent Campaign Briefs",
    keyField: "brief_id",
    fields: CAMPAIGN_BRIEFS_TABLE_FIELDS,
    configField: "FEISHU_BITABLE_CAMPAIGN_BRIEFS_TABLE_ID",
  },
  marketAllocations: {
    name: "Agent Market Allocations",
    keyField: "allocation_id",
    fields: MARKET_ALLOCATIONS_TABLE_FIELDS,
    configField: "FEISHU_BITABLE_MARKET_ALLOCATIONS_TABLE_ID",
  },
  salesTasks: {
    name: "Agent Sales Tasks",
    keyField: "task_id",
    fields: SALES_TASKS_TABLE_FIELDS,
    configField: "FEISHU_BITABLE_SALES_TASKS_TABLE_ID",
  },
  commercialReport: {
    name: "Agent Commercial Report",
    keyField: "report_row_id",
    fields: COMMERCIAL_REPORT_TABLE_FIELDS,
    configField: "FEISHU_BITABLE_COMMERCIAL_REPORT_TABLE_ID",
  },
};

const CONTROL_TABLE_KEYS = Object.keys(CONTROL_TABLE_SPECS) as AcquisitionControlTableKey[];

export interface BitableSchemaValidation {
  ok: boolean;
  controlSyncEnabled: boolean;
  missing: string[];
  mismatched: string[];
  fields: string[];
  tables: {
    Leads: TableSchemaValidation;
    Events: TableSchemaValidation;
    campaignBriefs: TableSchemaValidation;
    marketAllocations: TableSchemaValidation;
    salesTasks: TableSchemaValidation;
    commercialReport: TableSchemaValidation;
  };
}

export interface BitableBootstrapResult {
  appToken: string;
  leadsTableId: string;
  eventsTableId: string;
  controlTableIds: BitableControlTableIds;
  appUrl: string;
  createdApp: boolean;
  schema: BitableSchemaValidation;
}

export interface BitableMutableSyncResult {
  created: number;
  updated: number;
}

export interface BitableControlSyncResult {
  enabled: boolean;
  campaignBriefs: BitableMutableSyncResult;
  marketAllocations: BitableMutableSyncResult;
  salesTasks: BitableMutableSyncResult;
  commercialReport: BitableMutableSyncResult;
}

export interface BitableSyncResult {
  leads: { created: number; updated: number };
  events: { created: number; skipped: number };
  controls: BitableControlSyncResult;
}

interface LocalSyncRecord {
  key: string;
  fields: Record<string, unknown>;
}

interface RemoteKeyRecord {
  recordId: string;
  key: string;
}

const CONTROL_TABLE_MARKER_VERSION = 1;
const CONTROL_TABLE_OWNER = "export-ai-agent";
const EVENTS_ROLLOVER_MARKER_VERSION = 1;
const EVENTS_ROLLOVER_HEADROOM_LIMIT = 19_000;
const NON_OPERATIONAL_EVENT_TYPES = new Set([
  "AUTONOMOUS_MESSAGE_STAGING_BLOCKED",
  "CRAWL_STRICT_AUDIT",
  "LEAD_REVERIFIED",
  "MESSAGE_POLICY_BLOCKED",
  "PROVIDER_RUN_FAILED",
  "PROVIDER_RUN_STARTED",
  "PROVIDER_RUN_SUCCEEDED",
  "PROVIDER_RUN_STALE_LEASE_RECOVERED",
  "PROVIDER_STRICT_AUDIT",
]);

export function isOperationalBitableEvent(eventType: string): boolean {
  return !NON_OPERATIONAL_EVENT_TYPES.has(eventType.trim().toUpperCase());
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = (await response.json()) as T & { code?: number; msg?: string };
  if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
    throw new Error(`Feishu API failed: HTTP ${response.status}, code=${body.code}, msg=${body.msg}`);
  }
  return body;
}

export class FeishuBitableSync {
  private token = "";
  private tokenExpiresAt = 0;
  private syncAllInFlight: Promise<BitableSyncResult> | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.FEISHU_APP_ID &&
        this.config.FEISHU_APP_SECRET &&
        this.config.FEISHU_BITABLE_APP_TOKEN &&
        this.config.FEISHU_BITABLE_LEADS_TABLE_ID &&
        this.config.FEISHU_BITABLE_EVENTS_TABLE_ID,
    );
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const body = await requestJson<TenantTokenResponse>(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.FEISHU_APP_ID,
          app_secret: this.config.FEISHU_APP_SECRET,
        }),
      },
    );
    if (!body.tenant_access_token) throw new Error("Feishu token response is missing token");
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + 90 * 60_000;
    return this.token;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    return requestJson<T>(`https://open.feishu.cn/open-apis${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async listTables(appToken: string): Promise<Array<{ table_id: string; name: string }>> {
    const items: Array<{ table_id: string; name: string }> = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const body = await this.api<{
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{ table_id?: string; name?: string }>;
        };
      }>(`/bitable/v1/apps/${appToken}/tables?${query}`);
      for (const item of body.data?.items ?? []) {
        if (item.table_id && item.name) items.push({ table_id: item.table_id, name: item.name });
      }
      pageToken = body.data?.has_more ? body.data.page_token ?? "" : "";
    } while (pageToken);
    return items;
  }

  private async listFields(appToken: string, tableId: string): Promise<RemoteField[]> {
    const body = await this.api<{ data?: { items?: RemoteField[] } }>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=500`,
    );
    return body.data?.items ?? [];
  }

  private async createTable(
    appToken: string,
    name: string,
    primaryField: BitableFieldDefinition,
  ): Promise<string> {
    const body = await this.api<{ data?: { table_id?: string } }>(
      `/bitable/v1/apps/${appToken}/tables`,
      {
        method: "POST",
        body: JSON.stringify({
          table: {
            name,
            default_view_name: "全部记录",
            fields: [primaryField],
          },
        }),
      },
    );
    const tableId = body.data?.table_id;
    if (!tableId) throw new Error(`Feishu did not return a table ID for ${name}`);
    return tableId;
  }

  private eventsRolloverMarkerKey(appToken: string): string {
    const appHash = crypto.createHash("sha256").update(appToken).digest("hex").slice(0, 16);
    return `bitable-events-active:v${EVENTS_ROLLOVER_MARKER_VERSION}:${appHash}`;
  }

  private activeEventsTableId(appToken: string): string {
    const stored = this.db.getSetting(this.eventsRolloverMarkerKey(appToken));
    if (!stored) return this.config.FEISHU_BITABLE_EVENTS_TABLE_ID;
    try {
      const marker = JSON.parse(stored) as Record<string, unknown>;
      if (
        marker.owner === CONTROL_TABLE_OWNER &&
        marker.version === EVENTS_ROLLOVER_MARKER_VERSION &&
        marker.tableKind === "operational-events"
      ) {
        return String(marker.tableId ?? "").trim() || this.config.FEISHU_BITABLE_EVENTS_TABLE_ID;
      }
    } catch {
      // Invalid markers fail closed to the explicitly configured table.
    }
    return this.config.FEISHU_BITABLE_EVENTS_TABLE_ID;
  }

  private saveActiveEventsTableId(appToken: string, tableId: string): void {
    this.db.setSetting(this.eventsRolloverMarkerKey(appToken), JSON.stringify({
      owner: CONTROL_TABLE_OWNER,
      version: EVENTS_ROLLOVER_MARKER_VERSION,
      tableKind: "operational-events",
      tableId,
      createdAt: new Date().toISOString(),
    }));
  }

  private async remoteRecordCount(appToken: string, tableId: string): Promise<number> {
    const body = await this.api<{ data?: { total?: number } }>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=1`,
    );
    return Math.max(0, Number(body.data?.total ?? 0));
  }

  private async createOperationalEventsRollover(appToken: string): Promise<string> {
    const existing = await this.listTables(appToken);
    const timestamp = new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 12);
    const baseName = `Agent Events ${timestamp}`;
    let name = baseName;
    let suffix = 2;
    const names = new Set(existing.map((table) => table.name));
    while (names.has(name)) name = `${baseName} ${suffix++}`;
    const tableId = await this.createTable(appToken, name, EVENTS_TABLE_FIELDS[0]!);
    await this.ensureFields(appToken, tableId, EVENTS_TABLE_FIELDS);
    this.saveActiveEventsTableId(appToken, tableId);
    this.db.recordEvent("system", "bitable", "BITABLE_EVENTS_TABLE_ROLLED_OVER", "system", {
      tableName: name,
      previousTablePreserved: true,
      eventPolicy: "operational-events-v1",
    });
    return tableId;
  }

  private explicitControlTableIds(): BitableControlTableIds | null {
    const ids = {} as BitableControlTableIds;
    const configured: AcquisitionControlTableKey[] = [];
    for (const key of CONTROL_TABLE_KEYS) {
      ids[key] = String(this.config[CONTROL_TABLE_SPECS[key].configField] ?? "").trim();
      if (ids[key]) configured.push(key);
    }
    if (configured.length === 0) return null;
    if (configured.length !== CONTROL_TABLE_KEYS.length) {
      throw new Error(
        "Bitable control sync requires all four explicit control table IDs, not a partial set",
      );
    }
    return ids;
  }

  private controlMarkerKey(appToken: string, key: AcquisitionControlTableKey): string {
    const appHash = crypto.createHash("sha256").update(appToken).digest("hex").slice(0, 16);
    return `bitable-control-owner:v${CONTROL_TABLE_MARKER_VERSION}:${appHash}:${key}`;
  }

  private ownedControlTableId(appToken: string, key: AcquisitionControlTableKey): string {
    const stored = this.db.getSetting(this.controlMarkerKey(appToken, key));
    if (!stored) return "";
    try {
      const marker = JSON.parse(stored) as Record<string, unknown>;
      return marker.owner === CONTROL_TABLE_OWNER && marker.version === CONTROL_TABLE_MARKER_VERSION &&
          marker.tableKey === key
        ? String(marker.tableId ?? "").trim()
        : "";
    } catch {
      return "";
    }
  }

  private saveControlOwnership(
    appToken: string,
    key: AcquisitionControlTableKey,
    tableId: string,
  ): void {
    this.db.setSetting(this.controlMarkerKey(appToken, key), JSON.stringify({
      owner: CONTROL_TABLE_OWNER,
      version: CONTROL_TABLE_MARKER_VERSION,
      tableKey: key,
      tableId,
    }));
  }

  private ownedControlTableIds(appToken: string): BitableControlTableIds | null {
    const ids = {} as BitableControlTableIds;
    const present: AcquisitionControlTableKey[] = [];
    for (const key of CONTROL_TABLE_KEYS) {
      ids[key] = this.ownedControlTableId(appToken, key);
      if (ids[key]) present.push(key);
    }
    if (present.length === 0) return null;
    if (present.length !== CONTROL_TABLE_KEYS.length) {
      throw new Error("Bitable control table ownership markers are incomplete; run explicit bootstrap");
    }
    return ids;
  }

  private async bootstrapControlTables(appToken: string): Promise<BitableControlTableIds> {
    const explicitIds = this.explicitControlTableIds();
    const remoteTableIds = new Set((await this.listTables(appToken)).map((table) => table.table_id));
    const ids = {} as BitableControlTableIds;
    for (const key of CONTROL_TABLE_KEYS) {
      const explicitId = explicitIds?.[key] ?? "";
      let tableId = explicitId || this.ownedControlTableId(appToken, key);
      if (explicitId && !remoteTableIds.has(explicitId)) {
        throw new Error(`Explicit ${CONTROL_TABLE_SPECS[key].configField} does not exist`);
      }
      if (tableId && !remoteTableIds.has(tableId)) tableId = "";
      if (!tableId) {
        tableId = await this.createTable(
          appToken,
          CONTROL_TABLE_SPECS[key].name,
          CONTROL_TABLE_SPECS[key].fields[0]!,
        );
      }
      await this.ensureFields(appToken, tableId, CONTROL_TABLE_SPECS[key].fields);
      this.saveControlOwnership(appToken, key, tableId);
      ids[key] = tableId;
    }
    return ids;
  }

  private requireControlTableIds(appToken: string): BitableControlTableIds {
    return this.explicitControlTableIds() ?? this.ownedControlTableIds(appToken) ?? (() => {
      throw new Error(
        "Bitable control sync requires four explicit table IDs or ownership markers from explicit bootstrap",
      );
    })();
  }

  private async ensureFields(
    appToken: string,
    tableId: string,
    definitions: BitableFieldDefinition[],
  ): Promise<void> {
    let existing = await this.listFields(appToken, tableId);
    const expectedPrimary = definitions[0];
    if (!expectedPrimary) throw new Error("Bitable schema has no primary field");
    if (!existing.some((field) => field.field_name === expectedPrimary.field_name)) {
      const primary = existing.find((field) => field.is_primary);
      if (!primary?.field_id) {
        throw new Error(`Table ${tableId} has no editable primary field`);
      }
      await this.api(
        `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${primary.field_id}`,
        { method: "PUT", body: JSON.stringify(expectedPrimary) },
      );
      existing = await this.listFields(appToken, tableId);
    }

    const names = new Set(existing.map((field) => field.field_name));
    for (const definition of definitions) {
      if (names.has(definition.field_name)) continue;
      await this.api(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        method: "POST",
        body: JSON.stringify(definition),
      });
      names.add(definition.field_name);
    }
  }

  private async pruneGeneratedDefaultFields(appToken: string, tableId: string): Promise<void> {
    const generatedNames = new Set(["单选", "日期", "附件", "Single select", "Date", "Attachment"]);
    const expectedNames = new Set(LEADS_TABLE_FIELDS.map((field) => field.field_name));
    for (const field of await this.listFields(appToken, tableId)) {
      if (
        field.field_id &&
        !field.is_primary &&
        generatedNames.has(field.field_name) &&
        !expectedNames.has(field.field_name)
      ) {
        await this.api(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${field.field_id}`,
          { method: "DELETE" },
        );
      }
    }
  }

  private async validateTableSchema(
    appToken: string,
    tableId: string,
    definitions: BitableFieldDefinition[],
  ): Promise<TableSchemaValidation> {
    const fields = await this.listFields(appToken, tableId);
    const byName = new Map(fields.map((field) => [field.field_name, field]));
    const missing = definitions
      .filter((definition) => !byName.has(definition.field_name))
      .map((definition) => definition.field_name);
    const mismatched = definitions.flatMap((definition) => {
      const actual = byName.get(definition.field_name);
      if (!actual) return [];
      if (actual.type !== definition.type) {
        return [`${definition.field_name}: expected type ${definition.type}, got ${actual.type}`];
      }
      if (actual.ui_type && actual.ui_type !== definition.ui_type) {
        return [`${definition.field_name}: expected ${definition.ui_type}, got ${actual.ui_type}`];
      }
      return [];
    });
    return {
      ok: missing.length === 0 && mismatched.length === 0,
      missing,
      mismatched,
      fields: fields.map((field) => field.field_name),
    };
  }

  private async validateSchemaFor(
    appToken: string,
    leadsTableId: string,
    eventsTableId: string,
    controlTableIds: BitableControlTableIds | null,
    includeControls: boolean,
  ): Promise<BitableSchemaValidation> {
    const missingTable = (name: string): TableSchemaValidation => ({
      ok: false,
      missing: [`table:${name}`],
      mismatched: [],
      fields: [],
    });
    const skipped = (): TableSchemaValidation => ({
      ok: true,
      missing: [],
      mismatched: [],
      fields: [],
      skipped: true,
    });
    const validateControl = (key: AcquisitionControlTableKey): Promise<TableSchemaValidation> => {
      if (!includeControls) return Promise.resolve(skipped());
      const tableId = controlTableIds?.[key] ?? "";
      return tableId
        ? this.validateTableSchema(appToken, tableId, CONTROL_TABLE_SPECS[key].fields)
        : Promise.resolve(missingTable(CONTROL_TABLE_SPECS[key].name));
    };
    const [Leads, Events, campaignBriefs, marketAllocations, salesTasks, commercialReport] =
      await Promise.all([
        this.validateTableSchema(appToken, leadsTableId, LEADS_TABLE_FIELDS),
        this.validateTableSchema(appToken, eventsTableId, EVENTS_TABLE_FIELDS),
        validateControl("campaignBriefs"),
        validateControl("marketAllocations"),
        validateControl("salesTasks"),
        validateControl("commercialReport"),
      ]);
    const controlEntries: Array<[string, TableSchemaValidation]> = [
      ["Campaign Briefs", campaignBriefs],
      ["Market Allocations", marketAllocations],
      ["Sales Tasks", salesTasks],
      ["Commercial Report", commercialReport],
    ];
    const tableEntries: Array<[string, TableSchemaValidation]> = [
      ["Leads", Leads],
      ["Events", Events],
      ...(includeControls ? controlEntries : []),
    ];
    return {
      ok: tableEntries.every(([, validation]) => validation.ok),
      controlSyncEnabled: this.config.FEISHU_BITABLE_CONTROL_SYNC_ENABLED,
      missing: tableEntries.flatMap(([name, validation]) => [
        ...validation.missing.map((field) => `${name}.${field}`),
        ...validation.mismatched.map((issue) => `${name}.${issue}`),
      ]),
      mismatched: tableEntries.flatMap(([name, validation]) =>
        validation.mismatched.map((issue) => `${name}.${issue}`)),
      fields: tableEntries.flatMap(([name, validation]) =>
        validation.fields.map((field) => `${name}.${field}`)),
      tables: {
        Leads,
        Events,
        campaignBriefs,
        marketAllocations,
        salesTasks,
        commercialReport,
      },
    };
  }

  async bootstrapProductionBase(
    name = "外贸获客CRM-生产版",
    options: { pruneGeneratedDefaultFields?: boolean } = {},
  ): Promise<BitableBootstrapResult> {
    if (!this.config.FEISHU_APP_ID || !this.config.FEISHU_APP_SECRET) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
    }

    let appToken = this.config.FEISHU_BITABLE_APP_TOKEN;
    let appUrl = "";
    let defaultTableId = "";
    let createdApp = false;
    if (!appToken) {
      const body = await this.api<{
        data?: {
          app?: { app_token?: string; default_table_id?: string; url?: string };
        };
      }>("/bitable/v1/apps", {
        method: "POST",
        body: JSON.stringify({ name, time_zone: "Asia/Shanghai" }),
      });
      appToken = body.data?.app?.app_token ?? "";
      defaultTableId = body.data?.app?.default_table_id ?? "";
      appUrl = body.data?.app?.url ?? "";
      createdApp = true;
      if (!appToken || !defaultTableId) {
        throw new Error("Feishu did not return the new Bitable app and default table IDs");
      }
    }

    let tables = await this.listTables(appToken);
    let leadsTableId = this.config.FEISHU_BITABLE_LEADS_TABLE_ID;
    if (!tables.some((table) => table.table_id === leadsTableId)) {
      leadsTableId = tables.find((table) => table.name === "Leads")?.table_id ?? "";
    }
    if (!leadsTableId && createdApp && defaultTableId) {
      await this.api(`/bitable/v1/apps/${appToken}/tables/${defaultTableId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Leads" }),
      });
      leadsTableId = defaultTableId;
    }
    if (!leadsTableId) {
      leadsTableId = await this.createTable(appToken, "Leads", LEADS_TABLE_FIELDS[0]!);
    }
    await this.ensureFields(appToken, leadsTableId, LEADS_TABLE_FIELDS);
    if (createdApp || options.pruneGeneratedDefaultFields) {
      await this.pruneGeneratedDefaultFields(appToken, leadsTableId);
    }

    tables = await this.listTables(appToken);
    let eventsTableId = this.config.FEISHU_BITABLE_EVENTS_TABLE_ID;
    if (!tables.some((table) => table.table_id === eventsTableId)) {
      eventsTableId = tables.find((table) => table.name === "Events")?.table_id ?? "";
    }
    if (!eventsTableId) {
      eventsTableId = await this.createTable(appToken, "Events", EVENTS_TABLE_FIELDS[0]!);
    }
    await this.ensureFields(appToken, eventsTableId, EVENTS_TABLE_FIELDS);

    const controlTableIds = await this.bootstrapControlTables(appToken);

    const schema = await this.validateSchemaFor(
      appToken,
      leadsTableId,
      eventsTableId,
      controlTableIds,
      true,
    );
    if (!schema.ok) {
      throw new Error(`Feishu Bitable schema is invalid: ${schema.missing.join(", ")}`);
    }
    return {
      appToken,
      leadsTableId,
      eventsTableId,
      controlTableIds,
      appUrl,
      createdApp,
      schema,
    };
  }

  async validateSchema(): Promise<BitableSchemaValidation> {
    if (!this.isConfigured()) {
      const empty: TableSchemaValidation = {
        ok: false,
        missing: [],
        mismatched: [],
        fields: [],
      };
      return {
        ok: false,
        controlSyncEnabled: this.config.FEISHU_BITABLE_CONTROL_SYNC_ENABLED,
        missing: [
          "FEISHU_BITABLE_APP_TOKEN",
          "FEISHU_BITABLE_LEADS_TABLE_ID",
          "FEISHU_BITABLE_EVENTS_TABLE_ID",
        ].filter((key) => !this.config[key as keyof AgentConfig]),
        mismatched: [],
        fields: [],
        tables: {
          Leads: { ...empty },
          Events: { ...empty },
          campaignBriefs: { ...empty },
          marketAllocations: { ...empty },
          salesTasks: { ...empty },
          commercialReport: { ...empty },
        },
      };
    }
    const controlsEnabled = this.config.FEISHU_BITABLE_CONTROL_SYNC_ENABLED;
    const controlTableIds = controlsEnabled
      ? this.requireControlTableIds(this.config.FEISHU_BITABLE_APP_TOKEN)
      : null;
    return this.validateSchemaFor(
      this.config.FEISHU_BITABLE_APP_TOKEN,
      this.config.FEISHU_BITABLE_LEADS_TABLE_ID,
      this.activeEventsTableId(this.config.FEISHU_BITABLE_APP_TOKEN),
      controlTableIds,
      controlsEnabled,
    );
  }

  private async listRemoteKeyRecords(
    appToken: string,
    tableId: string,
    keyField: string,
  ): Promise<RemoteKeyRecord[]> {
    const result: RemoteKeyRecord[] = [];
    let pageToken = "";
    const seenPageTokens = new Set<string>();
    let pages = 0;
    do {
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error("Feishu Bitable pagination repeated a page token");
        }
        seenPageTokens.add(pageToken);
      }
      pages += 1;
      if (pages > 100) throw new Error("Feishu Bitable pagination exceeded the bounded page limit");
      const query = new URLSearchParams({
        page_size: "500",
        text_field_as_array: "false",
        field_names: JSON.stringify([keyField]),
      });
      if (pageToken) query.set("page_token", pageToken);
      const body = await this.api<{
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
        };
      }>(`/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query}`);
      for (const record of body.data?.items ?? []) {
        if (!record.record_id) throw new Error(`Feishu Bitable ${tableId} returned a record without an ID`);
        result.push({
          recordId: record.record_id,
          key: scalarText(record.fields?.[keyField]),
        });
      }
      pageToken = body.data?.has_more ? body.data.page_token ?? "" : "";
    } while (pageToken);
    return result;
  }

  private async listRemoteRecordIds(
    appToken: string,
    tableId: string,
    keyField: string,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const record of await this.listRemoteKeyRecords(appToken, tableId, keyField)) {
      if (!record.key) continue;
      const existing = result.get(record.key);
      if (existing && existing !== record.recordId) {
        throw new Error(`Feishu Bitable has duplicate ${keyField}: ${record.key}`);
      }
      result.set(record.key, record.recordId);
    }
    return result;
  }

  private async batchCreate(
    appToken: string,
    tableId: string,
    records: Array<{ fields: Record<string, unknown> }>,
  ): Promise<Array<{ record_id?: string; fields?: Record<string, unknown> }>> {
    const returned: Array<{ record_id?: string; fields?: Record<string, unknown> }> = [];
    for (let index = 0; index < records.length; index += 500) {
      const batch = records.slice(index, index + 500);
      const create = (payload: typeof batch) =>
        this.api<{
          data?: { records?: Array<{ record_id?: string; fields?: Record<string, unknown> }> };
        }>(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
          method: "POST",
          body: JSON.stringify({ records: payload }),
        });
      let body;
      try {
        body = await create(batch);
      } catch (error) {
        const sanitize = isUrlFieldConversionError(error)
          ? withoutUrlFields
          : isPhoneFieldConversionError(error)
            ? withoutPhoneFields
            : null;
        if (!sanitize) throw error;
        logger.warn(
          { tableId, records: batch.length },
          "Feishu rejected a typed field; retrying the batch without that optional field",
        );
        body = await create(batch.map(sanitize));
      }
      returned.push(...(body.data?.records ?? []));
    }
    return returned;
  }

  private async batchUpdate(
    appToken: string,
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, unknown> }>,
  ): Promise<void> {
    for (let index = 0; index < records.length; index += 500) {
      const batch = records.slice(index, index + 500);
      const update = (payload: typeof batch) =>
        this.api(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`, {
          method: "POST",
          body: JSON.stringify({ records: payload }),
        });
      try {
        await update(batch);
      } catch (error) {
        const sanitize = isUrlFieldConversionError(error)
          ? withoutUrlFields
          : isPhoneFieldConversionError(error)
            ? withoutPhoneFields
            : null;
        if (!sanitize) throw error;
        logger.warn(
          { tableId, records: batch.length },
          "Feishu rejected a typed field; retrying the batch without that optional field",
        );
        await update(batch.map(sanitize));
      }
    }
  }

  private async batchDelete(
    appToken: string,
    tableId: string,
    recordIds: string[],
  ): Promise<void> {
    for (let index = 0; index < recordIds.length; index += 500) {
      await this.api(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
        method: "POST",
        body: JSON.stringify({ records: recordIds.slice(index, index + 500) }),
      });
    }
  }

  private async reconcileControlRecordIds(input: {
    appToken: string;
    tableId: string;
    keyField: string;
    mappingKind: string;
    expectedKeys: ReadonlySet<string>;
    dedupeAttempt?: number;
  }): Promise<Map<string, string>> {
    const rows = await this.listRemoteKeyRecords(input.appToken, input.tableId, input.keyField);
    const missingKeys = rows.filter((row) => !row.key).map((row) => row.recordId);
    if (missingKeys.length > 0) {
      throw new Error(
        `${input.mappingKind} has ${missingKeys.length} remote records with an empty or tampered ${input.keyField}`,
      );
    }
    const unknown = [...new Set(rows
      .map((row) => row.key)
      .filter((key) => !input.expectedKeys.has(key)))].sort();
    if (unknown.length > 0) {
      const prefix = input.mappingKind === "commercialReport"
        ? "Commercial Report contains legacy or unknown rows"
        : `${input.mappingKind} contains unknown remote keys`;
      throw new Error(`${prefix}: ${unknown.slice(0, 10).join(", ")}`);
    }

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const ids = grouped.get(row.key) ?? [];
      ids.push(row.recordId);
      grouped.set(row.key, ids);
    }
    const duplicateIds: string[] = [];
    for (const ids of grouped.values()) {
      ids.sort();
      duplicateIds.push(...ids.slice(1));
    }
    if (duplicateIds.length > 0) {
      if ((input.dedupeAttempt ?? 0) >= 1) {
        throw new Error(`${input.mappingKind} duplicate reconciliation did not converge`);
      }
      await this.batchDelete(input.appToken, input.tableId, duplicateIds);
      return this.reconcileControlRecordIds({
        ...input,
        dedupeAttempt: (input.dedupeAttempt ?? 0) + 1,
      });
    }
    return new Map([...grouped].map(([key, ids]) => [key, ids[0]!]));
  }

  private async syncMutableRecords(input: {
    appToken: string;
    tableId: string;
    keyField: string;
    definitions: BitableFieldDefinition[];
    mappingKind: string;
    records: LocalSyncRecord[];
  }): Promise<BitableMutableSyncResult> {
    const schema = await this.validateTableSchema(
      input.appToken,
      input.tableId,
      input.definitions,
    );
    if (!schema.ok) {
      throw new Error(
        `Feishu ${input.mappingKind} table is invalid: ${[...schema.missing, ...schema.mismatched].join(", ")}`,
      );
    }

    const localKeys = new Set<string>();
    for (const record of input.records) {
      if (!record.key) throw new Error(`${input.mappingKind} contains an empty local key`);
      if (localKeys.has(record.key)) {
        throw new Error(`${input.mappingKind} contains duplicate local key: ${record.key}`);
      }
      localKeys.add(record.key);
    }
    const reconcileInput = {
      appToken: input.appToken,
      tableId: input.tableId,
      keyField: input.keyField,
      mappingKind: input.mappingKind,
      expectedKeys: localKeys,
    };
    const before = await this.reconcileControlRecordIds(reconcileInput);
    const creates = input.records.filter((record) => !before.has(record.key));
    let createError: unknown = null;
    try {
      await this.batchCreate(
        input.appToken,
        input.tableId,
        creates.map((record) => ({ fields: record.fields })),
      );
    } catch (error) {
      createError = error;
    }

    const reconciled = await this.reconcileControlRecordIds(reconcileInput);
    const missingAfterCreate = creates.filter((record) => !reconciled.has(record.key));
    if (missingAfterCreate.length > 0) {
      throw new Error(
        `${input.mappingKind} create did not reconcile ${missingAfterCreate.length} records`,
        createError ? { cause: createError } : undefined,
      );
    }
    if (createError) {
      logger.warn(
        { tableId: input.tableId, records: creates.length },
        "Bitable create returned an error but remote reconciliation confirmed every record",
      );
    }
    await this.batchUpdate(
      input.appToken,
      input.tableId,
      input.records.map((record) => ({
        record_id: reconciled.get(record.key)!,
        fields: record.fields,
      })),
    );
    return { created: creates.length, updated: input.records.length - creates.length };
  }

  private campaignBriefRecords(): LocalSyncRecord[] {
    const rows = this.db.db.prepare(`
      SELECT cb.id AS brief_id, cv.id AS version_id, cv.version_number, cb.status,
        cv.brief_json, cv.brief_hash,
        coalesce((
          SELECT approval.budget_hash FROM campaign_approvals approval
          WHERE approval.version_id=cv.id AND approval.scope='PROVIDER_BUDGET'
          LIMIT 1
        ), '') AS provider_budget_hash,
        cb.shadow_authorized, cb.provider_budget_authorized,
        cb.external_send_authorized, cb.content_publish_authorized, cb.updated_at
      FROM campaign_briefs cb
      JOIN campaign_versions cv ON cv.id=cb.current_version_id
      ORDER BY cb.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ key: scalarText(row.brief_id), fields: fieldsForCampaignBrief(row) }));
  }

  private marketAllocationRecords(): LocalSyncRecord[] {
    const rows = this.db.db.prepare(`
      SELECT allocation.id AS allocation_id, allocation.play_id, play.country,
        allocation.policy_version, allocation.recommended_units,
        allocation.recommended_share, allocation.recommendation,
        allocation.reasons_json, allocation.applied,
        allocation.requires_human_approval, allocation.created_at
      FROM play_allocations allocation
      JOIN plays play ON play.id=allocation.play_id
      ORDER BY allocation.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: scalarText(row.allocation_id),
      fields: fieldsForMarketAllocation(row),
    }));
  }

  private salesTaskRecords(): LocalSyncRecord[] {
    const rows = this.db.db.prepare(`
      SELECT id AS task_id, account_id, person_id, play_id, enrollment_id,
        opportunity_id, task_type, status, owner, due_at, source_signal, outcome, updated_at
      FROM sales_tasks
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ key: scalarText(row.task_id), fields: fieldsForSalesTask(row) }));
  }

  async syncAcquisitionControls(
    reportOptions: CommercialReportOptions = {},
  ): Promise<BitableControlSyncResult> {
    const empty = (): BitableMutableSyncResult => ({ created: 0, updated: 0 });
    if (!this.isConfigured() || !this.config.FEISHU_BITABLE_CONTROL_SYNC_ENABLED) {
      return {
        enabled: false,
        campaignBriefs: empty(),
        marketAllocations: empty(),
        salesTasks: empty(),
        commercialReport: empty(),
      };
    }
    const appToken = this.config.FEISHU_BITABLE_APP_TOKEN;
    const tableIds = this.requireControlTableIds(appToken);
    const sync = (
      key: AcquisitionControlTableKey,
      records: LocalSyncRecord[],
    ): Promise<BitableMutableSyncResult> => this.syncMutableRecords({
      appToken,
      tableId: tableIds[key],
      keyField: CONTROL_TABLE_SPECS[key].keyField,
      definitions: CONTROL_TABLE_SPECS[key].fields,
      mappingKind: key,
      records,
    });
    const campaignBriefs = await sync("campaignBriefs", this.campaignBriefRecords());
    const marketAllocations = await sync("marketAllocations", this.marketAllocationRecords());
    const salesTasks = await sync("salesTasks", this.salesTaskRecords());
    const commercialReport = await sync(
      "commercialReport",
      recordsForCommercialReport(buildCommercialFunnelReport(this.db, reportOptions)),
    );
    const result = {
      enabled: true,
      campaignBriefs,
      marketAllocations,
      salesTasks,
      commercialReport,
    };
    logger.info(result, "Feishu Bitable acquisition control sync complete");
    return result;
  }

  async syncLeads(): Promise<{ created: number; updated: number }> {
    if (!this.isConfigured()) return { created: 0, updated: 0 };
    const schema = await this.validateTableSchema(
      this.config.FEISHU_BITABLE_APP_TOKEN,
      this.config.FEISHU_BITABLE_LEADS_TABLE_ID,
      LEADS_TABLE_FIELDS,
    );
    if (!schema.ok) {
      throw new Error(
        `Feishu Leads table is invalid: ${[...schema.missing, ...schema.mismatched].join(", ")}`,
      );
    }

    const appToken = this.config.FEISHU_BITABLE_APP_TOKEN;
    const tableId = this.config.FEISHU_BITABLE_LEADS_TABLE_ID;
    const remoteIds = await this.listRemoteRecordIds(appToken, tableId, "lead_id");
    const mappingPrefix = `bitable:${appToken}:${tableId}:lead:`;
    const createRecords: Array<{ fields: Record<string, unknown> }> = [];
    const createLeadIds: string[] = [];
    const updateRecords: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
    for (const lead of this.db.listLeadsForSync()) {
      const leadId = String(lead.id);
      const recordId = remoteIds.get(leadId) ?? this.db.getSetting(`${mappingPrefix}${leadId}`);
      if (recordId) {
        updateRecords.push({ record_id: recordId, fields: fieldsForLead(lead) });
      } else {
        createLeadIds.push(leadId);
        createRecords.push({ fields: fieldsForLead(lead) });
      }
    }

    const returned = await this.batchCreate(appToken, tableId, createRecords);
    for (let index = 0; index < createLeadIds.length; index += 1) {
      const recordId = returned[index]?.record_id;
      if (recordId) this.db.setSetting(`${mappingPrefix}${createLeadIds[index]}`, recordId);
    }
    await this.batchUpdate(appToken, tableId, updateRecords);
    const result = { created: createRecords.length, updated: updateRecords.length };
    logger.info(result, "Feishu Bitable lead sync complete");
    return result;
  }

  async syncEvents(): Promise<{ created: number; skipped: number }> {
    if (!this.isConfigured()) return { created: 0, skipped: 0 };
    const appToken = this.config.FEISHU_BITABLE_APP_TOKEN;
    const events = this.db.listEventsForSync([...NON_OPERATIONAL_EVENT_TYPES]);
    let tableId = this.activeEventsTableId(appToken);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const schema = await this.validateTableSchema(appToken, tableId, EVENTS_TABLE_FIELDS);
      if (!schema.ok) {
        throw new Error(
          `Feishu Events table is invalid: ${[...schema.missing, ...schema.mismatched].join(", ")}`,
        );
      }
      const remoteIds = await this.listRemoteRecordIds(appToken, tableId, "event_id");
      const mappingPrefix = `bitable:${appToken}:${tableId}:event:`;
      const createEvents = events.filter((event) => {
        const eventId = String(event.id);
        return !remoteIds.has(eventId) && !this.db.getSetting(`${mappingPrefix}${eventId}`);
      });
      const remoteCount = await this.remoteRecordCount(appToken, tableId);
      if (remoteCount + createEvents.length > EVENTS_ROLLOVER_HEADROOM_LIMIT) {
        if (attempt > 0 || events.length > EVENTS_ROLLOVER_HEADROOM_LIMIT) {
          throw new Error(
            `Operational Events exceed the safe Bitable partition size (${events.length})`,
          );
        }
        tableId = await this.createOperationalEventsRollover(appToken);
        continue;
      }
      const returned = await this.batchCreate(
        appToken,
        tableId,
        createEvents.map((event) => ({ fields: fieldsForEvent(event) })),
      );
      for (let index = 0; index < createEvents.length; index += 1) {
        const eventId = String(createEvents[index]?.id ?? "");
        const recordId = returned[index]?.record_id;
        if (eventId && recordId) this.db.setSetting(`${mappingPrefix}${eventId}`, recordId);
      }
      const result = { created: createEvents.length, skipped: events.length - createEvents.length };
      logger.info(
        { ...result, remoteCount, eventPolicy: "operational-events-v1" },
        "Feishu Bitable event sync complete",
      );
      return result;
    }
    throw new Error("Feishu Events rollover did not converge");
  }

  private async performSyncAll(reportOptions: CommercialReportOptions): Promise<BitableSyncResult> {
    const leads = await this.syncLeads();
    const events = await this.syncEvents();
    const controls = await this.syncAcquisitionControls(reportOptions);
    return { leads, events, controls };
  }

  async syncAll(reportOptions: CommercialReportOptions = {}): Promise<BitableSyncResult> {
    if (this.syncAllInFlight) return this.syncAllInFlight;
    const task = this.performSyncAll(reportOptions);
    this.syncAllInFlight = task;
    try {
      return await task;
    } finally {
      if (this.syncAllInFlight === task) this.syncAllInFlight = null;
    }
  }
}
