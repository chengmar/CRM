import crypto from "node:crypto";

export type BounceDiagnosticCategory =
  | "RECIPIENT_INVALID"
  | "RECIPIENT_MAILBOX_UNAVAILABLE"
  | "REMOTE_FORWARDING_INFRASTRUCTURE"
  | "POLICY_REJECTION"
  | "UNCLASSIFIED_HARD_FAILURE";

export interface BounceDiagnostic {
  category: BounceDiagnosticCategory;
  enhancedStatusCode: string | null;
  diagnosticCode: string | null;
  evidenceSha256: string;
  evidenceExcerpt: string;
}

const emailPattern = /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function redactDiagnostic(value: string): string {
  return value
    .replace(emailPattern, (_match, local: string, domain: string) => `${local.slice(0, 1)}***@${domain.toLowerCase()}`)
    .replace(ipPattern, "[ip-redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeBounceDiagnostic(source: string): BounceDiagnostic {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const enhancedStatusCode = normalized.match(/(?:^|\s)([245]\.\d{1,3}\.\d{1,3})(?:\s|$)/m)?.[1] ?? null;
  const diagnosticCode = normalized.match(/Diagnostic-Code:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const lower = normalized.toLowerCase();
  let category: BounceDiagnosticCategory = "UNCLASSIFIED_HARD_FAILURE";

  if (
    enhancedStatusCode?.startsWith("5.1.") ||
    /(?:user|mailbox|recipient|address)\s+(?:unknown|not found|does not exist|invalid)|no such user/i.test(normalized)
  ) {
    category = "RECIPIENT_INVALID";
  } else if (
    enhancedStatusCode?.startsWith("5.2.") ||
    /mailbox (?:full|disabled|unavailable)|over quota/i.test(normalized)
  ) {
    category = "RECIPIENT_MAILBOX_UNAVAILABLE";
  } else if (
    enhancedStatusCode === "5.7.25" &&
    lower.includes("ptr record") &&
    (lower.includes("forward dns") || lower.includes("sending ip"))
  ) {
    category = "REMOTE_FORWARDING_INFRASTRUCTURE";
  } else if (enhancedStatusCode?.startsWith("5.7.") || /policy|blocked|rejected|spam/i.test(normalized)) {
    category = "POLICY_REJECTION";
  }

  return {
    category,
    enhancedStatusCode,
    diagnosticCode,
    evidenceSha256: crypto.createHash("sha256").update(normalized).digest("hex"),
    evidenceExcerpt: redactDiagnostic(normalized).slice(0, 1_500),
  };
}
