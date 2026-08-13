import type { InstallerConfig, SecretName } from "../../shared/contracts.js";

export const CONFIGURED_EMAIL_MIN_INTERVAL_SECONDS = 120;

function encode(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@,+-]*$/.test(text) ? text : JSON.stringify(text);
}

export function buildRemoteEnv(
  config: InstallerConfig,
  secrets: Partial<Record<SecretName, string>>,
): string {
  const gmailPilot = config.email.mode === "gmail_pilot";
  const emailEnabled = config.email.mode !== "disabled";
  const emailPassword = gmailPilot
    ? (secrets.email_password ?? "").replace(/\s+/g, "")
    : secrets.email_password ?? "";
  const values: Record<string, string | number | boolean> = {
    DEPLOYMENT_MODE: "vps",
    AGENT_MODE: "production",
    AGENT_HTTP_HOST: "127.0.0.1",
    AGENT_HTTP_PORT: 18790,
    AGENT_LOG_LEVEL: "info",
    BUSINESS_DATA_DIR: "customer_business_data",
    DEFAULT_PRODUCT: config.product.name,
    DEFAULT_BUYER_TYPE: config.product.buyerTypes.join(", "),
    RESEARCH_USER_AGENT: `${config.business.brandName.replace(/[^A-Za-z0-9_-]/g, "") || "Export"}-Research-Agent/1.0 (+${config.business.website})`,
    OUTBOUND_ENABLED: emailEnabled,
    AUTO_LEADS_TIMEZONE: "Asia/Shanghai",
    OPENAI_API_KEY: secrets.ai_api_key ?? "",
    OPENAI_BASE_URL: config.ai.baseUrl,
    OPENAI_MODEL: config.ai.model,
    OPENAI_CLASSIFIER_MODEL: config.ai.model,
    OPENAI_RESEARCH_MODEL: config.ai.model,
    FEISHU_BOT_ENABLED: config.feishu.enabled,
    FEISHU_APP_ID: config.feishu.appId,
    FEISHU_APP_SECRET: secrets.feishu_app_secret ?? "",
    FEISHU_DOMAIN: config.feishu.domain,
    FEISHU_CONNECTION_MODE: "websocket",
    FEISHU_REQUIRE_MENTION: true,
    FEISHU_GROUP_POLICY: "allowlist",
    FEISHU_PAIRING_CODE: secrets.feishu_pairing_code ?? "",
    EMAIL_OUTREACH_ENABLED: emailEnabled,
    EMAIL_INBOUND_ENABLED: emailEnabled,
    CONSUMER_EMAIL_PILOT_ENABLED: gmailPilot,
    EMAIL_POLL_SECONDS: 60,
    EMAIL_SEND_REQUIRES_CONFIRMATION: true,
    EMAIL_FROM_ADDRESS: config.email.fromAddress,
    EMAIL_FROM_NAME: config.email.fromName,
    EMAIL_REPLY_TO: config.email.replyTo,
    COMPANY_POSTAL_ADDRESS: config.business.postalAddress,
    EMAIL_DOMAIN_AUTH_VERIFIED: config.email.domainAuthVerified,
    EMAIL_WARMUP_COMPLETE: config.email.warmupComplete,
    SMTP_HOST: config.email.smtpHost,
    SMTP_PORT: config.email.smtpPort,
    SMTP_USER: config.email.smtpUser,
    SMTP_PASSWORD: emailPassword,
    IMAP_HOST: config.email.imapHost,
    IMAP_PORT: config.email.imapPort,
    IMAP_USER: config.email.imapUser,
    IMAP_PASSWORD: emailPassword,
    EMAIL_DAILY_LIMIT: config.email.dailyLimit,
    EMAIL_HOURLY_LIMIT: config.email.hourlyLimit,
    EMAIL_MIN_INTERVAL_SECONDS: CONFIGURED_EMAIL_MIN_INTERVAL_SECONDS,
    EMAIL_MAX_HARD_BOUNCE_RATE: 0.03,
    EMAIL_UNSUBSCRIBE_TEXT: config.email.unsubscribeText,
    FOLLOWUP_DAYS: "3,7,14",
    AUTO_FOLLOWUP_ENABLED: emailEnabled && !gmailPilot,
    SEARCH_PROVIDER: config.search.provider,
    SERPER_API_KEY: config.search.provider === "serper" ? secrets.search_api_key ?? "" : "",
    EXA_API_KEY: config.search.provider === "exa" ? secrets.search_api_key ?? "" : "",
    SEARXNG_BASE_URL: config.search.provider === "searxng" ? "http://127.0.0.1:8888" : "",
    MAX_SEARCH_RESULTS_PER_CAMPAIGN: 500,
    MAX_PAGES_PER_CAMPAIGN: 1600,
    MAX_LLM_CALLS_PER_JOB: 300,
    MAX_DISCOVERY_CONCURRENCY: 6,
    MAX_LLM_RESPONSE_TOKENS: 2400,
    MODEL_DAILY_TOKEN_BUDGET: 10000000,
    LEAD_SEND_SCORE_MIN: 90,
    COMPANY_ACTIVITY_MAX_AGE_DAYS: 548,
    WHATSAPP_OUTREACH_ENABLED: false,
    WHATSAPP_BUSINESS_API_ENABLED: config.whatsapp.enabled,
    WHATSAPP_GRAPH_API_VERSION: config.whatsapp.graphApiVersion,
    WHATSAPP_PHONE_NUMBER_ID: config.whatsapp.phoneNumberId,
    WHATSAPP_ACCESS_TOKEN: secrets.whatsapp_access_token ?? "",
    WHATSAPP_APP_SECRET: secrets.whatsapp_app_secret ?? "",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: secrets.whatsapp_verify_token ?? "",
    WHATSAPP_TEMPLATE_NAME: config.whatsapp.templateName,
    WHATSAPP_TEMPLATE_LANGUAGE: config.whatsapp.templateLanguage,
    WHATSAPP_DAILY_LIMIT: config.whatsapp.dailyLimit,
    WHATSAPP_SEND_REQUIRES_CONFIRMATION: true,
    PUBLIC_BASE_URL: config.whatsapp.publicBaseUrl,
    SPREADSHEET_WRITE_REQUIRES_CONFIRMATION: true,
    EXTERNAL_SEND_REQUIRES_CONFIRMATION: true,
    USE_PUBLIC_DATA_ONLY: true,
    REQUIRE_SOURCE_URL_FOR_COMPANY_FACTS: true,
    REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: true,
    OUTREACH_APPROVAL_REQUIRED: true,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join("\n")}\n`;
}
