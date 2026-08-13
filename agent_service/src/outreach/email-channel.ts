import crypto from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";

const CONFIG_FINGERPRINT_KEY = "email_channel_config_fingerprint";
const SELF_TEST_PASSED_KEY = "email_channel_self_test_passed";
const SELF_TEST_PASSED_AT_KEY = "email_channel_self_test_passed_at";

export interface EmailChannelState {
  configured: boolean;
  selfTestPassed: boolean;
  selfTestPassedAt: string | null;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function configFingerprint(config: AgentConfig): string {
  return digest(JSON.stringify({
    fromAddress: config.EMAIL_FROM_ADDRESS.toLowerCase(),
    replyTo: config.EMAIL_REPLY_TO.toLowerCase(),
    smtpHost: config.SMTP_HOST.toLowerCase(),
    smtpPort: config.SMTP_PORT,
    smtpUser: config.SMTP_USER.toLowerCase(),
    smtpPassword: digest(config.SMTP_PASSWORD),
    imapHost: config.IMAP_HOST.toLowerCase(),
    imapPort: config.IMAP_PORT,
    imapUser: config.IMAP_USER.toLowerCase(),
    imapPassword: digest(config.IMAP_PASSWORD),
    domainAuthVerified: config.EMAIL_DOMAIN_AUTH_VERIFIED,
  }));
}

export function ensureEmailChannelState(config: AgentConfig, db: AgentDatabase): EmailChannelState {
  const configured = Boolean(
    config.EMAIL_OUTREACH_ENABLED &&
    config.EMAIL_INBOUND_ENABLED &&
    config.EMAIL_FROM_ADDRESS &&
    config.SMTP_HOST &&
    config.SMTP_USER &&
    config.SMTP_PASSWORD &&
    config.IMAP_HOST &&
    config.IMAP_USER &&
    config.IMAP_PASSWORD,
  );
  if (!configured) return { configured: false, selfTestPassed: false, selfTestPassedAt: null };

  const fingerprint = configFingerprint(config);
  if (db.getSetting(CONFIG_FINGERPRINT_KEY) !== fingerprint) {
    db.setSetting(CONFIG_FINGERPRINT_KEY, fingerprint);
    db.setSetting(SELF_TEST_PASSED_KEY, "false");
    db.setSetting(SELF_TEST_PASSED_AT_KEY, "");
    db.setSetting("outbound_paused", "true");
    db.recordEvent("system", "email_channel", "EMAIL_CHANNEL_CONFIG_CHANGED", "system", {});
  }
  return {
    configured: true,
    selfTestPassed: db.getSetting(SELF_TEST_PASSED_KEY) === "true",
    selfTestPassedAt: db.getSetting(SELF_TEST_PASSED_AT_KEY) || null,
  };
}

export function markEmailChannelSelfTestPassed(
  config: AgentConfig,
  db: AgentDatabase,
  actor: string,
): EmailChannelState {
  ensureEmailChannelState(config, db);
  const now = new Date().toISOString();
  db.setSetting(SELF_TEST_PASSED_KEY, "true");
  db.setSetting(SELF_TEST_PASSED_AT_KEY, now);
  db.recordEvent("system", "email_channel", "EMAIL_CHANNEL_SELF_TEST_PASSED", actor, {});
  return ensureEmailChannelState(config, db);
}

export function markEmailChannelSelfTestFailed(
  config: AgentConfig,
  db: AgentDatabase,
  actor: string,
  error: string,
): EmailChannelState {
  ensureEmailChannelState(config, db);
  db.setSetting(SELF_TEST_PASSED_KEY, "false");
  db.setSetting(SELF_TEST_PASSED_AT_KEY, "");
  db.setSetting("outbound_paused", "true");
  db.recordEvent("system", "email_channel", "EMAIL_CHANNEL_SELF_TEST_FAILED", actor, {
    error: error.slice(0, 1000),
  });
  return ensureEmailChannelState(config, db);
}
