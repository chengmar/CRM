import { z } from "zod";
import {
  LocalePackSchema,
  evaluateLocalePackForUse,
  extractProtectedTranslationTokens,
  type LocalePack,
} from "./locale-safety.js";
import { PrivateCaseSchema } from "./seller-knowledge.js";

export const APPROVED_CLAIM_SCHEMA_VERSION = "approved-claim-v1" as const;
export const HIGH_INTENT_CONTENT_PACKAGE_SCHEMA_VERSION = "high-intent-content-package-v1" as const;

const IdSchema = z.string().trim().min(1).max(200);
const TextSchema = z.string().trim().min(1).max(20_000);
const LocaleTagSchema = z.string().trim().regex(
  /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
  "must be a BCP-47-like locale tag",
);
const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);
const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "must be an HTTP(S) URL");

export const ExternalContentChannelSchema = z.enum(["EMAIL", "LINKEDIN", "WHATSAPP", "WEBSITE"]);
export type ExternalContentChannel = z.infer<typeof ExternalContentChannelSchema>;

export const ClaimReviewerSchema = z.object({
  id: IdSchema,
  name: TextSchema.max(160),
  role: z.enum(["ENGINEERING", "COMPLIANCE", "COMMERCIAL", "CONTENT_OWNER"]),
  human: z.literal(true),
}).strict();

export const ApprovedClaimSchema = z.object({
  schemaVersion: z.literal(APPROVED_CLAIM_SCHEMA_VERSION),
  id: IdSchema,
  version: z.number().int().positive(),
  claimType: z.enum([
    "PRODUCT_PARAMETER",
    "CERTIFICATION",
    "STANDARD",
    "CUSTOMER_CASE",
    "PERFORMANCE",
    "REGULATORY",
    "COMPLIANCE",
    "SAFETY_COMPLIANCE",
    "MOQ",
    "LEAD_TIME",
    "OEM",
    "PACKAGING",
    "INSTALLATION",
    "PAYMENT",
    "QUOTE_BOUNDARY",
  ]),
  statement: TextSchema,
  locale: LocaleTagSchema,
  source: z.object({
    documentId: IdSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUrl: HttpUrlSchema.nullable(),
    sourceType: z.enum([
      "CERTIFICATE",
      "PRODUCT_SHEET",
      "OFFICIAL_WEBSITE",
      "SIGNED_APPROVAL",
      "SIGNED_PUBLIC_RELEASE",
    ]),
  }).strict(),
  visibility: z.enum(["PUBLIC", "PRIVATE"]),
  casePermission: z.enum(["NOT_APPLICABLE", "PRIVATE_ONLY", "PUBLIC_RELEASE_APPROVED"]),
  allowedMarkets: z.array(TextSchema.max(120)).min(1).max(200),
  allowedChannels: z.array(ExternalContentChannelSchema).min(1).max(4),
  status: z.enum(["DRAFT", "ENGINEERING_REVIEW", "APPROVED", "STALE", "REVOKED"]),
  approvedBy: ClaimReviewerSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  revokedBy: ClaimReviewerSchema.nullable(),
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((claim, context) => {
  if (Date.parse(claim.validFrom) >= Date.parse(claim.expiresAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after validFrom" });
  }
  if (claim.status === "APPROVED" && (!claim.approvedBy || !claim.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "APPROVED requires approvedBy and approvedAt",
    });
  }
  if (claim.status === "REVOKED" && (!claim.revokedAt || !claim.revokedBy)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "REVOKED requires revokedAt and revokedBy",
    });
  }
  if (claim.status !== "REVOKED" && (claim.revokedAt !== null || claim.revokedBy !== null)) {
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "revocation fields require REVOKED status",
    });
  }
  if (claim.approvedAt && Date.parse(claim.approvedAt) >= Date.parse(claim.expiresAt)) {
    context.addIssue({ code: "custom", path: ["approvedAt"], message: "must be before expiresAt" });
  }
  if (claim.claimType === "CUSTOMER_CASE") {
    if (claim.visibility === "PRIVATE" && claim.casePermission !== "PRIVATE_ONLY") {
      context.addIssue({
        code: "custom",
        path: ["casePermission"],
        message: "private customer cases must be PRIVATE_ONLY",
      });
    }
    if (claim.visibility === "PUBLIC"
      && (claim.casePermission !== "PUBLIC_RELEASE_APPROVED"
        || claim.source.sourceType !== "SIGNED_PUBLIC_RELEASE")) {
      context.addIssue({
        code: "custom",
        path: ["casePermission"],
        message: "public customer cases require a signed public release",
      });
    }
  } else if (claim.casePermission !== "NOT_APPLICABLE") {
    context.addIssue({
      code: "custom",
      path: ["casePermission"],
      message: "non-case claims must use NOT_APPLICABLE",
    });
  }
  const engineeringClaims = new Set([
    "CERTIFICATION",
    "STANDARD",
    "PERFORMANCE",
    "REGULATORY",
    "COMPLIANCE",
    "SAFETY_COMPLIANCE",
  ]);
  if (claim.status === "APPROVED"
    && engineeringClaims.has(claim.claimType)
    && claim.approvedBy
    && !["ENGINEERING", "COMPLIANCE"].includes(claim.approvedBy.role)) {
    context.addIssue({
      code: "custom",
      path: ["approvedBy", "role"],
      message: "technical, safety and regulatory claims require engineering or compliance approval",
    });
  }
  const normalizedMarkets = claim.allowedMarkets.map((market) => market.toLocaleLowerCase("en-US"));
  if (new Set(normalizedMarkets).size !== normalizedMarkets.length) {
    context.addIssue({ code: "custom", path: ["allowedMarkets"], message: "must not contain duplicates" });
  }
  if (new Set(claim.allowedChannels).size !== claim.allowedChannels.length) {
    context.addIssue({ code: "custom", path: ["allowedChannels"], message: "must not contain duplicates" });
  }
});

export type ApprovedClaim = z.infer<typeof ApprovedClaimSchema>;
type PrivateCase = z.infer<typeof PrivateCaseSchema>;

function marketAllowed(allowedMarkets: readonly string[], requestedMarket: string): boolean {
  const requested = requestedMarket.trim().toLocaleLowerCase("en-US");
  return allowedMarkets.some((market) => {
    const allowed = market.trim().toLocaleLowerCase("en-US");
    return allowed === "*" || allowed === requested;
  });
}

function localeCompatible(claimLocale: string, contentLocale: string): boolean {
  const claim = claimLocale.trim().toLocaleLowerCase("en-US");
  const content = contentLocale.trim().toLocaleLowerCase("en-US");
  return claim === content || (!claim.includes("-") && content.startsWith(`${claim}-`));
}

export interface ExternalClaimUseResult {
  eligible: boolean;
  claim: ApprovedClaim | null;
  blockers: string[];
}

export function evaluateApprovedClaimForExternalUse(input: {
  claim: unknown;
  market: string;
  channel: ExternalContentChannel;
  locale?: string;
  now?: Date;
}): ExternalClaimUseResult {
  const parsed = ApprovedClaimSchema.safeParse(input.claim);
  if (!parsed.success) {
    return {
      eligible: false,
      claim: null,
      blockers: parsed.error.issues.map((issue) =>
        `CLAIM_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const claim = parsed.data;
  const blockers: string[] = [];
  const now = input.now ?? new Date();
  if (claim.status !== "APPROVED") blockers.push("CLAIM_NOT_APPROVED");
  if (claim.visibility !== "PUBLIC") blockers.push("CLAIM_NOT_PUBLIC");
  if (claim.revokedAt !== null || claim.revokedBy !== null || claim.status === "REVOKED") {
    blockers.push("CLAIM_REVOKED");
  }
  if (!marketAllowed(claim.allowedMarkets, input.market)) blockers.push("CLAIM_MARKET_NOT_ALLOWED");
  if (!claim.allowedChannels.includes(input.channel)) blockers.push("CLAIM_CHANNEL_NOT_ALLOWED");
  if (input.locale && !localeCompatible(claim.locale, input.locale)) blockers.push("CLAIM_LOCALE_NOT_ALLOWED");
  if (now.getTime() < Date.parse(claim.validFrom)) blockers.push("CLAIM_NOT_YET_VALID");
  if (now.getTime() >= Date.parse(claim.expiresAt)) blockers.push("CLAIM_EXPIRED");
  return { eligible: blockers.length === 0, claim, blockers: [...new Set(blockers)].sort() };
}

export const EditorialCopyBlockSchema = z.object({
  kind: z.literal("COPY"),
  text: TextSchema,
}).strict();

export const ApprovedClaimBlockSchema = z.object({
  kind: z.literal("APPROVED_CLAIM"),
  claimId: IdSchema,
  claimVersion: z.number().int().positive(),
  statement: TextSchema,
}).strict();

export const ContentBlockSchema = z.discriminatedUnion("kind", [
  EditorialCopyBlockSchema,
  ApprovedClaimBlockSchema,
]);

const ContentSectionSchema = z.object({
  id: IdSchema,
  heading: TextSchema.max(500),
  blocks: z.array(ContentBlockSchema).min(1).max(200),
}).strict();

const FaqDraftSchema = z.object({
  id: IdSchema,
  question: TextSchema.max(1_000),
  answerBlocks: z.array(ContentBlockSchema).min(1).max(50),
}).strict();

const SeoDraftSchema = z.object({
  titleSuggestion: TextSchema.max(200),
  descriptionSuggestion: TextSchema.max(500),
  canonicalPathSuggestion: z.string().trim().regex(/^\/(?!\/)[^?#]*$/),
  hreflangSuggestions: z.array(z.object({
    locale: LocaleTagSchema,
    pathSuggestion: z.string().trim().regex(/^\/(?!\/)[^?#]*$/),
  }).strict()).min(1).max(100),
}).strict();

const JsonLdDraftSchema = z.object({
  status: z.literal("DRAFT"),
  context: z.literal("https://schema.org"),
  organization: z.object({
    type: z.literal("Organization"),
    name: TextSchema.max(300),
    urlSuggestion: HttpUrlSchema,
  }).strict(),
  product: z.object({
    type: z.literal("Product"),
    name: TextSchema.max(300),
    descriptionBlocks: z.array(ContentBlockSchema).min(1).max(100),
  }).strict().nullable(),
  faqPage: z.object({
    type: z.literal("FAQPage"),
    faqIds: z.array(IdSchema).min(1).max(100),
  }).strict().nullable(),
}).strict();

export const HighIntentContentCandidateSchema = z.object({
  id: IdSchema,
  assetType: z.enum([
    "APPLICATION_BOUNDARY",
    "APPLICATION_GUIDE",
    "SELECTION_GUIDE",
    "MAINTENANCE_GUIDE",
    "TECHNICAL_OPTIONS_GUIDE",
    "RFQ_CHECKLIST",
    "COMMERCIAL_BOUNDARY",
  ]),
  market: TextSchema.max(120),
  locale: LocaleTagSchema,
  localePackId: IdSchema,
  localePackVersion: z.number().int().positive(),
  title: TextSchema.max(300),
  slugSuggestion: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  searchIntent: z.literal("HIGH_INTENT"),
  audience: TextSchema.max(500),
  productFamily: TextSchema.max(500),
  application: TextSchema.max(1_000),
  requiredBuyerInputs: z.array(z.enum([
    "PERFORMANCE_REQUIREMENT",
    "PRODUCT_REQUIREMENT",
    "OPERATING_TEMPERATURE",
    "OPERATING_HUMIDITY",
    "MATERIAL_COMPATIBILITY",
    "SAFETY_REQUIREMENT",
    "COMPLIANCE_REQUIREMENT",
    "UTILITY_REQUIREMENT",
    "INSTALLATION_CONSTRAINT",
    "QUANTITY",
  ])).min(1).max(10),
  sections: z.array(ContentSectionSchema).min(1).max(100),
  faqDraft: z.array(FaqDraftSchema).max(100),
  seoDraft: SeoDraftSchema,
  jsonLdDraft: JsonLdDraftSchema,
  generationMode: z.enum(["MODEL", "DETERMINISTIC_COMPILER", "HUMAN"]),
}).strict();

export type HighIntentContentCandidate = z.infer<typeof HighIntentContentCandidateSchema>;

export const HighIntentContentPackageDraftSchema = HighIntentContentCandidateSchema.extend({
  schemaVersion: z.literal(HIGH_INTENT_CONTENT_PACKAGE_SCHEMA_VERSION),
  status: z.literal("DRAFT"),
  publicationState: z.literal("NOT_PUBLISHED"),
  externalReady: z.literal(false),
  approvedClaimIds: z.array(IdSchema).max(1_000),
  reviewChecklist: z.object({
    technicalReview: z.literal("PENDING"),
    localizationReview: z.literal("PENDING"),
    legalReview: z.literal("PENDING"),
    humanPublishAuthorization: z.literal(false),
  }).strict(),
  publishedUrl: z.null(),
  publishedAt: z.null(),
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((draft, context) => {
  const sectionIds = draft.sections.map((section) => section.id);
  if (new Set(sectionIds).size !== sectionIds.length) {
    context.addIssue({ code: "custom", path: ["sections"], message: "section IDs must be unique" });
  }
  const faqIds = draft.faqDraft.map((faq) => faq.id);
  if (new Set(faqIds).size !== faqIds.length) {
    context.addIssue({ code: "custom", path: ["faqDraft"], message: "FAQ IDs must be unique" });
  }
  if (new Set(draft.requiredBuyerInputs).size !== draft.requiredBuyerInputs.length) {
    context.addIssue({
      code: "custom",
      path: ["requiredBuyerInputs"],
      message: "required buyer inputs must be unique",
    });
  }
});

export type HighIntentContentPackageDraft = z.infer<typeof HighIntentContentPackageDraftSchema>;

function allBlocks(candidate: HighIntentContentCandidate): Array<z.infer<typeof ContentBlockSchema>> {
  return [
    ...candidate.sections.flatMap((section) => section.blocks),
    ...candidate.faqDraft.flatMap((faq) => faq.answerBlocks),
    ...(candidate.jsonLdDraft.product?.descriptionBlocks ?? []),
  ];
}

function contentBlockText(block: z.infer<typeof ContentBlockSchema>): string {
  return block.kind === "COPY" ? block.text : block.statement;
}

function packageText(candidate: HighIntentContentCandidate): string {
  return [
    candidate.title,
    candidate.audience,
    candidate.productFamily,
    candidate.application,
    candidate.seoDraft.titleSuggestion,
    candidate.seoDraft.descriptionSuggestion,
    candidate.jsonLdDraft.organization.name,
    candidate.jsonLdDraft.product?.name ?? "",
    ...candidate.sections.flatMap((section) => [
      section.heading,
      ...section.blocks.map(contentBlockText),
    ]),
    ...candidate.faqDraft.flatMap((faq) => [
      faq.question,
      ...faq.answerBlocks.map(contentBlockText),
    ]),
    ...(candidate.jsonLdDraft.product?.descriptionBlocks.map(contentBlockText) ?? []),
  ].join("\n");
}

function privateCaseLeakageIds(text: string, privateCases: readonly PrivateCase[]): string[] {
  const normalizedText = text.toLocaleLowerCase("en-US");
  return privateCases.flatMap((privateCase) => {
    const sensitiveFragments = [
      privateCase.customerName,
      privateCase.location,
      privateCase.result,
      ...privateCase.metrics,
    ].filter((fragment): fragment is string => Boolean(fragment && fragment.trim().length >= 4));
    return sensitiveFragments.some((fragment) =>
      normalizedText.includes(fragment.toLocaleLowerCase("en-US")))
      ? [privateCase.id]
      : [];
  });
}

const UNBOUND_RISK_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "CERTIFICATION", pattern: /\b(?:certifi(?:ed|cation)|complies?\s+with|approved\s+to|listed\s+to)\b/i },
  { code: "CUSTOMER_CASE", pattern: /\b(?:customer|client|case\s+study|installed\s+(?:at|for)|supplied\s+to|trusted\s+by)\b/i },
  { code: "PERFORMANCE", pattern: /\b(?:efficiency|removal\s+rate|guarantee(?:d)?|reduce(?:s|d)?|improve(?:s|d)?|up\s+to)\b/i },
  { code: "REGULATORY", pattern: /\b(?:regulated|regulation|legally\s+compliant|mandatory standard)\b/i },
  { code: "COMMERCIAL", pattern: /\b(?:MOQ|lead\s*time|payment\s+terms?|price|pricing|delivery\s+within|OEM\s+available)\b/i },
];

function lintEditorialCopy(blockText: string): string[] {
  const tokens = extractProtectedTranslationTokens(blockText);
  const blockers: string[] = [];
  if (tokens.numbers.length > 0 || tokens.units.length > 0 || tokens.certifications.length > 0) {
    blockers.push("CONTENT_UNBOUND_NUMBER_UNIT_OR_CERTIFICATION");
  }
  for (const risk of UNBOUND_RISK_PATTERNS) {
    if (risk.pattern.test(blockText)) blockers.push(`CONTENT_UNBOUND_${risk.code}_ASSERTION`);
  }
  return blockers;
}

function claimIdsFromCandidate(candidate: HighIntentContentCandidate): string[] {
  return [...new Set(allBlocks(candidate)
    .filter((block): block is z.infer<typeof ApprovedClaimBlockSchema> => block.kind === "APPROVED_CLAIM")
    .map((block) => block.claimId))].sort();
}

export interface ContentPackageBuildResult {
  accepted: boolean;
  status: "DRAFT" | "REJECTED";
  draft: HighIntentContentPackageDraft | null;
  blockers: string[];
}

export function createHighIntentContentPackageDraft(input: {
  candidate: unknown;
  localePack: unknown;
  claims: readonly unknown[];
  privateCases: readonly unknown[];
  now?: Date;
}): ContentPackageBuildResult {
  const candidateResult = HighIntentContentCandidateSchema.safeParse(input.candidate);
  if (!candidateResult.success) {
    return {
      accepted: false,
      status: "REJECTED",
      draft: null,
      blockers: candidateResult.error.issues.map((issue) =>
        `CONTENT_PACKAGE_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const candidate = candidateResult.data;
  const blockers: string[] = [];
  const now = input.now ?? new Date();
  const localePackResult = evaluateLocalePackForUse({
    pack: input.localePack,
    market: candidate.market,
    locale: candidate.locale,
    now,
  });
  blockers.push(...localePackResult.blockers.map((blocker) => `CONTENT_${blocker}`));
  const localePackParse = LocalePackSchema.safeParse(input.localePack);
  const localePack: LocalePack | null = localePackParse.success ? localePackParse.data : null;
  if (localePack
    && (candidate.localePackId !== localePack.id || candidate.localePackVersion !== localePack.version)) {
    blockers.push("CONTENT_LOCALE_PACK_VERSION_MISMATCH");
  }

  const privateCaseResults = input.privateCases.map((privateCase) => PrivateCaseSchema.safeParse(privateCase));
  if (privateCaseResults.some((result) => !result.success)) {
    blockers.push("CONTENT_PRIVATE_CASE_CORPUS_INVALID");
  }
  const privateCases = privateCaseResults.flatMap((result) => result.success ? [result.data] : []);
  for (const caseId of privateCaseLeakageIds(packageText(candidate), privateCases)) {
    blockers.push(`CONTENT_PRIVATE_CASE_LEAKAGE:${caseId}`);
  }

  const claims = new Map<string, ApprovedClaim>();
  for (const rawClaim of input.claims) {
    const parsed = ApprovedClaimSchema.safeParse(rawClaim);
    if (!parsed.success) {
      blockers.push(...parsed.error.issues.map((issue) =>
        `CONTENT_CLAIM_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
      continue;
    }
    if (claims.has(parsed.data.id)) blockers.push(`CONTENT_DUPLICATE_CLAIM_ID:${parsed.data.id}`);
    claims.set(parsed.data.id, parsed.data);
  }

  for (const block of allBlocks(candidate)) {
    if (block.kind === "COPY") {
      blockers.push(...lintEditorialCopy(block.text));
      continue;
    }
    const claim = claims.get(block.claimId);
    if (!claim) {
      blockers.push(`CONTENT_CLAIM_NOT_FOUND:${block.claimId}`);
      continue;
    }
    if (block.claimVersion !== claim.version) blockers.push(`CONTENT_CLAIM_VERSION_MISMATCH:${claim.id}`);
    if (block.statement !== claim.statement) blockers.push(`CONTENT_CLAIM_STATEMENT_CHANGED:${claim.id}`);
    const eligibility = evaluateApprovedClaimForExternalUse({
      claim,
      market: candidate.market,
      channel: "WEBSITE",
      locale: candidate.locale,
      now,
    });
    blockers.push(...eligibility.blockers.map((blocker) => `CONTENT_${blocker}:${claim.id}`));
  }

  if (candidate.jsonLdDraft.faqPage) {
    const availableFaqIds = new Set(candidate.faqDraft.map((faq) => faq.id));
    for (const faqId of candidate.jsonLdDraft.faqPage.faqIds) {
      if (!availableFaqIds.has(faqId)) blockers.push(`CONTENT_JSON_LD_FAQ_NOT_FOUND:${faqId}`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  if (uniqueBlockers.length > 0) {
    return { accepted: false, status: "REJECTED", draft: null, blockers: uniqueBlockers };
  }
  const draftResult = HighIntentContentPackageDraftSchema.safeParse({
    ...candidate,
    schemaVersion: HIGH_INTENT_CONTENT_PACKAGE_SCHEMA_VERSION,
    status: "DRAFT",
    publicationState: "NOT_PUBLISHED",
    externalReady: false,
    approvedClaimIds: claimIdsFromCandidate(candidate),
    reviewChecklist: {
      technicalReview: "PENDING",
      localizationReview: "PENDING",
      legalReview: "PENDING",
      humanPublishAuthorization: false,
    },
    publishedUrl: null,
    publishedAt: null,
    createdAt: now.toISOString(),
  });
  if (!draftResult.success) {
    return {
      accepted: false,
      status: "REJECTED",
      draft: null,
      blockers: draftResult.error.issues.map((issue) =>
        `CONTENT_PACKAGE_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  return { accepted: true, status: "DRAFT", draft: draftResult.data, blockers: [] };
}

export function createPrivateCustomerCaseClaimDraft(input: Omit<
  z.input<typeof ApprovedClaimSchema>,
  "schemaVersion" | "visibility" | "casePermission" | "status" | "approvedBy" | "approvedAt" | "revokedAt" | "revokedBy"
>): ApprovedClaim {
  return ApprovedClaimSchema.parse({
    ...input,
    schemaVersion: APPROVED_CLAIM_SCHEMA_VERSION,
    claimType: "CUSTOMER_CASE",
    visibility: "PRIVATE",
    casePermission: "PRIVATE_ONLY",
    status: "DRAFT",
    approvedBy: null,
    approvedAt: null,
    revokedAt: null,
    revokedBy: null,
  });
}
