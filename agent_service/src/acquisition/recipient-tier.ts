import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { DEMAND_POLICY_VERSION } from "../types.js";
import { QUALIFICATION_POLICY_VERSION } from "./models.js";

export const RECIPIENT_TIER_POLICY_VERSION = "recipient-tier-v1" as const;
export const RECIPIENT_EVIDENCE_TTL_DAYS = 30;

export const recipientTiers = ["A", "B", "C"] as const;
export type RecipientTier = (typeof recipientTiers)[number];

const companyMailboxLocalParts = new Set([
  "admin",
  "billing",
  "business",
  "commercial",
  "contacto",
  "contact",
  "cotizacion",
  "cotizaciones",
  "customerservice",
  "baogia",
  "bisnis",
  "bizdev",
  "enquiries",
  "enquiry",
  "export",
  "exportacion",
  "exportaciones",
  "foreigntrade",
  "hello",
  "info",
  "inquiry",
  "international",
  "intl",
  "kinhdoanh",
  "kontak",
  "lienhe",
  "marketing",
  "negocios",
  "office",
  "overseas",
  "orders",
  "procurement",
  "pemasaran",
  "penjualan",
  "pertanyaan",
  "project",
  "projects",
  "purchasing",
  "quote",
  "quotation",
  "quotations",
  "rfq",
  "sales",
  "service",
  "support",
  "team",
  "trade",
  "venta",
  "ventas",
  "xuatkhau",
  "ekspor",
  "eksport",
  "jualan",
]);

const nonOutreachMailboxLocalParts = new Set([
  "abuse",
  "careers",
  "dpo",
  "hr",
  "jobs",
  "legal",
  "noreply",
  "postmaster",
  "privacy",
  "recruitment",
  "security",
  "webmaster",
]);

const regionalMailboxPrefixes = new Set([
  "business",
  "commercial",
  "contact",
  "contacto",
  "cotizacion",
  "cotizaciones",
  "enquiries",
  "enquiry",
  "export",
  "info",
  "inquiry",
  "kinhdoanh",
  "marketing",
  "pemasaran",
  "penjualan",
  "quote",
  "rfq",
  "sales",
  "venta",
  "ventas",
  "xuatkhau",
]);

const regionalMailboxSuffixes = new Set([
  "apac",
  "asean",
  "asia",
  "en",
  "es",
  "export",
  "global",
  "id",
  "indonesia",
  "international",
  "intl",
  "latam",
  "malaysia",
  "mexico",
  "mx",
  "my",
  "overseas",
  "ph",
  "philippines",
  "team",
  "vi",
  "vietnam",
  "vn",
]);

const nonPersonNames = /^(?:admin|business|commercial|contact|customer service|export|hello|info|inquiry|marketing|office|sales|service|support|team)(?:\s+team)?$/i;

export interface OfficialMailboxEvidence {
  sourceUrl: string;
  exactText: string;
  observedAt: string;
}

export interface RecipientTierInput {
  accountDomain: string;
  email: string | null | undefined;
  name: string;
  title: string;
  employmentVerifiedAt?: string | null;
  emailStatus: "VALID" | "RISKY" | "UNKNOWN" | "INVALID";
  roleAddress: boolean;
  disposableAddress: boolean;
  catchAll: boolean;
  officialMailboxEvidence?: OfficialMailboxEvidence | null;
  asOf?: Date;
}

export interface RecipientTierDecision {
  tier: RecipientTier;
  sendable: boolean;
  policyVersion: typeof RECIPIENT_TIER_POLICY_VERSION;
  evidenceUrl: string | null;
  evidenceObservedAt: string | null;
  evidenceExpiresAt: string | null;
  evidenceHash: string | null;
  blockers: string[];
}

function registeredDomain(value: string): string {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
    return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname).toLowerCase();
  } catch {
    return "";
  }
}

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function emailDomain(value: string): string {
  return value.split("@").at(-1)?.trim().toLowerCase() ?? "";
}

function emailLocalPart(value: string): string {
  return value.split("@", 1)[0]?.trim().toLowerCase() ?? "";
}

function compactMailboxLocalPart(value: string): string {
  return value.replace(/[._-]+/g, "");
}

export function isCompanyRoleMailbox(value: string): boolean {
  const localPart = emailLocalPart(normalizedEmail(value));
  const compact = compactMailboxLocalPart(localPart);
  if (!compact || nonOutreachMailboxLocalParts.has(compact)) return false;
  if (companyMailboxLocalParts.has(compact)) return true;
  const parts = localPart.split(/[._+-]+/).map(compactMailboxLocalPart).filter(Boolean);
  return parts.length === 2 && regionalMailboxPrefixes.has(parts[0]!) && regionalMailboxSuffixes.has(parts[1]!);
}

export function looksLikeNamedPerson(name: string): boolean {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (normalized.length < 2 || nonPersonNames.test(normalized)) return false;
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length >= 1 && tokens.some((token) => token.length >= 2);
}

function validObservedAt(value: string, asOf: Date, maximumAgeDays = RECIPIENT_EVIDENCE_TTL_DAYS): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > asOf.getTime()) return null;
  const ageDays = (asOf.getTime() - time) / 86_400_000;
  if (ageDays < 0 || ageDays > maximumAgeDays) return null;
  return new Date(time).toISOString();
}

function exactTextContainsEmail(text: string, email: string): boolean {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9.!#$%&'*+/=?^_\u0060{|}~-])${escaped}([^a-z0-9.!#$%&'*+/=?^_\u0060{|}~-]|$)`, "i")
    .test(text);
}

function evidenceMaterial(input: {
  tier: "A" | "B";
  email: string;
  sourceUrl: string;
  observedAt: string;
  exactText?: string;
  ttlDays?: number;
}): Pick<RecipientTierDecision, "evidenceUrl" | "evidenceObservedAt" | "evidenceExpiresAt" | "evidenceHash"> {
  const expiresAt = new Date(Date.parse(input.observedAt) + (input.ttlDays ?? RECIPIENT_EVIDENCE_TTL_DAYS) * 86_400_000).toISOString();
  const evidenceHash = createHash("sha256").update(JSON.stringify({
    tier: input.tier,
    email: input.email,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    exactText: input.exactText ?? null,
    policyVersion: RECIPIENT_TIER_POLICY_VERSION,
  })).digest("hex");
  return {
    evidenceUrl: input.sourceUrl,
    evidenceObservedAt: input.observedAt,
    evidenceExpiresAt: expiresAt,
    evidenceHash,
  };
}

function blocked(blockers: string[]): RecipientTierDecision {
  return {
    tier: "C",
    sendable: false,
    policyVersion: RECIPIENT_TIER_POLICY_VERSION,
    evidenceUrl: null,
    evidenceObservedAt: null,
    evidenceExpiresAt: null,
    evidenceHash: null,
    blockers: [...new Set(blockers)].sort(),
  };
}

export function classifyRecipientTier(input: RecipientTierInput): RecipientTierDecision {
  const asOf = input.asOf ?? new Date();
  const email = normalizedEmail(input.email);
  const accountDomain = registeredDomain(input.accountDomain);
  const domainAligned = Boolean(email && accountDomain && registeredDomain(emailDomain(email)) === accountDomain);
  const roleMailbox = input.roleAddress || isCompanyRoleMailbox(email);
  const commonBlockers: string[] = [];
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) commonBlockers.push("RECIPIENT_EMAIL_SYNTAX_INVALID");
  if (!domainAligned) commonBlockers.push("RECIPIENT_EMAIL_DOMAIN_MISMATCH");
  if (input.disposableAddress) commonBlockers.push("RECIPIENT_EMAIL_DISPOSABLE");
  if (input.emailStatus === "INVALID") commonBlockers.push("RECIPIENT_EMAIL_EXPLICITLY_INVALID");
  if (commonBlockers.length > 0) return blocked(commonBlockers);

  const employmentObservedAt = input.employmentVerifiedAt
    ? validObservedAt(input.employmentVerifiedAt, asOf, 90)
    : null;
  if (
    looksLikeNamedPerson(input.name) &&
    input.title.trim().length > 0 &&
    employmentObservedAt &&
    input.emailStatus === "VALID" &&
    !roleMailbox &&
    !input.catchAll
  ) {
    const material = evidenceMaterial({
      tier: "A",
      email,
      sourceUrl: input.officialMailboxEvidence?.sourceUrl ?? "",
      observedAt: employmentObservedAt,
      ttlDays: 90,
    });
    return {
      tier: "A",
      sendable: true,
      policyVersion: RECIPIENT_TIER_POLICY_VERSION,
      ...material,
      blockers: [],
    };
  }

  const evidence = input.officialMailboxEvidence;
  const observedAt = evidence ? validObservedAt(evidence.observedAt, asOf) : null;
  const sourceDomainAligned = evidence ? registeredDomain(evidence.sourceUrl) === accountDomain : false;
  if (
    roleMailbox &&
    evidence &&
    observedAt &&
    sourceDomainAligned &&
    exactTextContainsEmail(evidence.exactText, email)
  ) {
    const material = evidenceMaterial({
      tier: "B",
      email,
      sourceUrl: evidence.sourceUrl,
      observedAt,
      exactText: evidence.exactText,
    });
    return {
      tier: "B",
      sendable: true,
      policyVersion: RECIPIENT_TIER_POLICY_VERSION,
      ...material,
      blockers: [],
    };
  }

  const blockers = [
    ...(roleMailbox ? [] : ["RECIPIENT_NOT_NAMED_OR_COMPANY_MAILBOX"]),
    ...(!evidence ? ["RECIPIENT_OFFICIAL_PUBLICATION_MISSING"] : []),
    ...(evidence && !observedAt ? ["RECIPIENT_OFFICIAL_PUBLICATION_STALE"] : []),
    ...(evidence && !sourceDomainAligned ? ["RECIPIENT_OFFICIAL_PUBLICATION_DOMAIN_MISMATCH"] : []),
    ...(evidence && !exactTextContainsEmail(evidence.exactText, email)
      ? ["RECIPIENT_OFFICIAL_PUBLICATION_EMAIL_NOT_EXACT"]
      : []),
  ];
  return blocked(blockers.length > 0 ? blockers : ["RECIPIENT_TIER_C"]);
}

export function outreachQualificationSatisfied(input: Record<string, unknown>): boolean {
  const directDemand = Boolean(input.demand_evidence_qualified) &&
    String(input.demand_policy_version) === DEMAND_POLICY_VERSION;
  const icpFit = String(input.outreach_qualification_track) === "ICP_FIT" &&
    String(input.outreach_qualification_policy_version) === QUALIFICATION_POLICY_VERSION;
  return directDemand || icpFit;
}
