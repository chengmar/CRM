import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import type { WorkflowRole } from "./db.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(currentDir, "..");
const workspaceRoot = path.resolve(serviceRoot, "..");

dotenv.config({ path: path.join(workspaceRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(serviceRoot, ".env"), override: true, quiet: true });

const boolValue = z
  .string()
  .optional()
  .transform((value) => value?.trim().toLowerCase() === "true");

const boolValueDefaultTrue = z
  .string()
  .optional()
  .transform((value) => value === undefined || value.trim() === ""
    ? true
    : value.trim().toLowerCase() === "true");

const intValue = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number.parseInt(value ?? "", 10);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    });

const stringValue = (defaultValue = "") =>
  z.string().optional().transform((value) => value?.trim() || defaultValue);

export const TRUSTED_FEISHU_ROLE_NAMES = [
  "ENGINEERING",
  "COMPLIANCE",
  "LOCALIZATION",
  "CONTENT_REVIEW",
  "PUBLISHER",
  "INBOUND_REVIEW",
  "SALES",
  "SALES_MANAGER",
  "CAMPAIGN_APPROVER",
  "BUDGET_APPROVER",
  "MARKET_REVIEW",
  "EXPERIMENT_REVIEW",
  "MESSAGE_REVIEWER",
] as const satisfies readonly WorkflowRole[];

function parseTrustedFeishuUserRoles(raw: string): ReadonlyMap<string, ReadonlySet<WorkflowRole>> {
  try {
    const parsed = z.record(
      z.string().trim().min(1).max(200),
      z.array(z.enum(TRUSTED_FEISHU_ROLE_NAMES)).min(1).max(TRUSTED_FEISHU_ROLE_NAMES.length),
    ).parse(JSON.parse(raw));
    if (Object.keys(parsed).length > 500) throw new Error("too many role bindings");
    const bindings = new Map<string, ReadonlySet<WorkflowRole>>();
    for (const [rawUserId, roles] of Object.entries(parsed)) {
      const userId = rawUserId.trim();
      if (userId !== rawUserId || /\s/.test(userId) || bindings.has(userId) ||
        new Set(roles).size !== roles.length) {
        throw new Error("ambiguous role binding");
      }
      bindings.set(userId, new Set<WorkflowRole>(roles));
    }
    return bindings;
  } catch {
    throw new Error(
      "FEISHU_TRUSTED_USER_ROLES must be a valid JSON object mapping Feishu user_id/open_id values to unique supported roles",
    );
  }
}

const schema = z.object({
  AGENT_MODE: z.enum(["dry_run", "production"]).default("dry_run"),
  AGENT_DB_PATH: stringValue(path.join(serviceRoot, "data", "agent.db")),
  AGENT_HTTP_HOST: stringValue("127.0.0.1"),
  AGENT_HTTP_PORT: intValue(18790),
  AGENT_LOG_LEVEL: stringValue("info"),
  DASHBOARD_ENABLED: boolValueDefaultTrue,
  DASHBOARD_REFRESH_SECONDS: intValue(5),
  BUSINESS_DATA_DIR: stringValue("customer_business_data"),
  DEFAULT_PRODUCT: stringValue("Sample Product"),
  DEFAULT_BUYER_TYPE: stringValue("distributor or system integrator"),
  RESEARCH_USER_AGENT: stringValue("Export-Research-Agent/1.0"),
  HERMES_RESEARCH_ENABLED: boolValue,
  HERMES_COMMAND: stringValue("hermes"),
  HERMES_HOME: stringValue(),
  HERMES_RESEARCH_TIMEOUT_SECONDS: intValue(300),
  OUTBOUND_ENABLED: boolValue,
  OUTBOUND_SENDING_STALE_SECONDS: intValue(300),
  REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: boolValue,
  OUTREACH_APPROVAL_REQUIRED: boolValue,
  EMAIL_OUTREACH_ENABLED: boolValue,
  EMAIL_INBOUND_ENABLED: boolValue,
  INQUIRY_FORM_WEBHOOK_ENABLED: boolValue,
  INQUIRY_FORM_HMAC_SECRET: stringValue(),
  INQUIRY_WEBHOOK_REPLAY_WINDOW_SECONDS: intValue(300),
  INQUIRY_WEBHOOK_RATE_LIMIT_PER_MINUTE: intValue(30),
  CONSUMER_EMAIL_PILOT_ENABLED: boolValue,
  EMAIL_POLL_SECONDS: intValue(60),
  IMAP_HEALTH_STALE_SECONDS: intValue(300),
  IMAP_FAILURE_PAUSE_THRESHOLD: intValue(3),
  IMAP_MESSAGE_MAX_ATTEMPTS: intValue(3),
  EMAIL_FROM_ADDRESS: stringValue(),
  EMAIL_FROM_NAME: stringValue(),
  EMAIL_REPLY_TO: stringValue(),
  EMAIL_UNSUBSCRIBE_TEXT: stringValue(),
  COMPANY_POSTAL_ADDRESS: stringValue(),
  EMAIL_DOMAIN_AUTH_VERIFIED: boolValue,
  EMAIL_WARMUP_COMPLETE: boolValue,
  SMTP_HOST: stringValue(),
  SMTP_PORT: intValue(587),
  SMTP_USER: stringValue(),
  SMTP_PASSWORD: stringValue(),
  IMAP_HOST: stringValue(),
  IMAP_PORT: intValue(993),
  IMAP_USER: stringValue(),
  IMAP_PASSWORD: stringValue(),
  EMAIL_DAILY_LIMIT: intValue(50),
  EMAIL_HOURLY_LIMIT: intValue(20),
  EMAIL_MIN_INTERVAL_SECONDS: intValue(120),
  EMAIL_MAX_HARD_BOUNCE_RATE: z
    .string()
    .optional()
    .transform((value) => Number.parseFloat(value ?? "0.03") || 0.03),
  FOLLOWUP_DAYS: stringValue("3,7,14"),
  AUTO_FOLLOWUP_ENABLED: boolValue,
  LEAD_SEND_SCORE_MIN: intValue(90),
  COMPANY_ACTIVITY_MAX_AGE_DAYS: intValue(548),
  SEARCH_PROVIDER: z
    .enum(["auto", "serper", "exa", "searxng", "none"])
    .default("auto"),
  SERPER_API_KEY: stringValue(),
  EXA_API_KEY: stringValue(),
  SEARXNG_BASE_URL: stringValue(),
  ACQ_SEARXNG_V2_ENABLED: boolValue,
  SEARXNG_LOCAL_ENDPOINT_ALLOWED: boolValue,
  SEARXNG_REQUEST_TIMEOUT_MS: intValue(20_000),
  SEARXNG_CACHE_TTL_SECONDS: intValue(3_600),
  ACQ_LOCAL_PUBLIC_WEB_ENABLED: boolValue,
  LOCAL_PUBLIC_WEB_TIMEOUT_MS: intValue(20_000),
  LOCAL_PUBLIC_WEB_CACHE_TTL_SECONDS: intValue(3_600),
  REACHER_BASE_URL: stringValue(),
  HUNTER_API_KEY: stringValue(),
  HUNTER_BASE_URL: stringValue("https://api.hunter.io/v2"),
  HUNTER_MIN_CONFIDENCE: intValue(80),
  ACQ_HUNTER_V2_ENABLED: boolValue,
  HUNTER_REQUEST_TIMEOUT_MS: intValue(20_000),
  HUNTER_CACHE_TTL_SECONDS: intValue(86_400),
  HUNTER_EMAIL_VERIFICATION_COST_UNITS: intValue(1),
  HUNTER_EMAIL_VERIFICATION_COST_MICROS: intValue(0),
  BOUNCER_API_KEY: stringValue(),
  ACQ_BOUNCER_V2_ENABLED: boolValue,
  BOUNCER_REQUEST_TIMEOUT_MS: intValue(20_000),
  BOUNCER_CACHE_TTL_SECONDS: intValue(86_400),
  BOUNCER_EMAIL_VERIFICATION_COST_UNITS: intValue(1),
  BOUNCER_EMAIL_VERIFICATION_COST_MICROS: intValue(0),
  MAX_SEARCH_RESULTS_PER_CAMPAIGN: intValue(500),
  MAX_PAGES_PER_CAMPAIGN: intValue(1_600),
  MAX_LLM_CALLS_PER_JOB: intValue(300),
  MAX_DISCOVERY_CONCURRENCY: intValue(6),
  MAX_SEARCH_CONCURRENCY: intValue(4),
  JOB_WORKER_REALTIME_CONCURRENCY: intValue(2),
  JOB_WORKER_OPERATIONS_CONCURRENCY: intValue(1),
  JOB_WORKER_RESEARCH_CONCURRENCY: intValue(2),
  SEARCH_RETRY_ATTEMPTS: intValue(3),
  SEARCH_RETRY_BASE_DELAY_MS: intValue(1000),
  MAX_DISCOVERY_ROUNDS: intValue(3),
  MAX_COMPANY_PAGES: intValue(8),
  MAX_CONTACTS_PER_COMPANY: intValue(4),
  DISCOVERY_PROGRESS_INTERVAL: intValue(10),
  DAILY_RESEARCH_ENABLED: boolValue,
  DAILY_RESEARCH_HOUR: intValue(9),
  DAILY_RESEARCH_TIMEZONE: stringValue("Asia/Shanghai"),
  DAILY_RESEARCH_MARKETS: stringValue("Malaysia,Vietnam,Philippines,Indonesia,Mexico"),
  DAILY_RESEARCH_TARGET: intValue(15),
  DAILY_OPERATIONS_REPORT_ENABLED: boolValueDefaultTrue,
  DAILY_OPERATIONS_REPORT_HOUR: intValue(20),
  DAILY_OPERATIONS_REPORT_TIMEZONE: stringValue("Asia/Shanghai"),
  MAX_LLM_RESPONSE_TOKENS: intValue(2400),
  MODEL_DAILY_TOKEN_BUDGET: intValue(10_000_000),
  OPENAI_API_KEY: stringValue(),
  OPENAI_BASE_URL: stringValue(),
  OPENAI_MODEL: stringValue(),
  OPENAI_CLASSIFIER_MODEL: stringValue(),
  OPENAI_RESEARCH_MODEL: stringValue(),
  FEISHU_BOT_ENABLED: boolValue,
  FEISHU_APP_ID: stringValue(),
  FEISHU_APP_SECRET: stringValue(),
  FEISHU_ALLOWED_USERS: stringValue(),
  FEISHU_ALLOWED_CHATS: stringValue(),
  FEISHU_TRUSTED_USER_ROLES: stringValue("{}"),
  FEISHU_MESSAGE_REVIEWER_USERS: stringValue(),
  FEISHU_MESSAGE_REVIEW_DESTINATIONS: stringValue(),
  FEISHU_PAIRING_CODE: stringValue(),
  FEISHU_ALERT_OPEN_IDS: stringValue(),
  FEISHU_ALERT_CHAT_ID: stringValue(),
  FEISHU_BITABLE_APP_TOKEN: stringValue(),
  FEISHU_BITABLE_LEADS_TABLE_ID: stringValue(),
  FEISHU_BITABLE_EVENTS_TABLE_ID: stringValue(),
  FEISHU_BITABLE_CONTROL_SYNC_ENABLED: boolValue,
  FEISHU_BITABLE_CAMPAIGN_BRIEFS_TABLE_ID: stringValue(),
  FEISHU_BITABLE_MARKET_ALLOCATIONS_TABLE_ID: stringValue(),
  FEISHU_BITABLE_SALES_TASKS_TABLE_ID: stringValue(),
  FEISHU_BITABLE_COMMERCIAL_REPORT_TABLE_ID: stringValue(),
  WHATSAPP_OUTREACH_ENABLED: boolValue,
  WHATSAPP_BUSINESS_API_ENABLED: boolValue,
  WHATSAPP_GRAPH_API_VERSION: stringValue("v23.0"),
  WHATSAPP_PHONE_NUMBER_ID: stringValue(),
  WHATSAPP_ACCESS_TOKEN: stringValue(),
  WHATSAPP_APP_SECRET: stringValue(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: stringValue(),
  WHATSAPP_TEMPLATE_NAME: stringValue(),
  WHATSAPP_TEMPLATE_LANGUAGE: stringValue("en_US"),
  WHATSAPP_DAILY_LIMIT: intValue(20),
  PUBLIC_BASE_URL: stringValue(),
});

export type AgentConfig = z.infer<typeof schema> & {
  workspaceRoot: string;
  serviceRoot: string;
  businessDataDir: string;
  followupDays: number[];
  allowedFeishuUsers: Set<string>;
  allowedFeishuChats: Set<string>;
  messageReviewerFeishuUsers: Set<string>;
  messageReviewDestinations: Set<string>;
  trustedFeishuUserRoles: ReadonlyMap<string, ReadonlySet<WorkflowRole>>;
  alertOpenIds: string[];
  dailyResearchMarkets: string[];
};

export function hasTrustedFeishuRole(
  config: Pick<AgentConfig, "trustedFeishuUserRoles">,
  role: WorkflowRole,
): boolean {
  return [...config.trustedFeishuUserRoles.values()].some((roles) => roles.has(role));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = schema.parse(env);
  const followupDays = parsed.FOLLOWUP_DAYS.split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  return {
    ...parsed,
    workspaceRoot,
    serviceRoot,
    businessDataDir: path.isAbsolute(parsed.BUSINESS_DATA_DIR)
      ? parsed.BUSINESS_DATA_DIR
      : path.join(workspaceRoot, parsed.BUSINESS_DATA_DIR),
    followupDays,
    allowedFeishuUsers: new Set(
      parsed.FEISHU_ALLOWED_USERS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    allowedFeishuChats: new Set(
      parsed.FEISHU_ALLOWED_CHATS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    messageReviewerFeishuUsers: new Set(
      parsed.FEISHU_MESSAGE_REVIEWER_USERS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    messageReviewDestinations: new Set(
      parsed.FEISHU_MESSAGE_REVIEW_DESTINATIONS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    trustedFeishuUserRoles: parseTrustedFeishuUserRoles(parsed.FEISHU_TRUSTED_USER_ROLES),
    alertOpenIds: parsed.FEISHU_ALERT_OPEN_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    dailyResearchMarkets: parsed.DAILY_RESEARCH_MARKETS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export const config = loadConfig();
