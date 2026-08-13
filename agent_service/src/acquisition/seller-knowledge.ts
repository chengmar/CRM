import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";

export const SELLER_KNOWLEDGE_SCHEMA_VERSION = "seller-knowledge-v2" as const;
export const SELLER_PROFILE_SCHEMA_VERSION = "seller-profile-v2" as const;

const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "must be an HTTP(S) URL");

const NonPlaceholderTextSchema = z.string().trim().min(1).max(2_000);

export const SellerSenderSchema = z.object({
  name: NonPlaceholderTextSchema.max(160),
  email: z.string().trim().email().max(320),
  title: NonPlaceholderTextSchema.max(160).optional(),
}).strict();

export const SellerPostalAddressSchema = z.object({
  line1: NonPlaceholderTextSchema.max(300),
  line2: NonPlaceholderTextSchema.max(300).optional(),
  city: NonPlaceholderTextSchema.max(160),
  region: NonPlaceholderTextSchema.max(160).optional(),
  postalCode: NonPlaceholderTextSchema.max(40),
  country: NonPlaceholderTextSchema.max(120),
}).strict();

export const SellerUnsubscribeSchema = z.object({
  method: z.enum(["REPLY", "MAILTO", "URL"]),
  instruction: NonPlaceholderTextSchema.max(500),
  destination: z.string().trim().max(500).optional(),
}).strict();

export const SellerProductSchema = z.object({
  id: NonPlaceholderTextSchema.max(120),
  name: NonPlaceholderTextSchema.max(240),
  modelsOrSpecifications: z.array(NonPlaceholderTextSchema.max(500)).min(1).max(100),
  publicApproved: z.boolean(),
}).strict();

export const SellerQuoteBoundariesSchema = z.object({
  moq: NonPlaceholderTextSchema.max(500),
  leadTime: NonPlaceholderTextSchema.max(500),
  pricing: NonPlaceholderTextSchema.max(500),
  payment: NonPlaceholderTextSchema.max(500),
  oem: NonPlaceholderTextSchema.max(500),
  packaging: NonPlaceholderTextSchema.max(500),
  installation: NonPlaceholderTextSchema.max(500),
  requiresHumanApproval: z.literal(true),
}).strict();

export const SellerProfileSchema = z.object({
  schemaVersion: z.literal(SELLER_PROFILE_SCHEMA_VERSION),
  id: NonPlaceholderTextSchema.max(120),
  version: z.number().int().positive(),
  status: z.enum(["DRAFT", "APPROVED", "REVOKED"]),
  legalNameEn: NonPlaceholderTextSchema.max(240),
  brandNameEn: NonPlaceholderTextSchema.max(240),
  website: HttpUrlSchema,
  sender: SellerSenderSchema,
  postalAddress: SellerPostalAddressSchema,
  unsubscribe: SellerUnsubscribeSchema,
  products: z.array(SellerProductSchema).min(1).max(100),
  quoteBoundaries: SellerQuoteBoundariesSchema,
  prohibitedClaims: z.array(NonPlaceholderTextSchema.max(500)).max(200),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema,
}).strict();

export const SellerFactSchema = z.object({
  schemaVersion: z.literal("seller-fact-v2"),
  id: NonPlaceholderTextSchema.max(120),
  profileId: NonPlaceholderTextSchema.max(120),
  factSetVersion: z.number().int().positive(),
  subject: NonPlaceholderTextSchema.max(240),
  predicate: NonPlaceholderTextSchema.max(160),
  value: NonPlaceholderTextSchema.max(2_000),
  unit: NonPlaceholderTextSchema.max(80).nullable(),
  source: z.object({
    type: z.enum(["OFFICIAL_WEBSITE", "CERTIFICATE", "PRODUCT_SHEET", "SIGNED_APPROVAL"]),
    url: HttpUrlSchema.nullable(),
    documentId: NonPlaceholderTextSchema.max(160).nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  publicApproved: z.boolean(),
  status: z.enum(["ACTIVE", "REVOKED", "SUPERSEDED"]),
  allowedMarkets: z.array(NonPlaceholderTextSchema.max(120)).min(1).max(100),
  allowedChannels: z.array(z.enum(["EMAIL", "LINKEDIN", "WHATSAPP", "WEBSITE"])).min(1),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema,
  confidentiality: z.enum(["PUBLIC", "INTERNAL_ONLY", "PROHIBITED"]),
  version: z.number().int().positive(),
}).strict();

export const SellerOfferSchema = z.object({
  schemaVersion: z.literal("seller-offer-v2"),
  id: NonPlaceholderTextSchema.max(120),
  profileId: NonPlaceholderTextSchema.max(120),
  profileVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  productId: NonPlaceholderTextSchema.max(120),
  text: NonPlaceholderTextSchema.max(1_000),
  sellerFactIds: z.array(NonPlaceholderTextSchema.max(120)).min(1).max(100),
  status: z.enum(["DRAFT", "ACTIVE", "REVOKED", "EXPIRED"]),
  publicApproved: z.boolean(),
  allowedMarkets: z.array(NonPlaceholderTextSchema.max(120)).min(1).max(100),
  allowedChannels: z.array(z.enum(["EMAIL", "LINKEDIN", "WHATSAPP", "WEBSITE"])).min(1),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema,
}).strict();

export const PrivateCaseSchema = z.object({
  id: NonPlaceholderTextSchema.max(120),
  confidentiality: z.literal("INTERNAL_ONLY"),
  customerName: NonPlaceholderTextSchema.max(240),
  location: NonPlaceholderTextSchema.max(240).nullable(),
  result: NonPlaceholderTextSchema.max(2_000).nullable(),
  metrics: z.array(NonPlaceholderTextSchema.max(500)).max(100),
  derivedApplicationTags: z.array(NonPlaceholderTextSchema.max(120)).max(100),
}).strict();

export const SellerKnowledgeDocumentSchema = z.object({
  schemaVersion: z.literal(SELLER_KNOWLEDGE_SCHEMA_VERSION),
  factSetId: NonPlaceholderTextSchema.max(120),
  factSetVersion: z.number().int().positive(),
  profile: SellerProfileSchema,
  facts: z.array(SellerFactSchema).max(1_000),
  offers: z.array(SellerOfferSchema).min(1).max(200),
  privateCases: z.array(PrivateCaseSchema).max(500),
}).strict();

export type SellerProfile = z.infer<typeof SellerProfileSchema>;
export type SellerFact = z.infer<typeof SellerFactSchema>;
export type SellerOffer = z.infer<typeof SellerOfferSchema>;
export type SellerKnowledgeDocument = z.infer<typeof SellerKnowledgeDocumentSchema>;
export type SellerChannel = SellerFact["allowedChannels"][number];

export interface SellerReadinessResult {
  ready: boolean;
  schemaVersion: typeof SELLER_KNOWLEDGE_SCHEMA_VERSION;
  checkedAt: string;
  profileId: string | null;
  profileVersion: number | null;
  factSetVersion: number | null;
  blockers: string[];
}

export interface SellerKnowledgeLoadResult {
  parsed: boolean;
  document: SellerKnowledgeDocument | null;
  readiness: SellerReadinessResult;
}

const PLACEHOLDER_PATTERNS = [
  /(?:^|\b)(?:todo|tbd|placeholder|fill\s+(?:this|in)|your\s+(?:company|brand|name|website)|company\s+name)(?:\b|$)/i,
  /(?:^|[^a-z])x{3,}(?:[^a-z]|$)/i,
  /<[^>]*(?:insert|replace|company|name|value)[^>]*>/i,
  /\{\{[^}]+\}\}/,
  /example\.com(?:\b|\/)/i,
  /待填写|占位|请填写/,
] as const;

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "qq.com",
  "163.com",
  "126.com",
]);

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

export function deterministicSellerContentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function isActiveWindow(validFrom: string, validTo: string, now: Date): boolean {
  const at = now.getTime();
  return Date.parse(validFrom) <= at && at <= Date.parse(validTo);
}

function marketAllowed(allowedMarkets: string[], market: string): boolean {
  const normalized = market.trim().toLowerCase();
  return allowedMarkets.some((candidate) => {
    const allowed = candidate.trim().toLowerCase();
    return allowed === "*" || allowed === normalized;
  });
}

function findPlaceholderPaths(value: unknown, path: string[] = []): string[] {
  if (typeof value === "string") {
    return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()))
      ? [path.join(".") || "$root"]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPlaceholderPaths(entry, [...path, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => findPlaceholderPaths(entry, [...path, key]));
  }
  return [];
}

function senderMatchesWebsite(profile: SellerProfile): boolean {
  const senderDomain = profile.sender.email.toLowerCase().split("@")[1] ?? "";
  if (!senderDomain || CONSUMER_EMAIL_DOMAINS.has(senderDomain)) return false;
  const websiteDomain = new URL(profile.website).hostname.toLowerCase().replace(/^www\./, "");
  return senderDomain === websiteDomain
    || senderDomain.endsWith(`.${websiteDomain}`)
    || websiteDomain.endsWith(`.${senderDomain}`);
}

function unsubscribeIsComplete(profile: SellerProfile): boolean {
  const { method, destination, instruction } = profile.unsubscribe;
  if (!/(?:unsubscribe|opt\s*out|stop|do not contact|remove)/i.test(instruction)) return false;
  if (method === "REPLY") return true;
  if (!destination) return false;
  if (method === "MAILTO") return /^mailto:[^\s@]+@[^\s@]+$/i.test(destination);
  try {
    return new URL(destination).protocol === "https:";
  } catch {
    return false;
  }
}

function emptyReadiness(now: Date, blockers: string[]): SellerReadinessResult {
  return {
    ready: false,
    schemaVersion: SELLER_KNOWLEDGE_SCHEMA_VERSION,
    checkedAt: now.toISOString(),
    profileId: null,
    profileVersion: null,
    factSetVersion: null,
    blockers,
  };
}

export function assessSellerReadiness(
  input: unknown,
  now = new Date(),
): SellerReadinessResult {
  const parsed = SellerKnowledgeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return emptyReadiness(now, parsed.error.issues.map((issue) =>
      `SELLER_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }

  const document = parsed.data;
  const { profile } = document;
  const blockers: string[] = [];
  if (profile.status !== "APPROVED") blockers.push("SELLER_PROFILE_NOT_APPROVED");
  if (!isActiveWindow(profile.validFrom, profile.validTo, now)) blockers.push("SELLER_PROFILE_STALE");
  if (!senderMatchesWebsite(profile)) blockers.push("SELLER_SENDER_POLICY_INVALID");
  if (!unsubscribeIsComplete(profile)) blockers.push("SELLER_UNSUBSCRIBE_POLICY_INVALID");

  for (const placeholderPath of findPlaceholderPaths(document)) {
    blockers.push(`SELLER_PLACEHOLDER:${placeholderPath}`);
  }

  const productIds = new Set(profile.products.map((product) => product.id));
  if (profile.products.some((product) => !product.publicApproved)) {
    blockers.push("SELLER_PRODUCT_NOT_PUBLIC_APPROVED");
  }

  const factById = new Map(document.facts.map((fact) => [fact.id, fact]));
  for (const fact of document.facts) {
    if (fact.profileId !== profile.id || fact.factSetVersion !== document.factSetVersion) {
      blockers.push(`SELLER_FACT_VERSION_MISMATCH:${fact.id}`);
    }
    if (fact.confidentiality === "PUBLIC" && !fact.publicApproved) {
      blockers.push(`SELLER_PUBLIC_FACT_NOT_APPROVED:${fact.id}`);
    }
    if (fact.status === "ACTIVE" && !isActiveWindow(fact.validFrom, fact.validTo, now)) {
      blockers.push(`SELLER_FACT_STALE:${fact.id}`);
    }
  }

  for (const offer of document.offers) {
    if (offer.profileId !== profile.id || offer.profileVersion !== profile.version) {
      blockers.push(`SELLER_OFFER_PROFILE_MISMATCH:${offer.id}`);
    }
    if (!productIds.has(offer.productId)) blockers.push(`SELLER_OFFER_PRODUCT_UNKNOWN:${offer.id}`);
    if (offer.status === "ACTIVE" && !isActiveWindow(offer.validFrom, offer.validTo, now)) {
      blockers.push(`SELLER_OFFER_STALE:${offer.id}`);
    }
    if (offer.status === "ACTIVE" && !offer.publicApproved) {
      blockers.push(`SELLER_OFFER_NOT_PUBLIC_APPROVED:${offer.id}`);
    }
    for (const factId of offer.sellerFactIds) {
      const fact = factById.get(factId);
      if (!fact) {
        blockers.push(`SELLER_OFFER_FACT_UNKNOWN:${offer.id}:${factId}`);
      } else if (fact.status !== "ACTIVE" || fact.confidentiality !== "PUBLIC" || !fact.publicApproved) {
        blockers.push(`SELLER_OFFER_FACT_NOT_APPROVED:${offer.id}:${factId}`);
      }
    }
  }
  if (!document.offers.some((offer) => offer.status === "ACTIVE" && offer.publicApproved)) {
    blockers.push("SELLER_ACTIVE_OFFER_MISSING");
  }

  return {
    ready: blockers.length === 0,
    schemaVersion: SELLER_KNOWLEDGE_SCHEMA_VERSION,
    checkedAt: now.toISOString(),
    profileId: profile.id,
    profileVersion: profile.version,
    factSetVersion: document.factSetVersion,
    blockers: [...new Set(blockers)].sort(),
  };
}

export function parseSellerKnowledgeDocument(
  raw: string,
  format: "JSON" | "YAML",
  now = new Date(),
): SellerKnowledgeLoadResult {
  let decoded: unknown;
  try {
    decoded = format === "JSON" ? JSON.parse(raw) : YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "unknown parse error";
    return {
      parsed: false,
      document: null,
      readiness: emptyReadiness(now, [`SELLER_${format}_PARSE_FAILED:${message}`]),
    };
  }
  const schemaResult = SellerKnowledgeDocumentSchema.safeParse(decoded);
  if (!schemaResult.success) {
    return {
      parsed: true,
      document: null,
      readiness: assessSellerReadiness(decoded, now),
    };
  }
  return {
    parsed: true,
    document: schemaResult.data,
    readiness: assessSellerReadiness(schemaResult.data, now),
  };
}

export interface PublicSellerPlanningContext {
  schemaVersion: typeof SELLER_KNOWLEDGE_SCHEMA_VERSION;
  profile: {
    id: string;
    version: number;
    legalNameEn: string;
    brandNameEn: string;
    products: Array<{ id: string; name: string }>;
    prohibitedClaims: string[];
  };
  factSetId: string;
  factSetVersion: number;
  facts: SellerFact[];
  offers: SellerOffer[];
}

export class SellerKnowledgeStore {
  readonly readiness: SellerReadinessResult;
  readonly document: SellerKnowledgeDocument;

  constructor(input: unknown, now = new Date()) {
    this.document = SellerKnowledgeDocumentSchema.parse(input);
    this.readiness = assessSellerReadiness(this.document, now);
  }

  static fromDocument(
    raw: string,
    format: "JSON" | "YAML",
    now = new Date(),
  ): { store: SellerKnowledgeStore | null; result: SellerKnowledgeLoadResult } {
    const result = parseSellerKnowledgeDocument(raw, format, now);
    return {
      store: result.document ? new SellerKnowledgeStore(result.document, now) : null,
      result,
    };
  }

  getApprovedFacts(
    factIds: readonly string[],
    market: string,
    channel: SellerChannel,
    now = new Date(),
  ): SellerFact[] {
    const requested = new Set(factIds);
    return this.document.facts.filter((fact) =>
      requested.has(fact.id)
      && fact.status === "ACTIVE"
      && fact.publicApproved
      && fact.confidentiality === "PUBLIC"
      && fact.allowedChannels.includes(channel)
      && marketAllowed(fact.allowedMarkets, market)
      && isActiveWindow(fact.validFrom, fact.validTo, now));
  }

  getApprovedOffer(
    offerId: string,
    market: string,
    channel: SellerChannel,
    now = new Date(),
  ): SellerOffer | null {
    return this.document.offers.find((offer) =>
      offer.id === offerId
      && offer.status === "ACTIVE"
      && offer.publicApproved
      && offer.profileId === this.document.profile.id
      && offer.profileVersion === this.document.profile.version
      && offer.allowedChannels.includes(channel)
      && marketAllowed(offer.allowedMarkets, market)
      && isActiveWindow(offer.validFrom, offer.validTo, now)) ?? null;
  }

  getPublicPlanningContext(
    market: string,
    channel: SellerChannel,
    now = new Date(),
  ): PublicSellerPlanningContext | null {
    if (!this.readiness.ready) return null;
    const facts = this.getApprovedFacts(this.document.facts.map((fact) => fact.id), market, channel, now);
    const offers = this.document.offers.filter((offer) =>
      this.getApprovedOffer(offer.id, market, channel, now) !== null
      && offer.sellerFactIds.every((id) => facts.some((fact) => fact.id === id)));
    return {
      schemaVersion: SELLER_KNOWLEDGE_SCHEMA_VERSION,
      profile: {
        id: this.document.profile.id,
        version: this.document.profile.version,
        legalNameEn: this.document.profile.legalNameEn,
        brandNameEn: this.document.profile.brandNameEn,
        products: this.document.profile.products.map(({ id, name }) => ({ id, name })),
        prohibitedClaims: [...this.document.profile.prohibitedClaims],
      },
      factSetId: this.document.factSetId,
      factSetVersion: this.document.factSetVersion,
      facts,
      offers,
    };
  }

  privateLeakageCaseIds(text: string): string[] {
    const normalized = text.toLocaleLowerCase("en-US");
    return this.document.privateCases.flatMap((privateCase) => {
      const sensitive = [
        privateCase.customerName,
        privateCase.location,
        privateCase.result,
        ...privateCase.metrics,
      ].filter((value): value is string => Boolean(value && value.trim().length >= 4));
      return sensitive.some((value) => normalized.includes(value.toLocaleLowerCase("en-US")))
        ? [privateCase.id]
        : [];
    });
  }
}
