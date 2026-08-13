import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EvidenceFactSchema,
  PageSnapshotSchema,
  selectOutreachEvidenceFacts,
  type EvidenceFact,
  type PageSnapshot,
} from "./evidence.js";
import {
  SellerFactSchema,
  SellerOfferSchema,
  SellerProfileSchema,
  SellerKnowledgeStore,
  type SellerChannel,
  type SellerFact,
  type SellerOffer,
  type SellerProfile,
} from "./seller-knowledge.js";

export const PERSONALIZATION_PLAN_SCHEMA_VERSION = "personalization-plan-v2" as const;
export const MESSAGE_GROUNDING_LINT_VERSION = "message-grounding-lint-v2" as const;
export const GROUNDED_REVIEW_MATERIAL_VERSION = "grounded-review-material-v2" as const;

const IdSchema = z.string().trim().min(1).max(200);
const TextSchema = z.string().trim().min(1).max(2_000);
const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);

const FactTextSchema = z.object({
  text: TextSchema,
  factIds: z.array(IdSchema).min(1).max(50),
}).strict();

const RelevanceHypothesisSchema = z.object({
  text: TextSchema,
  factIds: z.array(IdSchema).min(1).max(50),
  hedged: z.literal(true),
}).strict();

const ApprovedOfferReferenceSchema = z.object({
  offerId: IdSchema,
  text: TextSchema,
  sellerFactIds: z.array(IdSchema).min(1).max(100),
}).strict();

const CtaSchema = z.object({
  type: z.enum(["ASK_CORRECT_CONTACT", "OFFER_ASSET", "DISCOVERY_CALL", "REPLY_WITH_SPEC"]),
  text: TextSchema.max(500),
}).strict();

export const PersonalizationPlanCandidateSchema = z.object({
  buyerRoleFamily: TextSchema.max(160),
  processFocus: TextSchema.max(300),
  productRequirement: TextSchema.max(300).nullable(),
  application: TextSchema.max(500),
  matchedProductFamily: TextSchema.max(300),
  whyNowSignal: FactTextSchema.nullable(),
  observedFact: FactTextSchema,
  relevanceHypothesis: RelevanceHypothesisSchema,
  approvedOffer: ApprovedOfferReferenceSchema,
  cta: CtaSchema,
  angle: TextSchema.max(240),
  locale: z.string().trim().min(2).max(40),
}).strict();

const SellerIdentitySchema = z.object({
  profileId: IdSchema,
  profileVersion: z.number().int().positive(),
  legalNameEn: TextSchema.max(240),
  brandNameEn: TextSchema.max(240),
  senderName: TextSchema.max(160),
  senderEmail: z.string().trim().email().max(320),
  postalAddress: z.object({
    line1: TextSchema.max(300),
    line2: TextSchema.max(300).optional(),
    city: TextSchema.max(160),
    region: TextSchema.max(160).optional(),
    postalCode: TextSchema.max(40),
    country: TextSchema.max(120),
  }).strict(),
  unsubscribeInstruction: TextSchema.max(500),
}).strict();

const PlanVersionsSchema = z.object({
  dossierVersion: z.number().int().positive(),
  sellerFactSetVersion: z.number().int().positive(),
  playVersion: z.number().int().positive(),
  qualificationPolicyVersion: TextSchema.max(120),
  plannerVersion: TextSchema.max(120),
  localeVersion: z.number().int().positive(),
}).strict();

export const PersonalizationPlanSchema = PersonalizationPlanCandidateSchema.extend({
  schemaVersion: z.literal(PERSONALIZATION_PLAN_SCHEMA_VERSION),
  id: IdSchema,
  accountId: IdSchema,
  accountName: TextSchema.max(300),
  leadId: IdSchema,
  contactId: IdSchema,
  contactName: TextSchema.max(240),
  market: TextSchema.max(120),
  channel: z.enum(["EMAIL", "LINKEDIN", "WHATSAPP", "WEBSITE"]),
  qualificationTrack: z.enum(["ACTIVE_INTENT", "ICP_FIT"]),
  sellerIdentity: SellerIdentitySchema,
  versions: PlanVersionsSchema,
  createdAt: IsoDateTimeSchema,
}).strict();

export type PersonalizationPlanCandidate = z.infer<typeof PersonalizationPlanCandidateSchema>;
export type PersonalizationPlan = z.infer<typeof PersonalizationPlanSchema>;

export interface CreatePersonalizationPlanInput {
  id: string;
  accountId: string;
  accountName: string;
  leadId: string;
  contactId: string;
  contactName: string;
  market: string;
  channel: SellerChannel;
  qualificationTrack: "ACTIVE_INTENT" | "ICP_FIT";
  candidate: unknown;
  evidenceFacts: readonly EvidenceFact[];
  snapshots: readonly PageSnapshot[];
  sellerStore: SellerKnowledgeStore;
  versions: {
    dossierVersion: number;
    playVersion: number;
    qualificationPolicyVersion: string;
    plannerVersion: string;
    localeVersion: number;
  };
  now?: Date;
}

export interface PersonalizationPlanResult {
  status: "READY" | "NEEDS_REWRITE";
  plan: PersonalizationPlan | null;
  blockers: string[];
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
  /(?:system|developer|assistant)\s*(?:message|prompt)?\s*:/i,
  /\b(?:jailbreak|prompt\s+injection)\b/i,
  /\[(?:INST|\/INST)\]/i,
  /<\/?(?:script|system|assistant|developer)(?:\s|>)/i,
  /reveal\s+(?:the\s+)?(?:prompt|instructions?|secrets?)/i,
] as const;

const HEDGE_PATTERN = /\b(?:may|might|could|potentially|appears?|seems?|would|if|perhaps|likely)\b/i;
const ICP_PURCHASE_PATTERN = /\b(?:buying|purchasing|procuring|procurement|sourcing|rfq|tender|in\s+the\s+market|seeking|looking\s+for|current\s+(?:need|requirement|project)|upcoming\s+(?:need|requirement|project)|need(?:s|ed)?\s+(?:to\s+buy|a\s+supplier)|require(?:s|d)?\s+(?:a\s+supplier|supply))\b/i;

function hasPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function planFactIds(candidate: PersonalizationPlanCandidate): string[] {
  return [...new Set([
    ...candidate.observedFact.factIds,
    ...candidate.relevanceHypothesis.factIds,
    ...(candidate.whyNowSignal?.factIds ?? []),
  ])];
}

function factSupportsExactText(text: string, facts: readonly EvidenceFact[]): boolean {
  const target = normalized(text);
  return facts.some((fact) => target === normalized(fact.claim) || target === normalized(fact.exactQuote));
}

function semanticTokens(text: string): string[] {
  const pattern = /\b\d+(?:[.,]\d+)*(?:\s?(?:%|percent|mm|cm|m|km|kg|g|mg|t|tonnes?|tons?|kw|mw|v|a|pa|kpa|mpa|days?|weeks?|months?|years?))?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?\b|\b(?:not|no|never|without|cannot|can't|doesn't|isn't|aren't|won't)\b/gi;
  return [...text.matchAll(pattern)].map((match) => normalized(match[0] ?? ""));
}

function unsupportedSemanticTokens(text: string, allowedText: string): string[] {
  const allowed = new Set(semanticTokens(allowedText));
  return [...new Set(semanticTokens(text).filter((token) => !allowed.has(token)))];
}

function candidateText(candidate: PersonalizationPlanCandidate): string {
  return [
    candidate.buyerRoleFamily,
    candidate.processFocus,
    candidate.productRequirement ?? "",
    candidate.application,
    candidate.matchedProductFamily,
    candidate.whyNowSignal?.text ?? "",
    candidate.observedFact.text,
    candidate.relevanceHypothesis.text,
    candidate.approvedOffer.text,
    candidate.cta.text,
    candidate.angle,
    candidate.locale,
  ].join("\n");
}

function sellerIdentityFromProfile(profile: SellerProfile): PersonalizationPlan["sellerIdentity"] {
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    legalNameEn: profile.legalNameEn,
    brandNameEn: profile.brandNameEn,
    senderName: profile.sender.name,
    senderEmail: profile.sender.email,
    postalAddress: { ...profile.postalAddress },
    unsubscribeInstruction: profile.unsubscribe.instruction,
  };
}

function validateCandidate(
  input: CreatePersonalizationPlanInput,
  candidate: PersonalizationPlanCandidate,
  now: Date,
): { facts: EvidenceFact[]; offer: SellerOffer | null; sellerFacts: SellerFact[]; blockers: string[] } {
  const requestedFactIds = planFactIds(candidate);
  const selection = selectOutreachEvidenceFacts({
    factIds: requestedFactIds,
    accountId: input.accountId,
    leadId: input.leadId,
    facts: input.evidenceFacts,
    snapshots: input.snapshots,
    now,
  });
  const blockers = [...selection.blockers];
  if (!input.sellerStore.readiness.ready) blockers.push("SELLER_CONTEXT_NOT_READY");
  if (candidate.observedFact.factIds.length === 0 || !factSupportsExactText(candidate.observedFact.text, selection.selected)) {
    blockers.push("OBSERVED_FACT_NOT_EXACTLY_GROUNDED");
  }
  if (!HEDGE_PATTERN.test(candidate.relevanceHypothesis.text)) {
    blockers.push("RELEVANCE_HYPOTHESIS_NOT_HEDGED");
  }
  const relevanceFacts = selection.selected.filter((fact) =>
    candidate.relevanceHypothesis.factIds.includes(fact.id));
  const unsupportedRelevanceTokens = unsupportedSemanticTokens(
    candidate.relevanceHypothesis.text,
    relevanceFacts.flatMap((fact) => [fact.claim, fact.exactQuote]).join("\n"),
  );
  if (unsupportedRelevanceTokens.length > 0) {
    blockers.push(`RELEVANCE_HYPOTHESIS_CHANGED_FACT:${unsupportedRelevanceTokens.join(",")}`);
  }
  if (candidate.whyNowSignal !== null && !factSupportsExactText(candidate.whyNowSignal.text, selection.selected)) {
    blockers.push("WHY_NOW_NOT_EXACTLY_GROUNDED");
  }
  if (input.qualificationTrack === "ACTIVE_INTENT") {
    if (!candidate.whyNowSignal) {
      blockers.push("ACTIVE_INTENT_WHY_NOW_REQUIRED");
    } else {
      const intentFacts = selection.selected.filter((fact) => candidate.whyNowSignal?.factIds.includes(fact.id));
      if (!intentFacts.some((fact) => ["ACTIVE_INTENT", "DIRECT_DEMAND"].includes(fact.evidenceClass))) {
        blockers.push("ACTIVE_INTENT_FACT_REQUIRED");
      }
    }
  } else {
    if (candidate.whyNowSignal !== null) blockers.push("ICP_FIT_WHY_NOW_NOT_ALLOWED");
    if (ICP_PURCHASE_PATTERN.test(candidateText(candidate))) blockers.push("ICP_FIT_PURCHASE_LANGUAGE");
  }
  if (hasPromptInjection(candidateText(candidate))) blockers.push("PROMPT_INJECTION_DETECTED");
  if (selection.selected.some((fact) => hasPromptInjection(`${fact.claim}\n${fact.exactQuote}`))) {
    blockers.push("PROMPT_INJECTION_IN_SELECTED_EVIDENCE");
  }
  if (selection.selected.some((fact) => fact.subject !== input.accountName)) {
    blockers.push("EVIDENCE_SUBJECT_NOT_CURRENT_ACCOUNT");
  }

  const offer = input.sellerStore.getApprovedOffer(candidate.approvedOffer.offerId, input.market, input.channel, now);
  const sellerFacts = offer
    ? input.sellerStore.getApprovedFacts(offer.sellerFactIds, input.market, input.channel, now)
    : [];
  if (!offer) {
    blockers.push("APPROVED_ACTIVE_OFFER_NOT_FOUND");
  } else {
    if (candidate.approvedOffer.text !== offer.text) blockers.push("OFFER_TEXT_CHANGED");
    if (!sameSet(candidate.approvedOffer.sellerFactIds, offer.sellerFactIds)) {
      blockers.push("OFFER_SELLER_FACTS_CHANGED");
    }
    if (sellerFacts.length !== new Set(offer.sellerFactIds).size) {
      blockers.push("OFFER_HAS_UNAPPROVED_OR_STALE_SELLER_FACT");
    }
    const product = input.sellerStore.document.profile.products.find((entry) => entry.id === offer.productId);
    if (!product || normalized(candidate.matchedProductFamily) !== normalized(product.name)) {
      blockers.push("MATCHED_PRODUCT_NOT_APPROVED_OFFER_PRODUCT");
    }
  }
  const protectedContextText = [
    input.accountName,
    input.contactName,
    input.sellerStore.document.profile.legalNameEn,
    input.sellerStore.document.profile.brandNameEn,
    input.sellerStore.document.profile.sender.name,
    offer?.text ?? "",
    ...sellerFacts.map((fact) => fact.value),
  ].join("\n");
  if (hasPromptInjection(protectedContextText)) blockers.push("PROMPT_INJECTION_IN_PLANNING_CONTEXT");

  return { facts: selection.selected, offer, sellerFacts, blockers: [...new Set(blockers)].sort() };
}

export function createPersonalizationPlan(input: CreatePersonalizationPlanInput): PersonalizationPlanResult {
  const now = input.now ?? new Date();
  const candidateResult = PersonalizationPlanCandidateSchema.safeParse(input.candidate);
  if (!candidateResult.success) {
    return {
      status: "NEEDS_REWRITE",
      plan: null,
      blockers: candidateResult.error.issues.map((issue) =>
        `PERSONALIZATION_PLAN_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const candidate = candidateResult.data;
  const validation = validateCandidate(input, candidate, now);
  if (validation.blockers.length > 0) {
    return { status: "NEEDS_REWRITE", plan: null, blockers: validation.blockers };
  }

  const planResult = PersonalizationPlanSchema.safeParse({
    ...candidate,
    schemaVersion: PERSONALIZATION_PLAN_SCHEMA_VERSION,
    id: input.id,
    accountId: input.accountId,
    accountName: input.accountName,
    leadId: input.leadId,
    contactId: input.contactId,
    contactName: input.contactName,
    market: input.market,
    channel: input.channel,
    qualificationTrack: input.qualificationTrack,
    sellerIdentity: sellerIdentityFromProfile(input.sellerStore.document.profile),
    versions: {
      ...input.versions,
      sellerFactSetVersion: input.sellerStore.document.factSetVersion,
    },
    createdAt: now.toISOString(),
  });
  if (!planResult.success) {
    return {
      status: "NEEDS_REWRITE",
      plan: null,
      blockers: planResult.error.issues.map((issue) =>
        `PERSONALIZATION_PLAN_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  return { status: "READY", plan: planResult.data, blockers: [] };
}

export const MinimalWriterInputSchema = z.object({
  schemaVersion: z.literal("grounded-writer-input-v2"),
  planId: IdSchema,
  accountId: IdSchema,
  accountName: TextSchema.max(300),
  leadId: IdSchema,
  contactId: IdSchema,
  contactName: TextSchema.max(240),
  qualificationTrack: z.enum(["ACTIVE_INTENT", "ICP_FIT"]),
  buyerRoleFamily: TextSchema.max(160),
  processFocus: TextSchema.max(300),
  productRequirement: TextSchema.max(300).nullable(),
  application: TextSchema.max(500),
  matchedProductFamily: TextSchema.max(300),
  whyNowSignal: FactTextSchema.nullable(),
  observedFact: FactTextSchema,
  relevanceHypothesis: RelevanceHypothesisSchema,
  approvedOffer: ApprovedOfferReferenceSchema,
  cta: CtaSchema,
  angle: TextSchema.max(240),
  locale: z.string().trim().min(2).max(40),
  sellerIdentity: SellerIdentitySchema,
}).strict();

export type MinimalWriterInput = z.infer<typeof MinimalWriterInputSchema>;

export function buildMinimalWriterInput(planInput: unknown): MinimalWriterInput {
  const plan = PersonalizationPlanSchema.parse(planInput);
  return MinimalWriterInputSchema.parse({
    schemaVersion: "grounded-writer-input-v2",
    planId: plan.id,
    accountId: plan.accountId,
    accountName: plan.accountName,
    leadId: plan.leadId,
    contactId: plan.contactId,
    contactName: plan.contactName,
    qualificationTrack: plan.qualificationTrack,
    buyerRoleFamily: plan.buyerRoleFamily,
    processFocus: plan.processFocus,
    productRequirement: plan.productRequirement,
    application: plan.application,
    matchedProductFamily: plan.matchedProductFamily,
    whyNowSignal: plan.whyNowSignal,
    observedFact: plan.observedFact,
    relevanceHypothesis: plan.relevanceHypothesis,
    approvedOffer: plan.approvedOffer,
    cta: plan.cta,
    angle: plan.angle,
    locale: plan.locale,
    sellerIdentity: plan.sellerIdentity,
  });
}

export const GroundedMessageDraftSchema = z.object({
  schemaVersion: z.literal("grounded-message-draft-v2"),
  planId: IdSchema,
  accountId: IdSchema,
  leadId: IdSchema,
  contactId: IdSchema,
  offerId: IdSchema,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(12_000),
  referencedFactIds: z.array(IdSchema).min(1).max(100),
  referencedSellerFactIds: z.array(IdSchema).min(1).max(100),
  generationMode: z.enum(["MODEL", "DETERMINISTIC_COMPILER"]),
}).strict();

export type GroundedMessageDraft = z.infer<typeof GroundedMessageDraftSchema>;

export interface MessageLintResult {
  passed: boolean;
  status: "PENDING_APPROVAL" | "NEEDS_REWRITE" | "LINT_FAILED";
  blockers: string[];
  warnings: string[];
  referencedFactIds: string[];
}

export interface MessageGroundingInput {
  plan: unknown;
  draft: unknown;
  evidenceFacts: readonly EvidenceFact[];
  snapshots: readonly PageSnapshot[];
  sellerStore: SellerKnowledgeStore;
  now?: Date;
}

const GENERIC_FALLBACK_PATTERNS = [
  /\bi noticed\s+.+\s+appears?\s+relevant\b/i,
  /\bfollowing up in case\b/i,
  /\bour company supplies\b/i,
  /\b(?:your company|the right person)\b/i,
  /\bi will close this thread for now\b/i,
] as const;

const ASSERTION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "UNSUPPORTED_CERTIFICATION_ASSERTION", pattern: /\b(?:ISO\s*\d{3,5}|CE(?:[- ]certified)?|certifi(?:ed|cation)|UL\s+listed)\b/i },
  { code: "UNSUPPORTED_CUSTOMER_ASSERTION", pattern: /\b(?:customer|client|supplied\s+to|installed\s+(?:at|for)|worked\s+with|trusted\s+by)\b/i },
  { code: "UNSUPPORTED_PERFORMANCE_ASSERTION", pattern: /\b(?:efficiency|removal\s+rate|guarantee(?:d)?|reduce(?:s|d)?|improve(?:s|d)?|save(?:s|d)?|up\s+to)\b/i },
  { code: "UNSUPPORTED_PRICE_ASSERTION", pattern: /(?:[$€£¥]\s*\d|\b(?:usd|eur|gbp|cny|price|pricing|discount)\b)/i },
  { code: "UNSUPPORTED_LEAD_TIME_ASSERTION", pattern: /\b(?:lead\s*time|deliver(?:y|ed)?\s+(?:in|within)|ships?\s+(?:in|within)|\d+\s*(?:business\s+)?(?:days?|weeks?)\s+(?:lead|delivery))\b/i },
  { code: "UNSUPPORTED_PURCHASE_ASSERTION", pattern: ICP_PURCHASE_PATTERN },
];

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function splitStatements(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\r?\n+/).map((entry) => entry.trim()).filter(Boolean);
}

function statementSupported(statement: string, support: readonly string[]): boolean {
  const normalizedStatement = normalized(statement);
  return support.some((fragment) => {
    const normalizedFragment = normalized(fragment);
    return normalizedFragment.length >= 4 && normalizedStatement.includes(normalizedFragment);
  });
}

function renderedAddress(plan: PersonalizationPlan): string {
  const address = plan.sellerIdentity.postalAddress;
  return [address.line1, address.line2, address.city, address.region, address.postalCode, address.country]
    .filter(Boolean)
    .join(", ");
}

export function compileGroundedMessage(planInput: unknown): GroundedMessageDraft {
  const plan = PersonalizationPlanSchema.parse(planInput);
  const body = [
    `Hi ${plan.contactName},`,
    plan.whyNowSignal?.text ?? null,
    plan.observedFact.text,
    plan.relevanceHypothesis.text,
    plan.approvedOffer.text,
    plan.cta.text,
    "Regards,",
    plan.sellerIdentity.senderName,
    plan.sellerIdentity.brandNameEn,
    renderedAddress(plan),
    plan.sellerIdentity.unsubscribeInstruction,
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  return GroundedMessageDraftSchema.parse({
    schemaVersion: "grounded-message-draft-v2",
    planId: plan.id,
    accountId: plan.accountId,
    leadId: plan.leadId,
    contactId: plan.contactId,
    offerId: plan.approvedOffer.offerId,
    subject: `${plan.angle} | ${plan.accountName}`,
    body,
    referencedFactIds: planFactIds(plan),
    referencedSellerFactIds: [...new Set(plan.approvedOffer.sellerFactIds)],
    generationMode: "DETERMINISTIC_COMPILER",
  });
}

function validatePlanForLint(
  plan: PersonalizationPlan,
  input: MessageGroundingInput,
  now: Date,
): { facts: EvidenceFact[]; offer: SellerOffer | null; sellerFacts: SellerFact[]; blockers: string[] } {
  const candidate: PersonalizationPlanCandidate = {
    buyerRoleFamily: plan.buyerRoleFamily,
    processFocus: plan.processFocus,
    productRequirement: plan.productRequirement,
    application: plan.application,
    matchedProductFamily: plan.matchedProductFamily,
    whyNowSignal: plan.whyNowSignal,
    observedFact: plan.observedFact,
    relevanceHypothesis: plan.relevanceHypothesis,
    approvedOffer: plan.approvedOffer,
    cta: plan.cta,
    angle: plan.angle,
    locale: plan.locale,
  };
  const validated = validateCandidate({
    id: plan.id,
    accountId: plan.accountId,
    accountName: plan.accountName,
    leadId: plan.leadId,
    contactId: plan.contactId,
    contactName: plan.contactName,
    market: plan.market,
    channel: plan.channel,
    qualificationTrack: plan.qualificationTrack,
    candidate,
    evidenceFacts: input.evidenceFacts,
    snapshots: input.snapshots,
    sellerStore: input.sellerStore,
    versions: {
      dossierVersion: plan.versions.dossierVersion,
      playVersion: plan.versions.playVersion,
      qualificationPolicyVersion: plan.versions.qualificationPolicyVersion,
      plannerVersion: plan.versions.plannerVersion,
      localeVersion: plan.versions.localeVersion,
    },
    now,
  }, candidate, now);

  const profile = input.sellerStore.document.profile;
  if (plan.sellerIdentity.profileId !== profile.id || plan.sellerIdentity.profileVersion !== profile.version) {
    validated.blockers.push("SELLER_PROFILE_VERSION_MISMATCH");
  }
  if (plan.versions.sellerFactSetVersion !== input.sellerStore.document.factSetVersion) {
    validated.blockers.push("SELLER_FACT_SET_VERSION_MISMATCH");
  }
  if (JSON.stringify(plan.sellerIdentity) !== JSON.stringify(sellerIdentityFromProfile(profile))) {
    validated.blockers.push("SELLER_IDENTITY_CHANGED");
  }
  return { ...validated, blockers: [...new Set(validated.blockers)].sort() };
}

export function lintGroundedMessage(input: MessageGroundingInput): MessageLintResult {
  const planResult = PersonalizationPlanSchema.safeParse(input.plan);
  const draftResult = GroundedMessageDraftSchema.safeParse(input.draft);
  const schemaBlockers: string[] = [];
  if (!planResult.success) {
    schemaBlockers.push(...planResult.error.issues.map((issue) =>
      `PERSONALIZATION_PLAN_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  if (!draftResult.success) {
    schemaBlockers.push(...draftResult.error.issues.map((issue) =>
      `MESSAGE_DRAFT_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  if (!planResult.success || !draftResult.success) {
    return {
      passed: false,
      status: "NEEDS_REWRITE",
      blockers: [...new Set(schemaBlockers)].sort(),
      warnings: [],
      referencedFactIds: [],
    };
  }

  const now = input.now ?? new Date();
  const plan = planResult.data;
  const draft = draftResult.data;
  const validation = validatePlanForLint(plan, input, now);
  const blockers = [...validation.blockers];
  const allText = `${draft.subject}\n${draft.body}`;
  const requiredFactIds = planFactIds(plan);

  if (draft.planId !== plan.id) blockers.push("MESSAGE_PLAN_ID_MISMATCH");
  if (draft.accountId !== plan.accountId) blockers.push("MESSAGE_ACCOUNT_MISMATCH");
  if (draft.leadId !== plan.leadId) blockers.push("MESSAGE_LEAD_MISMATCH");
  if (draft.contactId !== plan.contactId) blockers.push("MESSAGE_CONTACT_MISMATCH");
  if (draft.offerId !== plan.approvedOffer.offerId) blockers.push("MESSAGE_OFFER_ID_MISMATCH");
  if (!sameSet(draft.referencedFactIds, requiredFactIds)) blockers.push("MESSAGE_FACT_REFERENCES_MISMATCH");
  const availableEvidence = new Map(input.evidenceFacts.map((fact) => [fact.id, fact]));
  for (const factId of draft.referencedFactIds) {
    const fact = availableEvidence.get(factId);
    if (!fact) {
      blockers.push(`MESSAGE_UNKNOWN_FACT_ID:${factId}`);
      continue;
    }
    if (fact.accountId !== plan.accountId) blockers.push(`MESSAGE_FACT_WRONG_ACCOUNT:${factId}`);
    if (fact.leadId !== plan.leadId) blockers.push(`MESSAGE_FACT_WRONG_LEAD:${factId}`);
    if (fact.subject !== plan.accountName) blockers.push(`MESSAGE_FACT_WRONG_SUBJECT:${factId}`);
  }
  if (!sameSet(draft.referencedSellerFactIds, plan.approvedOffer.sellerFactIds)) {
    blockers.push("MESSAGE_SELLER_FACT_REFERENCES_MISMATCH");
  }
  if (!draft.subject.includes(plan.angle)) blockers.push("MESSAGE_SUBJECT_ANGLE_MISSING_OR_CHANGED");
  if (!draft.body.includes(plan.observedFact.text)) blockers.push("MESSAGE_OBSERVED_FACT_MISSING_OR_CHANGED");
  if (!draft.body.includes(plan.relevanceHypothesis.text)) {
    blockers.push("MESSAGE_RELEVANCE_HYPOTHESIS_MISSING_OR_CHANGED");
  }
  if (plan.whyNowSignal && !draft.body.includes(plan.whyNowSignal.text)) {
    blockers.push("MESSAGE_WHY_NOW_MISSING_OR_CHANGED");
  }
  if (!draft.body.includes(plan.approvedOffer.text)) blockers.push("MESSAGE_APPROVED_OFFER_MISSING_OR_CHANGED");
  if (!draft.body.includes(plan.sellerIdentity.brandNameEn)) blockers.push("MESSAGE_SELLER_BRAND_MISSING");
  if (!draft.body.includes(plan.sellerIdentity.senderName)) blockers.push("MESSAGE_SENDER_MISSING");
  if (!draft.body.includes(renderedAddress(plan))) blockers.push("MESSAGE_POSTAL_ADDRESS_MISSING");
  if (!draft.body.includes(plan.sellerIdentity.unsubscribeInstruction)) blockers.push("MESSAGE_UNSUBSCRIBE_MISSING");

  const ctaCount = countOccurrences(draft.body, plan.cta.text);
  const questionCount = (draft.body.match(/\?/g) ?? []).length;
  const actionCtaCount = splitStatements(draft.body).filter((statement) =>
    /\b(?:(?:could|would|can|will)\s+you|please\s+(?:reply|send|share|confirm)|let\s+me\s+know|book\s+(?:a|the)|schedule\s+(?:a|the))\b/i
      .test(statement)
    && !normalized(statement).includes(normalized(plan.sellerIdentity.unsubscribeInstruction))).length;
  if (ctaCount === 0) blockers.push("MESSAGE_CTA_MISSING");
  if (ctaCount > 1 || questionCount > 1 || actionCtaCount > 1) blockers.push("MESSAGE_MULTIPLE_CTA");
  if (hasPromptInjection(`${candidateText(plan)}\n${allText}`)) blockers.push("PROMPT_INJECTION_DETECTED");
  if (GENERIC_FALLBACK_PATTERNS.some((pattern) => pattern.test(allText))) {
    blockers.push("GENERIC_FALLBACK_NOT_APPROVABLE");
  }
  if (input.sellerStore.privateLeakageCaseIds(allText).length > 0) {
    blockers.push("PRIVATE_CASE_LEAKAGE");
  }
  for (const prohibited of input.sellerStore.document.profile.prohibitedClaims) {
    if (normalized(allText).includes(normalized(prohibited))) blockers.push("SELLER_PROHIBITED_CLAIM");
  }

  const supportFragments = [
    ...validation.facts.flatMap((fact) => [fact.claim, fact.exactQuote]),
    ...validation.sellerFacts.map((fact) => fact.value),
    validation.offer?.text ?? "",
  ];
  for (const statement of splitStatements(allText)) {
    for (const assertion of ASSERTION_PATTERNS) {
      if (!assertion.pattern.test(statement)) continue;
      if (assertion.code === "UNSUPPORTED_PURCHASE_ASSERTION" && plan.qualificationTrack === "ICP_FIT") {
        blockers.push("ICP_FIT_PURCHASE_LANGUAGE");
      } else {
        const categorySupport = supportFragments.filter((fragment) => assertion.pattern.test(fragment));
        if (!statementSupported(statement, categorySupport)) blockers.push(assertion.code);
      }
    }
  }

  const allowedSemanticText = [
    candidateText(plan),
    plan.accountName,
    plan.contactName,
    plan.sellerIdentity.legalNameEn,
    plan.sellerIdentity.brandNameEn,
    plan.sellerIdentity.senderName,
    plan.sellerIdentity.senderEmail,
    renderedAddress(plan),
    plan.sellerIdentity.unsubscribeInstruction,
    ...supportFragments,
  ].join("\n");
  const changedTokens = unsupportedSemanticTokens(allText, allowedSemanticText);
  if (changedTokens.length > 0) {
    blockers.push(`MESSAGE_CHANGED_NUMBER_DATE_UNIT_OR_NEGATION:${changedTokens.join(",")}`);
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    passed: uniqueBlockers.length === 0,
    status: uniqueBlockers.length === 0 ? "PENDING_APPROVAL" : "LINT_FAILED",
    blockers: uniqueBlockers,
    warnings: [],
    referencedFactIds: [...new Set(draft.referencedFactIds)].sort(),
  };
}

export const evaluateGroundedMessage = lintGroundedMessage;

export const GroundedReviewVersionsSchema = z.object({
  messageVersion: z.number().int().positive(),
  dossierVersion: z.number().int().positive(),
  sellerProfileVersion: z.number().int().positive(),
  sellerFactSetVersion: z.number().int().positive(),
  playVersion: z.number().int().positive(),
  localeVersion: z.number().int().positive(),
  qualificationPolicyVersion: TextSchema.max(120),
  promptVersion: TextSchema.max(120),
  model: TextSchema.max(160),
  templateVersion: TextSchema.max(120),
  lintVersion: z.literal(MESSAGE_GROUNDING_LINT_VERSION),
  generationMode: z.enum(["MODEL", "DETERMINISTIC_COMPILER"]),
}).strict();

export type GroundedReviewVersions = z.infer<typeof GroundedReviewVersionsSchema>;

export interface GroundedReviewMaterialInput {
  plan: PersonalizationPlan;
  draft: GroundedMessageDraft;
  evidenceFacts: readonly EvidenceFact[];
  sellerProfile: SellerProfile;
  sellerFacts: readonly SellerFact[];
  offer: SellerOffer;
  versions: GroundedReviewVersions;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function buildGroundedReviewMaterial(input: GroundedReviewMaterialInput): Record<string, unknown> {
  const plan = PersonalizationPlanSchema.parse(input.plan);
  const draft = GroundedMessageDraftSchema.parse(input.draft);
  const evidenceFacts = input.evidenceFacts.map((fact) => EvidenceFactSchema.parse(fact))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sellerFacts = input.sellerFacts.map((fact) => SellerFactSchema.parse(fact))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sellerProfile = SellerProfileSchema.parse(input.sellerProfile);
  const offer = SellerOfferSchema.parse(input.offer);
  const versions = GroundedReviewVersionsSchema.parse(input.versions);
  if (!sameSet(evidenceFacts.map((fact) => fact.id), draft.referencedFactIds)) {
    throw new Error("Review material buyer facts do not match message references");
  }
  if (!sameSet(sellerFacts.map((fact) => fact.id), draft.referencedSellerFactIds)) {
    throw new Error("Review material seller facts do not match message references");
  }
  if (evidenceFacts.some((fact) => fact.accountId !== plan.accountId || fact.leadId !== plan.leadId)) {
    throw new Error("Review material contains a buyer fact for another account or lead");
  }
  if (sellerFacts.some((fact) => fact.profileId !== sellerProfile.id)) {
    throw new Error("Review material contains a seller fact for another profile");
  }
  if (offer.id !== draft.offerId || offer.id !== plan.approvedOffer.offerId) {
    throw new Error("Review material offer does not match the current message and plan");
  }
  if (
    versions.dossierVersion !== plan.versions.dossierVersion
    || versions.sellerProfileVersion !== sellerProfile.version
    || versions.sellerProfileVersion !== plan.sellerIdentity.profileVersion
    || versions.sellerFactSetVersion !== plan.versions.sellerFactSetVersion
    || versions.playVersion !== plan.versions.playVersion
    || versions.localeVersion !== plan.versions.localeVersion
    || versions.qualificationPolicyVersion !== plan.versions.qualificationPolicyVersion
    || versions.generationMode !== draft.generationMode
  ) {
    throw new Error("Review material versions do not match the current plan, seller profile or message");
  }
  return stableValue({
    materialVersion: GROUNDED_REVIEW_MATERIAL_VERSION,
    plan,
    draft,
    evidenceFacts,
    seller: {
      profile: sellerProfile,
      facts: sellerFacts,
      offer,
    },
    versions,
  }) as Record<string, unknown>;
}

export function groundedReviewHash(input: GroundedReviewMaterialInput): string {
  return createHash("sha256")
    .update(JSON.stringify(buildGroundedReviewMaterial(input)), "utf8")
    .digest("hex");
}

export const createGroundedReviewHash = groundedReviewHash;
