import { z } from "zod";
import { assessContactCandidate } from "./contact-ranking.js";
import { collapseIndependentSources, publisherDomainForSource } from "./source-independence.js";
import {
  ACTIVE_INTENT_TTL_DAYS,
  QUALIFICATION_POLICY_VERSION,
  evidenceFactSchema,
  parseQualificationInput,
  type EvidenceFact,
  type QualificationBlocker,
  type QualificationBlockerCode,
  type QualificationDecision,
  type QualificationInput,
} from "./models.js";

const millisecondsPerDay = 86_400_000;
const activeIntentSignalTypes = new Set([
  "TENDER",
  "SUPPLIER_REPLACEMENT",
  "CURRENT_PROJECT",
  "PLANT_EXPANSION",
  "NEW_PLANT",
  "NEW_LINE",
  "AIR_OR_ENVIRONMENTAL_PERMIT",
  "EPC_PROJECT_AWARD",
]);
const t2AuthorityClasses = new Set([
  "T2_GOVERNMENT",
  "T2_REGULATOR",
  "T2_EXCHANGE",
  "T2_PROJECT_OWNER",
  "T2_OFFICIAL_EPC",
]);

export interface PublisherIndependenceGroup {
  key: string;
  publisherDomains: string[];
  underlyingKeys: string[];
  factIds: string[];
}

export interface IcpFitLanguageIssue {
  code: "UNSUPPORTED_BUYING_ASSERTION";
  phrase: string;
  index: number;
}

export interface IcpFitLanguageLintResult {
  valid: boolean;
  issues: IcpFitLanguageIssue[];
}

function normalizePublisherDomain(value: string): string {
  return publisherDomainForSource({ id: value, publisherDomain: value });
}

export function collapseIndependentPublishers(factsInput: readonly EvidenceFact[]): PublisherIndependenceGroup[] {
  const facts = z.array(evidenceFactSchema).max(10_000).parse(factsInput);
  return collapseIndependentSources(facts.map((fact) => ({
    id: fact.id,
    publisherDomain: fact.publisherDomain,
    independenceKey: fact.independenceKey,
    originalDocumentKey: fact.originalDocumentKey,
  }))).map((group) => ({
    key: group.key,
    publisherDomains: group.publisherDomains,
    underlyingKeys: group.underlyingKeys,
    factIds: group.sourceIds,
  }));
}

const unsupportedBuyingPatterns: RegExp[] = [
  /\b(?:you|your company|your team)\s+(?:are|is|have been|has been)\s+(?:currently\s+)?(?:sourcing|buying|purchasing|procuring|seeking|looking for)\b/gi,
  /\b(?:because|since|given that)\s+(?:you|your company|your team)\s+(?:are|is|have been|has been)?\s*(?:currently\s+)?(?:sourcing|buying|purchasing|procuring|seeking|looking for)\b/gi,
  /\b(?:i|we)\s+(?:saw|noticed|learned|understand|understood|know|believe|heard)(?:\s+that)?[^.!?\n]{0,120}\b(?:sourcing|buying|purchasing|procuring|seeking|looking for|issued?\s+(?:an?\s+)?(?:tender|rfq|rfp))\b/gi,
  /\b(?:i|we)\s+(?:saw|noticed|learned about|came across)\s+your\s+(?:active\s+|current\s+|ongoing\s+|upcoming\s+)?(?:tender|rfq|rfp|procurement|sourcing initiative|purchase requirement|buying requirement)\b/gi,
  /\byour\s+(?:active\s+|current\s+|ongoing\s+|upcoming\s+)?(?:tender|rfq|rfp|procurement initiative|sourcing initiative|purchase requirement|buying requirement)\b/gi,
  /\b(?:i|we)\s+understand\s+(?:that\s+)?(?:you\s+)?(?:currently\s+)?(?:need|require|have\s+(?:a\s+)?(?:need|requirement|demand))\b/gi,
  /(?:看到|注意到|了解到|得知).{0,40}(?:正在|计划|寻求).{0,20}(?:采购|购买|寻找供应商|招标|询价)/g,
  /(?:贵司|贵公司|你们).{0,16}(?:正在|计划|目前需要).{0,20}(?:采购|购买|寻找供应商|招标|询价)/g,
  /(?:贵司|贵公司|你们)的?(?:当前|正在进行的|即将进行的)?(?:采购|招标|询价|寻源|购买需求)/g,
];

export function lintIcpFitLanguage(textInput: string): IcpFitLanguageLintResult {
  const text = z.string().trim().min(1).max(50_000).parse(textInput);
  const issues: IcpFitLanguageIssue[] = [];
  const seen = new Set<string>();
  for (const pattern of unsupportedBuyingPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const phrase = match[0];
      const index = match.index;
      if (phrase === undefined || index === undefined) continue;
      const key = `${index}:${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({ code: "UNSUPPORTED_BUYING_ASSERTION", phrase, index });
    }
  }
  issues.sort((left, right) => left.index - right.index || left.phrase.localeCompare(right.phrase));
  return { valid: issues.length === 0, issues };
}

function makeBlocker(
  code: QualificationBlockerCode,
  message: string,
  evidenceIds: string[] = [],
): QualificationBlocker {
  return { code, message, evidenceIds: [...new Set(evidenceIds)].sort() };
}

function deduplicateBlockers(blockers: QualificationBlocker[]): QualificationBlocker[] {
  const values = new Map<string, QualificationBlocker>();
  for (const item of blockers) {
    const key = `${item.code}:${item.evidenceIds.join(",")}`;
    if (!values.has(key)) values.set(key, item);
  }
  return [...values.values()];
}

function evidenceIsCurrent(fact: EvidenceFact, asOfMs: number): boolean {
  const observedMs = Date.parse(fact.observedAt);
  const expiresMs = Date.parse(fact.expiresAt);
  return fact.status === "CURRENT" && observedMs <= asOfMs && expiresMs >= asOfMs && expiresMs >= observedMs;
}

function evidenceSupports(
  fact: EvidenceFact | undefined,
  input: QualificationInput,
  claimType: EvidenceFact["claimType"],
  qualificationUse: EvidenceFact["allowedQualificationUses"][number],
): fact is EvidenceFact {
  if (!fact) return false;
  return fact.subjectEntityId === input.account.id &&
    fact.claimType === claimType &&
    fact.entityBound &&
    fact.allowedForOutreach &&
    fact.humanReview !== "REJECTED" &&
    fact.allowedQualificationUses.includes(qualificationUse) &&
    evidenceIsCurrent(fact, Date.parse(input.asOf));
}

function resolveAccountFacts(
  ids: string[],
  factById: ReadonlyMap<string, EvidenceFact>,
  input: QualificationInput,
  claimType: EvidenceFact["claimType"],
  qualificationUse: EvidenceFact["allowedQualificationUses"][number],
): EvidenceFact[] {
  return [...new Set(ids)]
    .map((id) => factById.get(id))
    .filter((fact): fact is EvidenceFact => evidenceSupports(fact, input, claimType, qualificationUse));
}

function activeIntentFresh(fact: EvidenceFact, asOfMs: number): boolean {
  if (!evidenceIsCurrent(fact, asOfMs) || !fact.effectiveAt) return false;
  const effectiveMs = Date.parse(fact.effectiveAt);
  const ageDays = (asOfMs - effectiveMs) / millisecondsPerDay;
  return effectiveMs <= asOfMs && ageDays >= 0 && ageDays <= ACTIVE_INTENT_TTL_DAYS;
}

function evaluateActiveIntentFacts(
  input: QualificationInput,
): { qualifyingFacts: EvidenceFact[]; blockers: QualificationBlocker[] } {
  const asOfMs = Date.parse(input.asOf);
  const officialDomains = new Set(input.account.officialDomains.map(normalizePublisherDomain));
  const candidates = input.evidenceFacts.filter((fact) =>
    fact.claimType === "ACTIVE_INTENT" || fact.allowedQualificationUses.includes("ACTIVE_INTENT"),
  );
  if (candidates.length === 0) {
    return {
      qualifyingFacts: [],
      blockers: [makeBlocker("ACTIVE_INTENT_MISSING", "no active-intent evidence is available")],
    };
  }

  const qualifyingFacts: EvidenceFact[] = [];
  const stale: string[] = [];
  const entityMismatch: string[] = [];
  const sourceNotAllowed: string[] = [];
  const t2ReviewMissing: string[] = [];

  for (const fact of candidates) {
    const signalAllowed = fact.signalType !== null && fact.signalType !== undefined && activeIntentSignalTypes.has(fact.signalType);
    const entityAllowed = fact.subjectEntityId === input.account.id && fact.entityBound && fact.subjectRole === "BUYER";
    const useAllowed = fact.allowedForOutreach && fact.allowedQualificationUses.includes("ACTIVE_INTENT") && signalAllowed;
    const fresh = activeIntentFresh(fact, asOfMs);
    const t1Allowed = fact.authorityClass === "T1_COMPANY_OFFICIAL" &&
      fact.sourceKind === "OFFICIAL_WEBSITE" &&
      fact.humanReview !== "REJECTED" &&
      officialDomains.has(normalizePublisherDomain(fact.publisherDomain));
    const isT2 = t2AuthorityClasses.has(fact.authorityClass);
    const t2Allowed = isT2 &&
      fact.sourceKind === "AUTHORITY_DOCUMENT" &&
      fact.authorityAllowlisted &&
      fact.humanReview === "APPROVED";

    if (!fresh) stale.push(fact.id);
    if (!entityAllowed) entityMismatch.push(fact.id);
    if (!useAllowed || (!t1Allowed && !isT2)) sourceNotAllowed.push(fact.id);
    if (isT2 && !t2Allowed) t2ReviewMissing.push(fact.id);
    if (fresh && entityAllowed && useAllowed && (t1Allowed || t2Allowed)) qualifyingFacts.push(fact);
  }

  if (qualifyingFacts.length > 0) return { qualifyingFacts, blockers: [] };
  const blockers: QualificationBlocker[] = [];
  if (stale.length > 0) {
    blockers.push(makeBlocker("ACTIVE_INTENT_STALE", "active-intent evidence is missing a current date or has expired", stale));
  }
  if (entityMismatch.length > 0) {
    blockers.push(makeBlocker("ACTIVE_INTENT_ENTITY_MISMATCH", "active-intent evidence is not bound to this buyer entity", entityMismatch));
  }
  if (sourceNotAllowed.length > 0) {
    blockers.push(makeBlocker(
      "ACTIVE_INTENT_SOURCE_NOT_ALLOWED",
      "active intent cannot be established by this source tier, source kind, or signal type",
      sourceNotAllowed,
    ));
  }
  if (t2ReviewMissing.length > 0) {
    blockers.push(makeBlocker(
      "ACTIVE_INTENT_T2_REVIEW_REQUIRED",
      "T2 evidence requires an authority-allowlisted direct document and approved human review",
      t2ReviewMissing,
    ));
  }
  if (blockers.length === 0) {
    blockers.push(makeBlocker("ACTIVE_INTENT_MISSING", "no evidence satisfies active-intent policy"));
  }
  return { qualifyingFacts: [], blockers };
}

function sharedBlockers(
  input: QualificationInput,
  identityFacts: EvidenceFact[],
  buyerTypeFacts: EvidenceFact[],
  requireBuyerTypeEvidence: boolean,
): QualificationBlocker[] {
  const blockers: QualificationBlocker[] = [];
  if (input.policyVersion !== QUALIFICATION_POLICY_VERSION) {
    blockers.push(makeBlocker(
      "POLICY_VERSION_STALE",
      `qualification must be recomputed under ${QUALIFICATION_POLICY_VERSION}`,
    ));
  }
  if (!input.account.identityVerified) {
    blockers.push(makeBlocker("ACCOUNT_IDENTITY_UNVERIFIED", "account identity is not verified"));
  }
  if (identityFacts.length === 0) {
    blockers.push(makeBlocker("ACCOUNT_IDENTITY_EVIDENCE_MISSING", "account identity lacks current outreach-eligible evidence"));
  }
  if (!input.account.buyerTypeMatchesPlay) {
    blockers.push(makeBlocker("BUYER_TYPE_MISMATCH", "account is not a target buyer type for the play"));
  }
  if (requireBuyerTypeEvidence && buyerTypeFacts.length === 0) {
    blockers.push(makeBlocker("BUYER_TYPE_EVIDENCE_MISSING", "target buyer type lacks current outreach-eligible evidence"));
  }
  if (input.account.dncMatch || input.contact.dncMatch) {
    blockers.push(makeBlocker("DNC_MATCH", "account or contact matches do-not-contact policy"));
  }
  if (input.account.excluded || input.contact.excluded) {
    blockers.push(makeBlocker("EXCLUSION_MATCH", "account or contact matches an exclusion policy"));
  }
  if (input.account.ownershipConflict || input.contact.ownershipConflict) {
    blockers.push(makeBlocker("OWNERSHIP_CONFLICT", "account or contact ownership is unresolved"));
  }

  const rankedContact = assessContactCandidate(input.contact, {
    accountId: input.account.id,
    buyerType: input.account.buyerType,
    asOf: input.asOf,
  });
  for (const contactBlocker of rankedContact.blockers) {
    blockers.push(makeBlocker(
      contactBlocker.code,
      contactBlocker.message,
      contactBlocker.assertionIds,
    ));
  }

  if (!input.seller.sellerContextApproved) {
    blockers.push(makeBlocker("SELLER_CONTEXT_UNAPPROVED", "seller context is not approved"));
  }
  if (!input.seller.offerApproved) blockers.push(makeBlocker("OFFER_UNAPPROVED", "offer is not approved"));

  const factById = new Map(input.evidenceFacts.map((fact) => [fact.id, fact]));
  const citedFacts = input.message.citedFactIds.map((id) => factById.get(id));
  if (!input.message.grounded || citedFacts.length === 0) {
    blockers.push(makeBlocker("MESSAGE_NOT_GROUNDED", "draft is not grounded in at least one cited fact"));
  }
  const invalidCitations = input.message.citedFactIds.filter((id) => {
    const fact = factById.get(id);
    return !fact || !fact.allowedForOutreach || !evidenceIsCurrent(fact, Date.parse(input.asOf));
  });
  const unsupportedFacts = [...new Set([...input.message.unsupportedFactIds, ...invalidCitations])];
  if (unsupportedFacts.length > 0) {
    blockers.push(makeBlocker("MESSAGE_FACTS_UNSUPPORTED", "draft cites missing, stale, or unsupported facts", unsupportedFacts));
  }
  return deduplicateBlockers(blockers);
}

function isOfficialAccountFact(fact: EvidenceFact, input: QualificationInput): boolean {
  const officialDomains = new Set(input.account.officialDomains.map(normalizePublisherDomain));
  return fact.authorityClass === "T1_COMPANY_OFFICIAL" &&
    fact.sourceKind === "OFFICIAL_WEBSITE" &&
    officialDomains.has(normalizePublisherDomain(fact.publisherDomain));
}

export function evaluateQualification(inputValue: unknown): QualificationDecision {
  const input = parseQualificationInput(inputValue);
  const factById = new Map(input.evidenceFacts.map((fact) => [fact.id, fact]));
  const identityFacts = resolveAccountFacts(
    input.account.identityFactIds,
    factById,
    input,
    "ACCOUNT_IDENTITY",
    "ICP_IDENTITY",
  );
  const businessScenarioFacts = resolveAccountFacts(
    input.account.businessScenarioFactIds,
    factById,
    input,
    "BUSINESS_SCENARIO",
    "ICP_BUSINESS_SCENARIO",
  );
  const buyerTypeFacts = resolveAccountFacts(
    input.account.buyerTypeFactIds,
    factById,
    input,
    "BUYER_TYPE",
    "ICP_BUYER_TYPE",
  );
  const tierBOfficialIcp = input.contact.recipientTier === "B" &&
    input.contact.email.roleAddress &&
    input.contact.email.officiallyPublished &&
    identityFacts.some((fact) => isOfficialAccountFact(fact, input)) &&
    businessScenarioFacts.some((fact) => isOfficialAccountFact(fact, input));
  const activeCommon = sharedBlockers(input, identityFacts, buyerTypeFacts, true);
  const icpCommon = sharedBlockers(input, identityFacts, buyerTypeFacts, !tierBOfficialIcp);
  const activeIntent = evaluateActiveIntentFacts(input);
  const activeBlockers = [...activeCommon, ...activeIntent.blockers];

  if (activeIntent.qualifyingFacts.length > 0) {
    const cited = new Set(input.message.citedFactIds);
    if (!activeIntent.qualifyingFacts.some((fact) => cited.has(fact.id))) {
      activeBlockers.push(makeBlocker(
        "MESSAGE_NOT_GROUNDED",
        "ACTIVE_INTENT draft must cite a qualifying why-now fact",
        activeIntent.qualifyingFacts.map((fact) => fact.id),
      ));
    }
  }

  const icpBlockers = [...icpCommon];
  if (!input.account.businessScenarioVerified) {
    icpBlockers.push(makeBlocker("BUSINESS_SCENARIO_UNVERIFIED", "industrial business scenario is not verified"));
  }
  if (businessScenarioFacts.length === 0) {
    icpBlockers.push(makeBlocker(
      "BUSINESS_SCENARIO_EVIDENCE_MISSING",
      "business scenario lacks current outreach-eligible evidence",
    ));
  }
  const icpFacts = [...identityFacts, ...businessScenarioFacts, ...buyerTypeFacts];
  const independentGroups = collapseIndependentPublishers(icpFacts);
  if (!tierBOfficialIcp && independentGroups.length < 2) {
    icpBlockers.push(makeBlocker(
      "INDEPENDENT_PUBLISHERS_INSUFFICIENT",
      "ICP_FIT requires at least two independent publisher or underlying-source groups",
      icpFacts.map((fact) => fact.id),
    ));
  }
  const icpFactIds = new Set(icpFacts.map((fact) => fact.id));
  if (!input.message.citedFactIds.some((id) => icpFactIds.has(id))) {
    icpBlockers.push(makeBlocker(
      "MESSAGE_NOT_GROUNDED",
      "ICP_FIT draft must cite a verified identity, buyer-type, or business-scenario fact",
      icpFacts.map((fact) => fact.id),
    ));
  }
  const languageLint = lintIcpFitLanguage(input.message.draftText);
  if (!languageLint.valid) {
    icpBlockers.push(makeBlocker(
      "ICP_FIT_LANGUAGE_UNSUPPORTED",
      "ICP_FIT draft asserts unsupported procurement or buying intent",
    ));
  }

  const cleanActiveBlockers = deduplicateBlockers(activeBlockers);
  const cleanIcpBlockers = deduplicateBlockers(icpBlockers);
  const whyContactAssertionIds = [...new Set(input.contact.employment.assertionIds)].sort();

  if (cleanActiveBlockers.length === 0) {
    const usedFacts = [...identityFacts, ...buyerTypeFacts, ...activeIntent.qualifyingFacts];
    return {
      track: "ACTIVE_INTENT",
      policyVersion: QUALIFICATION_POLICY_VERSION,
      eligible: true,
      blockers: [],
      laneBlockers: { activeIntent: [], icpFit: cleanIcpBlockers },
      rankScore: input.rankScore,
      whyNowFactIds: activeIntent.qualifyingFacts.map((fact) => fact.id).sort(),
      whyContactAssertionIds,
      independentPublisherKeys: collapseIndependentPublishers(usedFacts).map((group) => group.key),
      requiredReviewPolicy: "REVIEW_ALL",
    };
  }

  if (cleanIcpBlockers.length === 0) {
    return {
      track: "ICP_FIT",
      policyVersion: QUALIFICATION_POLICY_VERSION,
      eligible: true,
      blockers: [],
      laneBlockers: { activeIntent: cleanActiveBlockers, icpFit: [] },
      rankScore: input.rankScore,
      whyNowFactIds: [],
      whyContactAssertionIds,
      independentPublisherKeys: independentGroups.map((group) => group.key),
      requiredReviewPolicy: "REVIEW_ALL",
    };
  }

  const allRelevantFacts = [...icpFacts, ...activeIntent.qualifyingFacts];
  return {
    track: "WATCHLIST",
    policyVersion: QUALIFICATION_POLICY_VERSION,
    eligible: false,
    blockers: cleanIcpBlockers,
    laneBlockers: { activeIntent: cleanActiveBlockers, icpFit: cleanIcpBlockers },
    rankScore: input.rankScore,
    whyNowFactIds: activeIntent.qualifyingFacts.map((fact) => fact.id).sort(),
    whyContactAssertionIds,
    independentPublisherKeys: collapseIndependentPublishers(allRelevantFacts).map((group) => group.key),
    requiredReviewPolicy: "NOT_REVIEWABLE",
  };
}

export const qualifyAcquisitionCandidate = evaluateQualification;
