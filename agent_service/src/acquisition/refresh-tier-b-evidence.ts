import pLimit from "p-limit";
import { getDomain } from "tldts";
import type { AgentDatabase, ContactInput } from "../db.js";
import { normalizePublicHttpUrl } from "../http-url.js";
import type { WebsiteAssessment } from "../types.js";
import { assessWebsite } from "../search/website.js";
import { extractOfficialCompanyMailboxes } from "../search/discovery.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const AUTONOMOUS_POLICY_PREFIX = "campaign-autonomous-pilot-v";

export interface RefreshTierBEvidenceCliOptions {
  confirmed: true;
  campaignIds: string[];
  limit: number;
  concurrency: number;
}

export type TierBEvidenceRefreshErrorCode =
  | "EVIDENCE_URL_INVALID"
  | "EVIDENCE_URL_DOMAIN_MISMATCH"
  | "ROBOTS_DISALLOWED"
  | "WEBSITE_POLICY_REJECTED"
  | "WEBSITE_UNREACHABLE"
  | "WEBSITE_PARKED"
  | "ASSESSMENT_DOMAIN_MISMATCH"
  | "EXACT_EMAIL_NOT_FOUND"
  | "ASSESSMENT_FAILED"
  | "PERSISTENCE_FAILED"
  | "CONTACT_SYNC_REJECTED";

export interface RefreshTierBEvidenceResult extends Record<string, unknown> {
  authorizedCampaignCount: number;
  tierBContactCount: number;
  alreadyExactEvidenceCount: number;
  candidateCount: number;
  selectedCount: number;
  deferredByLimitCount: number;
  attemptedCount: number;
  refreshedCount: number;
  failedCount: number;
  errorCounts: Array<{ code: TierBEvidenceRefreshErrorCode; count: number }>;
}

interface RefreshCandidate {
  contactId: string;
  leadId: string;
  campaignId: string;
  company: string;
  domain: string;
  evidenceUrl: string;
  name: string;
  title: string;
  email: string;
  whatsapp: string | null;
  linkedin: string | null;
  contactSourceUrl: string;
  employmentVerifiedAt: string | null;
  emailStatus: ContactInput["emailStatus"];
  emailRisk: string;
  roleAddress: boolean;
  disposableAddress: boolean;
  catchAll: boolean;
  whatsappOptInAt: string | null;
  verificationNotes: string | null;
}

export interface RefreshTierBEvidenceDependencies {
  assessor?: typeof assessWebsite;
  mailboxExtractor?: typeof extractOfficialCompanyMailboxes;
  now?: () => Date;
}

function positiveInteger(value: string, maximum: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return parsed;
}

export function parseRefreshTierBEvidenceCliArgs(args: readonly string[]): RefreshTierBEvidenceCliOptions {
  let confirmations = 0;
  let limit = DEFAULT_LIMIT;
  let concurrency = DEFAULT_CONCURRENCY;
  const campaignIds: string[] = [];
  for (const argument of args) {
    if (argument === "--confirm-refresh-public-evidence") {
      confirmations += 1;
    } else if (argument.startsWith("--campaign=")) {
      const campaignId = argument.slice("--campaign=".length).trim();
      if (!campaignId || campaignId.length > 200 || /[\u0000-\u001f\u007f]/.test(campaignId)) {
        throw new Error("--campaign requires a valid campaign identifier");
      }
      campaignIds.push(campaignId);
    } else if (argument.startsWith("--limit=")) {
      limit = positiveInteger(argument.slice("--limit=".length), MAX_LIMIT, "--limit");
    } else if (argument.startsWith("--concurrency=")) {
      concurrency = positiveInteger(
        argument.slice("--concurrency=".length),
        MAX_CONCURRENCY,
        "--concurrency",
      );
    } else {
      throw new Error("refresh-tier-b-evidence received an unsupported argument");
    }
  }
  if (confirmations !== 1) {
    throw new Error(
      "refresh-tier-b-evidence requires exactly one --confirm-refresh-public-evidence",
    );
  }
  const uniqueCampaignIds = [...new Set(campaignIds)];
  if (uniqueCampaignIds.length > 100) throw new Error("Too many campaign filters");
  return { confirmed: true, campaignIds: uniqueCampaignIds, limit, concurrency };
}

function registrableDomain(value: string): string {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname)
      .toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function exactTextContainsEmail(text: string, email: string): boolean {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^a-z0-9.!#$%&'*+/=?^_\u0060{|}~-])${escaped}([^a-z0-9.!#$%&'*+/=?^_\u0060{|}~-]|$)`,
    "i",
  ).test(text);
}

function sourceHasExactEvidence(
  db: AgentDatabase,
  candidate: RefreshCandidate,
): boolean {
  const normalizedEvidenceUrl = normalizePublicHttpUrl(candidate.evidenceUrl);
  if (!normalizedEvidenceUrl) return false;
  return db.listLeadSources(candidate.leadId).some((source) =>
    String(source.source_type ?? "").trim().toLocaleLowerCase("en-US") === "official_website" &&
    normalizePublicHttpUrl(String(source.source_url ?? "")) === normalizedEvidenceUrl &&
    exactTextContainsEmail(String(source.evidence ?? ""), candidate.email));
}

function campaignFilter(campaignIds: readonly string[], column: string): {
  sql: string;
  parameters: string[];
} {
  return campaignIds.length === 0
    ? { sql: "", parameters: [] }
    : {
        sql: ` AND ${column} IN (${campaignIds.map(() => "?").join(",")})`,
        parameters: [...campaignIds],
      };
}

function loadCandidates(
  db: AgentDatabase,
  campaignIds: readonly string[],
  now: string,
): { authorizedCampaignCount: number; candidates: RefreshCandidate[] } {
  const authorizationFilter = campaignFilter(campaignIds, "csa.campaign_id");
  const authorizationSql = `
    FROM campaign_send_authorizations csa
    LEFT JOIN campaign_send_authorization_revocations revocation
      ON revocation.campaign_send_authorization_id=csa.id
    WHERE revocation.id IS NULL
      AND csa.external_send_authorized=1
      AND csa.transport='SMTP'
      AND csa.maximum_sequence_index=0
      AND csa.valid_from<=? AND csa.expires_at>?
      AND lower(csa.policy_version) LIKE ?
      ${authorizationFilter.sql}`;
  const authorizationParameters = [
    now,
    now,
    `${AUTONOMOUS_POLICY_PREFIX}%`,
    ...authorizationFilter.parameters,
  ];
  const authorizedCampaignCount = Number((db.db.prepare(
    `SELECT count(DISTINCT csa.campaign_id) AS count ${authorizationSql}`,
  ).get(...authorizationParameters) as { count: number }).count);

  const contactFilter = campaignFilter(campaignIds, "l.campaign_id");
  const rows = db.db.prepare(
    `SELECT c.id AS contact_id, c.lead_id, l.campaign_id, l.company, l.domain,
            c.recipient_evidence_url, c.name, c.title, c.email, c.whatsapp, c.linkedin,
            c.source_url, c.employment_verified_at, c.email_status, c.email_risk,
            c.role_address, c.disposable_address, c.catch_all, c.whatsapp_opt_in_at,
            c.verification_notes
     FROM contacts c
     JOIN leads l ON l.id=c.lead_id
     WHERE c.recipient_tier='B'
       AND trim(coalesce(c.recipient_evidence_url,''))<>''
       AND trim(coalesce(c.email,''))<>''
       AND EXISTS (
         SELECT 1 FROM campaign_send_authorizations csa
         LEFT JOIN campaign_send_authorization_revocations revocation
           ON revocation.campaign_send_authorization_id=csa.id
         WHERE csa.campaign_id=l.campaign_id
           AND revocation.id IS NULL
           AND csa.external_send_authorized=1
           AND csa.transport='SMTP'
           AND csa.maximum_sequence_index=0
           AND csa.valid_from<=? AND csa.expires_at>?
           AND lower(csa.policy_version) LIKE ?
       )
       ${contactFilter.sql}
     ORDER BY l.campaign_id, c.lead_id, c.id`,
  ).all(
    now,
    now,
    `${AUTONOMOUS_POLICY_PREFIX}%`,
    ...contactFilter.parameters,
  ) as Array<Record<string, unknown>>;
  const candidates = rows.map((row): RefreshCandidate => ({
    contactId: String(row.contact_id),
    leadId: String(row.lead_id),
    campaignId: String(row.campaign_id),
    company: String(row.company),
    domain: String(row.domain),
    evidenceUrl: String(row.recipient_evidence_url),
    name: String(row.name),
    title: String(row.title),
    email: String(row.email).trim().toLocaleLowerCase("en-US"),
    whatsapp: row.whatsapp === null ? null : String(row.whatsapp),
    linkedin: row.linkedin === null ? null : String(row.linkedin),
    contactSourceUrl: String(row.source_url ?? ""),
    employmentVerifiedAt: row.employment_verified_at === null
      ? null
      : String(row.employment_verified_at),
    emailStatus: String(row.email_status) as ContactInput["emailStatus"],
    emailRisk: String(row.email_risk ?? ""),
    roleAddress: Boolean(row.role_address),
    disposableAddress: Boolean(row.disposable_address),
    catchAll: Boolean(row.catch_all),
    whatsappOptInAt: row.whatsapp_opt_in_at === null ? null : String(row.whatsapp_opt_in_at),
    verificationNotes: row.verification_notes === null ? null : String(row.verification_notes),
  }));
  return { authorizedCampaignCount, candidates };
}

function unreachableCode(assessment: WebsiteAssessment): TierBEvidenceRefreshErrorCode {
  const signals = assessment.activitySignals.join(" ").toLocaleLowerCase("en-US");
  if (signals.includes("robots.txt disallows")) return "ROBOTS_DISALLOWED";
  if (/(?:unsafe target|address resolution|cross-domain redirect)/.test(signals)) {
    return "WEBSITE_POLICY_REJECTED";
  }
  return "WEBSITE_UNREACHABLE";
}

interface RefreshGroup {
  contacts: RefreshCandidate[];
  missing: RefreshCandidate[];
}

interface RefreshGroupOutcome {
  refreshed: number;
  errors: TierBEvidenceRefreshErrorCode[];
}

function repeatedError(
  code: TierBEvidenceRefreshErrorCode,
  count: number,
): RefreshGroupOutcome {
  return { refreshed: 0, errors: Array.from({ length: count }, () => code) };
}

function syncContact(
  db: AgentDatabase,
  candidate: RefreshCandidate,
  officialMailboxEvidence: ReturnType<AgentDatabase["persistOfficialMailboxEvidence"]>,
): void {
  db.upsertContact({
    leadId: candidate.leadId,
    name: candidate.name,
    title: candidate.title,
    email: candidate.email,
    whatsapp: candidate.whatsapp,
    linkedin: candidate.linkedin,
    sourceUrl: candidate.contactSourceUrl,
    employmentVerifiedAt: candidate.employmentVerifiedAt,
    emailStatus: candidate.emailStatus,
    emailRisk: candidate.emailRisk,
    roleAddress: candidate.roleAddress,
    disposableAddress: candidate.disposableAddress,
    catchAll: candidate.catchAll,
    whatsappOptInAt: candidate.whatsappOptInAt,
    verificationNotes: candidate.verificationNotes,
    officialMailboxEvidence,
  });
  const updated = db.getContact(candidate.contactId);
  if (!updated || String(updated.email).trim().toLocaleLowerCase("en-US") !== candidate.email ||
    String(updated.recipient_tier) !== "B" ||
    String(updated.recipient_evidence_url) !== officialMailboxEvidence.sourceUrl ||
    String(updated.recipient_evidence_observed_at) !== officialMailboxEvidence.observedAt ||
    String(updated.recipient_evidence_hash).length !== 64) {
    throw new Error("CONTACT_SYNC_REJECTED");
  }
}

async function refreshGroup(input: {
  db: AgentDatabase;
  group: RefreshGroup;
  observedAt: string;
  assessor: typeof assessWebsite;
  mailboxExtractor: typeof extractOfficialCompanyMailboxes;
}): Promise<RefreshGroupOutcome> {
  const { db, group } = input;
  const candidate = group.contacts[0];
  if (!candidate) return { refreshed: 0, errors: [] };
  const evidenceUrl = normalizePublicHttpUrl(candidate.evidenceUrl);
  if (!evidenceUrl) return repeatedError("EVIDENCE_URL_INVALID", group.missing.length);
  const accountDomain = registrableDomain(candidate.domain);
  if (!accountDomain || registrableDomain(evidenceUrl) !== accountDomain) {
    return repeatedError("EVIDENCE_URL_DOMAIN_MISMATCH", group.missing.length);
  }

  let assessment: WebsiteAssessment;
  try {
    assessment = await input.assessor(evidenceUrl, undefined, 1);
  } catch {
    return repeatedError("ASSESSMENT_FAILED", group.missing.length);
  }
  if (!assessment.reachable) return repeatedError(unreachableCode(assessment), group.missing.length);
  if (assessment.parked) return repeatedError("WEBSITE_PARKED", group.missing.length);
  if (registrableDomain(assessment.url) !== accountDomain ||
    registrableDomain(assessment.domain) !== accountDomain) {
    return repeatedError("ASSESSMENT_DOMAIN_MISMATCH", group.missing.length);
  }

  const extracted = input.mailboxExtractor({
    candidate: { company: candidate.company, domain: candidate.domain },
    assessment,
    maxContacts: Math.max(100, group.contacts.length),
    observedAt: input.observedAt,
  });
  const extractedByEmail = new Map(extracted.flatMap((mailbox) => {
    const email = mailbox.email?.trim().toLocaleLowerCase("en-US") ?? "";
    const exactText = mailbox.officialMailboxEvidence?.exactText?.trim() ?? "";
    return email && exactText && exactTextContainsEmail(exactText, email)
      ? [[email, exactText] as const]
      : [];
  }));
  const matched = group.missing.filter((item) => extractedByEmail.has(item.email));
  const unmatchedCount = group.missing.length - matched.length;
  if (matched.length === 0) {
    return repeatedError("EXACT_EMAIL_NOT_FOUND", unmatchedCount);
  }

  try {
    db.runInTransaction(() => {
      let persisted: ReturnType<AgentDatabase["persistOfficialMailboxEvidence"]> | null = null;
      for (const item of matched) {
        persisted = db.persistOfficialMailboxEvidence(item.leadId, {
          sourceUrl: evidenceUrl,
          exactText: extractedByEmail.get(item.email)!,
          observedAt: input.observedAt,
        });
      }
      if (!persisted) throw new Error("CONTACT_SYNC_REJECTED");
      for (const item of group.contacts) {
        if (exactTextContainsEmail(persisted.exactText, item.email)) syncContact(db, item, persisted);
      }
    });
  } catch (error) {
    const code = error instanceof Error && error.message === "CONTACT_SYNC_REJECTED"
      ? "CONTACT_SYNC_REJECTED" as const
      : "PERSISTENCE_FAILED" as const;
    return {
      refreshed: 0,
      errors: [
        ...Array.from({ length: matched.length }, () => code),
        ...Array.from({ length: unmatchedCount }, () => "EXACT_EMAIL_NOT_FOUND" as const),
      ],
    };
  }
  return {
    refreshed: matched.length,
    errors: Array.from({ length: unmatchedCount }, () => "EXACT_EMAIL_NOT_FOUND"),
  };
}

export async function refreshTierBEvidence(
  db: AgentDatabase,
  options: RefreshTierBEvidenceCliOptions,
  dependencies: RefreshTierBEvidenceDependencies = {},
): Promise<RefreshTierBEvidenceResult> {
  if (options.confirmed !== true) {
    throw new Error("Public evidence refresh requires explicit confirmation");
  }
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Public evidence refresh time is invalid");
  const loaded = loadCandidates(db, options.campaignIds, now.toISOString());
  const missingEvidence = loaded.candidates.filter((candidate) => !sourceHasExactEvidence(db, candidate));
  const missingIds = new Set(missingEvidence.map((candidate) => candidate.contactId));
  const groups = new Map<string, RefreshGroup>();
  for (const candidate of loaded.candidates) {
    const normalizedUrl = normalizePublicHttpUrl(candidate.evidenceUrl) ?? candidate.evidenceUrl;
    const key = `${candidate.leadId}\u0000${normalizedUrl.toLocaleLowerCase("en-US")}`;
    const group = groups.get(key) ?? { contacts: [], missing: [] };
    group.contacts.push(candidate);
    if (missingIds.has(candidate.contactId)) group.missing.push(candidate);
    groups.set(key, group);
  }
  const refreshGroups = [...groups.values()].filter((group) => group.missing.length > 0);
  const selectedGroups: RefreshGroup[] = [];
  let selectedCount = 0;
  for (const group of refreshGroups) {
    if (selectedCount >= options.limit) break;
    selectedGroups.push(group);
    selectedCount += group.missing.length;
  }
  const limiter = pLimit(options.concurrency);
  const outcomes = await Promise.all(selectedGroups.map((group) => limiter(() => refreshGroup({
    db,
    group,
    observedAt: now.toISOString(),
    assessor: dependencies.assessor ?? assessWebsite,
    mailboxExtractor: dependencies.mailboxExtractor ?? extractOfficialCompanyMailboxes,
  }))));
  const counts = new Map<TierBEvidenceRefreshErrorCode, number>();
  for (const outcome of outcomes) {
    for (const code of outcome.errors) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const failedCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const refreshedCount = outcomes.reduce((sum, outcome) => sum + outcome.refreshed, 0);
  return {
    authorizedCampaignCount: loaded.authorizedCampaignCount,
    tierBContactCount: loaded.candidates.length,
    alreadyExactEvidenceCount: loaded.candidates.length - missingEvidence.length,
    candidateCount: missingEvidence.length,
    selectedCount,
    deferredByLimitCount: missingEvidence.length - selectedCount,
    attemptedCount: selectedCount,
    refreshedCount,
    failedCount,
    errorCounts: [...counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  };
}
