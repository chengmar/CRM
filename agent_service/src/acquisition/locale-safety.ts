import { z } from "zod";

export const LOCALE_PACK_SCHEMA_VERSION = "locale-pack-v1" as const;
export const TRANSLATION_SCHEMA_VERSION = "translation-v1" as const;

const IdSchema = z.string().trim().min(1).max(200);
const TextSchema = z.string().trim().min(1).max(4_000);
const LocaleTagSchema = z.string().trim().regex(
  /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
  "must be a BCP-47-like locale tag",
);
const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);

export const LocaleReviewerSchema = z.object({
  id: IdSchema,
  name: TextSchema.max(160),
  role: z.literal("LOCALIZATION_REVIEWER"),
  human: z.literal(true),
}).strict();

const LocaleTermSchema = z.object({
  conceptId: IdSchema,
  sourceTerm: TextSchema.max(300),
  localizedTerm: TextSchema.max(300),
  doNotTranslate: z.boolean(),
}).strict();

const ProductNameSchema = z.object({
  productId: IdSchema,
  approvedSourceName: TextSchema.max(300),
  approvedLocalizedName: TextSchema.max(300),
}).strict();

const UnitDisplaySchema = z.object({
  symbol: TextSchema.max(40),
  localizedDisplay: TextSchema.max(80),
}).strict();

const ForbiddenLiteralTranslationSchema = z.object({
  sourceText: TextSchema.max(500),
  forbiddenText: TextSchema.max(500),
  approvedAlternative: TextSchema.max(500),
}).strict();

export const LocalePackSchema = z.object({
  schemaVersion: z.literal(LOCALE_PACK_SCHEMA_VERSION),
  id: IdSchema,
  sourceLocale: LocaleTagSchema,
  locale: LocaleTagSchema,
  market: TextSchema.max(120),
  version: z.number().int().positive(),
  status: z.enum(["DRAFT", "LOCALIZATION_REVIEW", "APPROVED", "STALE", "REVOKED"]),
  technicalTerms: z.array(LocaleTermSchema).min(1).max(1_000),
  productNames: z.array(ProductNameSchema).min(1).max(200),
  approvedVocabulary: z.record(
    z.string().trim().min(1).max(100),
    TextSchema.max(160),
  ).refine((value) => Object.keys(value).length > 0, "approved vocabulary cannot be empty"),
  metricUnits: z.array(UnitDisplaySchema).min(1).max(100),
  forbiddenLiteralTranslations: z.array(ForbiddenLiteralTranslationSchema).max(500),
  sourceNegationMarkers: z.array(TextSchema.max(80)).min(1).max(100),
  targetNegationMarkers: z.array(TextSchema.max(80)).min(1).max(100),
  style: z.object({
    salutation: TextSchema.max(200),
    tone: z.enum(["FORMAL", "NEUTRAL", "DIRECT_TECHNICAL"]),
    subjectGuidance: TextSchema.max(1_000),
    ctaGuidance: TextSchema.max(1_000),
  }).strict(),
  businessCalendar: z.object({
    timeZone: TextSchema.max(100),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    businessHours: z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    }).strict(),
  }).strict(),
  legal: z.object({
    unsubscribeRequired: z.literal(true),
    unsubscribeText: TextSchema.max(1_000),
    requirements: z.array(TextSchema.max(1_000)).max(100),
  }).strict(),
  reviewer: LocaleReviewerSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
}).strict().superRefine((pack, context) => {
  if (Date.parse(pack.validFrom) >= Date.parse(pack.validTo)) {
    context.addIssue({ code: "custom", path: ["validTo"], message: "must be after validFrom" });
  }
  if (pack.status === "APPROVED" && (!pack.reviewer || !pack.reviewedAt || !pack.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "APPROVED requires a human reviewer, reviewedAt and approvedAt",
    });
  }
  if (pack.status === "REVOKED" && !pack.revokedAt) {
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "REVOKED requires revokedAt" });
  }
  if (pack.status !== "REVOKED" && pack.revokedAt !== null) {
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "revokedAt requires REVOKED status" });
  }
  if (pack.approvedAt && Date.parse(pack.approvedAt) > Date.parse(pack.validTo)) {
    context.addIssue({ code: "custom", path: ["approvedAt"], message: "must not be after validTo" });
  }
  const uniqueFields: Array<[string, readonly string[]]> = [
    ["technicalTerms.conceptId", pack.technicalTerms.map((entry) => entry.conceptId)],
    ["productNames.productId", pack.productNames.map((entry) => entry.productId)],
    ["metricUnits.symbol", pack.metricUnits.map((entry) => entry.symbol)],
    ["sourceNegationMarkers", pack.sourceNegationMarkers],
    ["targetNegationMarkers", pack.targetNegationMarkers],
  ];
  for (const [path, values] of uniqueFields) {
    const normalized = values.map((value) => value.trim().toLocaleLowerCase("en-US"));
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", path: path.split("."), message: "must not contain duplicates" });
    }
  }
  if (new Set(pack.businessCalendar.workingDays).size !== pack.businessCalendar.workingDays.length) {
    context.addIssue({
      code: "custom",
      path: ["businessCalendar", "workingDays"],
      message: "must not contain duplicates",
    });
  }
});

export type LocaleReviewer = z.infer<typeof LocaleReviewerSchema>;
export type LocalePack = z.infer<typeof LocalePackSchema>;

export interface LocalePackUseResult {
  eligible: boolean;
  pack: LocalePack | null;
  blockers: string[];
}

function marketMatches(allowed: string, requested: string): boolean {
  const normalizedAllowed = allowed.trim().toLocaleLowerCase("en-US");
  return normalizedAllowed === "*"
    || normalizedAllowed === requested.trim().toLocaleLowerCase("en-US");
}

function localeMatches(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

export function evaluateLocalePackForUse(input: {
  pack: unknown;
  market: string;
  locale: string;
  now?: Date;
}): LocalePackUseResult {
  const parsed = LocalePackSchema.safeParse(input.pack);
  if (!parsed.success) {
    return {
      eligible: false,
      pack: null,
      blockers: parsed.error.issues.map((issue) =>
        `LOCALE_PACK_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const now = input.now ?? new Date();
  const pack = parsed.data;
  const blockers: string[] = [];
  if (pack.status !== "APPROVED") blockers.push("LOCALE_PACK_NOT_APPROVED");
  if (pack.revokedAt !== null) blockers.push("LOCALE_PACK_REVOKED");
  if (!marketMatches(pack.market, input.market)) blockers.push("LOCALE_PACK_MARKET_NOT_ALLOWED");
  if (!localeMatches(pack.locale, input.locale)) blockers.push("LOCALE_PACK_LOCALE_MISMATCH");
  if (now.getTime() < Date.parse(pack.validFrom)) blockers.push("LOCALE_PACK_NOT_YET_VALID");
  if (now.getTime() >= Date.parse(pack.validTo)) blockers.push("LOCALE_PACK_EXPIRED");
  return { eligible: blockers.length === 0, pack, blockers: [...new Set(blockers)].sort() };
}

const TranslationReviewerSchema = LocaleReviewerSchema;

export const NegationBindingSchema = z.object({
  id: IdSchema,
  sourceFragment: TextSchema.max(2_000),
  translatedFragment: TextSchema.max(2_000),
  meaning: z.literal("NEGATED"),
}).strict();

export const TranslationSchema = z.object({
  schemaVersion: z.literal(TRANSLATION_SCHEMA_VERSION),
  id: IdSchema,
  sourceLocale: LocaleTagSchema,
  targetLocale: LocaleTagSchema,
  localePackId: IdSchema,
  localePackVersion: z.number().int().positive(),
  sourceText: z.string().trim().min(1).max(100_000),
  translatedText: z.string().trim().min(1).max(100_000),
  approvedClaimIds: z.array(IdSchema).max(500),
  negationBindings: z.array(NegationBindingSchema).max(200),
  generationMode: z.enum(["MACHINE", "HUMAN"]),
  status: z.enum(["DRAFT", "LOCALIZATION_REVIEW", "APPROVED", "STALE", "REVOKED"]),
  reviewer: TranslationReviewerSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
}).strict().superRefine((translation, context) => {
  if (translation.generationMode === "MACHINE") {
    if (translation.status !== "DRAFT") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "machine translation output must remain DRAFT",
      });
    }
    if (translation.reviewer || translation.reviewedAt || translation.approvedAt || translation.revokedAt) {
      context.addIssue({
        code: "custom",
        path: ["generationMode"],
        message: "machine translation output cannot carry human review or approval fields",
      });
    }
  }
  if (translation.status === "APPROVED"
    && (translation.generationMode !== "HUMAN"
      || !translation.reviewer
      || !translation.reviewedAt
      || !translation.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "APPROVED requires HUMAN generation and a human localization review",
    });
  }
  if (translation.status === "REVOKED" && !translation.revokedAt) {
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "REVOKED requires revokedAt" });
  }
  if (translation.status !== "REVOKED" && translation.revokedAt !== null) {
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "revokedAt requires REVOKED status" });
  }
});

export type Translation = z.infer<typeof TranslationSchema>;

export interface ProtectedTranslationTokens {
  numbers: string[];
  units: string[];
  certifications: string[];
}

const NUMBER_PATTERN = /\d+(?:[.,]\d+)*/g;
const UNIT_PATTERN = /(?<![\p{L}\p{N}])(?:m\s*\/\s*s|dB\s*\(\s*A\s*\)|(?:k|M)?Pa|(?:k|M)?W|kWh|ppm|(?:m|c)?m|(?:k|m|µ|μ)?g|tonnes?|tons?|°\s*[CF]|%\s*RH|%)(?![\p{L}\p{N}])/giu;
const CERTIFICATION_PATTERN = /\b(?:ISO\s*\d{3,6}(?::\d{2,4})?(?:[-/]\d+)*|EN\s*\d+(?:[-:]\d+)*|IEC\s*\d+(?:[-:]\d+)*|UL(?:\s+(?:LISTED|\d+[A-Z]?))?|CE(?:\s+MARK(?:ING)?)?|RoHS|REACH)\b/giu;

function normalizeUnit(token: string): string {
  return token
    .replace(/[³^]3?/gu, "3")
    .replace(/[µμ]/gu, "u")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("en-US");
}

function normalizeCertification(token: string): string {
  return token.replace(/\s+/g, " ").trim().toLocaleUpperCase("en-US");
}

export function extractProtectedTranslationTokens(text: string): ProtectedTranslationTokens {
  return {
    numbers: [...text.matchAll(NUMBER_PATTERN)].map((match) => match[0] ?? ""),
    units: [...text.matchAll(UNIT_PATTERN)].map((match) => normalizeUnit(match[0] ?? "")),
    certifications: [...text.matchAll(CERTIFICATION_PATTERN)]
      .map((match) => normalizeCertification(match[0] ?? "")),
  };
}

function multisetDifference(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const difference: string[] = [];
  for (const value of left) {
    const count = remaining.get(value) ?? 0;
    if (count === 0) difference.push(value);
    else remaining.set(value, count - 1);
  }
  return difference.sort();
}

function markerCount(text: string, marker: string): number {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asciiWordLike = /^[A-Za-z0-9 '\-]+$/.test(marker);
  const expression = asciiWordLike
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "giu")
    : new RegExp(escaped, "gu");
  return [...text.matchAll(expression)].length;
}

function totalNegations(text: string, markers: readonly string[]): number {
  return markers.reduce((total, marker) => total + markerCount(text, marker), 0);
}

function clauses(text: string): string[] {
  return text.split(/[\r\n.!?;。！？；]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase("en-US").includes(needle.toLocaleLowerCase("en-US"));
}

export interface TranslationSafetyResult {
  passed: boolean;
  status: Translation["status"] | "REJECTED";
  translation: Translation | null;
  blockers: string[];
  protectedTokens: {
    source: ProtectedTranslationTokens;
    target: ProtectedTranslationTokens;
  } | null;
}

export function validateTranslationSafety(input: {
  translation: unknown;
  localePack: unknown;
  market: string;
  now?: Date;
}): TranslationSafetyResult {
  const translationResult = TranslationSchema.safeParse(input.translation);
  if (!translationResult.success) {
    return {
      passed: false,
      status: "REJECTED",
      translation: null,
      blockers: translationResult.error.issues.map((issue) =>
        `TRANSLATION_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
      protectedTokens: null,
    };
  }
  const translation = translationResult.data;
  const packResult = evaluateLocalePackForUse({
    pack: input.localePack,
    market: input.market,
    locale: translation.targetLocale,
    now: input.now,
  });
  const blockers = packResult.blockers.map((blocker) => `TRANSLATION_${blocker}`);
  const pack = packResult.pack;
  if (!pack) {
    return {
      passed: false,
      status: "REJECTED",
      translation,
      blockers,
      protectedTokens: null,
    };
  }
  if (translation.localePackId !== pack.id || translation.localePackVersion !== pack.version) {
    blockers.push("TRANSLATION_LOCALE_PACK_VERSION_MISMATCH");
  }
  if (!localeMatches(translation.sourceLocale, pack.sourceLocale)) {
    blockers.push("TRANSLATION_SOURCE_LOCALE_MISMATCH");
  }

  const sourceTokens = extractProtectedTranslationTokens(translation.sourceText);
  const targetTokens = extractProtectedTranslationTokens(translation.translatedText);
  const tokenGroups: Array<[keyof ProtectedTranslationTokens, string]> = [
    ["numbers", "NUMBER"],
    ["units", "UNIT"],
    ["certifications", "CERTIFICATION"],
  ];
  for (const [key, label] of tokenGroups) {
    const removed = multisetDifference(sourceTokens[key], targetTokens[key]);
    const added = multisetDifference(targetTokens[key], sourceTokens[key]);
    if (removed.length > 0 || added.length > 0) {
      blockers.push(`TRANSLATION_${label}_CHANGED:missing=${removed.join("|") || "none"}:added=${added.join("|") || "none"}`);
    }
  }

  const sourceNegationCount = totalNegations(translation.sourceText, pack.sourceNegationMarkers);
  const targetNegationCount = totalNegations(translation.translatedText, pack.targetNegationMarkers);
  if (sourceNegationCount !== targetNegationCount) blockers.push("TRANSLATION_NEGATION_CHANGED");

  const sourceNegativeClauses = clauses(translation.sourceText).filter((clause) =>
    totalNegations(clause, pack.sourceNegationMarkers) > 0);
  const targetNegativeClauses = clauses(translation.translatedText).filter((clause) =>
    totalNegations(clause, pack.targetNegationMarkers) > 0);
  if (sourceNegativeClauses.length !== targetNegativeClauses.length) {
    blockers.push("TRANSLATION_NEGATION_SCOPE_CHANGED");
  }
  for (const binding of translation.negationBindings) {
    if (!includesNormalized(translation.sourceText, binding.sourceFragment)
      || totalNegations(binding.sourceFragment, pack.sourceNegationMarkers) === 0
      || !includesNormalized(translation.translatedText, binding.translatedFragment)
      || totalNegations(binding.translatedFragment, pack.targetNegationMarkers) === 0) {
      blockers.push(`TRANSLATION_NEGATION_BINDING_INVALID:${binding.id}`);
    }
  }
  for (const sourceClause of sourceNegativeClauses) {
    if (!translation.negationBindings.some((binding) =>
      includesNormalized(sourceClause, binding.sourceFragment)
      || includesNormalized(binding.sourceFragment, sourceClause))) {
      blockers.push("TRANSLATION_NEGATED_SOURCE_CLAUSE_UNBOUND");
    }
  }
  for (const targetClause of targetNegativeClauses) {
    if (!translation.negationBindings.some((binding) =>
      includesNormalized(targetClause, binding.translatedFragment)
      || includesNormalized(binding.translatedFragment, targetClause))) {
      blockers.push("TRANSLATION_NEGATED_TARGET_CLAUSE_UNBOUND");
    }
  }
  for (const forbidden of pack.forbiddenLiteralTranslations) {
    if (includesNormalized(translation.translatedText, forbidden.forbiddenText)) {
      blockers.push(`TRANSLATION_FORBIDDEN_LITERAL:${forbidden.sourceText}`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    passed: uniqueBlockers.length === 0,
    status: uniqueBlockers.length === 0 ? translation.status : "REJECTED",
    translation,
    blockers: uniqueBlockers,
    protectedTokens: { source: sourceTokens, target: targetTokens },
  };
}

export function createMachineTranslationDraft(input: {
  id: string;
  sourceLocale: string;
  targetLocale: string;
  localePackId: string;
  localePackVersion: number;
  sourceText: string;
  translatedText: string;
  approvedClaimIds?: readonly string[];
  negationBindings?: readonly z.input<typeof NegationBindingSchema>[];
  createdAt?: Date;
}): Translation {
  return TranslationSchema.parse({
    schemaVersion: TRANSLATION_SCHEMA_VERSION,
    id: input.id,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    localePackId: input.localePackId,
    localePackVersion: input.localePackVersion,
    sourceText: input.sourceText,
    translatedText: input.translatedText,
    approvedClaimIds: [...(input.approvedClaimIds ?? [])],
    negationBindings: [...(input.negationBindings ?? [])],
    generationMode: "MACHINE",
    status: "DRAFT",
    reviewer: null,
    reviewedAt: null,
    approvedAt: null,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    revokedAt: null,
  });
}
