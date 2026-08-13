import dns from "node:dns/promises";
import type { AgentConfig } from "../config.js";
import type { EmailVerificationStatus } from "../types.js";

const roleLocalParts = new Set([
  "admin",
  "billing",
  "contact",
  "hello",
  "info",
  "inquiry",
  "office",
  "sales",
  "service",
  "support",
  "team",
]);

const disposableDomains = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "yopmail.com",
]);

export interface EmailVerificationResult {
  email: string;
  status: EmailVerificationStatus;
  roleAddress: boolean;
  disposableAddress: boolean;
  catchAll: boolean;
  mxHosts: string[];
  reason: string;
}

function validSyntax(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function verifyWithReacher(baseUrl: string, email: string): Promise<{
  status: EmailVerificationStatus;
  catchAll: boolean;
  roleAddress: boolean;
  disposableAddress: boolean;
  reason: string;
}> {
  const endpoint = new URL("v0/check_email", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to_email: email }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Reacher returned HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const smtp = body.smtp && typeof body.smtp === "object"
    ? body.smtp as Record<string, unknown>
    : {};
  const misc = body.misc && typeof body.misc === "object"
    ? body.misc as Record<string, unknown>
    : {};
  const verdict = String(body.is_reachable ?? body.status ?? "unknown").toLowerCase();
  const flagTrue = (value: unknown): boolean => value === true || String(value).toLowerCase() === "true";
  const catchAll = [body.is_catch_all, body.catch_all, smtp.is_catch_all, smtp.catch_all].some(flagTrue);
  const roleAddress = [body.is_role_account, misc.is_role_account].some(flagTrue);
  const disposableAddress = [body.is_disposable, misc.is_disposable].some(flagTrue);
  const status = verdict === "safe" || verdict === "valid"
    ? "VALID"
    : verdict === "invalid"
      ? "INVALID"
      : verdict === "risky"
        ? "RISKY"
        : "UNKNOWN";
  return {
    status: disposableAddress ? "INVALID" : status,
    catchAll,
    roleAddress,
    disposableAddress,
    reason: `Reacher verdict: ${verdict}`,
  };
}

function dnsFailureStatus(error: unknown): EmailVerificationStatus {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toUpperCase()
    : "";
  return new Set(["ENODATA", "ENOTFOUND", "ENONAME", "ENXDOMAIN"]).has(code)
    ? "INVALID"
    : "UNKNOWN";
}

export async function verifyEmail(
  rawEmail: string,
  config: AgentConfig,
  options: { allowExternalProvider?: boolean } = {},
): Promise<EmailVerificationResult> {
  const email = rawEmail.trim().toLowerCase();
  const [localPart = "", domain = ""] = email.split("@", 2);
  const roleAddress = roleLocalParts.has(localPart);
  const disposableAddress = disposableDomains.has(domain);

  if (!validSyntax(email)) {
    return {
      email,
      status: "INVALID",
      roleAddress,
      disposableAddress,
      catchAll: false,
      mxHosts: [],
      reason: "invalid syntax",
    };
  }
  if (disposableAddress) {
    return {
      email,
      status: "INVALID",
      roleAddress,
      disposableAddress,
      catchAll: false,
      mxHosts: [],
      reason: "disposable email domain",
    };
  }

  let mxHosts: string[] = [];
  try {
    const records = await dns.resolveMx(domain);
    mxHosts = records
      .sort((a, b) => a.priority - b.priority)
      .map((record) => record.exchange.trim().toLowerCase())
      .filter((exchange) => exchange && exchange !== ".");
    if (mxHosts.length === 0) {
      return {
        email,
        status: "INVALID",
        roleAddress,
        disposableAddress,
        catchAll: false,
        mxHosts: [],
        reason: "domain explicitly accepts no email or has no usable MX records",
      };
    }
  } catch (error) {
    const status = dnsFailureStatus(error);
    return {
      email,
      status,
      roleAddress,
      disposableAddress,
      catchAll: false,
      mxHosts: [],
      reason: status === "INVALID"
        ? "domain has no MX records"
        : "MX lookup temporarily unavailable",
    };
  }

  if (options.allowExternalProvider !== false && config.REACHER_BASE_URL) {
    try {
      const result = await verifyWithReacher(config.REACHER_BASE_URL, email);
      return {
        email,
        status: result.catchAll && result.status === "VALID" ? "RISKY" : result.status,
        roleAddress: roleAddress || result.roleAddress,
        disposableAddress: disposableAddress || result.disposableAddress,
        catchAll: result.catchAll,
        mxHosts,
        reason: result.catchAll ? `${result.reason}; catch-all domain` : result.reason,
      };
    } catch (error) {
      return {
        email,
        status: "RISKY",
        roleAddress,
        disposableAddress,
        catchAll: false,
        mxHosts,
        reason: `MX valid; deep verification unavailable: ${String(error)}`,
      };
    }
  }

  return {
    email,
    status: "RISKY",
    roleAddress,
    disposableAddress,
    catchAll: false,
    mxHosts,
    reason: "MX valid; deep mailbox verification not configured",
  };
}
