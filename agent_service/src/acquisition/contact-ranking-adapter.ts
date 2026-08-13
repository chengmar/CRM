import { getDomain } from "tldts";
import { normalizePublicHttpUrl } from "../http-url.js";
import { normalizeBuyerType } from "./buyer-type.js";
import {
  inferRoleFamily,
  rankSendableContacts,
  type RankedContact,
} from "./contact-ranking.js";
import {
  contactCandidateSchema,
  type BuyerType,
  type ContactCandidate,
  type SeniorityLevel,
} from "./models.js";
import {
  RECIPIENT_TIER_POLICY_VERSION,
  classifyRecipientTier,
  looksLikeNamedPerson,
  type OfficialMailboxEvidence,
  type RecipientTierDecision,
} from "./recipient-tier.js";

export interface StoredContactRow extends Record<string, unknown> {
  id: unknown;
  name: unknown;
  title: unknown;
  email: unknown;
  source_url: unknown;
  employment_verified_at: unknown;
  email_status: unknown;
  role_address: unknown;
  disposable_address: unknown;
  catch_all: unknown;
  recipient_tier: unknown;
  recipient_evidence_url: unknown;
  recipient_evidence_observed_at: unknown;
  recipient_evidence_expires_at: unknown;
  recipient_evidence_hash: unknown;
  recipient_policy_version: unknown;
}

export interface StoredLeadSourceRow extends Record<string, unknown> {
  source_url: unknown;
  source_type: unknown;
  evidence: unknown;
  created_at: unknown;
}

export interface ContactRankingVerification {
  discoveryAssertionId: string;
  verificationAssertionId: string;
  discoverySourceKey: string;
  verifierSourceKey: string;
  independentlyVerified: true;
  confidence: number;
  observedAt: string;
  expiresAt: string;
}

export interface AdaptedStoredContact {
  row: StoredContactRow;
  candidate: ContactCandidate;
  lineage: ContactRankingVerification | null;
  recipient: RecipientTierDecision;
  recipientPolicyCurrent: boolean;
}

export interface RankedStoredContact extends AdaptedStoredContact {
  ranking: RankedContact;
  contactScore: number;
  channelScore: number;
}

export interface RankStoredContactRowsInput {
  contacts: readonly StoredContactRow[];
  sources: readonly StoredLeadSourceRow[];
  accountId: string;
  accountDomain: string;
  buyerType: BuyerType;
  asOf: Date | string;
  verificationFor?: (
    contact: StoredContactRow,
    normalizedEmail: string,
  ) => ContactRankingVerification | null;
  dncMatchFor?: (contact: StoredContactRow, normalizedEmail: string) => boolean;
  excluded?: boolean;
  ownershipConflict?: boolean;
}

const millisecondsPerDay = 86_400_000;

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || String(value ?? "").trim() === "1";
}

function normalizedIso(value: unknown): string | null {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * millisecondsPerDay).toISOString();
}

function registeredDomain(value: string): string {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname).toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function emailStatus(value: unknown): "VALID" | "RISKY" | "UNKNOWN" | "INVALID" {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "VALID" || normalized === "RISKY" || normalized === "INVALID"
    ? normalized
    : "UNKNOWN";
}

function seniority(title: string): SeniorityLevel {
  if (/\b(?:owner|founder|chief|ceo|president|managing director|general manager)\b/i.test(title)) {
    return "OWNER_C_SUITE";
  }
  if (/\b(?:vice president|vp|director|head)\b/i.test(title)) return "VP_DIRECTOR_HEAD";
  if (/\bmanager\b/i.test(title)) return "MANAGER";
  if (/\b(?:engineer|specialist|officer|buyer|coordinator|lead)\b/i.test(title)) return "SPECIALIST";
  return "OTHER";
}

function exactEmailPublication(
  contact: StoredContactRow,
  sources: readonly StoredLeadSourceRow[],
  email: string,
): OfficialMailboxEvidence | null {
  const storedEvidenceUrl = String(contact.recipient_evidence_url ?? "").trim();
  const evidenceUrl = normalizePublicHttpUrl(storedEvidenceUrl);
  if (!evidenceUrl || !email) return null;
  const matching = sources.find((source) =>
    String(source.source_type ?? "").trim().toLocaleLowerCase("en-US") === "official_website" &&
    normalizePublicHttpUrl(String(source.source_url ?? "")) === evidenceUrl &&
    String(source.evidence ?? "").toLocaleLowerCase("en-US").includes(email));
  if (!matching) return null;
  const observedAt = normalizedIso(contact.recipient_evidence_observed_at) ?? normalizedIso(matching.created_at);
  if (!observedAt) return null;
  return {
    sourceUrl: storedEvidenceUrl,
    exactText: String(matching.evidence ?? ""),
    observedAt,
  };
}

function sameNullableValue(left: string | null, right: unknown, normalizeDate = false): boolean {
  const normalizedRight = normalizeDate
    ? normalizedIso(right)
    : String(right ?? "").trim() || null;
  return left === normalizedRight;
}

function storedRecipientPolicyIsCurrent(
  contact: StoredContactRow,
  recipient: RecipientTierDecision,
  publicContactSource: string | null,
): boolean {
  if (String(contact.recipient_policy_version ?? "") !== RECIPIENT_TIER_POLICY_VERSION ||
    String(contact.recipient_tier ?? "") !== recipient.tier) {
    return false;
  }
  if (recipient.tier === "C") return !recipient.sendable;
  if (recipient.tier === "A" && !publicContactSource) return false;
  return recipient.sendable &&
    sameNullableValue(recipient.evidenceUrl, contact.recipient_evidence_url) &&
    sameNullableValue(recipient.evidenceObservedAt, contact.recipient_evidence_observed_at, true) &&
    sameNullableValue(recipient.evidenceExpiresAt, contact.recipient_evidence_expires_at, true) &&
    sameNullableValue(recipient.evidenceHash, contact.recipient_evidence_hash);
}

function confidence(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function candidateDates(input: {
  contact: StoredContactRow;
  lineage: ContactRankingVerification | null;
  recipient: RecipientTierDecision;
  asOf: string;
}): {
  employmentObservedAt: string;
  employmentExpiresAt: string;
  emailObservedAt: string;
  emailExpiresAt: string;
  lastEvidenceAt: string;
  employmentCurrent: boolean;
} {
  const employmentAt = normalizedIso(input.contact.employment_verified_at);
  const rowEvidenceAt = normalizedIso(input.contact.updated_at) ?? normalizedIso(input.contact.created_at) ?? input.asOf;
  const emailObservedAt = normalizedIso(input.lineage?.observedAt) ??
    normalizedIso(input.recipient.evidenceObservedAt) ?? rowEvidenceAt;
  const emailExpiresAt = normalizedIso(input.lineage?.expiresAt) ??
    normalizedIso(input.recipient.evidenceExpiresAt) ?? emailObservedAt;
  const employmentObservedAt = employmentAt ?? rowEvidenceAt;
  const employmentExpiresAt = employmentAt ? addDays(employmentAt, 90) : employmentObservedAt;
  const lastEvidenceAt = new Date(Math.min(Date.parse(employmentObservedAt), Date.parse(emailObservedAt))).toISOString();
  return {
    employmentObservedAt,
    employmentExpiresAt,
    emailObservedAt,
    emailExpiresAt,
    lastEvidenceAt,
    employmentCurrent: employmentAt !== null,
  };
}

export function normalizeContactRankingBuyerType(value: unknown): BuyerType | null {
  return normalizeBuyerType(value);
}

export function adaptStoredContactForRanking(input: {
  contact: StoredContactRow;
  sources: readonly StoredLeadSourceRow[];
  accountId: string;
  accountDomain: string;
  asOf: Date | string;
  lineage?: ContactRankingVerification | null;
  dncMatch?: boolean;
  excluded?: boolean;
  ownershipConflict?: boolean;
}): AdaptedStoredContact | null {
  const asOfDate = input.asOf instanceof Date ? input.asOf : new Date(input.asOf);
  if (!Number.isFinite(asOfDate.getTime())) throw new Error("Contact ranking requires a valid as-of time");
  const asOf = asOfDate.toISOString();
  const id = String(input.contact.id ?? "").trim();
  const email = String(input.contact.email ?? "").trim().toLocaleLowerCase("en-US");
  if (!id || !email) return null;
  const name = String(input.contact.name ?? "").trim() || "Unknown contact";
  const title = String(input.contact.title ?? "").trim() || "Unknown role";
  const storedSourceUrl = String(input.contact.source_url ?? "").trim();
  const publicContactSource = normalizePublicHttpUrl(storedSourceUrl);
  const employmentAt = normalizedIso(input.contact.employment_verified_at);
  const officialPublication = exactEmailPublication(input.contact, input.sources, email);
  const recipient = classifyRecipientTier({
    accountDomain: input.accountDomain,
    email,
    name,
    title,
    employmentVerifiedAt: employmentAt,
    emailStatus: emailStatus(input.contact.email_status),
    roleAddress: booleanValue(input.contact.role_address),
    disposableAddress: booleanValue(input.contact.disposable_address),
    catchAll: booleanValue(input.contact.catch_all),
    officialMailboxEvidence: officialPublication ?? (employmentAt && publicContactSource ? {
      sourceUrl: storedSourceUrl,
      exactText: "",
      observedAt: employmentAt,
    } : null),
    asOf: asOfDate,
  });
  const recipientPolicyCurrent = storedRecipientPolicyIsCurrent(input.contact, recipient, publicContactSource);
  const effectiveTier = recipientPolicyCurrent && recipient.sendable ? recipient.tier : "C";
  const lineage = input.lineage ?? null;
  const dates = candidateDates({ contact: input.contact, lineage, recipient, asOf });
  const accountDomain = registeredDomain(input.accountDomain);
  const addressDomain = registeredDomain(email.split("@").at(-1) ?? "");
  const domainMatchesAccount = Boolean(accountDomain && addressDomain && accountDomain === addressDomain);
  const roleAddress = booleanValue(input.contact.role_address);
  const evidenceAssertionId = recipient.evidenceHash
    ? `recipient-evidence:${recipient.evidenceHash}`
    : `contact-email:${id}`;
  const assertionIds = lineage
    ? [lineage.discoveryAssertionId, lineage.verificationAssertionId]
    : [evidenceAssertionId];
  const emailConfidence = lineage
    ? confidence(lineage.confidence, 0)
    : effectiveTier === "B" ? 1 : 0;
  const candidateResult = contactCandidateSchema.safeParse({
    id,
    accountId: input.accountId,
    name,
    named: !roleAddress && looksLikeNamedPerson(name),
    title,
    roleFamily: inferRoleFamily(title),
    seniority: seniority(title),
    employment: {
      accountId: input.accountId,
      status: dates.employmentCurrent ? "CURRENT" : "UNKNOWN",
      observedAt: dates.employmentObservedAt,
      expiresAt: dates.employmentExpiresAt,
      confidence: dates.employmentCurrent ? 1 : 0,
      assertionIds: [`contact-employment:${id}`],
      conflict: false,
    },
    email: {
      address: email,
      status: emailStatus(input.contact.email_status),
      workEmail: domainMatchesAccount && !booleanValue(input.contact.disposable_address),
      roleAddress,
      disposable: booleanValue(input.contact.disposable_address),
      catchAll: booleanValue(input.contact.catch_all),
      domainMatchesAccount,
      discoverySourceKey: lineage?.discoverySourceKey ?? `contact-source:${id}`,
      verifierSourceKey: lineage?.verifierSourceKey ?? `contact-source:${id}`,
      independentlyVerified: lineage?.independentlyVerified === true,
      observedAt: dates.emailObservedAt,
      expiresAt: dates.emailExpiresAt,
      confidence: emailConfidence,
      assertionIds,
      conflict: false,
      officiallyPublished: effectiveTier === "B" && officialPublication !== null,
      officialSourceUrl: effectiveTier === "B" ? officialPublication?.sourceUrl ?? null : null,
      officialObservedAt: effectiveTier === "B" ? recipient.evidenceObservedAt : null,
      officialEvidenceHash: effectiveTier === "B" ? recipient.evidenceHash : null,
    },
    evidenceConfidence: Math.min(dates.employmentCurrent ? 1 : emailConfidence, emailConfidence),
    lastEvidenceAt: dates.lastEvidenceAt,
    dncMatch: input.dncMatch ?? false,
    excluded: input.excluded ?? false,
    ownershipConflict: input.ownershipConflict ?? false,
    conflicts: [],
    recipientTier: effectiveTier,
  });
  if (!candidateResult.success) return null;
  return {
    row: input.contact,
    candidate: candidateResult.data,
    lineage,
    recipient,
    recipientPolicyCurrent,
  };
}

export function rankStoredContactRows(input: RankStoredContactRowsInput): RankedStoredContact[] {
  const asOf = input.asOf instanceof Date ? input.asOf : new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error("Contact ranking requires a valid as-of time");
  const adapted = input.contacts.flatMap((contact): AdaptedStoredContact[] => {
    const email = String(contact.email ?? "").trim().toLocaleLowerCase("en-US");
    const value = adaptStoredContactForRanking({
      contact,
      sources: input.sources,
      accountId: input.accountId,
      accountDomain: input.accountDomain,
      asOf,
      lineage: input.verificationFor?.(contact, email) ?? null,
      dncMatch: input.dncMatchFor?.(contact, email) ?? false,
      excluded: input.excluded,
      ownershipConflict: input.ownershipConflict,
    });
    return value ? [value] : [];
  });
  const byId = new Map(adapted.map((value) => [value.candidate.id, value]));
  return rankSendableContacts(adapted.map((value) => value.candidate), {
    accountId: input.accountId,
    buyerType: input.buyerType,
    asOf: asOf.toISOString(),
  }).flatMap((ranking): RankedStoredContact[] => {
    const value = byId.get(ranking.contact.id);
    if (!value) return [];
    return [{
      ...value,
      ranking,
      contactScore: 10 + (ranking.dimensions.roleRelevance > 0 ? 5 : 0) +
        (ranking.dimensions.currentFreshEmploymentRank === 2 ? 5 : 0),
      channelScore: ranking.contact.email.status === "VALID"
        ? 5
        : ranking.contact.email.status === "RISKY" ? 2 : 0,
    }];
  });
}
