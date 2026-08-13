import crypto from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import { isGmailPilotMode } from "./email-policy.js";

const CONFIG_FINGERPRINT_KEY = "gmail_pilot_config_fingerprint";
const SELF_TEST_PASSED_KEY = "gmail_pilot_self_test_passed";
const SELF_TEST_PASSED_AT_KEY = "gmail_pilot_self_test_passed_at";
const ACTIVATED_KEY = "gmail_pilot_activated";
const ACTIVATED_AT_KEY = "gmail_pilot_activated_at";

export interface GmailPilotState {
  mode: boolean;
  configFingerprint: string;
  selfTestPassed: boolean;
  selfTestPassedAt: string | null;
  activated: boolean;
  activatedAt: string | null;
}

function secretDigest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function gmailPilotConfigFingerprint(config: AgentConfig): string {
  const material = {
    mode: config.AGENT_MODE,
    outboundEnabled: config.OUTBOUND_ENABLED,
    approvalRequired: config.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND && config.OUTREACH_APPROVAL_REQUIRED,
    emailOutreachEnabled: config.EMAIL_OUTREACH_ENABLED,
    emailInboundEnabled: config.EMAIL_INBOUND_ENABLED,
    consumerPilotEnabled: config.CONSUMER_EMAIL_PILOT_ENABLED,
    fromAddress: config.EMAIL_FROM_ADDRESS.toLowerCase(),
    smtpHost: config.SMTP_HOST.toLowerCase(),
    smtpPort: config.SMTP_PORT,
    smtpUser: config.SMTP_USER.toLowerCase(),
    smtpPasswordDigest: secretDigest(config.SMTP_PASSWORD),
    imapHost: config.IMAP_HOST.toLowerCase(),
    imapPort: config.IMAP_PORT,
    imapUser: config.IMAP_USER.toLowerCase(),
    imapPasswordDigest: secretDigest(config.IMAP_PASSWORD),
    dailyLimit: config.EMAIL_DAILY_LIMIT,
    hourlyLimit: config.EMAIL_HOURLY_LIMIT,
    minimumIntervalSeconds: config.EMAIL_MIN_INTERVAL_SECONDS,
    autoFollowupEnabled: config.AUTO_FOLLOWUP_ENABLED,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function ensureGmailPilotState(config: AgentConfig, db: AgentDatabase): GmailPilotState {
  const mode = isGmailPilotMode(config);
  if (!mode) {
    return {
      mode: false,
      configFingerprint: "",
      selfTestPassed: false,
      selfTestPassedAt: null,
      activated: false,
      activatedAt: null,
    };
  }

  const fingerprint = gmailPilotConfigFingerprint(config);
  const storedFingerprint = db.getSetting(CONFIG_FINGERPRINT_KEY);
  if (storedFingerprint !== fingerprint) {
    db.setSetting(CONFIG_FINGERPRINT_KEY, fingerprint);
    db.setSetting(SELF_TEST_PASSED_KEY, "false");
    db.setSetting(SELF_TEST_PASSED_AT_KEY, "");
    db.setSetting(ACTIVATED_KEY, "false");
    db.setSetting(ACTIVATED_AT_KEY, "");
    db.setSetting("outbound_paused", "true");
    db.recordEvent("system", "gmail_pilot", "GMAIL_PILOT_CONFIG_INITIALIZED", "system", {
      changed: storedFingerprint !== null,
    });
  }

  return {
    mode: true,
    configFingerprint: fingerprint,
    selfTestPassed: db.getSetting(SELF_TEST_PASSED_KEY) === "true",
    selfTestPassedAt: db.getSetting(SELF_TEST_PASSED_AT_KEY) || null,
    activated: db.getSetting(ACTIVATED_KEY) === "true",
    activatedAt: db.getSetting(ACTIVATED_AT_KEY) || null,
  };
}

export function markGmailPilotSelfTestPassed(
  config: AgentConfig,
  db: AgentDatabase,
  actor: string,
  providerMessageId: string,
): GmailPilotState {
  ensureGmailPilotState(config, db);
  const now = new Date().toISOString();
  db.setSetting(SELF_TEST_PASSED_KEY, "true");
  db.setSetting(SELF_TEST_PASSED_AT_KEY, now);
  db.recordEvent("system", "gmail_pilot", "GMAIL_PILOT_SELF_TEST_PASSED", actor, {
    providerMessageId,
    sender: config.EMAIL_FROM_ADDRESS,
  });
  return ensureGmailPilotState(config, db);
}

export function markGmailPilotSelfTestFailed(
  config: AgentConfig,
  db: AgentDatabase,
  actor: string,
  error: string,
): GmailPilotState {
  ensureGmailPilotState(config, db);
  db.setSetting(SELF_TEST_PASSED_KEY, "false");
  db.setSetting(SELF_TEST_PASSED_AT_KEY, "");
  db.setSetting(ACTIVATED_KEY, "false");
  db.setSetting(ACTIVATED_AT_KEY, "");
  db.setSetting("outbound_paused", "true");
  db.recordEvent("system", "gmail_pilot", "GMAIL_PILOT_SELF_TEST_FAILED", actor, {
    error: error.slice(0, 1000),
  });
  return ensureGmailPilotState(config, db);
}

export function activateGmailPilot(
  config: AgentConfig,
  db: AgentDatabase,
  actor: string,
): GmailPilotState {
  const state = ensureGmailPilotState(config, db);
  if (!state.mode) throw new Error("当前不是 Gmail 试运行模式。");
  if (!state.selfTestPassed) throw new Error("请先发送“测试 Gmail”并确认自测成功。");
  const now = new Date().toISOString();
  db.setSetting(ACTIVATED_KEY, "true");
  db.setSetting(ACTIVATED_AT_KEY, now);
  db.setSetting("outbound_paused", "false");
  db.recordEvent("system", "gmail_pilot", "GMAIL_PILOT_ACTIVATED", actor, {
    sender: config.EMAIL_FROM_ADDRESS,
  });
  return ensureGmailPilotState(config, db);
}
