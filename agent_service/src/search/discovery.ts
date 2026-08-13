import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { getDomain } from "tldts";
import { loadBusinessContextStrict, type BusinessContext, type SeedLead } from "../business-context.js";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import { normalizePublicHttpUrl } from "../http-url.js";
import type { AgentLlm } from "../llm.js";
import { logger } from "../logger.js";
import { isGmailPilotMode } from "../outreach/email-policy.js";
import { normalizeBuyerType } from "../acquisition/buyer-type.js";
import { inferRoleFamily } from "../acquisition/contact-ranking.js";
import {
  normalizeContactRankingBuyerType,
  rankStoredContactRows,
  type RankedStoredContact,
  type StoredContactRow,
  type StoredLeadSourceRow,
} from "../acquisition/contact-ranking-adapter.js";
import { isCompanyRoleMailbox, type OfficialMailboxEvidence, type RecipientTier } from "../acquisition/recipient-tier.js";
import { scoreLead } from "../scoring.js";
import type { LeadStatus, SearchResult, WebsiteAssessment } from "../types.js";
import { verifyEmail, type EmailVerificationResult } from "./email-verifier.js";
import { HermesResearchClient } from "./hermes-research.js";
import { createSearchProvider, type SearchProvider } from "./provider.js";
import {
  buildDefaultResearchQueries,
  buildMarketResearchPlan,
  type MarketResearchPlan,
  type ResearchCampaignInput,
} from "./research-plan.js";
import { assessWebsite } from "./website.js";
import {
  StrictLegacyDiscoveryRuntime,
  type LegacyDiscoveryJobType,
  type LegacyDiscoveryRuntimeContract,
  type LegacyDiscoveryRuntimeReport,
} from "./legacy-discovery-runtime.js";
import type {
  CampaignEmailVerifier,
  CampaignEmailVerificationOutcome,
} from "../acquisition/providers/campaign-runtime.js";
import {
  assessDemandEvidence,
  type DemandEvidence,
  type DemandStage,
} from "./demand-evidence.js";

const blockedCandidateDomains = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "pinterest.com",
  "reddit.com",
  "quora.com",
  "google.com",
  "googleusercontent.com",
  "wikipedia.org",
  "yellowpages.com",
  "yellowpages.com.my",
  "yellowpages.com.vn",
  "kompass.com",
  "europages.com",
  "cylex.com",
  "contact.page",
  "infopages.net.my",
  "dnb.com",
  "bloomberg.com",
  "crunchbase.com",
]);

const contactFunctionTokens = new Set([
  "procurement", "purchasing", "sourcing", "supply", "engineering", "engineer",
  "project", "technical", "operations", "operation", "business", "development",
  "buyer", "product", "category", "portfolio", "merchandising", "plant", "factory",
  "production", "maintenance", "reliability", "ehs", "hse", "environment",
  "environmental", "safety", "compliance", "commissioning", "process", "technology", "design",
]);
const contactLevelTokens = new Set([
  "manager", "director", "owner", "founder", "chief", "head", "president", "lead", "engineer",
]);
const executiveTitlePhrases = [
  "managing director",
  "general manager",
  "chief executive officer",
  "chief operating officer",
  "owner",
  "founder",
  "president",
];

export interface DiscoveryCampaign extends ResearchCampaignInput {
  id: string;
}

export interface DiscoveryProgress {
  stage: "PLANNING" | "SEARCHING" | "RESEARCHING" | "ENRICHING" | "COMPLETED";
  message: string;
  round?: number;
  searchResults?: number;
  candidates?: number;
  researched?: number;
  qualified?: number;
  sendReady?: number;
}

export interface DiscoverySummary {
  campaignId: string;
  provider: string;
  orchestrator: string;
  marketSummary: string;
  queries: string[];
  roundsCompleted: number;
  searchResults: number;
  candidateCompanies: number;
  domainsAssessed: number;
  leadsStored: number;
  companyQualified: number;
  contactsFound: number;
  verifiedEmails: number;
  riskyEmails: number;
  enrichmentPending: number;
  eligibleForReview: number;
  rejected: number;
  skipped: number;
  duplicatesSkipped: number;
  rejectionReasons: Record<string, number>;
  llmCallsUsed: number;
  llmCallLimit: number;
  hermesCallsUsed: number;
  errors: Array<{ domain: string; error: string }>;
}

export interface ContactEnrichmentSummary extends Record<string, unknown> {
  campaignId: string;
  pass: number | null;
  attempted: number;
  contactsFound: number;
  verifiedEmails: number;
  riskyEmails: number;
  readyForReview: number;
  stillPending: number;
  nextPass: number | null;
  remainingInPass: number;
  remainingEligible: number;
  nextRunAt: string | null;
  hermesCallsUsed: number;
  errors: Array<{ domain: string; error: string }>;
}

export interface DiscoveryServiceDependencies {
  assessWebsite?: typeof assessWebsite;
  createSearchProvider?: typeof createSearchProvider;
  runtimeContracts?: LegacyDiscoveryRuntimeContract;
}

const DISCOVERY_AUTOMATION_STATUSES: readonly LeadStatus[] = [
  "NEW",
  "VERIFYING",
  "ENRICHING",
  "ENRICHMENT_EXHAUSTED",
  "REJECTED",
];
const ENRICHMENT_AUTOMATION_STATUSES: readonly LeadStatus[] = ["ENRICHING"];

class LeadAutomationGuardLostError extends Error {}

export class LlmCallBudget {
  private used = 0;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(0, limit);
  }

  tryTake(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  get usedCalls(): number {
    return this.used;
  }
}

export interface CampaignPageReservation {
  readonly limit: number;
  finalize(actualPages?: number): void;
}

export class CampaignPageBudget {
  private reservedPages = 0;
  private consumedPages = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Campaign page budget must be a non-negative integer");
    }
  }

  reserve(requestedPages: number): CampaignPageReservation | null {
    if (!Number.isSafeInteger(requestedPages) || requestedPages <= 0) {
      throw new Error("Requested page budget must be a positive integer");
    }
    const available = this.limit - this.consumedPages - this.reservedPages;
    if (available <= 0) return null;
    const limit = Math.min(requestedPages, available);
    this.reservedPages += limit;
    let finalized = false;
    return {
      limit,
      finalize: (actualPages = limit) => {
        if (finalized) return;
        finalized = true;
        this.reservedPages -= limit;
        const consumed = Math.max(1, Math.min(limit, Math.trunc(actualPages)));
        this.consumedPages += consumed;
      },
    };
  }

  snapshot(): { limit: number; consumedPages: number; reservedPages: number; remainingPages: number } {
    return {
      limit: this.limit,
      consumedPages: this.consumedPages,
      reservedPages: this.reservedPages,
      remainingPages: Math.max(0, this.limit - this.consumedPages - this.reservedPages),
    };
  }
}

interface CandidateCompany {
  company: string;
  domain: string;
  website: string;
  results: SearchResult[];
  seed: SeedLead | null;
}

interface CompanyAnalysis {
  companyName: string;
  companyType: string;
  fitScore: number;
  intentScore: number;
  buyingLikelihood: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  demandStage: DemandStage;
  demandEvidence: DemandEvidence[];
  demandEvidenceQualified: boolean;
  demandPolicyVersion: string;
  qualified: boolean;
  matchedProducts: string[];
  purchaseReasons: string[];
  risks: string[];
  recommendedOffer: string;
  researchSummary: string;
  evidence: Array<{ claim: string; sourceUrl: string }>;
}

const BROAD_ICP_PRODUCT_MATCH_MIN = 1;

export interface ContactCandidate {
  name: string;
  title: string;
  email: string | null;
  emailSourceUrl: string | null;
  sourceScopeId: string | null;
  emailScopeId: string | null;
  linkedin: string | null;
  sourceUrl: string;
  evidence: string;
  employmentVerified: boolean;
  recipientTier?: RecipientTier;
  officialMailboxEvidence?: OfficialMailboxEvidence | null;
}

const evidenceStopWords = new Set(["and", "the", "for", "with", "from", "of", "at"]);
const legalSuffixes = new Set([
  "berhad",
  "bhd",
  "company",
  "corporation",
  "corp",
  "inc",
  "limited",
  "ltd",
  "private",
  "pte",
  "sdn",
]);
const contactNameNoiseTokens = new Set([
  ...contactFunctionTokens,
  ...contactLevelTokens,
  ...evidenceStopWords,
  "buyer", "contact", "customer", "email", "employee", "general", "leader",
  "managing", "member", "people", "person", "profile", "staff", "team",
]);

function evidenceTokens(value: string, excluded = evidenceStopWords): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 2 && !excluded.has(token)),
  )];
}

function orderedEvidenceTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsTokenSequence(context: string, phrase: string): boolean {
  const contextTokens = orderedEvidenceTokens(context);
  const phraseTokens = orderedEvidenceTokens(phrase);
  if (phraseTokens.length === 0 || phraseTokens.length > contextTokens.length) return false;
  return contextTokens.some((_, index) =>
    phraseTokens.every((token, offset) => contextTokens[index + offset] === token),
  );
}

function isRelevantContactTitle(title: string): boolean {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  if (inferRoleFamily(normalized) !== "OTHER") return true;
  const tokens = new Set(orderedEvidenceTokens(normalized));
  const hasFunction = [...tokens].some((token) => contactFunctionTokens.has(token));
  const hasLevel = [...tokens].some((token) => contactLevelTokens.has(token));
  return (hasFunction && hasLevel) || executiveTitlePhrases.some((phrase) => containsTokenSequence(normalized, phrase));
}

function isPlausibleContactName(name: string, title: string): boolean {
  const nameTokens = orderedEvidenceTokens(name);
  if (nameTokens.length === 0) return false;
  const titleTokens = new Set(orderedEvidenceTokens(title));
  if (nameTokens.every((token) => titleTokens.has(token))) return false;
  return nameTokens.some((token) => !contactNameNoiseTokens.has(token));
}

export function hasCurrentEmploymentEvidence(input: {
  sourceText: string;
  sourceContexts?: string[];
  sourceUrl: string;
  companyDomain: string;
  companyName: string;
  contactName: string;
  contactTitle: string;
}): boolean {
  const normalizedName = input.contactName.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedName || !isPlausibleContactName(normalizedName, input.contactTitle) ||
    !containsTokenSequence(input.sourceText, normalizedName)) return false;

  const titleTokens = evidenceTokens(input.contactTitle);
  if (titleTokens.length === 0) return false;
  const contexts = (input.sourceContexts?.length
    ? input.sourceContexts
    : input.sourceText.split(/[.!?;|\r\n]+/))
    .map((context) => context.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const employmentContext = contexts.find((context) => {
    return containsTokenSequence(context, normalizedName) &&
      containsTokenSequence(context, input.contactTitle);
  });
  if (!employmentContext) return false;

  let sourceDomain = "";
  try {
    const host = new URL(input.sourceUrl).hostname;
    sourceDomain = getDomain(host, { allowPrivateDomains: true }) ?? host.replace(/^www\./, "");
  } catch {
    return false;
  }
  const companyDomain = getDomain(input.companyDomain, { allowPrivateDomains: true }) ??
    input.companyDomain.replace(/^www\./, "");
  if (sourceDomain.toLowerCase() === companyDomain.toLowerCase()) return true;

  const companyTokens = evidenceTokens(input.companyName, new Set([...evidenceStopWords, ...legalSuffixes]));
  const normalizedTitle = input.contactTitle.toLowerCase().replace(/\s+/g, " ").trim();
  const companyEvidenceText = employmentContext
    .split(normalizedName).join(" ")
    .split(normalizedTitle).join(" ");
  const companyEvidenceTokens = new Set(orderedEvidenceTokens(companyEvidenceText));
  return companyTokens.length > 0 && companyTokens.every((token) => companyEvidenceTokens.has(token));
}

export async function verifyContactEmail(
  contact: ContactCandidate,
  domain: string,
  config: AgentConfig,
  strictVerifier: CampaignEmailVerifier | null = null,
): Promise<{
  verification: EmailVerificationResult | null;
  evidence: string;
  provenance: CampaignEmailVerificationOutcome | null;
}> {
  const email = contact.email ?? null;
  if (!email) {
    return {
      verification: null,
      evidence: contact.evidence,
      provenance: null,
    };
  }
  // Legacy discovery may use local syntax/MX checks only. Paid/deep providers must use
  // their own strict campaign-bound adapters and independent assertion ledger.
  const localVerification = await verifyEmail(email, config, { allowExternalProvider: false });
  if (!strictVerifier || localVerification.status === "INVALID" ||
    !contact.employmentVerified || !contact.emailSourceUrl || !contact.emailScopeId) {
    return {
      verification: localVerification,
      evidence: contact.evidence,
      provenance: null,
    };
  }
  const emailHash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const discoveryEvidenceHash = createHash("sha256").update(JSON.stringify({
    sourceUrl: contact.emailSourceUrl,
    sourceScopeId: contact.emailScopeId,
    emailHash,
  })).digest("hex");
  const discoveryAssertionId = `local-public-email-${discoveryEvidenceHash.slice(0, 40)}`;
  const personRef = `legacy-person-${createHash("sha256").update(JSON.stringify({
    domain: domain.trim().toLowerCase(),
    name: contact.name.trim().toLowerCase(),
  })).digest("hex").slice(0, 40)}`;
  const provenance = await strictVerifier.verify({
    email,
    expectedDomain: domain.trim().toLowerCase().replace(/^www\./, ""),
    personRef,
    discoveryAssertionId,
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    discoverySourceUrl: contact.emailSourceUrl,
    discoveryEvidenceHash,
  });
  if (!provenance) {
    return {
      verification: {
        ...localVerification,
        status: "UNKNOWN",
        reason: `independent official verifier unavailable; ${localVerification.reason}`,
      },
      evidence: contact.evidence,
      provenance: null,
    };
  }
  const verification: EmailVerificationResult = {
    ...localVerification,
    status: provenance.status,
    roleAddress: localVerification.roleAddress || provenance.roleMailbox,
    disposableAddress: localVerification.disposableAddress || provenance.disposable,
    catchAll: localVerification.catchAll || provenance.catchAll,
    reason: provenance.reason,
  };
  const lineage = JSON.stringify({
    discoverySourceKey: provenance.discoverySourceKey,
    verifierSourceKey: provenance.verifierSourceKey,
    independentlyVerified: provenance.independentlyVerified,
    discoveryAssertionId: provenance.discoveryAssertionId,
    verificationAssertionId: provenance.verificationAssertionId,
    providerRunId: provenance.providerRunId,
    emailHash: provenance.emailHash,
    providerMailboxVerdict: provenance.providerMailboxVerdict,
    observedAt: provenance.observedAt,
    expiresAt: provenance.expiresAt,
  });
  return {
    verification,
    evidence: `${contact.evidence}; STRICT_EMAIL_VERIFICATION:${lineage}`,
    provenance,
  };
}

function persistStrictEmailVerification(
  db: AgentDatabase,
  contactId: string,
  campaignId: string,
  versionId: string,
  provenance: CampaignEmailVerificationOutcome | null,
): void {
  if (!provenance) return;
  db.persistIndependentEmailVerification({
    contactId,
    campaignId,
    versionId,
    providerRunId: provenance.providerRunId,
    discoveryAssertionId: provenance.discoveryAssertionId,
    verificationAssertionId: provenance.verificationAssertionId,
    emailHash: provenance.emailHash,
    discoverySourceKey: provenance.discoverySourceKey,
    verifierSourceKey: provenance.verifierSourceKey,
    discoverySourceUrl: provenance.discoverySourceUrl,
    discoveryEvidenceHash: provenance.discoveryEvidenceHash,
    providerMailboxVerdict: provenance.providerMailboxVerdict,
    catchAll: provenance.catchAll,
    disposable: provenance.disposable,
    roleMailbox: provenance.roleMailbox,
    confidence: provenance.confidence,
    rawPayloadHash: provenance.rawPayloadHash,
    observedAt: provenance.observedAt,
    expiresAt: provenance.expiresAt,
    creditUnits: provenance.creditUnits,
    estimatedCostMicros: provenance.estimatedCostMicros,
  });
}

function bestRankedStoredContact(input: {
  db: AgentDatabase;
  leadId: string;
  campaignId: string;
  versionId: string | null;
  accountDomain: string;
  company: string;
  buyerType: string;
  asOf: Date;
}): RankedStoredContact | null {
  const account = input.db.db.prepare(
    "SELECT account_id FROM lead_account_links WHERE lead_id=?",
  ).get(input.leadId) as { account_id: string } | undefined;
  const mappedBuyerType = normalizeContactRankingBuyerType(input.buyerType);
  if (!account?.account_id || !mappedBuyerType) return null;
  const ranked = rankStoredContactRows({
    contacts: input.db.listContactsForLead(input.leadId) as StoredContactRow[],
    sources: input.db.listLeadSources(input.leadId) as StoredLeadSourceRow[],
    accountId: account.account_id,
    accountDomain: input.accountDomain,
    buyerType: mappedBuyerType,
    asOf: input.asOf,
    verificationFor: input.versionId ? (contact, email) => input.db.getIndependentValidEmailVerification({
      contactId: String(contact.id),
      email,
      campaignId: input.campaignId,
      versionId: input.versionId!,
      at: input.asOf.toISOString(),
    }) : undefined,
    dncMatchFor: (_contact, email) => input.db.hasDncMatch([
      { type: "domain", value: input.accountDomain },
      { type: "company", value: input.company },
      { type: "email", value: email },
    ]),
  });
  return ranked.at(0) ?? null;
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : min;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function trustedDemandProductTerms(campaignProduct: string, context: BusinessContext): string[] {
  return unique([
    campaignProduct,
    context.brief.product?.name_en ?? "",
    ...(context.brief.product?.models_or_specs ?? []),
  ].flatMap((value) => value.split(/[,;|/]+/)));
}

function queryText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["query", "search", "searchQuery", "search_query", "text"]) {
    if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
  }
  return "";
}

export function normalizeContactResearchQueries(raw: unknown): string[] {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(record.queries)
      ? record.queries
      : [];
  return unique(values.map(queryText))
    .filter((query) => query.length >= 8 && query.length <= 300 && !query.includes("[object Object]"))
    .slice(0, 12);
}

function normalizeDomain(rawUrl: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    return getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function companyNameFromResult(result: SearchResult, domain: string): string {
  const title = result.title.split(/\s+[|\-–—]\s+/)[0]?.trim();
  if (title && title.length >= 3 && title.length <= 120) return title;
  return domain
    .split(".")[0]
    ?.split(/[-_]/)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ") || domain;
}

function sourceTypeForUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("linkedin.com/")) return "linkedin_public";
  if (/exhibitor|expo|trade.?show|fair/.test(lower)) return "trade_show";
  if (/yellowpages|directory|kompass|europages|cylex/.test(lower)) return "directory";
  if (/tender|procurement|project|bid|quotation/.test(lower)) return "project_signal";
  if (/news|press|event|blog/.test(lower)) return "activity_signal";
  return "search_index";
}

function marketMatches(left: string, right: string): boolean {
  const aliases: Record<string, string> = {
    马来西亚: "malaysia",
    越南: "vietnam",
    菲律宾: "philippines",
    印度尼西亚: "indonesia",
    印尼: "indonesia",
    墨西哥: "mexico",
  };
  const normalize = (value: string) => aliases[value.trim()] ?? value.trim().toLowerCase();
  return normalize(left) === normalize(right);
}

function mergeCandidate(map: Map<string, CandidateCompany>, candidate: CandidateCompany): void {
  if (blockedCandidateDomains.has(candidate.domain)) return;
  const existing = map.get(candidate.domain);
  if (!existing) {
    map.set(candidate.domain, candidate);
    return;
  }
  existing.results = [...existing.results, ...candidate.results].filter(
    (result, index, all) => all.findIndex((item) => item.url === result.url) === index,
  );
  if (!existing.seed && candidate.seed) existing.seed = candidate.seed;
  if (existing.company === existing.domain && candidate.company !== candidate.domain) {
    existing.company = candidate.company;
  }
}

function seedCandidates(context: BusinessContext, campaign: DiscoveryCampaign): CandidateCompany[] {
  return context.seedLeads.flatMap((seed) => {
    if (!marketMatches(seed.country, campaign.market)) return [];
    const domain = normalizeDomain(seed.website);
    const website = normalizePublicHttpUrl(seed.website);
    if (!domain || !website) return [];
    const urls = unique([website, ...seed.sourceUrls]);
    return [{
      company: seed.company,
      domain,
      website,
      seed,
      results: urls.map((url) => ({
        title: seed.company,
        url,
        snippet: `${seed.productMatch} ${seed.notes}`.trim(),
        sourceType: "seed_research",
        sourceDate: null,
        query: "existing verified research seed",
      })),
    }];
  });
}

function deterministicCandidates(results: SearchResult[]): CandidateCompany[] {
  const byDomain = new Map<string, CandidateCompany>();
  for (const result of results) {
    const domain = normalizeDomain(result.url);
    if (!domain || blockedCandidateDomains.has(domain)) continue;
    const website = normalizePublicHttpUrl(result.url);
    if (!website) continue;
    mergeCandidate(byDomain, {
      company: companyNameFromResult(result, domain),
      domain,
      website,
      results: [result],
      seed: null,
    });
  }
  return [...byDomain.values()];
}

async function extractCandidatesFromSearch(
  results: SearchResult[],
  campaign: DiscoveryCampaign,
  llm: AgentLlm,
  config: AgentConfig,
  budget: LlmCallBudget,
): Promise<CandidateCompany[]> {
  if (!llm.isConfigured() || !budget.tryTake() || results.length === 0) return [];
  try {
    const raw = await llm.json<{ candidates?: unknown[] }>(
      "search_result_company_extraction",
      [
        "Extract real B2B companies from public search results, including directory and trade-show entries.",
        "Only return a company when an official company website URL is explicit in the evidence.",
        "Exclude media sites, job boards, marketplaces, consumer stores and directories as candidate websites.",
        "Return JSON only as {candidates:[{company,website,reason,sourceUrls}]}",
      ].join(" "),
      JSON.stringify({
        market: campaign.market,
        product: campaign.product,
        buyer_type: campaign.buyerType,
        results: results.slice(0, 60).map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet,
        })),
      }),
      config.OPENAI_RESEARCH_MODEL || config.OPENAI_MODEL,
    );
    return (raw.candidates ?? []).flatMap((item): CandidateCompany[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const company = String(value.company ?? "").trim();
      const website = normalizePublicHttpUrl(value.website);
      const domain = website ? normalizeDomain(website) : null;
      if (!company || !website || !domain || blockedCandidateDomains.has(domain)) return [];
      const sourceUrls = Array.isArray(value.sourceUrls)
        ? value.sourceUrls.map((url) => normalizePublicHttpUrl(url)).filter((url): url is string => Boolean(url))
        : [];
      const matching = results.filter((result) => sourceUrls.includes(result.url));
      return [{
        company,
        website,
        domain,
        seed: null,
        results: matching.length > 0 ? matching : [{
          title: company,
          url: website,
          snippet: String(value.reason ?? "company extracted from public search evidence"),
          sourceType: "search",
          sourceDate: null,
          query: "company extraction",
        }],
      }];
    });
  } catch {
    return [];
  }
}

function evidenceUrls(assessment: WebsiteAssessment, results: SearchResult[]): Set<string> {
  return new Set(
    [
      assessment.url,
      ...assessment.pages.map((page) => page.url),
      ...results.map((result) => result.url),
    ]
      .map((url) => normalizePublicHttpUrl(url))
      .filter((url): url is string => Boolean(url)),
  );
}

export function prepareLeadForDiscoveryVerification(
  db: AgentDatabase,
  leadId: string,
  currentStatus: LeadStatus | undefined,
): void {
  if (["NEW", "REJECTED", "ENRICHING", "ENRICHMENT_EXHAUSTED"].includes(currentStatus ?? "")) {
    db.transitionLead(leadId, "VERIFYING", "discovery", "deep verification started");
  }
}

function fallbackCompanyAnalysis(
  candidate: CandidateCompany,
  assessment: WebsiteAssessment,
  results: SearchResult[],
  plan: MarketResearchPlan,
  trustedProductTerms: string[],
): CompanyAnalysis {
  const corpus = [
    candidate.company,
    assessment.title,
    assessment.text,
    ...assessment.pages.map((page) => `${page.title} ${page.text}`),
    ...results.map((item) => `${item.title} ${item.snippet}`),
  ].join(" ").toLowerCase();
  const productMatches = plan.productTerms.filter((term) => corpus.includes(term.toLowerCase()));
  const buyerMatches = plan.buyerTerms.filter((term) => corpus.includes(term.toLowerCase()));
  const fitScore = Math.min(30, productMatches.length * 4 + buyerMatches.length * 3);
  const evidence = [
    { claim: `${assessment.title} ${assessment.text}`.trim(), sourceUrl: assessment.url },
    ...assessment.pages.map((page) => ({
      claim: `${page.title} ${page.text}`.trim(),
      sourceUrl: page.url,
    })),
    ...results.map((result) => ({ claim: result.snippet.trim(), sourceUrl: result.url })),
  ].flatMap((item) => {
    const sourceUrl = normalizePublicHttpUrl(item.sourceUrl);
    return sourceUrl && item.claim ? [{ claim: item.claim.slice(0, 1_000), sourceUrl }] : [];
  }).filter((item, index, all) =>
    all.findIndex((candidateEvidence) =>
      candidateEvidence.sourceUrl === item.sourceUrl && candidateEvidence.claim === item.claim) === index)
    .slice(0, 6);
  const demand = assessDemandEvidence({
    results,
    pages: assessment.pages,
    productTerms: unique([...trustedProductTerms, candidate.seed?.productMatch ?? ""]
      .flatMap((value) => value.split(/[,;|/]+/))),
    companyName: candidate.company,
    companyDomain: candidate.domain,
  });
  const intentScore = demand.score;
  const qualified = evidence.length >= 1 &&
    productMatches.length >= BROAD_ICP_PRODUCT_MATCH_MIN;
  return {
    companyName: candidate.company,
    companyType: buyerMatches[0] ?? candidate.seed?.buyerType ?? "B2B company",
    fitScore,
    intentScore,
    buyingLikelihood: demand.buyingLikelihood,
    demandStage: demand.stage,
    demandEvidence: demand.evidence,
    demandEvidenceQualified: demand.demandEvidenceQualified,
    demandPolicyVersion: demand.policyVersion,
    qualified,
    matchedProducts: productMatches.slice(0, 6),
    purchaseReasons: demand.reasons.slice(0, 6),
    risks: qualified ? [] : ["insufficient public evidence of product fit"],
    recommendedOffer: productMatches.slice(0, 3).join(", "),
    researchSummary: qualified
      ? "Public evidence shows relevant product and company fit."
      : "Public evidence is not strong enough to qualify the company.",
    evidence,
  };
}

export async function analyzeCompany(
  candidate: CandidateCompany,
  assessment: WebsiteAssessment,
  results: SearchResult[],
  plan: MarketResearchPlan,
  campaignProduct: string,
  context: BusinessContext,
  llm: AgentLlm,
  config: AgentConfig,
  budget: LlmCallBudget,
): Promise<CompanyAnalysis> {
  const fallback = fallbackCompanyAnalysis(
    candidate,
    assessment,
    results,
    plan,
    trustedDemandProductTerms(campaignProduct, context),
  );
  if (!llm.isConfigured() || !budget.tryTake()) return fallback;
  try {
    const websitePages = assessment.pages
      .slice(0, config.MAX_COMPANY_PAGES)
      .flatMap((page) => {
        const url = normalizePublicHttpUrl(page.url);
        return url
          ? [{
              url,
              title: page.title,
              text: page.text.slice(0, 12_000),
            }]
          : [];
      });
    const publicEvidence = results.slice(0, 24).flatMap((result) => {
      const url = normalizePublicHttpUrl(result.url);
      return url
        ? [{
            title: result.title,
            url,
            snippet: result.snippet,
            sourceDate: result.sourceDate,
          }]
        : [];
    });
    const raw = await llm.json<Record<string, unknown>>(
      "company_due_diligence",
      [
        "Act as a senior industrial B2B market and buyer analyst.",
        "Assess company fit and company type using only supplied evidence.",
        "Do not assign buying-intent scores or buying likelihood; deterministic code evaluates dated demand evidence.",
        "A direct manufacturer of the same finished equipment is not a qualified buyer unless evidence shows importing, distribution, OEM sourcing, component demand or an active complementary project.",
        "Use internal case patterns only to identify analogous applications; never cite private cases or unsupported performance numbers.",
        "Every evidence item must use one of the supplied source URLs.",
        "Return JSON only with companyName, companyType, fitScore(0-30), matchedProducts, risks, recommendedOffer, researchSummary, evidence[{claim,sourceUrl}].",
      ].join(" "),
      JSON.stringify({
        campaign: { market: plan.market, product: candidate.seed?.productMatch || plan.productTerms, buyerTypes: plan.buyerTerms },
        seller: context.brief,
        internal_case_patterns: context.casePatterns,
        candidate: { company: candidate.company, website: candidate.website, seed: candidate.seed },
        website_pages: websitePages,
        public_evidence: publicEvidence,
      }),
      config.OPENAI_RESEARCH_MODEL || config.OPENAI_MODEL,
    );
    const allowedUrls = new Set([
      ...websitePages.map((page) => page.url),
      ...publicEvidence.map((result) => result.url),
    ]);
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.flatMap((item): Array<{ claim: string; sourceUrl: string }> => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const sourceUrl = normalizePublicHttpUrl(value.sourceUrl);
          const claim = String(value.claim ?? "").trim();
          return sourceUrl && claim && allowedUrls.has(sourceUrl) ? [{ claim, sourceUrl }] : [];
        })
      : [];
    const fitScore = clamp(raw.fitScore, 0, 30);
    const intentScore = fallback.intentScore;
    const matchedProducts = Array.isArray(raw.matchedProducts)
      ? raw.matchedProducts.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 8)
      : fallback.matchedProducts;
    const qualified = evidence.length >= 1 &&
      matchedProducts.length >= BROAD_ICP_PRODUCT_MATCH_MIN;
    return {
      companyName: String(raw.companyName ?? candidate.company).trim() || candidate.company,
      companyType: String(raw.companyType ?? fallback.companyType).trim(),
      fitScore,
      intentScore,
      buyingLikelihood: fallback.buyingLikelihood,
      demandStage: fallback.demandStage,
      demandEvidence: fallback.demandEvidence,
      demandEvidenceQualified: fallback.demandEvidenceQualified,
      demandPolicyVersion: fallback.demandPolicyVersion,
      qualified,
      matchedProducts,
      purchaseReasons: fallback.purchaseReasons,
      risks: Array.isArray(raw.risks) ? raw.risks.map(String).slice(0, 8) : [],
      recommendedOffer: String(raw.recommendedOffer ?? "").trim(),
      researchSummary: String(raw.researchSummary ?? fallback.researchSummary).trim(),
      evidence: evidence.length > 0 ? evidence : fallback.evidence,
    };
  } catch {
    return fallback;
  }
}

async function searchEvidence(
  provider: SearchProvider,
  queries: string[],
  limit: number,
  concurrency: number,
): Promise<SearchResult[]> {
  const limiter = pLimit(Math.max(1, concurrency));
  const outcomes = await Promise.all(
    queries.map((query) => limiter(async () => {
      try {
        return { results: await provider.search(query, limit), error: null };
      } catch (error) {
        logger.warn({ error, query, provider: provider.name }, "Search query failed after provider retries");
        return { results: [] as SearchResult[], error };
      }
    })),
  );
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.error && outcome.results.length === 0)) {
    throw new Error(`All ${outcomes.length} ${provider.name} search queries failed after retries`);
  }
  return outcomes.flatMap((outcome) => outcome.results).filter(
    (result, index, all) => all.findIndex((item) => item.url === result.url) === index,
  );
}

async function researchCompanyEvidence(
  provider: SearchProvider,
  candidate: CandidateCompany,
  plan: MarketResearchPlan,
  config: AgentConfig,
): Promise<SearchResult[]> {
  const product = plan.productTerms.slice(0, 4).join(" OR ");
  const queries = [
    `"${candidate.company}" ${product}`,
    `"${candidate.company}" project OR installation OR distributor OR importer`,
    `"${candidate.company}" news OR exhibition OR expansion OR tender`,
    `site:${candidate.domain} product OR solution OR project OR news`,
  ];
  return searchEvidence(provider, queries, 10, config.MAX_SEARCH_CONCURRENCY);
}

async function researchContactEvidence(
  provider: SearchProvider,
  candidate: CandidateCompany,
  config: AgentConfig,
  additionalQueries: string[] = [],
): Promise<SearchResult[]> {
  const queries = [
    `"${candidate.company}" procurement OR purchasing OR sourcing OR engineering`,
    `"${candidate.company}" product OR category OR portfolio OR EHS OR safety`,
    `"${candidate.company}" plant OR production OR maintenance OR reliability`,
    `"${candidate.company}" "managing director" OR owner OR founder OR "general manager"`,
    `site:linkedin.com/in "${candidate.company}" procurement OR purchasing OR engineering OR director`,
    `site:${candidate.domain} team OR management OR director OR contact`,
    `"${candidate.company}" "@${candidate.domain}" email`,
    ...additionalQueries,
  ];
  return searchEvidence(provider, queries, 10, config.MAX_SEARCH_CONCURRENCY);
}

async function buildHermesContactQueries(
  candidate: CandidateCompany,
  analysis: CompanyAnalysis,
  plan: MarketResearchPlan,
  hermes: HermesResearchClient,
): Promise<{ queries: string[]; calls: number }> {
  if (!hermes.isEnabled()) return { queries: [], calls: 0 };
  try {
    const raw = await hermes.json<unknown>(
      ["customer-discovery-pro", "export-customer-research"],
      [
        "Act as a public-source B2B decision-maker research planner.",
        "Generate targeted web-search queries only; do not invent or return contacts.",
        "Cover current procurement, sourcing, product, category, engineering, project, plant operations, production, EHS, safety, maintenance, reliability, managing director, owner or founder roles, LinkedIn public pages, company PDFs, conference pages and exact-domain email evidence.",
        "Use local market terms where useful. Every query must be a plain string.",
        "Return JSON only as {queries:[string]}. Do not send messages or access private accounts.",
        JSON.stringify({
          market: plan.market,
          company: analysis.companyName || candidate.company,
          domain: candidate.domain,
          companyType: analysis.companyType,
          matchedProducts: analysis.matchedProducts,
          buyingLikelihood: analysis.buyingLikelihood,
        }),
      ].join("\n"),
    );
    return { queries: normalizeContactResearchQueries(raw), calls: 1 };
  } catch (error) {
    logger.warn({ error, domain: candidate.domain }, "Hermes contact research planning failed");
    return { queries: [], calls: 0 };
  }
}

function evidenceForUrl(
  sourceUrl: string,
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
): string {
  return [
    ...assessment.pages
      .filter((page) => normalizePublicHttpUrl(page.url) === sourceUrl)
      .map((page) => `${page.title} ${page.text} ${(page.emails ?? []).join(" ")}`),
    ...evidenceResults
      .filter((item) => normalizePublicHttpUrl(item.url) === sourceUrl)
      .map((item) => `${item.title} ${item.snippet}`),
  ].join(" ");
}

function contactContextsForUrl(
  sourceUrl: string,
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
): string[] {
  return [
    ...assessment.pages
      .filter((page) => normalizePublicHttpUrl(page.url) === sourceUrl)
      .flatMap((page) => page.contactContexts ?? []),
    ...evidenceResults
      .filter((item) => normalizePublicHttpUrl(item.url) === sourceUrl)
      .map((item) => `${item.title} ${item.snippet}`),
  ];
}

function pageForUrl(
  sourceUrl: string,
  assessment: WebsiteAssessment,
): WebsiteAssessment["pages"][number] | null {
  return assessment.pages.find((page) => normalizePublicHttpUrl(page.url) === sourceUrl) ?? null;
}

export const CONTACT_RESEARCH_PROMPT_MAX_BYTES = 96_000;
const CONTACT_RESEARCH_WEBSITE_MAX_BYTES = 64_000;

function compactPromptField(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function promptUrl(value: unknown): string | null {
  return normalizePublicHttpUrl(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function buildBoundedContactResearchEvidence(
  candidate: { company: string; website: string },
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
  maxBytes: number,
): { user: string; assessment: WebsiteAssessment; evidenceResults: SearchResult[] } {
  const websitePages: Array<Record<string, unknown>> = [];
  const publicEvidence: Array<Record<string, string>> = [];
  const selectedPages: WebsiteAssessment["pages"] = [];
  const selectedEvidenceResults: SearchResult[] = [];
  const payload = {
    company: compactPromptField(candidate.company, 500),
    website: promptUrl(candidate.website) ?? "",
    website_pages: websitePages,
    public_evidence: publicEvidence,
  };
  if (jsonBytes(payload) > maxBytes) throw new Error("Contact research prompt budget is too small");

  for (const page of assessment.pages.slice(0, 12)) {
    const url = promptUrl(page.url);
    if (!url) continue;
    const evidenceScopes = (page.evidenceScopes ?? []).slice(0, 12).map((scope) => ({
      id: compactPromptField(scope.id, 100),
      text: compactPromptField(scope.text, 800),
      ambiguous: Boolean(scope.ambiguous),
      emails: scope.emails.slice(0, 4).map((item) => ({
        email: compactPromptField(item.email, 320),
        method: item.method,
      })),
    }));
    const pageInput = {
      url,
      title: compactPromptField(page.title, 300),
      text: compactPromptField(page.text, 6_000),
      evidenceScopes,
    };
    const candidatePayload = { ...payload, website_pages: [...websitePages, pageInput] };
    if (jsonBytes(candidatePayload) > Math.min(CONTACT_RESEARCH_WEBSITE_MAX_BYTES, maxBytes)) continue;
    websitePages.push(pageInput);
    selectedPages.push({
      url,
      title: pageInput.title,
      text: pageInput.text,
      emails: unique(evidenceScopes.flatMap((scope) => scope.emails.map((item) => item.email))),
      emailEvidence: evidenceScopes.flatMap((scope) => scope.emails.map((item) => ({
        email: item.email,
        context: scope.text,
        method: item.method,
        scopeId: scope.id,
      }))),
      contactContexts: evidenceScopes.filter((scope) => !scope.ambiguous).map((scope) => scope.text),
      evidenceScopes,
    });
  }

  for (const result of evidenceResults.slice(0, 30)) {
    const url = promptUrl(result.url);
    if (!url) continue;
    const item = {
      title: compactPromptField(result.title, 300),
      url,
      snippet: compactPromptField(result.snippet, 1_200),
    };
    const candidatePayload = { ...payload, public_evidence: [...publicEvidence, item] };
    if (jsonBytes(candidatePayload) > maxBytes) continue;
    publicEvidence.push(item);
    selectedEvidenceResults.push({
      ...result,
      title: item.title,
      url: item.url,
      snippet: item.snippet,
    });
  }

  return {
    user: JSON.stringify(payload),
    assessment: {
      ...assessment,
      pages: selectedPages,
      text: selectedPages.map((page) => page.text).join(" \n").slice(0, 300_000),
      emails: unique(selectedPages.flatMap((page) => page.emails ?? [])),
    },
    evidenceResults: selectedEvidenceResults,
  };
}

export function buildContactResearchPrompt(
  candidate: { company: string; website: string },
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
  maxContacts: number,
): {
  system: string;
  user: string;
  assessment: WebsiteAssessment;
  evidenceResults: SearchResult[];
} {
  const system = [
    `Find up to ${Math.max(0, Math.trunc(maxContacts))} explicitly evidenced current decision makers.`,
    "Prefer procurement, sourcing, product, category, engineering, project, plant operations, production, EHS, safety, maintenance, reliability, managing director, owner or founder roles.",
    "Never invent a person or email. Search snippets may discover a person but can never support an email.",
    "For an official website contact, cite one non-ambiguous evidence scope as sourceScopeId. Return an email only when the same scope contains the exact address; set emailSourceUrl to that page and emailScopeId equal to sourceScopeId.",
    "employmentVerified may be true only when the cited evidence directly links the exact person name, complete current title and company.",
    "Return JSON only as {contacts:[{name,title,email,emailSourceUrl,sourceScopeId,emailScopeId,linkedin,sourceUrl,evidence,employmentVerified}]}",
  ].join(" ");
  const userBudget = CONTACT_RESEARCH_PROMPT_MAX_BYTES - Buffer.byteLength(system, "utf8");
  return {
    system,
    ...buildBoundedContactResearchEvidence(candidate, assessment, evidenceResults, userBudget),
  };
}

function sameRegistrantDomain(email: string, companyDomain: string): boolean {
  const emailDomain = email.split("@").at(-1)?.trim().toLowerCase() ?? "";
  if (!emailDomain) return false;
  const normalizedEmailDomain = getDomain(emailDomain, { allowPrivateDomains: true }) ??
    emailDomain.replace(/^www\./, "");
  const normalizedCompanyDomain = getDomain(companyDomain, { allowPrivateDomains: true }) ??
    companyDomain.toLowerCase().replace(/^www\./, "");
  return normalizedEmailDomain.toLowerCase() === normalizedCompanyDomain.toLowerCase();
}

function evidencedLinkedInProfile(
  value: unknown,
  allowedUrls: Set<string>,
  contactName: string,
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
): string | null {
  const normalized = normalizePublicHttpUrl(value);
  if (!normalized || !allowedUrls.has(normalized)) return null;
  const url = new URL(normalized);
  const domain = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  const profileEvidence = evidenceForUrl(normalized, assessment, evidenceResults);
  return domain.toLowerCase() === "linkedin.com" && /^\/(?:in|pub)\//i.test(url.pathname) &&
    containsTokenSequence(profileEvidence, contactName)
    ? normalized
    : null;
}

export function normalizeEvidencedContacts(input: {
  rawContacts: unknown[];
  candidate: Pick<CandidateCompany, "company" | "domain">;
  assessment: WebsiteAssessment;
  evidenceResults: SearchResult[];
  maxContacts: number;
}): ContactCandidate[] {
  const allowedUrls = evidenceUrls(input.assessment, input.evidenceResults);
  return input.rawContacts.flatMap((item): ContactCandidate[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const name = String(value.name ?? "").trim();
    const title = String(value.title ?? "").trim();
    const sourceUrl = normalizePublicHttpUrl(value.sourceUrl);
    if (!name || !title || !sourceUrl || !allowedUrls.has(sourceUrl) || !isRelevantContactTitle(title)) return [];

    const sourcePage = pageForUrl(sourceUrl, input.assessment);
    const sourceScopeId = String(value.sourceScopeId ?? "").trim() || null;
    const sourceScope = sourceScopeId
      ? sourcePage?.evidenceScopes?.find((scope) => scope.id === sourceScopeId) ?? null
      : null;
    const pageRequiresScope = Boolean(sourcePage?.evidenceScopes?.length);
    const validSourceScope = Boolean(sourceScope && !sourceScope.ambiguous);
    const sourceText = validSourceScope
      ? sourceScope!.text
      : evidenceForUrl(sourceUrl, input.assessment, input.evidenceResults);
    const sourceContexts = validSourceScope
      ? [sourceScope!.text]
      : pageRequiresScope
        ? []
        : contactContextsForUrl(sourceUrl, input.assessment, input.evidenceResults);
    const employmentVerified = value.employmentVerified === true && hasCurrentEmploymentEvidence({
      sourceText,
      sourceContexts,
      sourceUrl,
      companyDomain: input.candidate.domain,
      companyName: input.candidate.company,
      contactName: name,
      contactTitle: title,
    }) && (!pageRequiresScope || validSourceScope);
    if (!containsTokenSequence(sourceText, name)) return [];

    const rawEmail = String(value.email ?? "").trim().toLowerCase();
    const requestedEmailSourceUrl = normalizePublicHttpUrl(value.emailSourceUrl ?? sourceUrl);
    const emailScopeId = String(value.emailScopeId ?? sourceScopeId ?? "").trim() || null;
    const emailPage = requestedEmailSourceUrl ? pageForUrl(requestedEmailSourceUrl, input.assessment) : null;
    const emailScope = emailScopeId
      ? emailPage?.evidenceScopes?.find((scope) => scope.id === emailScopeId) ?? null
      : null;
    const sameEvidenceScope = Boolean(
      sourceScopeId && emailScopeId && sourceScopeId === emailScopeId &&
      requestedEmailSourceUrl === sourceUrl,
    );
    const selectedEmailEvidence = emailScope?.emails.find((item) => item.email === rawEmail) ?? null;
    const email = rawEmail && employmentVerified && sameEvidenceScope && emailScope && !emailScope.ambiguous &&
      selectedEmailEvidence && sameRegistrantDomain(rawEmail, input.candidate.domain)
      ? rawEmail
      : null;
    const emailSourceUrl = email ? requestedEmailSourceUrl : null;
    const evidence = [
      String(value.evidence ?? "").trim(),
      emailSourceUrl
        ? `Public email evidence (${selectedEmailEvidence?.method ?? "public_text"}; scope ${emailScopeId}): ${emailSourceUrl}`
        : "",
    ].filter(Boolean).join("; ");

    return [{
      name,
      title,
      email,
      emailSourceUrl,
      sourceScopeId: validSourceScope ? sourceScopeId : null,
      emailScopeId: email ? emailScopeId : null,
      linkedin: evidencedLinkedInProfile(
        value.linkedin,
        allowedUrls,
        name,
        input.assessment,
        input.evidenceResults,
      ),
      sourceUrl,
      evidence,
      employmentVerified,
      recipientTier: "A",
      officialMailboxEvidence: null,
    }];
  }).slice(0, Math.max(0, input.maxContacts));
}

export function extractOfficialCompanyMailboxes(input: {
  candidate: Pick<CandidateCompany, "company" | "domain">;
  assessment: WebsiteAssessment;
  maxContacts: number;
  observedAt?: string;
}): ContactCandidate[] {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const values = new Map<string, ContactCandidate>();
  for (const page of input.assessment.pages) {
    const sourceUrl = normalizePublicHttpUrl(page.url);
    if (!sourceUrl || normalizeDomain(sourceUrl) !== normalizeDomain(input.candidate.domain)) continue;
    for (const scope of page.evidenceScopes ?? []) {
      if (scope.ambiguous) continue;
      for (const item of scope.emails) {
        const email = item.email.trim().toLowerCase();
        if (!sameRegistrantDomain(email, input.candidate.domain) || !isCompanyRoleMailbox(email)) continue;
        if (values.has(email)) continue;
        const exactPublication = `${scope.text}\nPublished address (${item.method}): ${email}`.trim();
        const evidence: OfficialMailboxEvidence = {
          sourceUrl,
          exactText: exactPublication,
          observedAt,
        };
        values.set(email, {
          name: `${input.candidate.company} team`,
          title: "Company mailbox",
          email,
          emailSourceUrl: sourceUrl,
          sourceScopeId: scope.id,
          emailScopeId: scope.id,
          linkedin: null,
          sourceUrl,
          evidence: `Official company mailbox publication (${item.method}; scope ${scope.id}): ${sourceUrl}`,
          employmentVerified: false,
          recipientTier: "B",
          officialMailboxEvidence: evidence,
        });
      }
    }
  }
  return [...values.values()].slice(0, Math.max(0, input.maxContacts));
}

export function mergeContactCandidatesForInventory(input: {
  people: readonly ContactCandidate[];
  companyMailboxes: readonly ContactCandidate[];
  maxContacts: number;
}): ContactCandidate[] {
  const limit = Math.max(0, Math.trunc(input.maxContacts));
  if (limit === 0) return [];
  const selected: ContactCandidate[] = [];
  const seenEmails = new Set<string>();
  const seenIdentities = new Set<string>();
  const peopleWithEmail = input.people.filter((item) => item.email);
  const peopleWithoutEmail = input.people.filter((item) => !item.email);
  for (const candidate of [...input.companyMailboxes, ...peopleWithEmail, ...peopleWithoutEmail]) {
    const emailKey = candidate.email?.trim().toLowerCase() ?? null;
    const identityKey = [candidate.name, candidate.title, candidate.sourceUrl]
      .map((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
      .join("|");
    if ((emailKey && seenEmails.has(emailKey)) || (!emailKey && seenIdentities.has(identityKey))) continue;
    if (emailKey) seenEmails.add(emailKey);
    seenIdentities.add(identityKey);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function extractContacts(
  candidate: CandidateCompany,
  assessment: WebsiteAssessment,
  evidenceResults: SearchResult[],
  llm: AgentLlm,
  config: AgentConfig,
  budget: LlmCallBudget,
): Promise<ContactCandidate[]> {
  const companyMailboxes = extractOfficialCompanyMailboxes({
    candidate,
    assessment,
    maxContacts: config.MAX_CONTACTS_PER_COMPANY,
  });
  if (!llm.isConfigured() || !budget.tryTake()) return companyMailboxes;
  try {
    const prompt = buildContactResearchPrompt(
      candidate,
      assessment,
      evidenceResults,
      config.MAX_CONTACTS_PER_COMPANY,
    );
    const result = await llm.json<{ contacts?: unknown[] }>(
      "decision_maker_enrichment",
      prompt.system,
      prompt.user,
      config.OPENAI_RESEARCH_MODEL || config.OPENAI_MODEL,
    );
    const people = normalizeEvidencedContacts({
      rawContacts: result.contacts ?? [],
      candidate,
      assessment: prompt.assessment,
      evidenceResults: prompt.evidenceResults,
      maxContacts: config.MAX_CONTACTS_PER_COMPANY,
    });
    return mergeContactCandidatesForInventory({
      people,
      companyMailboxes,
      maxContacts: config.MAX_CONTACTS_PER_COMPANY,
    });
  } catch {
    return companyMailboxes;
  }
}

export function buildDefaultQueries(campaign: DiscoveryCampaign): string[] {
  const queries = buildDefaultResearchQueries(campaign);
  if (queries.some((query) => query.includes(campaign.product))) return queries;
  return [`"${campaign.product}" "${campaign.buyerType}" ${campaign.market}`, ...queries];
}

export class DiscoveryService {
  private readonly hermes: HermesResearchClient;
  private readonly websiteAssessor: typeof assessWebsite | null;
  private readonly searchProviderFactory: typeof createSearchProvider | null;
  private readonly runtimeContracts: LegacyDiscoveryRuntimeContract;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    hermes?: HermesResearchClient,
    dependencies: DiscoveryServiceDependencies = {},
  ) {
    this.hermes = hermes ?? new HermesResearchClient(config);
    const fixtureOverride = Boolean(dependencies.assessWebsite || dependencies.createSearchProvider);
    this.websiteAssessor = dependencies.assessWebsite ?? (fixtureOverride ? assessWebsite : null);
    this.searchProviderFactory = dependencies.createSearchProvider ??
      (fixtureOverride ? createSearchProvider : null);
    this.runtimeContracts = dependencies.runtimeContracts ?? new StrictLegacyDiscoveryRuntime(config, {
      database: db,
    });
  }

  async assertLegacyRuntimeContracts(
    jobType: LegacyDiscoveryJobType,
    campaignId: string,
  ): Promise<LegacyDiscoveryRuntimeReport> {
    const campaign = this.db.getCampaign(campaignId);
    if (!campaign) throw new Error("Campaign not found for legacy discovery runtime preflight");
    return this.runtimeContracts.assertJob({
      jobType,
      campaignId,
      market: String(campaign.market),
      product: String(campaign.product),
      buyerType: String(campaign.buyer_type),
    });
  }

  async enrichPendingContacts(
    campaignId: string,
    limit = 25,
    onProgress?: (completed: number, total: number) => Promise<void>,
    assertActive: () => void = () => undefined,
    authorizedRuntime?: LegacyDiscoveryRuntimeReport,
  ): Promise<ContactEnrichmentSummary> {
    assertActive();
    const campaignRow = this.db.getCampaign(campaignId);
    if (!campaignRow) throw new Error("Campaign not found for contact enrichment");
    const campaign: DiscoveryCampaign = {
      id: campaignId,
      market: String(campaignRow.market),
      product: String(campaignRow.product),
      buyerType: String(campaignRow.buyer_type),
      targetCount: Number(campaignRow.target_count),
    };
    const leads = this.db.listEnrichingLeads(campaignId, limit);
    const firstLead = leads.at(0);
    const pass = firstLead ? Number(firstLead.enrichment_attempts ?? 0) + 1 : null;
    if (leads.length === 0) {
      assertActive();
      const queue = this.db.getEnrichmentQueueState(campaignId);
      const summary: ContactEnrichmentSummary = {
        campaignId,
        pass,
        attempted: 0,
        contactsFound: 0,
        verifiedEmails: 0,
        riskyEmails: 0,
        readyForReview: 0,
        stillPending: 0,
        nextPass: queue.currentPass,
        remainingInPass: queue.remainingInPass,
        remainingEligible: queue.remainingEligible,
        nextRunAt: queue.nextRunAt,
        hermesCallsUsed: 0,
        errors: [],
      };
      return summary;
    }
    const context = loadBusinessContextStrict(this.config);
    const runtime = this.searchProviderFactory && this.websiteAssessor
      ? authorizedRuntime ?? null
      : authorizedRuntime ?? await this.assertLegacyRuntimeContracts("ENRICH_CONTACTS", campaignId);
    if (runtime && runtime.campaignId !== campaignId) {
      throw new Error("Authorized provider runtime belongs to another campaign");
    }
    const provider = this.searchProviderFactory
      ? this.searchProviderFactory(this.config)
      : this.runtimeContracts.createSearchProvider(runtime!);
    const websiteAssessor = this.websiteAssessor ?? this.runtimeContracts.createWebsiteAssessor(runtime!);
    const emailVerifier = runtime ? this.runtimeContracts.createEmailVerifier(runtime) : null;
    const budget = new LlmCallBudget(this.config.MAX_LLM_CALLS_PER_JOB);
    const planned = await buildMarketResearchPlan({
      campaign,
      context,
      config: this.config,
      llm: this.llm,
      hermes: this.hermes,
      budget,
    });
    const limiter = pLimit(Math.max(1, this.config.MAX_DISCOVERY_CONCURRENCY));
    const hermesLimiter = pLimit(2);
    const pageBudget = new CampaignPageBudget(this.config.MAX_PAGES_PER_CAMPAIGN);
    const errors: Array<{ domain: string; error: string }> = [];
    let completed = 0;
    let attempted = 0;
    let contactsFound = 0;
    let verifiedEmails = 0;
    let riskyEmails = 0;
    let readyForReview = 0;
    let stillPending = 0;
    let hermesCallsUsed = planned.hermesCalls;

    await Promise.all(leads.map((lead) => limiter(async () => {
      assertActive();
      const leadId = String(lead.id);
      const domain = String(lead.domain);
      const company = String(lead.company);
      const website = String(lead.website);
      const expectedAttempts = Number(lead.enrichment_attempts ?? 0);
      const nextRunAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const guard = <T,>(
        operation: () => T,
        additionalDncValues: Array<{ type: string; value: string | null | undefined }> = [],
        ...asyncOperationRejected: T extends PromiseLike<unknown> ? [never] : []
      ) => this.db.withLeadAutomationGuard(leadId, {
        campaignId,
        allowedStatuses: ENRICHMENT_AUTOMATION_STATUSES,
        expectedEnrichmentAttempts: expectedAttempts,
        additionalDncValues,
      }, operation, ...asyncOperationRejected);
      const commitPendingAttempt = (): boolean => {
        const result = guard(() =>
          this.db.completeEnrichmentAttempt(leadId, expectedAttempts, nextRunAt));
        if (!result.applied || !result.value) return false;
        attempted += 1;
        const refreshed = this.db.getLead(leadId);
        if (refreshed?.status === "ENRICHING") stillPending += 1;
        return true;
      };

      try {
        const sources = this.db.listLeadSources(leadId);
        const candidate: CandidateCompany = {
          company,
          domain,
          website,
          seed: null,
          results: sources.map((source) => ({
            title: company,
            url: String(source.source_url),
            snippet: String(source.evidence ?? ""),
            sourceType: String(source.source_type ?? "public_source"),
            sourceDate: source.source_date ? String(source.source_date) : null,
            query: "stored lead evidence",
          })),
        };
        const pageReservation = pageBudget.reserve(this.config.MAX_COMPANY_PAGES);
        if (!pageReservation) {
          errors.push({ domain, error: "CRAWL_PAGE_BUDGET_EXHAUSTED" });
          return;
        }
        let assessment: WebsiteAssessment | undefined;
        try {
          assessment = await websiteAssessor(
            website,
            this.config.RESEARCH_USER_AGENT,
            pageReservation.limit,
          );
        } finally {
          pageReservation.finalize(assessment?.pages.length);
        }
        if (!assessment) throw new Error("Website assessment did not return a result");
        assertActive();
        if (!assessment.reachable || assessment.parked) {
          commitPendingAttempt();
          return;
        }
        const demand = assessDemandEvidence({
          results: candidate.results,
          pages: assessment.pages,
          productTerms: trustedDemandProductTerms(campaign.product, context),
          companyName: candidate.company,
          companyDomain: candidate.domain,
        });
        const analysis: CompanyAnalysis = {
          companyName: company,
          companyType: String(lead.buyer_type),
          fitScore: Number(lead.fit_score),
          intentScore: demand.score,
          buyingLikelihood: demand.buyingLikelihood,
          demandStage: demand.stage,
          demandEvidence: demand.evidence,
          demandEvidenceQualified: demand.demandEvidenceQualified,
          demandPolicyVersion: demand.policyVersion,
          qualified: true,
          matchedProducts: String(lead.product).split(",").map((value) => value.trim()).filter(Boolean),
          purchaseReasons: [],
          risks: [],
          recommendedOffer: String(lead.product),
          researchSummary: "Previously qualified company awaiting decision-maker enrichment.",
          evidence: [],
        };
        const hermesPlan = await hermesLimiter(() =>
          buildHermesContactQueries(candidate, analysis, planned.plan, this.hermes),
        );
        assertActive();
        hermesCallsUsed += hermesPlan.calls;
        const contactEvidence = await researchContactEvidence(
          provider,
          candidate,
          this.config,
          hermesPlan.queries,
        );
        assertActive();
        const contacts = await extractContacts(
          candidate,
          assessment,
          contactEvidence,
          this.llm,
          this.config,
          budget,
        );
        assertActive();
        const resolvedContacts: Array<{
          contact: ContactCandidate;
          resolved: Awaited<ReturnType<typeof verifyContactEmail>>;
        }> = [];
        for (const contact of contacts) {
          const resolved = await verifyContactEmail(contact, domain, this.config, emailVerifier);
          assertActive();
          resolvedContacts.push({ contact, resolved });
        }

        const finalization = guard(() => {
          for (const result of contactEvidence) {
            this.db.addLeadSource(
              leadId,
              result.url,
              sourceTypeForUrl(result.url),
              result.sourceDate ?? null,
              result.snippet.slice(0, 1000),
            );
          }
          const persistedOfficialEvidence = new Map<string, OfficialMailboxEvidence>();
          for (const { contact } of resolvedContacts) {
            if (contact.officialMailboxEvidence) {
              const persisted = this.db.persistOfficialMailboxEvidence(
                leadId,
                contact.officialMailboxEvidence,
              );
              persistedOfficialEvidence.set(contact.officialMailboxEvidence.sourceUrl, persisted);
            }
          }
          for (const { contact, resolved } of resolvedContacts) {
            const verification = resolved.verification;
            const officialMailboxEvidence = contact.officialMailboxEvidence
              ? persistedOfficialEvidence.get(contact.officialMailboxEvidence.sourceUrl) ?? null
              : null;
            const contactId = this.db.upsertContact({
              leadId,
              name: contact.name,
              title: contact.title,
              email: verification?.email ?? null,
              linkedin: contact.linkedin,
              sourceUrl: contact.sourceUrl,
              employmentVerifiedAt: contact.employmentVerified ? new Date().toISOString() : null,
              emailStatus: verification?.status ?? "UNKNOWN",
              emailRisk: verification?.reason ?? "public personal email not found",
              roleAddress: (verification?.roleAddress ?? false) || contact.recipientTier === "B",
              disposableAddress: verification?.disposableAddress ?? false,
              catchAll: verification?.catchAll ?? false,
              verificationNotes: resolved.evidence,
              officialMailboxEvidence,
            });
            if (resolved.provenance && runtime?.versionId) {
              persistStrictEmailVerification(
                this.db,
                contactId,
                campaignId,
                runtime.versionId,
                resolved.provenance,
              );
            }
          }

          const rankingAsOf = new Date();
          const bestContact = bestRankedStoredContact({
            db: this.db,
            leadId,
            campaignId,
            versionId: runtime?.versionId ?? null,
            accountDomain: domain,
            company,
            buyerType: String(lead.buyer_type),
            asOf: rankingAsOf,
          });
          const bestContactScore = bestContact?.contactScore ?? 0;
          const bestChannelScore = bestContact?.channelScore ?? 0;
          const sourceCount = this.db.countIndependentLeadSources(leadId);
          const lastActivityAt = assessment.recentActivityAt ?? null;
          const activityScore = assessment.activityScore;
          const score = scoreLead(
            {
              fitScore: Number(lead.fit_score),
              intentScore: demand.score,
              demandEvidenceQualified: demand.demandEvidenceQualified,
              demandPolicyVersion: demand.policyVersion,
              activityScore,
              contactScore: bestContactScore,
              channelScore: bestChannelScore,
              independentSourceCount: sourceCount,
              lastActivityAt,
              namedContact: bestContact?.candidate.named ?? false,
              employmentVerified: bestContact?.ranking.dimensions.currentFreshEmploymentRank === 2,
              emailStatus: bestContact?.candidate.email.status ?? "UNKNOWN",
              roleAddress: bestContact?.candidate.email.roleAddress ?? false,
              disposableAddress: bestContact?.candidate.email.disposable ?? false,
              catchAll: bestContact?.candidate.email.catchAll ?? false,
              dncMatch: bestContact?.candidate.dncMatch ?? this.db.hasDncMatch([
                { type: "domain", value: domain },
                { type: "company", value: company },
              ]),
            },
            this.config.LEAD_SEND_SCORE_MIN,
            this.config.COMPANY_ACTIVITY_MAX_AGE_DAYS,
            new Date(),
            isGmailPilotMode(this.config),
          );
          this.db.upsertLead({
            campaignId,
            company,
            domain,
            website,
            country: String(lead.country),
            buyerType: String(lead.buyer_type),
            product: String(lead.product),
            fitScore: Number(lead.fit_score),
            intentScore: demand.score,
            activityScore,
            contactScore: bestContactScore,
            channelScore: bestChannelScore,
            totalScore: score.totalScore,
            grade: score.grade,
            lastActivityAt,
            demandEvidenceQualified: demand.demandEvidenceQualified,
            demandPolicyVersion: demand.policyVersion,
            demandStage: demand.stage,
            demandEvidence: demand.evidence,
            sendEligible: score.eligibleForReview,
            eligibilityReasons: score.reasons,
          });
          if (!this.db.completeEnrichmentAttempt(
            leadId,
            expectedAttempts,
            nextRunAt,
            3,
            !score.eligibleForReview,
          )) {
            throw new LeadAutomationGuardLostError("Enrichment attempt changed during finalization");
          }
          if (score.eligibleForReview) {
            this.db.transitionLead(leadId, "VERIFYING", "contact_enrichment", "evidence-backed contact found");
            this.db.transitionLead(leadId, "READY_FOR_REVIEW", "contact_enrichment", "all review gates passed");
          }
          this.db.upsertDiscoveryCandidate({
            campaignId,
            domain,
            company,
            website,
            round: 4,
            stage: score.eligibleForReview ? "SEND_REVIEW" : "CONTACT_ENRICHMENT",
            outcome: score.eligibleForReview ? "SEND_READY" : "ENRICHMENT_PENDING",
            reason: score.eligibleForReview ? "contact enrichment passed all gates" : score.reasons.join("; "),
            sourceCount,
            fitScore: Number(lead.fit_score),
            intentScore: demand.score,
            activityScore,
            buyingLikelihood: demand.buyingLikelihood,
            recommendedOffer: String(lead.product),
            evidence: {
              contactEvidence,
              demandPolicyVersion: demand.policyVersion,
              demandEvidenceQualified: demand.demandEvidenceQualified,
              demandStage: demand.stage,
              demandEvidence: demand.evidence,
            },
          });
          return { eligibleForReview: score.eligibleForReview };
        }, resolvedContacts.map(({ resolved }) => ({
          type: "email",
          value: resolved.verification?.email,
        })));
        if (!finalization.applied) throw new LeadAutomationGuardLostError("Lead automation guard lost");

        attempted += 1;
        contactsFound += resolvedContacts.length;
        verifiedEmails += resolvedContacts.filter(({ resolved }) =>
          resolved.verification?.status === "VALID").length;
        riskyEmails += resolvedContacts.filter(({ resolved }) =>
          resolved.verification?.status === "RISKY").length;
        if (finalization.value.eligibleForReview) {
          readyForReview += 1;
        } else if (this.db.getLead(leadId)?.status === "ENRICHING") {
          stillPending += 1;
        }
      } catch (error) {
        if (error instanceof LeadAutomationGuardLostError) return;
        assertActive();
        if (commitPendingAttempt()) errors.push({ domain, error: String(error) });
      } finally {
        assertActive();
        completed += 1;
        await onProgress?.(completed, leads.length);
        assertActive();
      }
    })));

    assertActive();
    const queue = this.db.getEnrichmentQueueState(campaignId);
    const summary: ContactEnrichmentSummary = {
      campaignId,
      pass,
      attempted,
      contactsFound,
      verifiedEmails,
      riskyEmails,
      readyForReview,
      stillPending,
      nextPass: queue.currentPass,
      remainingInPass: queue.remainingInPass,
      remainingEligible: queue.remainingEligible,
      nextRunAt: queue.nextRunAt,
      hermesCallsUsed,
      errors,
    };
    if (attempted > 0) {
      this.db.recordEvent("campaign", campaignId, "CONTACT_ENRICHMENT_COMPLETED", "system", summary);
    }
    return summary;
  }

  async run(
    campaign: DiscoveryCampaign,
    onProgress?: (progress: DiscoveryProgress) => Promise<void>,
    assertActive: () => void = () => undefined,
    authorizedRuntime?: LegacyDiscoveryRuntimeReport,
  ): Promise<DiscoverySummary> {
    assertActive();
    const context = loadBusinessContextStrict(this.config);
    const runtime = this.searchProviderFactory && this.websiteAssessor
      ? authorizedRuntime ?? null
      : authorizedRuntime ?? await this.assertLegacyRuntimeContracts("DISCOVER_CAMPAIGN", campaign.id);
    if (runtime && runtime.campaignId !== campaign.id) {
      throw new Error("Authorized provider runtime belongs to another campaign");
    }
    const provider = this.searchProviderFactory
      ? this.searchProviderFactory(this.config)
      : this.runtimeContracts.createSearchProvider(runtime!);
    const websiteAssessor = this.websiteAssessor ?? this.runtimeContracts.createWebsiteAssessor(runtime!);
    const emailVerifier = runtime ? this.runtimeContracts.createEmailVerifier(runtime) : null;
    const llmBudget = new LlmCallBudget(this.config.MAX_LLM_CALLS_PER_JOB);
    const hermesLimiter = pLimit(2);
    this.db.setCampaignStatus(campaign.id, "RESEARCHING");
    await onProgress?.({ stage: "PLANNING", message: "正在进行市场评估、产品拆分和多语言搜索规划。" });
    assertActive();
    const planned = await buildMarketResearchPlan({
      campaign,
      context,
      config: this.config,
      llm: this.llm,
      hermes: this.hermes,
      budget: llmBudget,
    });
    assertActive();
    const plan = planned.plan;
    this.db.recordEvent("campaign", campaign.id, "MARKET_RESEARCH_PLAN_CREATED", "system", {
      source: plan.source,
      marketSummary: plan.marketSummary,
      segments: plan.segments,
      queryCount: plan.queries.length,
    });
    await onProgress?.({
      stage: "PLANNING",
      message: `市场研究完成：由 ${plan.source} 生成 ${plan.queries.length} 条多语言查询，重点行业为 ${plan.segments.slice(0, 4).map((segment) => segment.industry).join("；") || "系统集成商与工业终端"}。`,
    });
    assertActive();

    const searchResultLimit = Math.min(
      this.config.MAX_SEARCH_RESULTS_PER_CAMPAIGN,
      Math.max(150, campaign.targetCount * 20),
    );
    const candidateLimit = Math.min(
      this.config.MAX_PAGES_PER_CAMPAIGN,
      Math.max(60, campaign.targetCount * 8),
    );
    const maxRounds = Math.max(1, this.config.MAX_DISCOVERY_ROUNDS);
    const queryChunks: string[][] = Array.from({ length: maxRounds }, () => []);
    plan.queries.forEach((query, index) => queryChunks[index % maxRounds]?.push(query));
    const allResults: SearchResult[] = [];
    const candidates = new Map<string, CandidateCompany>();
    const processed = new Set<string>();
    const errors: Array<{ domain: string; error: string }> = [];
    const pageBudget = new CampaignPageBudget(this.config.MAX_PAGES_PER_CAMPAIGN);
    const rejectionReasons: Record<string, number> = {};
    const countReason = (reason: string) => {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    };
    let roundsCompleted = 0;
    let hermesCallsUsed = planned.hermesCalls;
    let domainsAssessed = 0;
    let leadsStored = 0;
    let companyQualified = 0;
    let contactsFound = 0;
    let verifiedEmails = 0;
    let riskyEmails = 0;
    let enrichmentPending = 0;
    let eligibleForReview = 0;
    let rejected = 0;
    let skipped = 0;
    let duplicatesSkipped = 0;
    let managedSkipped = 0;
    let committedOutcomes = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      assertActive();
      const remainingResults = searchResultLimit - allResults.length;
      if (remainingResults <= 0 || eligibleForReview >= campaign.targetCount) break;
      const queries = queryChunks[round - 1] ?? [];
      if (queries.length === 0) continue;
      await onProgress?.({
        stage: "SEARCHING",
        round,
        message: `第 ${round}/${maxRounds} 轮：正在搜索官网、项目、展会、目录和近期需求信号。`,
        searchResults: allResults.length,
        candidates: candidates.size,
      });
      assertActive();
      const perQuery = Math.max(8, Math.min(20, Math.ceil(remainingResults / queries.length)));
      const roundResults = await searchEvidence(
        provider,
        queries,
        perQuery,
        this.config.MAX_SEARCH_CONCURRENCY,
      );
      assertActive();
      for (const result of roundResults) {
        if (allResults.length >= searchResultLimit) break;
        if (!allResults.some((item) => item.url === result.url)) allResults.push(result);
      }
      for (const candidate of deterministicCandidates(roundResults)) mergeCandidate(candidates, candidate);
      const extracted = await extractCandidatesFromSearch(
        roundResults,
        campaign,
        this.llm,
        this.config,
        llmBudget,
      );
      assertActive();
      for (const candidate of extracted) mergeCandidate(candidates, candidate);
      if (round === 1) {
        for (const candidate of seedCandidates(context, campaign)) mergeCandidate(candidates, candidate);
      }
      roundsCompleted = round;

      const unprocessed = [...candidates.values()]
        .filter((candidate) => !processed.has(candidate.domain))
        .sort((left, right) => {
          const seedDiff = Number(Boolean(right.seed)) - Number(Boolean(left.seed));
          return seedDiff || right.results.length - left.results.length;
        })
        .slice(0, Math.max(0, candidateLimit - processed.size));
      const limiter = pLimit(Math.max(1, this.config.MAX_DISCOVERY_CONCURRENCY));
      let researchedThisRound = 0;
      await Promise.all(unprocessed.map((candidate) => limiter(async () => {
        assertActive();
        processed.add(candidate.domain);
        const identityGuard = <T,>(
          operation: (leadId: string | null) => T,
          additionalDncValues: Array<{ type: string; value: string | null | undefined }> = [],
          ...asyncOperationRejected: T extends PromiseLike<unknown> ? [never] : []
        ) => this.db.withLeadAutomationGuard({
          campaignId: campaign.id,
          domain: candidate.domain,
          allowMissing: true,
        }, {
          campaignId: campaign.id,
          allowedStatuses: DISCOVERY_AUTOMATION_STATUSES,
          additionalDncValues,
        }, operation, ...asyncOperationRejected);
        try {
          const existingLead = this.db.findLeadByDomain(candidate.domain, campaign.id);
          if (existingLead &&
            (Boolean(existingLead.human_takeover) ||
              !DISCOVERY_AUTOMATION_STATUSES.includes(existingLead.status as LeadStatus))) {
            managedSkipped += 1;
            return;
          }
          const selected = identityGuard(() => this.db.upsertDiscoveryCandidate({
            campaignId: campaign.id,
            domain: candidate.domain,
            company: candidate.company,
            website: candidate.website,
            round,
            stage: "WEBSITE_RESEARCH",
            outcome: "IN_PROGRESS",
            reason: "candidate selected for deep research",
            sourceCount: candidate.results.length,
            evidence: candidate.results,
          }), [{ type: "company", value: candidate.company }]);
          if (!selected.applied) {
            managedSkipped += 1;
            return;
          }
          const pageReservation = pageBudget.reserve(this.config.MAX_COMPANY_PAGES);
          if (!pageReservation) {
            const outcome = identityGuard(() => this.db.upsertDiscoveryCandidate({
              campaignId: campaign.id,
              domain: candidate.domain,
              company: candidate.company,
              website: candidate.website,
              round,
              stage: "WEBSITE_RESEARCH",
              outcome: "BUDGET_EXHAUSTED",
              reason: "campaign crawl page budget exhausted",
              sourceCount: candidate.results.length,
              evidence: pageBudget.snapshot(),
            }), [{ type: "company", value: candidate.company }]);
            if (outcome.applied) {
              committedOutcomes += 1;
              countReason("crawl_page_budget_exhausted");
            } else {
              managedSkipped += 1;
            }
            return;
          }
          domainsAssessed += 1;
          let assessment: WebsiteAssessment | undefined;
          try {
            assessment = await websiteAssessor(
              candidate.website,
              this.config.RESEARCH_USER_AGENT,
              pageReservation.limit,
            );
          } finally {
            pageReservation.finalize(assessment?.pages.length);
          }
          if (!assessment) throw new Error("Website assessment did not return a result");
          assertActive();
          if (!assessment.reachable || assessment.parked) {
            const reason = assessment.parked ? "parked_or_inactive" : "website_unreachable";
            const outcome = identityGuard(() => this.db.upsertDiscoveryCandidate({
              campaignId: campaign.id,
              domain: candidate.domain,
              company: candidate.company,
              website: candidate.website,
              round,
              stage: "WEBSITE_RESEARCH",
              outcome: "REJECTED",
              reason,
              sourceCount: candidate.results.length,
              evidence: assessment.activitySignals,
            }), [{ type: "company", value: candidate.company }]);
            if (!outcome.applied) {
              managedSkipped += 1;
              return;
            }
            rejected += 1;
            committedOutcomes += 1;
            countReason(reason);
            return;
          }
          const companyEvidence = await researchCompanyEvidence(provider, candidate, plan, this.config);
          assertActive();
          const publicEvidence = [...candidate.results, ...companyEvidence].filter(
            (result, index, all) => all.findIndex((item) => item.url === result.url) === index,
          );
          const analysis = await analyzeCompany(
            candidate,
            assessment,
            publicEvidence,
            plan,
            campaign.product,
            context,
            this.llm,
            this.config,
            llmBudget,
          );
          assertActive();
          if (!analysis.qualified) {
            const outcome = identityGuard(() => this.db.upsertDiscoveryCandidate({
              campaignId: campaign.id,
              domain: candidate.domain,
              company: analysis.companyName || candidate.company,
              website: assessment.url,
              round,
              stage: "COMPANY_ANALYSIS",
              outcome: "REJECTED",
              reason: analysis.researchSummary || "company fit not evidenced",
              sourceCount: publicEvidence.length,
              fitScore: analysis.fitScore,
              intentScore: analysis.intentScore,
              activityScore: assessment.activityScore,
              buyingLikelihood: analysis.buyingLikelihood,
              recommendedOffer: analysis.recommendedOffer,
              evidence: {
                analysis: analysis.evidence,
                demandPolicyVersion: analysis.demandPolicyVersion,
                demandEvidenceQualified: analysis.demandEvidenceQualified,
                demandStage: analysis.demandStage,
                demandEvidence: analysis.demandEvidence,
              },
            }), [{ type: "company", value: analysis.companyName || candidate.company }]);
            if (!outcome.applied) {
              managedSkipped += 1;
              return;
            }
            rejected += 1;
            committedOutcomes += 1;
            countReason("company_fit_not_evidenced");
            return;
          }

          const companyName = analysis.companyName || candidate.company;
          const initialCommit = this.db.withLeadAutomationGuard({
            campaignId: campaign.id,
            domain: candidate.domain,
            allowMissing: true,
          }, {
            campaignId: campaign.id,
            allowedStatuses: DISCOVERY_AUTOMATION_STATUSES,
            additionalDncValues: [{ type: "company", value: companyName }],
          }, (guardedLeadId) => {
            const storedLeadId = this.db.upsertLead({
              campaignId: campaign.id,
              company: companyName,
              domain: candidate.domain,
              website: assessment.url,
              country: plan.market,
              buyerType: analysis.companyType || candidate.seed?.buyerType || campaign.buyerType,
              product: analysis.matchedProducts.join(", ") || campaign.product,
              fitScore: analysis.fitScore,
              intentScore: analysis.intentScore,
              activityScore: assessment.activityScore,
              contactScore: 0,
              channelScore: 0,
              totalScore: analysis.fitScore + analysis.intentScore + assessment.activityScore,
              grade: "BRONZE",
              lastActivityAt: assessment.recentActivityAt,
              demandEvidenceQualified: analysis.demandEvidenceQualified,
              demandPolicyVersion: analysis.demandPolicyVersion,
              demandStage: analysis.demandStage,
              demandEvidence: analysis.demandEvidence,
              sendEligible: false,
              eligibilityReasons: ["decision-maker enrichment pending"],
            });
            if (guardedLeadId && storedLeadId !== guardedLeadId) {
              throw new Error("Discovery lead identity changed during guarded commit");
            }
            const current = this.db.getLead(storedLeadId);
            prepareLeadForDiscoveryVerification(
              this.db,
              storedLeadId,
              current?.status as LeadStatus | undefined,
            );
            this.db.addLeadSource(
              storedLeadId,
              assessment.url,
              "official_website",
              assessment.recentActivityAt ?? null,
              `${analysis.researchSummary}; ${assessment.activitySignals.join("; ")}`,
            );
            for (const result of publicEvidence) {
              this.db.addLeadSource(
                storedLeadId,
                result.url,
                sourceTypeForUrl(result.url),
                result.sourceDate ?? null,
                result.snippet.slice(0, 1000),
              );
            }
            return storedLeadId;
          });
          if (!initialCommit.applied) {
            managedSkipped += 1;
            return;
          }
          const leadId = initialCommit.value;
          companyQualified += 1;
          const hermesContactPlan = await hermesLimiter(() =>
            buildHermesContactQueries(candidate, analysis, plan, this.hermes),
          );
          assertActive();
          hermesCallsUsed += hermesContactPlan.calls;
          const contactEvidence = await researchContactEvidence(
            provider,
            candidate,
            this.config,
            hermesContactPlan.queries,
          );
          assertActive();
          const contacts = await extractContacts(
            candidate,
            assessment,
            contactEvidence,
            this.llm,
            this.config,
            llmBudget,
          );
          assertActive();
          const resolvedContacts: Array<{
            contact: ContactCandidate;
            resolved: Awaited<ReturnType<typeof verifyContactEmail>>;
          }> = [];
          for (const contact of contacts) {
            const resolved = await verifyContactEmail(contact, candidate.domain, this.config, emailVerifier);
            assertActive();
            resolvedContacts.push({ contact, resolved });
          }
          const finalCommit = this.db.withLeadAutomationGuard(leadId, {
            campaignId: campaign.id,
            allowedStatuses: ["VERIFYING"],
            additionalDncValues: [
              { type: "company", value: companyName },
              ...resolvedContacts.map(({ resolved }) => ({
                type: "email",
                value: resolved.verification?.email,
              })),
            ],
          }, () => {
            for (const result of contactEvidence) {
              this.db.addLeadSource(
                leadId,
                result.url,
                sourceTypeForUrl(result.url),
                result.sourceDate ?? null,
                result.snippet.slice(0, 1000),
              );
            }
            const persistedOfficialEvidence = new Map<string, OfficialMailboxEvidence>();
            for (const { contact } of resolvedContacts) {
              if (contact.officialMailboxEvidence) {
                const persisted = this.db.persistOfficialMailboxEvidence(
                  leadId,
                  contact.officialMailboxEvidence,
                );
                persistedOfficialEvidence.set(contact.officialMailboxEvidence.sourceUrl, persisted);
              }
            }
            for (const { contact, resolved } of resolvedContacts) {
              const verification = resolved.verification;
              const officialMailboxEvidence = contact.officialMailboxEvidence
                ? persistedOfficialEvidence.get(contact.officialMailboxEvidence.sourceUrl) ?? null
                : null;
              const contactId = this.db.upsertContact({
                leadId,
                name: contact.name,
                title: contact.title,
                email: verification?.email ?? null,
                linkedin: contact.linkedin,
                sourceUrl: contact.sourceUrl,
                employmentVerifiedAt: contact.employmentVerified ? new Date().toISOString() : null,
                emailStatus: verification?.status ?? "UNKNOWN",
                emailRisk: verification?.reason ?? "public personal email not found",
                roleAddress: (verification?.roleAddress ?? false) || contact.recipientTier === "B",
                disposableAddress: verification?.disposableAddress ?? false,
                catchAll: verification?.catchAll ?? false,
                verificationNotes: resolved.evidence,
                officialMailboxEvidence,
              });
              if (resolved.provenance && runtime?.versionId) {
                persistStrictEmailVerification(
                  this.db,
                  contactId,
                  campaign.id,
                  runtime.versionId,
                  resolved.provenance,
                );
              }
            }

            const reportedBuyerType = analysis.companyType || candidate.seed?.buyerType || campaign.buyerType;
            const storedBuyerType = normalizeBuyerType(reportedBuyerType)
              ?? normalizeBuyerType(candidate.seed?.buyerType)
              ?? normalizeBuyerType(campaign.buyerType)
              ?? reportedBuyerType;
            const rankingAsOf = new Date();
            const bestContact = bestRankedStoredContact({
              db: this.db,
              leadId,
              campaignId: campaign.id,
              versionId: runtime?.versionId ?? null,
              accountDomain: candidate.domain,
              company: companyName,
              buyerType: storedBuyerType,
              asOf: rankingAsOf,
            });
            const bestContactScore = bestContact?.contactScore ?? 0;
            const bestChannelScore = bestContact?.channelScore ?? 0;
            const sourceCount = this.db.countIndependentLeadSources(leadId);
            const score = scoreLead(
              {
                fitScore: analysis.fitScore,
                intentScore: analysis.intentScore,
                demandEvidenceQualified: analysis.demandEvidenceQualified,
                demandPolicyVersion: analysis.demandPolicyVersion,
                activityScore: assessment.activityScore,
                contactScore: bestContactScore,
                channelScore: bestChannelScore,
                independentSourceCount: sourceCount,
                lastActivityAt: assessment.recentActivityAt,
                namedContact: bestContact?.candidate.named ?? false,
                employmentVerified: bestContact?.ranking.dimensions.currentFreshEmploymentRank === 2,
                emailStatus: bestContact?.candidate.email.status ?? "UNKNOWN",
                roleAddress: bestContact?.candidate.email.roleAddress ?? false,
                disposableAddress: bestContact?.candidate.email.disposable ?? false,
                catchAll: bestContact?.candidate.email.catchAll ?? false,
                dncMatch: bestContact?.candidate.dncMatch ?? this.db.hasDncMatch([
                  { type: "domain", value: candidate.domain },
                  { type: "company", value: companyName },
                ]),
              },
              this.config.LEAD_SEND_SCORE_MIN,
              this.config.COMPANY_ACTIVITY_MAX_AGE_DAYS,
              new Date(),
              isGmailPilotMode(this.config),
            );
            const storedLeadId = this.db.upsertLead({
              campaignId: campaign.id,
              company: companyName,
              domain: candidate.domain,
              website: assessment.url,
              country: plan.market,
              buyerType: storedBuyerType,
              product: analysis.matchedProducts.join(", ") || campaign.product,
              fitScore: analysis.fitScore,
              intentScore: analysis.intentScore,
              activityScore: assessment.activityScore,
              contactScore: bestContactScore,
              channelScore: bestChannelScore,
              totalScore: score.totalScore,
              grade: score.grade,
              lastActivityAt: assessment.recentActivityAt,
              demandEvidenceQualified: analysis.demandEvidenceQualified,
              demandPolicyVersion: analysis.demandPolicyVersion,
              demandStage: analysis.demandStage,
              demandEvidence: analysis.demandEvidence,
              sendEligible: score.eligibleForReview,
              eligibilityReasons: score.reasons,
            });
            if (storedLeadId !== leadId) throw new Error("Discovery lead identity changed during finalization");
            this.db.transitionLead(
              leadId,
              score.eligibleForReview ? "READY_FOR_REVIEW" : "ENRICHING",
              "discovery",
              score.eligibleForReview ? "quality and send-readiness gates passed" : score.reasons.join("; "),
            );
            this.db.upsertDiscoveryCandidate({
              campaignId: campaign.id,
              domain: candidate.domain,
              company: companyName,
              website: assessment.url,
              round,
              stage: score.eligibleForReview ? "SEND_REVIEW" : "CONTACT_ENRICHMENT",
              outcome: score.eligibleForReview ? "SEND_READY" : "ENRICHMENT_PENDING",
              reason: score.eligibleForReview ? "all quality gates passed" : score.reasons.join("; "),
              sourceCount,
              fitScore: analysis.fitScore,
              intentScore: analysis.intentScore,
              activityScore: assessment.activityScore,
              buyingLikelihood: analysis.buyingLikelihood,
              recommendedOffer: analysis.recommendedOffer,
              evidence: {
                analysis: analysis.evidence,
                reportedBuyerType,
                canonicalBuyerType: storedBuyerType,
                risks: analysis.risks,
                purchaseReasons: analysis.purchaseReasons,
                demandPolicyVersion: analysis.demandPolicyVersion,
                demandEvidenceQualified: analysis.demandEvidenceQualified,
                demandStage: analysis.demandStage,
                demandEvidence: analysis.demandEvidence,
              },
            });
            return { eligibleForReview: score.eligibleForReview };
          });
          if (!finalCommit.applied) {
            managedSkipped += 1;
            return;
          }
          leadsStored += 1;
          contactsFound += resolvedContacts.length;
          verifiedEmails += resolvedContacts.filter(({ resolved }) =>
            resolved.verification?.status === "VALID").length;
          riskyEmails += resolvedContacts.filter(({ resolved }) =>
            resolved.verification?.status === "RISKY").length;
          if (finalCommit.value.eligibleForReview) eligibleForReview += 1;
          else enrichmentPending += 1;
          committedOutcomes += 1;
        } catch (error) {
          assertActive();
          const failureAudit = identityGuard(() => this.db.upsertDiscoveryCandidate({
            campaignId: campaign.id,
            domain: candidate.domain,
            company: candidate.company,
            website: candidate.website,
            round,
            stage: "ERROR",
            outcome: "RETRY_REQUIRED",
            reason: String(error).slice(0, 1000),
            sourceCount: candidate.results.length,
            evidence: candidate.results,
          }), [{ type: "company", value: candidate.company }]);
          if (!failureAudit.applied) {
            managedSkipped += 1;
            return;
          }
          errors.push({ domain: candidate.domain, error: String(error) });
          committedOutcomes += 1;
          countReason("research_error");
        } finally {
          assertActive();
          researchedThisRound += 1;
          if (researchedThisRound % Math.max(1, this.config.DISCOVERY_PROGRESS_INTERVAL) === 0) {
            await onProgress?.({
              stage: "RESEARCHING",
              round,
              message: `第 ${round} 轮已深度评估 ${researchedThisRound}/${unprocessed.length} 家公司。`,
              searchResults: allResults.length,
              candidates: candidates.size,
              researched: domainsAssessed,
              qualified: companyQualified,
              sendReady: eligibleForReview,
            });
            assertActive();
          }
        }
      })));
      assertActive();

      await onProgress?.({
        stage: "ENRICHING",
        round,
        message: `第 ${round} 轮完成：公司级高匹配 ${companyQualified}，待补联系人 ${enrichmentPending}，可审核发送 ${eligibleForReview}。未达到目标会自动进入下一轮补位。`,
        searchResults: allResults.length,
        candidates: candidates.size,
        researched: domainsAssessed,
        qualified: companyQualified,
        sendReady: eligibleForReview,
      });
      assertActive();
    }

    skipped = Math.max(0, candidates.size - processed.size) + duplicatesSkipped + managedSkipped;
    const finalStatus = eligibleForReview >= campaign.targetCount ? "TARGET_REACHED" : "ENRICHMENT_PENDING";
    this.db.setCampaignStatus(campaign.id, finalStatus);
    const summary: DiscoverySummary = {
      campaignId: campaign.id,
      provider: provider.name,
      orchestrator: plan.source,
      marketSummary: plan.marketSummary,
      queries: plan.queries,
      roundsCompleted,
      searchResults: allResults.length,
      candidateCompanies: candidates.size,
      domainsAssessed,
      leadsStored,
      companyQualified,
      contactsFound,
      verifiedEmails,
      riskyEmails,
      enrichmentPending,
      eligibleForReview,
      rejected,
      skipped,
      duplicatesSkipped,
      rejectionReasons,
      llmCallsUsed: llmBudget.usedCalls,
      llmCallLimit: llmBudget.limit,
      hermesCallsUsed,
      errors,
    };
    if (committedOutcomes > 0) {
      this.db.recordEvent("campaign", campaign.id, "DEEP_DISCOVERY_COMPLETED", "system", summary as unknown as Record<string, unknown>);
    }
    await onProgress?.({
      stage: "COMPLETED",
      message: "深度获客任务完成，所有候选均已记录阶段和原因。",
      searchResults: allResults.length,
      candidates: candidates.size,
      researched: domainsAssessed,
      qualified: companyQualified,
      sendReady: eligibleForReview,
    });
    assertActive();
    return summary;
  }
}
