import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { z } from "zod";
import type { AgentDatabase, IndependentEmailVerificationRecord } from "../db.js";
import { normalizePublicHttpUrl } from "../http-url.js";
import { normalizeBuyerType, normalizeBuyerTypes } from "./buyer-type.js";
import { inferRoleFamily } from "./contact-ranking.js";
import {
  rankStoredContactRows,
  type StoredContactRow,
  type StoredLeadSourceRow,
} from "./contact-ranking-adapter.js";
import { CampaignBriefSchema, campaignBriefHash, type CampaignBrief } from "./campaign-brief.js";
import {
  createPageSnapshot,
  type EvidenceFact as OutreachEvidenceFact,
  type PageSnapshot,
} from "./evidence.js";
import {
  compileGroundedMessage,
  createPersonalizationPlan,
  type PersonalizationPlan,
  type PersonalizationPlanCandidate,
} from "./message-grounding.js";
import {
  QUALIFICATION_POLICY_VERSION,
  type BuyerType,
  type EvidenceFact as QualificationEvidenceFact,
  type QualificationInput,
  type QualificationTrack,
  type SeniorityLevel,
  type SignalType,
} from "./models.js";
import { evaluateQualification } from "./qualification.js";
import {
  type RecipientTierDecision,
} from "./recipient-tier.js";
import {
  SellerKnowledgeDocumentSchema,
  SellerKnowledgeStore,
  deterministicSellerContentHash,
  type SellerKnowledgeDocument,
  type SellerOffer,
} from "./seller-knowledge.js";

const IdSchema = z.string().trim().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const AutonomousDiscoveryPayloadSchema = z.object({
  campaignId: IdSchema,
  briefId: IdSchema,
  versionId: IdSchema,
  briefHash: HashSchema,
  sendAuthorizationId: IdSchema,
  launchKey: IdSchema,
  sellerKnowledge: SellerKnowledgeDocumentSchema,
  sellerKnowledgeHash: HashSchema,
  allowedOfferIds: z.array(IdSchema).min(1).max(100),
  createdBy: IdSchema,
  replyChatId: z.string().trim().max(300).optional().default(""),
  maximumSequenceIndex: z.literal(0),
}).passthrough();

type AutonomousDiscoveryPayload = z.infer<typeof AutonomousDiscoveryPayloadSchema>;

interface LeadRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  company: string;
  domain: string;
  buyer_type: string;
  product: string;
  status: string;
  send_eligible: number;
  demand_evidence_qualified: number;
  demand_policy_version: string;
  demand_evidence_json: string;
  total_score: number;
  human_takeover: number;
}

interface ContactRow extends Record<string, unknown> {
  id: string;
  name: string;
  title: string;
  email: string;
  source_url: string;
  employment_verified_at: string;
  email_status: string;
  role_address: number;
  disposable_address: number;
  catch_all: number;
  recipient_tier: string;
  recipient_evidence_url: string | null;
  recipient_evidence_observed_at: string | null;
  recipient_evidence_expires_at: string | null;
  recipient_evidence_hash: string | null;
  recipient_policy_version: string;
}

interface SourceRow extends Record<string, unknown> {
  id: string;
  source_url: string;
  source_type: string;
  source_date: string | null;
  evidence: string;
  created_at: string;
}

interface PublicSource extends SourceRow {
  url: string;
  publisherDomain: string;
  publishedAt: string | null;
  retrievedAt: string;
  text: string;
}

type EmailLineage = IndependentEmailVerificationRecord;

interface BuildResult {
  payload: Record<string, unknown> | null;
  leadId: string;
  contactId: string | null;
  materialHash: string | null;
  blockers: string[];
}

export interface AutonomousDiscoveryMessageBridgeResult extends Record<string, unknown> {
  status: "NOT_AUTONOMOUS" | "STAGED" | "BLOCKED";
  campaignId: string | null;
  examined: number;
  enqueued: number;
  alreadyStaged: number;
  blocked: number;
  jobIds: string[];
  blockers: Array<{ leadId: string | null; codes: string[] }>;
}

export interface AutonomousCampaignReplayResult extends Record<string, unknown> {
  campaignCount: number;
  examined: number;
  enqueued: number;
  alreadyStaged: number;
  blocked: number;
  campaigns: Array<{
    campaignId: string;
    status: AutonomousDiscoveryMessageBridgeResult["status"];
    examined: number;
    enqueued: number;
    alreadyStaged: number;
    blocked: number;
    blockerCodes: string[];
  }>;
}

export interface AutonomousMessageBridgeDiagnostics extends Record<string, unknown> {
  authorizedCampaigns: number;
  authorizedLeads: number;
  contactsWithEmail: number;
  stageJobs: number;
  outboundMessages: number;
  messageAuthorizations: number;
  topBlockers: Array<{ code: string; count: number }>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

function normalizedDomain(value: string): string {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname).toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function validDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function futureDate(from: string, days: number): string {
  return new Date(Date.parse(from) + days * 86_400_000).toISOString();
}

function truncate(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum).trimEnd();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (values: readonly string[]) => new Set(values.map((value) => value.trim().toLocaleLowerCase("en-US")));
  const leftSet = normalized(left);
  const rightSet = normalized(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function loadCampaignBrief(db: AgentDatabase, payload: AutonomousDiscoveryPayload): CampaignBrief | null {
  const row = db.db.prepare(
    `SELECT cv.brief_id, cv.brief_hash, cv.brief_json, cpb.campaign_id
     FROM campaign_versions cv
     JOIN campaign_provider_bindings cpb ON cpb.version_id=cv.id AND cpb.brief_id=cv.brief_id
     WHERE cv.id=? AND cv.brief_id=? AND cpb.campaign_id=?`,
  ).get(payload.versionId, payload.briefId, payload.campaignId) as Record<string, unknown> | undefined;
  if (!row || String(row.brief_hash) !== payload.briefHash) return null;
  try {
    const brief = CampaignBriefSchema.parse(JSON.parse(String(row.brief_json)) as unknown);
    return campaignBriefHash(brief) === payload.briefHash ? brief : null;
  } catch {
    return null;
  }
}

function launchSellerHash(db: AgentDatabase, launchKey: string): string | null {
  const raw = db.getSetting(`autonomous_pilot_launch:${launchKey.trim().toLocaleLowerCase("en-US")}`);
  if (!raw) return null;
  try {
    const decoded = JSON.parse(raw) as Record<string, unknown>;
    return HashSchema.safeParse(decoded.sellerKnowledgeHash).data ?? null;
  } catch {
    return null;
  }
}

function publicSources(db: AgentDatabase, lead: LeadRow, sellerDomain: string, now: Date): PublicSource[] {
  const accountDomain = normalizedDomain(lead.domain);
  const rows = db.listLeadSources(lead.id) as SourceRow[];
  const seenUrls = new Set<string>();
  const sources: PublicSource[] = [];
  for (const row of rows) {
    const url = normalizePublicHttpUrl(String(row.source_url ?? ""));
    const text = truncate(String(row.evidence ?? ""), 20_000);
    const retrievedAt = validDate(row.created_at);
    if (!url || text.length < 20 || !retrievedAt || Date.parse(retrievedAt) > now.getTime()) continue;
    const sourceType = String(row.source_type ?? "").toLocaleLowerCase("en-US");
    if (sourceType === "search_index" || sourceType === "email_verification") continue;
    const publisherDomain = normalizedDomain(url);
    if (!publisherDomain || publisherDomain === sellerDomain || seenUrls.has(url)) continue;
    const publishedAt = validDate(row.source_date);
    if (publishedAt && Date.parse(publishedAt) > now.getTime()) continue;
    seenUrls.add(url);
    sources.push({
      ...row,
      url,
      publisherDomain,
      publishedAt,
      retrievedAt,
      text,
      source_type: sourceType,
    });
  }
  return sources.sort((left, right) => {
    const leftOfficial = Number(left.publisherDomain === accountDomain);
    const rightOfficial = Number(right.publisherDomain === accountDomain);
    return rightOfficial - leftOfficial || left.url.localeCompare(right.url);
  });
}

function companyTokens(company: string): string[] {
  const ignored = new Set(["company", "limited", "ltd", "sdn", "bhd", "inc", "corp", "pte"]);
  return company.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function supportsIdentity(source: PublicSource, lead: LeadRow): boolean {
  if (source.publisherDomain !== normalizedDomain(lead.domain)) return false;
  const lower = source.text.toLocaleLowerCase("en-US");
  const tokens = companyTokens(lead.company);
  return tokens.length === 0 || tokens.some((token) => lower.includes(token));
}

function supportsBuyerType(source: PublicSource, mappedBuyerType: BuyerType): boolean {
  const text = source.text.toLocaleLowerCase("en-US");
  if (mappedBuyerType === "SYSTEM_INTEGRATOR_EPC") {
    return /\b(?:integrat\w*|epc|engineering\s+(?:contractor|services?|company)|contractor|turnkey)\b/.test(text);
  }
  if (mappedBuyerType === "DISTRIBUTOR") {
    return /\b(?:distribut\w*|dealer|reseller|stockist|wholesal\w*|supplier|portfolio)\b/.test(text);
  }
  return /\b(?:factory|plant|manufactur\w*|production\s+facilit\w*|operator|producer|mill|foundry)\b/.test(text);
}

function resolveBuyerType(input: {
  leadBuyerType: string;
  campaignBuyerTypes: readonly string[];
  sources: readonly PublicSource[];
  allowCampaignFallback: boolean;
}): BuyerType | null {
  const observed = normalizeBuyerType(input.leadBuyerType);
  const allowed = normalizeBuyerTypes(input.campaignBuyerTypes);
  const candidates = allowed.length > 0 ? allowed : observed ? [observed] : [];
  if (candidates.length === 0) return null;

  const ranked = candidates.map((candidate, index) => ({
    candidate,
    index,
    evidenceCount: input.sources.filter((source) => supportsBuyerType(source, candidate)).length,
  })).sort((left, right) => right.evidenceCount - left.evidenceCount || left.index - right.index);
  const best = ranked[0];
  if (best && best.evidenceCount > 0) {
    const tied = ranked.filter((entry) => entry.evidenceCount === best.evidenceCount);
    if (observed && tied.some((entry) => entry.candidate === observed)) return observed;
    return best.candidate;
  }
  if (observed && candidates.includes(observed)) return observed;
  if (input.allowCampaignFallback) return candidates[0] ?? null;
  return candidates.length === 1 ? candidates[0]! : null;
}

function supportsScenario(source: PublicSource, lead: LeadRow): boolean {
  const sourceTokens = new Set(source.text.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const productTokens = String(lead.product).toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4 && !new Set(["industrial", "system", "equipment", "solution"]).has(token));
  if (productTokens.some((token) => sourceTokens.has(token))) return true;
  return productTokens.length > 0 && productTokens.some((token) => sourceTokens.has(token));
}

function excludedByBrief(brief: CampaignBrief, lead: LeadRow): boolean {
  const haystack = [lead.company, lead.domain, lead.buyer_type, lead.product]
    .join(" ").toLocaleLowerCase("en-US");
  return brief.exclusions.some((exclusion) => {
    const normalized = exclusion.trim().toLocaleLowerCase("en-US");
    return normalized.length >= 4 && haystack.includes(normalized);
  });
}

const ICP_PURCHASE_LANGUAGE = /\b(?:buying|purchasing|procuring|procurement|sourcing|rfq|tender|in\s+the\s+market|seeking|looking\s+for|current\s+(?:need|requirement|project)|upcoming\s+(?:need|requirement|project)|need(?:s|ed)?\s+(?:to\s+buy|a\s+supplier)|require(?:s|d)?\s+(?:a\s+supplier|supply))\b/i;
const SOURCE_PROMPT_INJECTION = /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)|(?:system|developer|assistant)\s*(?:message|prompt)?\s*:|\b(?:jailbreak|prompt\s+injection)\b|\[(?:INST|\/INST)\]|<\/?(?:script|system|assistant|developer)(?:\s|>)|reveal\s+(?:the\s+)?(?:prompt|instructions?|secrets?)/i;

function exactOutreachClaim(input: {
  source: PublicSource;
  lead: LeadRow;
  evidenceClass: OutreachEvidenceFact["evidenceClass"];
}): string | null {
  if (SOURCE_PROMPT_INJECTION.test(input.source.text)) return null;
  const trimmed = input.source.text.trim();
  if (!trimmed) return null;
  if (input.evidenceClass === "ACTIVE_INTENT") return trimmed.slice(0, 500).trim();

  const candidates = trimmed
    .split(/\r?\n+|(?<=[.!?])\s+|[;|•]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 20 && value.length <= 600)
    .filter((value) => !ICP_PURCHASE_LANGUAGE.test(value))
    .filter((value) => supportsScenario({ ...input.source, text: value }, input.lead));
  const identityTokens = companyTokens(input.lead.company);
  candidates.sort((left, right) => {
    const leftBound = Number(identityTokens.some((token) => left.toLocaleLowerCase("en-US").includes(token)));
    const rightBound = Number(identityTokens.some((token) => right.toLocaleLowerCase("en-US").includes(token)));
    return rightBound - leftBound || left.length - right.length;
  });
  return candidates[0]?.slice(0, 500).trim() ?? null;
}

function seniority(title: string): SeniorityLevel {
  if (/\b(?:owner|founder|chief|ceo|president|managing director|general manager)\b/i.test(title)) return "OWNER_C_SUITE";
  if (/\b(?:vice president|vp|director|head)\b/i.test(title)) return "VP_DIRECTOR_HEAD";
  if (/\bmanager\b/i.test(title)) return "MANAGER";
  if (/\b(?:engineer|specialist|officer|buyer|coordinator)\b/i.test(title)) return "SPECIALIST";
  return "OTHER";
}

function selectContact(
  db: AgentDatabase,
  lead: LeadRow,
  payload: AutonomousDiscoveryPayload,
  mappedBuyerType: BuyerType,
  now: Date,
): { contact: ContactRow; lineage: EmailLineage | null; recipient: RecipientTierDecision } | { blockers: string[] } {
  const contacts = db.listContactsForLead(lead.id) as StoredContactRow[];
  const sources = db.listLeadSources(lead.id) as StoredLeadSourceRow[];
  const lineages = new Map<string, EmailLineage>();
  const ranked = rankStoredContactRows({
    contacts,
    sources,
    accountId: lead.account_id,
    accountDomain: lead.domain,
    buyerType: mappedBuyerType,
    asOf: now,
    verificationFor: (contact, email) => {
      const lineage = db.getIndependentValidEmailVerification({
        contactId: String(contact.id),
        email,
        campaignId: payload.campaignId,
        versionId: payload.versionId,
        at: now.toISOString(),
      });
      if (lineage) lineages.set(String(contact.id), lineage);
      return lineage;
    },
    dncMatchFor: (_contact, email) => db.hasDncMatch([
      { type: "domain", value: lead.domain },
      { type: "company", value: lead.company },
      { type: "email", value: email },
    ]),
  });
  const selected = ranked.find((value) => value.ranking.sendable);
  if (selected) {
    const contact = selected.row as ContactRow;
    return {
      contact: {
        ...contact,
        email: selected.candidate.email.address,
        employment_verified_at: validDate(contact.employment_verified_at) ?? "",
      },
      lineage: lineages.get(String(contact.id)) ?? null,
      recipient: selected.recipient,
    };
  }

  const blockers = new Set<string>();
  for (const value of ranked) {
    const rawEmailStatus = String(value.row.email_status ?? "UNKNOWN").toUpperCase();
    for (const blocker of value.ranking.blockers) {
      if (blocker.code === "CONTACT_NOT_NAMED") blockers.add("AUTONOMOUS_CONTACT_NOT_NAMED");
      else if (blocker.code === "CONTACT_ROLE_IRRELEVANT") blockers.add("AUTONOMOUS_CONTACT_ROLE_IRRELEVANT");
      else if (blocker.code === "EMPLOYMENT_NOT_CURRENT" || blocker.code === "EMPLOYMENT_EXPIRED") {
        blockers.add("AUTONOMOUS_CONTACT_EMPLOYMENT_NOT_CURRENT");
      } else if (blocker.code === "EMAIL_NOT_INDEPENDENT") {
        blockers.add("AUTONOMOUS_EMAIL_INDEPENDENT_VALID_PROVENANCE_MISSING");
      } else if (blocker.code === "EMAIL_NOT_VALID") blockers.add("AUTONOMOUS_EMAIL_NOT_VALID");
      else if (blocker.code === "EMAIL_DOMAIN_MISMATCH" || blocker.code === "EMAIL_NOT_WORK") {
        blockers.add("AUTONOMOUS_EMAIL_DOMAIN_MISMATCH");
      } else if (blocker.code === "DNC_MATCH") blockers.add("AUTONOMOUS_DNC_MATCH");
      else if (blocker.code === "EMAIL_ROLE_ADDRESS" || blocker.code === "EMAIL_DISPOSABLE" ||
        blocker.code === "EMAIL_CATCH_ALL" || blocker.code === "EMAIL_CONFLICT") {
        blockers.add("AUTONOMOUS_EMAIL_POLICY_RISK");
      } else if (blocker.code === "EMAIL_OFFICIAL_PUBLICATION_MISSING") {
        blockers.add("AUTONOMOUS_RECIPIENT_TIER_C");
      } else if (blocker.code === "RECIPIENT_TIER_C") {
        blockers.add(!Number(value.row.role_address) && rawEmailStatus !== "VALID"
          ? "AUTONOMOUS_EMAIL_NOT_VALID"
          : "AUTONOMOUS_RECIPIENT_TIER_C");
      }
    }
    if (!normalizePublicHttpUrl(String(value.row.source_url ?? "")) && value.recipient.tier === "A") {
      blockers.add("AUTONOMOUS_CONTACT_PUBLIC_SOURCE_MISSING");
    }
    if (value.recipient.blockers.some((code) => code.includes("DOMAIN_MISMATCH"))) {
      blockers.add("AUTONOMOUS_EMAIL_DOMAIN_MISMATCH");
    }
    if (rawEmailStatus === "INVALID" || Number(value.row.disposable_address)) {
      blockers.add(value.recipient.tier === "B" ? "AUTONOMOUS_TIER_B_EMAIL_UNSAFE" : "AUTONOMOUS_EMAIL_POLICY_RISK");
    }
  }
  return { blockers: blockers.size > 0 ? [...blockers].sort() : ["AUTONOMOUS_SENDABLE_CONTACT_MISSING"] };
}

function evidenceMaterial(input: {
  lead: LeadRow;
  accountId: string;
  source: PublicSource;
  claim: string;
  suffix: string;
  evidenceClass: OutreachEvidenceFact["evidenceClass"];
  relationship: OutreachEvidenceFact["independence"]["relationship"];
}): { snapshot: PageSnapshot; fact: OutreachEvidenceFact } {
  const snapshot = createPageSnapshot({
    id: stableId("snapshot", input.lead.id, input.source.id, input.suffix),
    accountId: input.accountId,
    leadId: input.lead.id,
    subject: input.lead.company,
    sourceUrl: input.source.url,
    publisher: {
      id: `publisher:${input.source.publisherDomain}`,
      name: input.source.publisherDomain,
      domain: input.source.publisherDomain,
    },
    text: input.source.text,
    publishedAt: input.source.publishedAt,
    retrievedAt: input.source.retrievedAt,
  });
  return {
    snapshot,
    fact: {
      schemaVersion: "evidence-fact-v2",
      id: stableId("fact", input.lead.id, input.source.id, input.suffix),
      accountId: input.accountId,
      leadId: input.lead.id,
      subject: input.lead.company,
      claim: input.claim,
      exactQuote: input.claim,
      sourceUrl: snapshot.sourceUrl,
      sourceSnapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      observedAt: input.source.publishedAt ?? input.source.retrievedAt,
      publishedAt: input.source.publishedAt,
      retrievedAt: input.source.retrievedAt,
      expiresAt: null,
      publisher: snapshot.publisher,
      independence: {
        publisherKey: snapshot.publisher.id,
        relationship: input.relationship,
        independentFromSeller: true,
        independentFromAccount: input.relationship === "INDEPENDENT",
      },
      evidenceClass: input.evidenceClass,
      allowedUses: ["RESEARCH", "OUTREACH", "QUALIFICATION"],
      visibility: "PUBLIC",
      confidence: "HIGH",
    },
  };
}

function qualificationFact(input: {
  id: string;
  accountId: string;
  source: PublicSource;
  claimType: QualificationEvidenceFact["claimType"];
  uses: QualificationEvidenceFact["allowedQualificationUses"];
  signalType?: SignalType | null;
  effectiveAt?: string | null;
  official: boolean;
}): QualificationEvidenceFact {
  return {
    id: input.id,
    subjectEntityId: input.accountId,
    claimType: input.claimType,
    signalType: input.signalType ?? null,
    publisherDomain: input.source.publisherDomain,
    independenceKey: `source:${input.source.url}`,
    originalDocumentKey: `document:${input.source.url}`,
    authorityClass: input.official ? "T1_COMPANY_OFFICIAL" : "OTHER",
    authorityAllowlisted: false,
    sourceKind: input.official ? "OFFICIAL_WEBSITE" : "PUBLIC_WEB",
    subjectRole: "BUYER",
    exactQuote: input.source.text,
    entityBound: true,
    effectiveAt: input.effectiveAt ?? null,
    observedAt: input.source.retrievedAt,
    expiresAt: futureDate(input.source.retrievedAt, 365),
    status: "CURRENT",
    confidence: 0.9,
    humanReview: "UNREVIEWED",
    allowedQualificationUses: input.uses,
    allowedForOutreach: true,
  };
}

function sourceIsOfficial(source: PublicSource, lead: LeadRow): boolean {
  return source.publisherDomain === normalizedDomain(lead.domain);
}

function directIntent(input: {
  lead: LeadRow;
  sources: readonly PublicSource[];
  now: Date;
}): { source: PublicSource; signalType: SignalType; effectiveAt: string } | null {
  let decoded: unknown = [];
  try {
    decoded = JSON.parse(input.lead.demand_evidence_json) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;
  for (const entry of decoded) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const evidence = entry as Record<string, unknown>;
    if (evidence.reviewEligible !== true) continue;
    const sourceUrl = normalizePublicHttpUrl(String(evidence.sourceUrl ?? ""));
    const quote = truncate(String(evidence.quote ?? ""), 20_000);
    const effectiveAt = validDate(evidence.sourceDate);
    if (!sourceUrl || !quote || !effectiveAt || Date.parse(effectiveAt) > input.now.getTime()) continue;
    const source = input.sources.find((candidate) => candidate.url === sourceUrl && candidate.text.includes(quote));
    if (!source || !sourceIsOfficial(source, input.lead)) continue;
    const stage = String(evidence.stage ?? "");
    let signalType: SignalType | null = null;
    if (stage === "SUPPLIER_REPLACEMENT" && /\b(?:replacement supplier|new supplier|second source|supplier change)\b/i.test(quote)) {
      signalType = "SUPPLIER_REPLACEMENT";
    } else if (stage === "CURRENT_PROJECT" && /\b(?:project|new plant|new factory|expansion|new line|upgrade)\b/i.test(quote)) {
      signalType = /\b(?:new plant|new factory)\b/i.test(quote) ? "NEW_PLANT" :
        /\bnew line\b/i.test(quote) ? "NEW_LINE" : /\bexpansion\b/i.test(quote) ? "PLANT_EXPANSION" : "CURRENT_PROJECT";
    } else if (stage === "RECENT_PROCUREMENT" && /\b(?:rfq|request for quotation|tender|invites? bids?)\b/i.test(quote)) {
      signalType = "TENDER";
    }
    if (signalType) return { source: { ...source, text: quote }, signalType, effectiveAt };
  }
  return null;
}

function sellerOffer(
  sellerStore: SellerKnowledgeStore,
  offerIds: readonly string[],
  market: string,
  now: Date,
): SellerOffer | null {
  for (const offerId of offerIds) {
    const offer = sellerStore.getApprovedOffer(offerId, market, "EMAIL", now);
    if (offer) return offer;
  }
  return null;
}

function makeCandidate(input: {
  contact: ContactRow;
  observed: OutreachEvidenceFact;
  track: Exclude<QualificationTrack, "WATCHLIST">;
  offer: SellerOffer;
  sellerKnowledge: SellerKnowledgeDocument;
}): PersonalizationPlanCandidate {
  const product = input.sellerKnowledge.profile.products.find((item) => item.id === input.offer.productId);
  if (!product) throw new Error("Approved offer product is missing from bound seller knowledge");
  return {
    buyerRoleFamily: truncate(input.contact.title, 160),
    processFocus: "documented industrial application",
    productRequirement: null,
    application: truncate(input.observed.claim, 500),
    matchedProductFamily: product.name,
    whyNowSignal: input.track === "ACTIVE_INTENT"
      ? { text: input.observed.claim, factIds: [input.observed.id] }
      : null,
    observedFact: { text: input.observed.claim, factIds: [input.observed.id] },
    relevanceHypothesis: {
      text: `This may make ${product.name} relevant to the documented application.`,
      factIds: [input.observed.id],
      hedged: true,
    },
    approvedOffer: {
      offerId: input.offer.id,
      text: input.offer.text,
      sellerFactIds: [...input.offer.sellerFactIds],
    },
    cta: {
      type: "OFFER_ASSET",
      text: "Would it be useful if I sent the approved product material?",
    },
    angle: `${product.name} application`,
    locale: "en",
  };
}

function buildQualificationInput(input: {
  plan: PersonalizationPlan;
  lead: LeadRow;
  contact: ContactRow;
  buyerType: BuyerType;
  identity: QualificationEvidenceFact;
  scenario: QualificationEvidenceFact | null;
  buyer: QualificationEvidenceFact | null;
  activeIntent: QualificationEvidenceFact | null;
  lineage: EmailLineage | null;
  recipient: RecipientTierDecision;
  sellerStore: SellerKnowledgeStore;
  offer: SellerOffer;
  excluded: boolean;
  now: Date;
}): QualificationInput {
  const tierB = input.recipient.tier === "B";
  const employmentAt = tierB
    ? input.recipient.evidenceObservedAt!
    : input.contact.employment_verified_at;
  const emailObservedAt = tierB ? input.recipient.evidenceObservedAt! : input.lineage!.observedAt;
  const emailExpiresAt = tierB ? input.recipient.evidenceExpiresAt! : input.lineage!.expiresAt;
  const discoverySourceKey = tierB ? "OFFICIAL_SITE_PUBLICATION" : input.lineage!.discoverySourceKey;
  const verifierSourceKey = tierB ? "OFFICIAL_SITE_PUBLICATION" : input.lineage!.verifierSourceKey;
  const assertionIds = tierB
    ? [input.recipient.evidenceHash!]
    : [input.lineage!.discoveryAssertionId, input.lineage!.verificationAssertionId];
  const facts = [input.identity, input.scenario, input.buyer, input.activeIntent]
    .filter((fact): fact is QualificationEvidenceFact => fact !== null);
  const draft = compileGroundedMessage(input.plan);
  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    asOf: input.now.toISOString(),
    rankScore: Math.max(0, Math.min(100, Number(input.lead.total_score) || 0)),
    account: {
      id: input.plan.accountId,
      buyerType: input.buyerType,
      officialDomains: [normalizedDomain(input.lead.domain)],
      identityVerified: true,
      identityFactIds: [input.identity.id],
      businessScenarioVerified: input.scenario !== null,
      businessScenarioFactIds: input.scenario ? [input.scenario.id] : [],
      buyerTypeMatchesPlay: true,
      buyerTypeFactIds: input.buyer ? [input.buyer.id] : [],
      dncMatch: false,
      excluded: input.excluded,
      ownershipConflict: false,
    },
    contact: {
      id: input.contact.id,
      accountId: input.plan.accountId,
      name: input.contact.name,
      named: !tierB,
      title: input.contact.title,
      roleFamily: tierB ? "OTHER" : inferRoleFamily(input.contact.title),
      seniority: tierB ? "OTHER" : seniority(input.contact.title),
      employment: {
        accountId: input.plan.accountId,
        status: tierB ? "UNKNOWN" : "CURRENT",
        observedAt: employmentAt,
        expiresAt: futureDate(employmentAt, 90),
        confidence: 0.9,
        assertionIds: [stableId("employment", input.contact.id, input.contact.source_url, employmentAt)],
        conflict: false,
      },
      email: {
        address: input.contact.email,
        status: String(input.contact.email_status) as "VALID" | "RISKY" | "UNKNOWN" | "INVALID",
        workEmail: true,
        roleAddress: tierB,
        disposable: false,
        catchAll: Boolean(input.contact.catch_all),
        domainMatchesAccount: true,
        discoverySourceKey,
        verifierSourceKey,
        independentlyVerified: tierB ? false : input.lineage!.independentlyVerified,
        observedAt: emailObservedAt,
        expiresAt: emailExpiresAt,
        confidence: tierB ? 0.8 : input.lineage!.confidence,
        assertionIds,
        conflict: false,
        officiallyPublished: tierB,
        officialSourceUrl: tierB ? input.recipient.evidenceUrl : null,
        officialObservedAt: tierB ? input.recipient.evidenceObservedAt : null,
        officialEvidenceHash: tierB ? input.recipient.evidenceHash : null,
      },
      evidenceConfidence: 0.9,
      lastEvidenceAt: Date.parse(emailObservedAt) >= Date.parse(employmentAt) ? emailObservedAt : employmentAt,
      dncMatch: false,
      excluded: input.excluded,
      ownershipConflict: false,
      conflicts: [],
      recipientTier: input.recipient.tier,
    },
    evidenceFacts: facts,
    seller: {
      sellerContextId: input.sellerStore.document.profile.id,
      sellerContextApproved: input.sellerStore.readiness.ready,
      offerId: input.offer.id,
      offerApproved: true,
    },
    message: {
      draftText: draft.body,
      grounded: true,
      citedFactIds: draft.referencedFactIds,
      unsupportedFactIds: [],
    },
  };
}

function buildForLead(input: {
  db: AgentDatabase;
  payload: AutonomousDiscoveryPayload;
  brief: CampaignBrief;
  sellerStore: SellerKnowledgeStore;
  lead: LeadRow;
  now: Date;
}): BuildResult {
  const blockers: string[] = [];
  const leadId = input.lead.id;
  const supportsIcpTrack = input.brief.qualificationTracks.includes("HIGH_ICP_FIT");
  const supportsActiveIntentTrack = input.brief.qualificationTracks.includes("ACTIVE_INTENT");
  const leadStatusAllowed = supportsIcpTrack
    ? ["VERIFYING", "ENRICHING", "READY_FOR_REVIEW"].includes(input.lead.status)
    : input.lead.status === "READY_FOR_REVIEW";
  const laneReady = supportsIcpTrack
    ? leadStatusAllowed
    : Number(input.lead.send_eligible) === 1 && Number(input.lead.demand_evidence_qualified) === 1;
  if (!leadStatusAllowed || !laneReady || Number(input.lead.human_takeover) !== 0) {
    return { payload: null, leadId, contactId: null, materialHash: null, blockers: ["AUTONOMOUS_LEAD_NOT_READY_FOR_REVIEW"] };
  }
  if (excludedByBrief(input.brief, input.lead)) {
    return { payload: null, leadId, contactId: null, materialHash: null, blockers: ["AUTONOMOUS_CAMPAIGN_EXCLUSION_MATCH"] };
  }
  const sellerDomain = normalizedDomain(input.sellerStore.document.profile.website);
  const sources = publicSources(input.db, input.lead, sellerDomain, input.now);
  const mappedBuyerType = resolveBuyerType({
    leadBuyerType: input.lead.buyer_type,
    campaignBuyerTypes: input.brief.buyerTypes,
    sources,
    allowCampaignFallback: supportsIcpTrack,
  });
  if (!mappedBuyerType) {
    return { payload: null, leadId, contactId: null, materialHash: null, blockers: ["AUTONOMOUS_BUYER_TYPE_UNSUPPORTED"] };
  }
  const contactResult = selectContact(input.db, input.lead, input.payload, mappedBuyerType, input.now);
  if ("blockers" in contactResult) {
    return { payload: null, leadId, contactId: null, materialHash: null, blockers: contactResult.blockers };
  }
  const { contact, lineage, recipient } = contactResult;
  const official = sources.find((source) => supportsIdentity(source, input.lead));
  const independent = sources.find((source) =>
    source.publisherDomain !== normalizedDomain(input.lead.domain) && supportsBuyerType(source, mappedBuyerType));
  const intent = supportsActiveIntentTrack
    ? directIntent({ lead: input.lead, sources, now: input.now })
    : null;
  const useActiveIntent = intent !== null;
  const useIcp = !useActiveIntent && supportsIcpTrack;
  const relaxedTierBIcp = useIcp && recipient.tier === "B";
  const scenario = useIcp ? sources.find((source) =>
    supportsScenario(source, input.lead) && (!relaxedTierBIcp || sourceIsOfficial(source, input.lead))) ?? null : null;
  if (!official) blockers.push("AUTONOMOUS_OFFICIAL_IDENTITY_EVIDENCE_MISSING");
  if (!relaxedTierBIcp && !independent) blockers.push("AUTONOMOUS_INDEPENDENT_BUYER_TYPE_EVIDENCE_MISSING");
  if (!relaxedTierBIcp && new Set(sources.map((source) => source.publisherDomain)).size < 2) {
    blockers.push("AUTONOMOUS_TWO_INDEPENDENT_PUBLIC_EVIDENCE_GROUPS_REQUIRED");
  }
  if (useIcp && !scenario) blockers.push("AUTONOMOUS_ICP_BUSINESS_SCENARIO_EVIDENCE_MISSING");
  if (!supportsIcpTrack && supportsActiveIntentTrack && !intent) {
    blockers.push("AUTONOMOUS_ACTIVE_INTENT_DIRECT_EVIDENCE_MISSING");
  }
  if (!supportsIcpTrack && !supportsActiveIntentTrack) {
    blockers.push("AUTONOMOUS_SUPPORTED_QUALIFICATION_TRACK_MISSING");
  }
  const offer = sellerOffer(input.sellerStore, input.payload.allowedOfferIds, input.brief.market, input.now);
  if (!offer) blockers.push("AUTONOMOUS_APPROVED_ACTIVE_OFFER_MISSING");
  if (blockers.length > 0 || !official || (!relaxedTierBIcp && !independent) || !offer ||
    (useIcp && !scenario) || (useActiveIntent && !intent)) {
    return { payload: null, leadId, contactId: contact.id, materialHash: null, blockers: [...new Set(blockers)].sort() };
  }

  const observedSource = useIcp ? scenario! : intent!.source;
  const evidenceClass = useIcp ? "FIT" as const : "ACTIVE_INTENT" as const;
  const observedClaim = exactOutreachClaim({ source: observedSource, lead: input.lead, evidenceClass });
  if (!observedClaim) {
    return {
      payload: null,
      leadId,
      contactId: contact.id,
      materialHash: null,
      blockers: ["AUTONOMOUS_OUTREACH_FACT_NOT_SAFE"],
    };
  }
  const outreach = evidenceMaterial({
    lead: input.lead,
    accountId: input.lead.account_id,
    source: observedSource,
    claim: observedClaim,
    suffix: useIcp ? "icp-scenario" : "active-intent",
    evidenceClass,
    relationship: sourceIsOfficial(observedSource, input.lead) ? "FIRST_PARTY" : "INDEPENDENT",
  });
  const identityFact = qualificationFact({
    id: stableId("qfact", leadId, official.id, "identity"),
    accountId: input.lead.account_id,
    source: official,
    claimType: "ACCOUNT_IDENTITY",
    uses: ["ICP_IDENTITY"],
    official: true,
  });
  const scenarioFact = useIcp ? qualificationFact({
    id: outreach.fact.id,
    accountId: input.lead.account_id,
    source: scenario!,
    claimType: "BUSINESS_SCENARIO",
    uses: ["ICP_BUSINESS_SCENARIO"],
    official: sourceIsOfficial(scenario!, input.lead),
  }) : null;
  const buyerFact = independent ? qualificationFact({
    id: stableId("qfact", leadId, independent.id, "buyer-type"),
    accountId: input.lead.account_id,
    source: independent,
    claimType: "BUYER_TYPE",
    uses: ["ICP_BUYER_TYPE"],
    official: false,
  }) : null;
  const activeFact = useActiveIntent ? qualificationFact({
    id: outreach.fact.id,
    accountId: input.lead.account_id,
    source: intent!.source,
    claimType: "ACTIVE_INTENT",
    uses: ["ACTIVE_INTENT"],
    signalType: intent!.signalType,
    effectiveAt: intent!.effectiveAt,
    official: true,
  }) : null;
  const track = useIcp ? "ICP_FIT" as const : "ACTIVE_INTENT" as const;
  const candidate = makeCandidate({
    contact,
    observed: outreach.fact,
    track,
    offer,
    sellerKnowledge: input.sellerStore.document,
  });
  const planResult = createPersonalizationPlan({
    id: stableId("autonomous-plan", input.payload.sendAuthorizationId, leadId, contact.id),
    accountId: input.lead.account_id,
    accountName: input.lead.company,
    leadId,
    contactId: contact.id,
    contactName: contact.name,
    market: input.brief.market,
    channel: "EMAIL",
    qualificationTrack: track,
    candidate,
    evidenceFacts: [outreach.fact],
    snapshots: [outreach.snapshot],
    sellerStore: input.sellerStore,
    versions: {
      dossierVersion: 1,
      playVersion: 1,
      qualificationPolicyVersion: QUALIFICATION_POLICY_VERSION,
      plannerVersion: "autonomous-discovery-bridge-v1",
      localeVersion: 1,
    },
    now: input.now,
  });
  if (!planResult.plan) {
    return {
      payload: null,
      leadId,
      contactId: contact.id,
      materialHash: null,
      blockers: planResult.blockers.map((blocker) => `AUTONOMOUS_PLAN_BLOCKED:${blocker}`).sort(),
    };
  }
  const qualificationInput = buildQualificationInput({
    plan: planResult.plan,
    lead: input.lead,
    contact,
    buyerType: mappedBuyerType,
    identity: identityFact,
    scenario: scenarioFact,
    buyer: buyerFact,
    activeIntent: activeFact,
    lineage,
    recipient,
    sellerStore: input.sellerStore,
    offer,
    excluded: false,
    now: input.now,
  });
  const decision = evaluateQualification(qualificationInput);
  if (!decision.eligible || decision.track !== track) {
    return {
      payload: null,
      leadId,
      contactId: contact.id,
      materialHash: null,
      blockers: decision.blockers.map((blocker) => `AUTONOMOUS_QUALIFICATION_BLOCKED:${blocker.code}`).sort(),
    };
  }
  const canonical = input.db.db.prepare(
    `SELECT p.id AS person_id, pe.id AS enrollment_id
     FROM people p
     LEFT JOIN play_enrollments pe ON pe.legacy_lead_id=? AND pe.campaign_id=?
     WHERE p.legacy_contact_id=? LIMIT 1`,
  ).get(leadId, input.payload.campaignId, contact.id) as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = {
    plan: planResult.plan,
    evidenceFacts: [outreach.fact],
    snapshots: [outreach.snapshot],
    sellerKnowledge: input.sellerStore.document,
    qualificationInput,
    destination: contact.email,
    messageKey: `autonomous:${input.payload.sendAuthorizationId}:${leadId}:${contact.id}:0`,
    planKey: `autonomous:${input.payload.sendAuthorizationId}:${leadId}:${contact.id}`,
    sequenceIndex: 0,
    personId: canonical?.person_id ? String(canonical.person_id) : null,
    enrollmentId: canonical?.enrollment_id ? String(canonical.enrollment_id) : null,
    dossierVersionId: null,
    campaignSendAuthorizationId: input.payload.sendAuthorizationId,
    scheduledAt: input.now.toISOString(),
    evaluatorVersion: "campaign-message-gate-v1",
    createdBy: input.payload.createdBy,
    replyChatId: input.payload.replyChatId,
  };
  return {
    payload,
    leadId,
    contactId: contact.id,
    materialHash: hash(payload),
    blockers: [],
  };
}

function recordBlockers(
  db: AgentDatabase,
  campaignId: string,
  sendAuthorizationId: string,
  leadId: string | null,
  codes: readonly string[],
): void {
  const normalized = [...new Set(codes)].sort();
  const key = `autonomous_message_blocker:${sendAuthorizationId}:${leadId ?? "campaign"}`;
  const value = canonicalJson({ schemaVersion: "autonomous-message-blocker-v1", codes: normalized });
  if (db.getSetting(key) === value) return;
  db.runInTransaction(() => {
    db.setSetting(key, value);
    db.recordEvent(
      leadId ? "lead" : "campaign",
      leadId ?? campaignId,
      "AUTONOMOUS_MESSAGE_STAGING_BLOCKED",
      "autonomous-discovery-bridge",
      { sendAuthorizationId, codes: normalized },
    );
  });
}

function invalidBridgeResult(campaignId: string | null, codes: string[]): AutonomousDiscoveryMessageBridgeResult {
  return {
    status: "BLOCKED",
    campaignId,
    examined: 0,
    enqueued: 0,
    alreadyStaged: 0,
    blocked: 1,
    jobIds: [],
    blockers: [{ leadId: null, codes: [...new Set(codes)].sort() }],
  };
}

export function enqueueAutonomousGroundedMessagesAfterDiscovery(input: {
  db: AgentDatabase;
  discoveryPayload: unknown;
  now?: Date;
}): AutonomousDiscoveryMessageBridgeResult {
  const parsed = AutonomousDiscoveryPayloadSchema.safeParse(input.discoveryPayload);
  if (!parsed.success) {
    const raw = input.discoveryPayload && typeof input.discoveryPayload === "object"
      ? input.discoveryPayload as Record<string, unknown>
      : {};
    if (!raw.sendAuthorizationId && !raw.sellerKnowledgeHash) {
      return {
        status: "NOT_AUTONOMOUS",
        campaignId: raw.campaignId ? String(raw.campaignId) : null,
        examined: 0,
        enqueued: 0,
        alreadyStaged: 0,
        blocked: 0,
        jobIds: [],
        blockers: [],
      };
    }
    const campaignId = raw.campaignId ? String(raw.campaignId) : null;
    const codes = parsed.error.issues.map((issue) =>
      `AUTONOMOUS_DISCOVERY_PAYLOAD_INVALID:${issue.path.join(".") || "$root"}`).sort();
    if (campaignId && raw.sendAuthorizationId) {
      recordBlockers(input.db, campaignId, String(raw.sendAuthorizationId), null, codes);
    }
    return invalidBridgeResult(campaignId, codes);
  }
  const payload = parsed.data;
  const now = input.now ?? new Date();
  const globalBlockers: string[] = [];
  const brief = loadCampaignBrief(input.db, payload);
  if (!brief) globalBlockers.push("AUTONOMOUS_BRIEF_BINDING_INVALID");
  if (brief && !sameStringSet(brief.offerIds, payload.allowedOfferIds)) {
    globalBlockers.push("AUTONOMOUS_ALLOWED_OFFERS_CHANGED");
  }
  if (launchSellerHash(input.db, payload.launchKey) !== payload.sellerKnowledgeHash) {
    globalBlockers.push("AUTONOMOUS_SELLER_LAUNCH_BINDING_INVALID");
  }
  if (deterministicSellerContentHash(payload.sellerKnowledge) !== payload.sellerKnowledgeHash) {
    globalBlockers.push("AUTONOMOUS_SELLER_HASH_MISMATCH");
  }
  if (payload.sellerKnowledge.privateCases.length > 0) {
    globalBlockers.push("AUTONOMOUS_PRIVATE_SELLER_CASES_IN_JOB_PAYLOAD");
  }
  const sellerStore = new SellerKnowledgeStore(payload.sellerKnowledge, now);
  if (!sellerStore.readiness.ready) {
    globalBlockers.push(...sellerStore.readiness.blockers.map((blocker) => `AUTONOMOUS_SELLER_NOT_READY:${blocker}`));
  }
  const sendAuthorization = input.db.db.prepare(
    `SELECT csa.total_limit, csa.valid_from, csa.expires_at,
            CASE WHEN revocation.id IS NULL THEN 0 ELSE 1 END AS revoked
     FROM campaign_send_authorizations csa
     LEFT JOIN campaign_send_authorization_revocations revocation
       ON revocation.campaign_send_authorization_id=csa.id
     WHERE csa.id=? AND csa.campaign_id=? AND csa.brief_id=? AND csa.version_id=?
       AND csa.brief_hash=? AND csa.maximum_sequence_index=0`,
  ).get(
    payload.sendAuthorizationId,
    payload.campaignId,
    payload.briefId,
    payload.versionId,
    payload.briefHash,
  ) as Record<string, unknown> | undefined;
  if (!sendAuthorization || Number(sendAuthorization.revoked) !== 0 ||
    String(sendAuthorization.valid_from) > now.toISOString() ||
    String(sendAuthorization.expires_at) <= now.toISOString()) {
    globalBlockers.push("AUTONOMOUS_SEND_AUTHORIZATION_INACTIVE_OR_MISMATCHED");
  }
  if (globalBlockers.length > 0 || !brief) {
    recordBlockers(input.db, payload.campaignId, payload.sendAuthorizationId, null, globalBlockers);
    return invalidBridgeResult(payload.campaignId, globalBlockers);
  }

  const existingAuthorizedRows = input.db.db.prepare(
    `SELECT DISTINCT om.lead_id, om.contact_id
     FROM outbound_messages om
     JOIN campaign_message_authorizations cma ON cma.outbound_message_id=om.id
     WHERE cma.campaign_send_authorization_id=? AND om.sequence_index=0`,
  ).all(payload.sendAuthorizationId) as Array<{ lead_id: string; contact_id: string }>;
  const remainingAuthorizationCapacity = Math.max(
    0,
    Number(sendAuthorization?.total_limit ?? 0) - existingAuthorizedRows.length,
  );
  const existingAuthorizedLeads = new Set(existingAuthorizedRows.map((row) => row.lead_id));
  const leads = input.db.db.prepare(
    `SELECT l.*, lal.account_id
     FROM leads l
     JOIN lead_account_links lal ON lal.lead_id=l.id
     WHERE l.campaign_id=? AND l.status IN (${brief.qualificationTracks.includes("HIGH_ICP_FIT")
       ? "'VERIFYING','ENRICHING','READY_FOR_REVIEW'"
       : "'READY_FOR_REVIEW'"})
     ORDER BY l.total_score DESC, l.id`,
  ).all(payload.campaignId) as LeadRow[];
  if (leads.length === 0 && existingAuthorizedRows.length === 0) {
    const codes = ["AUTONOMOUS_READY_FOR_REVIEW_LEAD_MISSING"];
    recordBlockers(input.db, payload.campaignId, payload.sendAuthorizationId, null, codes);
    return invalidBridgeResult(payload.campaignId, codes);
  }
  const jobIds: string[] = [];
  const blockerRows: Array<{ leadId: string | null; codes: string[] }> = [];
  let enqueued = 0;
  let alreadyStaged = existingAuthorizedRows.length;
  for (const lead of leads) {
    if (existingAuthorizedLeads.has(lead.id)) continue;
    if (enqueued >= remainingAuthorizationCapacity) {
      const codes = ["AUTONOMOUS_CAMPAIGN_TOTAL_AUTHORIZATION_LIMIT_REACHED"];
      recordBlockers(input.db, payload.campaignId, payload.sendAuthorizationId, lead.id, codes);
      blockerRows.push({ leadId: lead.id, codes });
      continue;
    }
    const built = buildForLead({ db: input.db, payload, brief, sellerStore, lead, now });
    if (!built.payload || !built.contactId || !built.materialHash) {
      recordBlockers(input.db, payload.campaignId, payload.sendAuthorizationId, lead.id, built.blockers);
      blockerRows.push({ leadId: lead.id, codes: built.blockers });
      continue;
    }
    const existingAuthorization = input.db.db.prepare(
      `SELECT om.id
       FROM outbound_messages om
       JOIN campaign_message_authorizations cma ON cma.outbound_message_id=om.id
       WHERE cma.campaign_send_authorization_id=? AND om.lead_id=? AND om.contact_id=?
         AND om.sequence_index=0 LIMIT 1`,
    ).get(payload.sendAuthorizationId, lead.id, built.contactId) as { id: string } | undefined;
    if (existingAuthorization) {
      alreadyStaged += 1;
      continue;
    }
    const stateKey = `autonomous_message_stage:${payload.sendAuthorizationId}:${lead.id}:${built.contactId}:0`;
    const previousRaw = input.db.getSetting(stateKey);
    if (previousRaw) {
      try {
        const previous = JSON.parse(previousRaw) as Record<string, unknown>;
        const previousJob = previous.jobId ? input.db.getJob(String(previous.jobId)) : null;
        if (previous.materialHash === built.materialHash && previousJob &&
          new Set(["QUEUED", "RUNNING", "COMPLETED"]).has(String(previousJob.status))) {
          alreadyStaged += 1;
          jobIds.push(String(previous.jobId));
          continue;
        }
      } catch {
        // Replace malformed mutable bridge state with newly constructed immutable material.
      }
    }
    const jobId = input.db.runInTransaction(() => {
      const queued = input.db.enqueueJob("STAGE_GROUNDED_MESSAGE", built.payload!, undefined, {
        dedupeKey: `autonomous-grounded:${payload.sendAuthorizationId}:${lead.id}:${built.contactId}:0`,
        lane: "OPERATIONS",
        priority: 80,
      });
      input.db.setSetting(stateKey, canonicalJson({
        schemaVersion: "autonomous-message-stage-state-v1",
        materialHash: built.materialHash,
        jobId: queued,
      }));
      input.db.recordEvent("lead", lead.id, "AUTONOMOUS_GROUNDED_MESSAGE_QUEUED", "autonomous-discovery-bridge", {
        campaignId: payload.campaignId,
        sendAuthorizationId: payload.sendAuthorizationId,
        jobId: queued,
        materialHash: built.materialHash,
      });
      return queued;
    });
    enqueued += 1;
    jobIds.push(jobId);
  }
  return {
    status: enqueued > 0 || alreadyStaged > 0 ? "STAGED" : "BLOCKED",
    campaignId: payload.campaignId,
    examined: leads.length,
    enqueued,
    alreadyStaged,
    blocked: blockerRows.length,
    jobIds,
    blockers: blockerRows,
  };
}

export function replayAuthorizedAutonomousCampaignMessages(input: {
  db: AgentDatabase;
  campaignIds?: readonly string[];
  now?: Date;
}): AutonomousCampaignReplayResult {
  const now = input.now ?? new Date();
  const requestedCampaignIds = [...new Set((input.campaignIds ?? []).map((value) => value.trim()).filter(Boolean))];
  const campaignFilter = requestedCampaignIds.length > 0
    ? ` AND csa.campaign_id IN (${requestedCampaignIds.map(() => "?").join(",")})`
    : "";
  const rows = input.db.db.prepare(
    `SELECT csa.campaign_id,
            (SELECT j.payload_json
             FROM jobs j
             WHERE j.job_type IN ('DISCOVER_CAMPAIGN','ENRICH_CONTACTS')
               AND json_extract(j.payload_json, '$.campaignId')=csa.campaign_id
               AND json_extract(j.payload_json, '$.sendAuthorizationId')=csa.id
             ORDER BY j.created_at DESC, j.id DESC
             LIMIT 1) AS payload_json
     FROM campaign_send_authorizations csa
     LEFT JOIN campaign_send_authorization_revocations revocation
       ON revocation.campaign_send_authorization_id=csa.id
     WHERE revocation.id IS NULL AND csa.valid_from<=? AND csa.expires_at>?
       ${campaignFilter}
     ORDER BY csa.campaign_id, csa.id`,
  ).all(now.toISOString(), now.toISOString(), ...requestedCampaignIds) as Array<{
    campaign_id: string;
    payload_json: string | null;
  }>;

  const campaigns = rows.map((row) => {
    if (!row.payload_json) {
      return {
        campaignId: row.campaign_id,
        status: "BLOCKED" as const,
        examined: 0,
        enqueued: 0,
        alreadyStaged: 0,
        blocked: 1,
        blockerCodes: ["AUTONOMOUS_DISCOVERY_PAYLOAD_MISSING"],
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      payload = {};
    }
    const result = enqueueAutonomousGroundedMessagesAfterDiscovery({ db: input.db, discoveryPayload: payload, now });
    return {
      campaignId: row.campaign_id,
      status: result.status,
      examined: result.examined,
      enqueued: result.enqueued,
      alreadyStaged: result.alreadyStaged,
      blocked: result.blocked,
      blockerCodes: [...new Set(result.blockers.flatMap((entry) => entry.codes))].sort(),
    };
  });
  return {
    campaignCount: campaigns.length,
    examined: campaigns.reduce((sum, result) => sum + result.examined, 0),
    enqueued: campaigns.reduce((sum, result) => sum + result.enqueued, 0),
    alreadyStaged: campaigns.reduce((sum, result) => sum + result.alreadyStaged, 0),
    blocked: campaigns.reduce((sum, result) => sum + result.blocked, 0),
    campaigns,
  };
}

export function getAutonomousMessageBridgeDiagnostics(
  db: AgentDatabase,
): AutonomousMessageBridgeDiagnostics {
  const scalar = (sql: string): number => Number(
    (db.db.prepare(sql).get() as { count: number } | undefined)?.count ?? 0,
  );
  const activeAuthorizations = `SELECT csa.id, csa.campaign_id
    FROM campaign_send_authorizations csa
    LEFT JOIN campaign_send_authorization_revocations revocation
      ON revocation.campaign_send_authorization_id=csa.id
    WHERE revocation.id IS NULL
      AND csa.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND csa.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const blockerCounts = new Map<string, number>();
  const blockerRows = db.db.prepare(
    `SELECT payload_json FROM events
     WHERE event_type='AUTONOMOUS_MESSAGE_STAGING_BLOCKED'
     ORDER BY created_at DESC, id DESC LIMIT 5000`,
  ).all() as Array<{ payload_json: string }>;
  for (const row of blockerRows) {
    try {
      const payload = JSON.parse(row.payload_json) as { codes?: unknown };
      if (!Array.isArray(payload.codes)) continue;
      for (const rawCode of payload.codes) {
        const code = String(rawCode ?? "").trim();
        if (code) blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
      }
    } catch {
      // Historical malformed audit rows are ignored; they never become sendable state.
    }
  }
  return {
    authorizedCampaigns: scalar(`SELECT count(DISTINCT campaign_id) AS count FROM (${activeAuthorizations})`),
    authorizedLeads: scalar(
      `SELECT count(*) AS count FROM leads WHERE campaign_id IN (SELECT campaign_id FROM (${activeAuthorizations}))`,
    ),
    contactsWithEmail: scalar(
      `SELECT count(*) AS count FROM contacts
       WHERE trim(coalesce(email,''))<>'' AND lead_id IN (
         SELECT id FROM leads WHERE campaign_id IN (SELECT campaign_id FROM (${activeAuthorizations})))`,
    ),
    stageJobs: scalar(
      "SELECT count(*) AS count FROM jobs WHERE job_type='STAGE_GROUNDED_MESSAGE'",
    ),
    outboundMessages: scalar(
      `SELECT count(*) AS count FROM outbound_messages
       WHERE campaign_id IN (SELECT campaign_id FROM (${activeAuthorizations}))`,
    ),
    messageAuthorizations: scalar(
      `SELECT count(*) AS count FROM campaign_message_authorizations
       WHERE campaign_send_authorization_id IN (SELECT id FROM (${activeAuthorizations}))`,
    ),
    topBlockers: [...blockerCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, 3),
  };
}
