import type { AgentConfig } from "../config.js";

export const GMAIL_PILOT_HOURLY_LIMIT = 20;
export const GMAIL_PILOT_DAILY_LIMIT = 100;
export const GMAIL_PILOT_MIN_INTERVAL_SECONDS = 60;
export const GMAIL_PILOT_MIN_SCORE = 90;

const consumerDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "qq.com",
  "163.com",
  "126.com",
]);

function truthyDatabaseValue(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

export function mailboxDomain(address: string): string {
  return address.trim().toLowerCase().split("@")[1] ?? "";
}

export function isConsumerMailbox(address: string): boolean {
  return consumerDomains.has(mailboxDomain(address));
}

export function isGmailMailbox(address: string): boolean {
  return new Set(["gmail.com", "googlemail.com"]).has(mailboxDomain(address));
}

export function isGmailPilotMode(config: AgentConfig): boolean {
  return config.CONSUMER_EMAIL_PILOT_ENABLED && isGmailMailbox(config.EMAIL_FROM_ADDRESS);
}

export function hasMxVerificationEvidence(contact: Record<string, unknown>): boolean {
  const status = String(contact.email_status ?? "");
  if (status === "VALID") return true;
  const evidence = String(contact.email_risk ?? "");
  return status === "RISKY" && /\bMX\b|Reacher verdict/i.test(evidence);
}

export function emailDraftPolicyBlockers(
  config: AgentConfig,
  lead: Record<string, unknown>,
  contact: Record<string, unknown>,
): string[] {
  const blockers: string[] = [];
  const pilot = isGmailPilotMode(config);
  const emailStatus = String(contact.email_status ?? "UNKNOWN");
  const recipientTier = String(contact.recipient_tier ?? "A");

  if (pilot) {
    if (Number(lead.total_score ?? 0) < GMAIL_PILOT_MIN_SCORE) {
      blockers.push(`Gmail pilot requires a lead score of at least ${GMAIL_PILOT_MIN_SCORE}`);
    }
    if (Number(lead.source_count ?? 0) < 2) {
      blockers.push("Gmail pilot requires at least two independent company sources");
    }
    if (recipientTier === "A") {
      if (!String(contact.name ?? "").trim()) blockers.push("named contact is missing");
      if (!String(contact.title ?? "").trim()) blockers.push("current job title is missing");
      if (!String(contact.employment_verified_at ?? "").trim()) {
        blockers.push("current employment verification is missing");
      }
    }
    if (!String(contact.source_url ?? "").trim()) blockers.push("contact evidence URL is missing");
    if (!new Set(["VALID", "RISKY"]).has(emailStatus)) {
      blockers.push("Gmail pilot requires a VALID or MX-verified RISKY email");
    }
    if (emailStatus === "RISKY" && !hasMxVerificationEvidence(contact)) {
      blockers.push("RISKY email has no stored MX verification evidence");
    }
  } else if (recipientTier === "A" && emailStatus !== "VALID") {
    blockers.push("email status is not VALID");
  } else if (recipientTier === "B" && emailStatus === "INVALID") {
    blockers.push("tier B email is explicitly INVALID");
  }

  if (recipientTier === "C") blockers.push("recipient tier C is not sendable");
  if (recipientTier === "A" && truthyDatabaseValue(contact.role_address)) blockers.push("role-based mailbox is blocked");
  if (recipientTier === "B" && !truthyDatabaseValue(contact.role_address)) {
    blockers.push("tier B recipient is not a company role mailbox");
  }
  if (truthyDatabaseValue(contact.disposable_address)) blockers.push("disposable mailbox is blocked");
  if (recipientTier === "A" && truthyDatabaseValue(contact.catch_all)) blockers.push("catch-all mailbox is blocked");
  return blockers;
}
