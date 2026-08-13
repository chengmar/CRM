import { isIP } from "node:net";
import { getDomain } from "tldts";
import { z } from "zod";
import { normalizePublicHttpUrl } from "../../http-url.js";
import type { ProviderCost, ProviderHealth } from "../provider-runtime.js";

export const ProviderIdSchema = z.enum([
  "LOCAL_PUBLIC_WEB",
  "SERPER",
  "EXA",
  "SEARXNG",
  "APOLLO_OFFICIAL",
  "APIFY_WEBSITE",
  "APIFY_PLACES",
  "GOOGLE_PLACES",
  "INSTANTLY",
  "ANYMAIL_FINDER",
  "WIZA",
  "HUNTER",
  "BOUNCER",
  "CLAY",
  "LEMLIST",
  "PERPLEXITY_EVIDENCE",
]);

export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderOperationSchema = z.enum([
  "ACCOUNT_DISCOVERY",
  "CONTACT_SEARCH",
  "PERSON_ENRICHMENT",
  "WORK_EMAIL_DISCOVERY",
  "EMAIL_VERIFICATION",
  "WEBSITE_CRAWL",
  "OUTREACH_DRAFT",
  "OUTREACH_RECONCILE",
  "OUTREACH_CANCEL",
  "EVIDENCE_SEARCH",
]);

export type ProviderOperation = z.infer<typeof ProviderOperationSchema>;

export const ProviderCapabilitySchema = ProviderOperationSchema;
export type ProviderCapability = ProviderOperation;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().trim().min(1).max(200);
const DateTimeSchema = z.string().datetime({ offset: true });

function normalizedRegisteredDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (!candidate || candidate.includes("/") || candidate.includes(":")) return null;
  return getDomain(candidate, { allowPrivateDomains: false }) ?? null;
}

function emailRegisteredDomain(value: string): string | null {
  const domain = value.split("@").at(-1) ?? "";
  return normalizedRegisteredDomain(domain);
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    ) {
      return false;
    }
  }
  if (version === 6) {
    return !(
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host)
    );
  }
  return true;
}

export const PublicHttpUrlSchema = z.string().trim().max(2_000).superRefine((value, context) => {
  const normalized = normalizePublicHttpUrl(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: "A public HTTP(S) URL is required" });
    return;
  }
  if (!isPublicHostname(new URL(normalized).hostname)) {
    context.addIssue({ code: "custom", message: "Private and local network URLs are prohibited" });
  }
});

export const CorporateDomainSchema = z.string().trim().toLowerCase().max(253).refine(
  (value) => normalizedRegisteredDomain(value) === value.replace(/^www\./, ""),
  "A registrable canonical domain is required",
);

const roleLocalParts = new Set([
  "admin",
  "billing",
  "contact",
  "hello",
  "info",
  "inquiry",
  "office",
  "sales",
  "service",
  "support",
  "team",
]);

const personalMailboxDomains = new Set([
  "aol.com",
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "yahoo.com",
  "yandex.com",
]);

export const WorkEmailSchema = z.string().trim().toLowerCase().max(320).email().superRefine((email, context) => {
  const [localPart = "", domain = ""] = email.split("@", 2);
  if (roleLocalParts.has(localPart)) {
    context.addIssue({ code: "custom", message: "Role mailboxes are prohibited" });
  }
  if (personalMailboxDomains.has(domain)) {
    context.addIssue({ code: "custom", message: "Personal mailbox domains are prohibited" });
  }
});

const RoleFamilySchema = z.enum([
  "OWNER",
  "GENERAL_MANAGEMENT",
  "PRODUCT",
  "SALES",
  "SOURCING",
  "PROCUREMENT",
  "TECHNICAL",
  "PROJECT",
  "ENGINEERING",
  "EHS",
  "MAINTENANCE",
  "PLANT",
]);

const AccountDiscoveryRequestSchema = z.object({
  operation: z.literal("ACCOUNT_DISCOVERY"),
  country: z.string().trim().min(2).max(100),
  localities: z.array(z.string().trim().min(1).max(150)).max(50),
  buyerTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  keywords: z.array(z.string().trim().min(1).max(150)).min(1).max(50),
  limit: z.number().int().min(1).max(100),
  budgetId: IdentifierSchema,
  sourceMode: z.literal("OFFICIAL_API_ONLY"),
  personalDataAllowed: z.literal(false),
}).strict();

const ContactSearchRequestSchema = z.object({
  operation: z.literal("CONTACT_SEARCH"),
  accountId: IdentifierSchema,
  displayName: z.string().trim().min(1).max(300),
  canonicalDomain: CorporateDomainSchema,
  buyerType: z.string().trim().min(1).max(100),
  roleFamilies: z.array(RoleFamilySchema).min(1).max(12),
  limit: z.number().int().min(1).max(2),
  dataPolicy: z.literal("B2B_WORK_ONLY"),
}).strict();

const PersonReferenceSchema = z.object({
  personRef: IdentifierSchema,
  providerPersonId: IdentifierSchema.nullable(),
  fullName: z.string().trim().min(2).max(200),
}).strict();

const PersonEnrichmentRequestSchema = z.object({
  operation: z.literal("PERSON_ENRICHMENT"),
  accountId: IdentifierSchema,
  canonicalDomain: CorporateDomainSchema,
  person: PersonReferenceSchema,
  requestedAssertions: z.array(z.enum(["EMPLOYMENT", "WORK_EMAIL_DISCOVERY"])).min(1).max(2),
  personalEmailAllowed: z.literal(false),
  phoneAllowed: z.literal(false),
}).strict();

export const WorkEmailDiscoveryRequestSchema = z.object({
  operation: z.literal("WORK_EMAIL_DISCOVERY"),
  accountId: IdentifierSchema,
  canonicalDomain: CorporateDomainSchema,
  person: PersonReferenceSchema,
  roleFamily: RoleFamilySchema,
  personalEmailAllowed: z.literal(false),
  roleMailboxAllowed: z.literal(false),
}).strict();

export const EmailVerificationRequestSchema = z.object({
  operation: z.literal("EMAIL_VERIFICATION"),
  accountId: IdentifierSchema,
  personRef: IdentifierSchema,
  email: WorkEmailSchema,
  expectedDomain: CorporateDomainSchema,
  discoveryAssertionId: IdentifierSchema,
  discoveryProviderId: ProviderIdSchema,
  independentVerificationRequired: z.literal(true),
}).strict().superRefine((value, context) => {
  if (emailRegisteredDomain(value.email) !== normalizedRegisteredDomain(value.expectedDomain)) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: "The mailbox must match the canonical account domain",
    });
  }
});

const WebsiteCrawlRequestSchema = z.object({
  operation: z.literal("WEBSITE_CRAWL"),
  accountId: IdentifierSchema,
  canonicalDomain: CorporateDomainSchema,
  url: PublicHttpUrlSchema,
  escalationReason: z.enum(["JS_REQUIRED", "BLOCKED", "PARTIAL", "DOCUMENT", "CONTENT_INSUFFICIENT"]),
  maxPages: z.number().int().min(1).max(20),
  obeyRobots: z.literal(true),
  allowCrossDomain: z.literal(false),
  allowPrivateNetworks: z.literal(false),
}).strict().superRefine((value, context) => {
  const normalized = normalizePublicHttpUrl(value.url);
  const urlDomain = normalized ? getDomain(new URL(normalized).hostname) : null;
  if (urlDomain !== normalizedRegisteredDomain(value.canonicalDomain)) {
    context.addIssue({ code: "custom", path: ["url"], message: "Cross-domain crawl requests are prohibited" });
  }
});

const OutreachDraftRequestSchema = z.object({
  operation: z.literal("OUTREACH_DRAFT"),
  accountId: IdentifierSchema,
  leadId: IdentifierSchema,
  contactId: IdentifierSchema,
  messageIds: z.array(IdentifierSchema).min(1).max(10),
  recipientWorkEmail: WorkEmailSchema,
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  reviewHash: Sha256Schema,
  dossierVersion: z.number().int().min(1),
  experimentArm: IdentifierSchema,
  contentHash: Sha256Schema,
  approvalState: z.literal("APPROVED"),
  transportMode: z.literal("PAUSED_DRAFT"),
  openTrackingEnabled: z.literal(false),
  clickTrackingEnabled: z.literal(false),
  replyStopEnabled: z.literal(true),
  companyStopEnabled: z.literal(true),
  dncCheckedAt: DateTimeSchema,
  riskyMailbox: z.literal(false),
  humanTakeover: z.literal(false),
  alreadyReplied: z.literal(false),
}).strict();

const OutreachReconcileRequestSchema = z.object({
  operation: z.literal("OUTREACH_RECONCILE"),
  externalDraftId: IdentifierSchema,
  localCampaignId: IdentifierSchema,
  originalIdempotencyKey: Sha256Schema,
}).strict();

const OutreachCancelRequestSchema = z.object({
  operation: z.literal("OUTREACH_CANCEL"),
  leadId: IdentifierSchema,
  externalDraftId: IdentifierSchema,
  reason: z.enum(["REPLY", "UNSUBSCRIBE", "DNC", "HUMAN_TAKEOVER", "CANCELLED"]),
}).strict();

const EvidenceSearchRequestSchema = z.object({
  operation: z.literal("EVIDENCE_SEARCH"),
  accountId: IdentifierSchema,
  query: z.string().trim().min(3).max(500),
  limit: z.number().int().min(1).max(25).default(10),
  publicSourcesOnly: z.literal(true),
  localFetchValidationRequired: z.literal(true),
}).strict();

export const ProviderRequestSchema = z.discriminatedUnion("operation", [
  AccountDiscoveryRequestSchema,
  ContactSearchRequestSchema,
  PersonEnrichmentRequestSchema,
  WorkEmailDiscoveryRequestSchema,
  EmailVerificationRequestSchema,
  WebsiteCrawlRequestSchema,
  OutreachDraftRequestSchema,
  OutreachReconcileRequestSchema,
  OutreachCancelRequestSchema,
  EvidenceSearchRequestSchema,
]);

export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

export const ProviderAssertionKindSchema = z.enum([
  "ACCOUNT_DISCOVERY",
  "CONTACT_IDENTITY",
  "EMPLOYMENT",
  "EMAIL_DISCOVERY",
  "EMAIL_VERIFICATION",
  "WEBSITE_CONTENT",
  "TRANSPORT_DRAFT",
  "TRANSPORT_EVENT",
  "EVIDENCE_REFERENCE",
]);

export type ProviderAssertionKind = z.infer<typeof ProviderAssertionKindSchema>;

const AssertionBaseShape = {
  assertionId: IdentifierSchema,
  providerId: ProviderIdSchema,
  providerRunId: IdentifierSchema,
  accountId: IdentifierSchema,
  sourceUri: PublicHttpUrlSchema.nullable(),
  observedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  confidence: z.number().min(0).max(1),
  rawPayloadHash: Sha256Schema,
  creditUnits: z.number().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
};

export const AccountDiscoveryAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("ACCOUNT_DISCOVERY"),
  providerExternalId: IdentifierSchema,
  displayName: z.string().trim().min(1).max(300),
  country: z.string().trim().min(2).max(100),
  locality: z.string().trim().min(1).max(150).nullable(),
  websiteAssertion: PublicHttpUrlSchema.nullable(),
  identityEffect: z.literal("ASSERTION_ONLY"),
}).strict();

export const ContactIdentityAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("CONTACT_IDENTITY"),
  personRef: IdentifierSchema,
  providerPersonId: IdentifierSchema,
  fullName: z.string().trim().min(2).max(200),
  title: z.string().trim().min(1).max(250),
  identityEffect: z.literal("ASSERTION_ONLY"),
}).strict();

export const EmploymentAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("EMPLOYMENT"),
  personRef: IdentifierSchema,
  providerPersonId: IdentifierSchema,
  providerCompanyId: IdentifierSchema,
  employerName: z.string().trim().min(1).max(300),
  employerDomainAssertion: CorporateDomainSchema,
  title: z.string().trim().min(1).max(250),
  providerVerdict: z.enum(["CURRENT", "PAST", "UNKNOWN"]),
  localEmploymentState: z.literal("UNCHANGED"),
}).strict();

export const EmailDiscoveryAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("EMAIL_DISCOVERY"),
  personRef: IdentifierSchema,
  email: WorkEmailSchema,
  emailDomain: CorporateDomainSchema,
  emailType: z.literal("WORK"),
  providerStatus: z.enum(["PROVIDER_VALID_ASSERTION", "PROVIDER_RISKY_ASSERTION", "PROVIDER_UNKNOWN"]),
  localMailboxVerdict: z.literal("NOT_VERIFIED"),
}).strict().superRefine((value, context) => {
  if (emailRegisteredDomain(value.email) !== normalizedRegisteredDomain(value.emailDomain)) {
    context.addIssue({ code: "custom", path: ["email"], message: "Cross-domain email assertions are prohibited" });
  }
});

export const EmailVerificationAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("EMAIL_VERIFICATION"),
  personRef: IdentifierSchema,
  emailHash: Sha256Schema,
  discoveryAssertionId: IdentifierSchema,
  discoveryProviderId: ProviderIdSchema,
  verificationProviderId: ProviderIdSchema,
  providerMailboxVerdict: z.enum([
    "VALID_ASSERTION",
    "INVALID_ASSERTION",
    "RISKY_ASSERTION",
    "UNKNOWN_ASSERTION",
  ]),
  catchAll: z.boolean(),
  disposable: z.boolean(),
  roleMailbox: z.boolean(),
  localMailboxVerdict: z.literal("UNCHANGED"),
}).strict().superRefine((value, context) => {
  if (value.discoveryProviderId === value.verificationProviderId) {
    context.addIssue({
      code: "custom",
      path: ["verificationProviderId"],
      message: "Mailbox verification must be independent from discovery",
    });
  }
  if (
    value.providerMailboxVerdict === "VALID_ASSERTION" &&
    (value.catchAll || value.disposable || value.roleMailbox)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerMailboxVerdict"],
      message: "A risky mailbox cannot carry a valid verification assertion",
    });
  }
});

export const WebsiteContentAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("WEBSITE_CONTENT"),
  snapshotId: IdentifierSchema,
  pageUrl: PublicHttpUrlSchema,
  exactQuote: z.string().trim().min(1).max(20_000),
  contentHash: Sha256Schema,
  evidenceEffect: z.literal("SNAPSHOT_ONLY"),
}).strict();

export const TransportDraftAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("TRANSPORT_DRAFT"),
  externalDraftId: IdentifierSchema,
  contentHash: Sha256Schema,
  reviewHash: Sha256Schema,
  paused: z.literal(true),
  activated: z.literal(false),
}).strict();

export const TransportEventAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("TRANSPORT_EVENT"),
  providerEventId: IdentifierSchema,
  externalDraftId: IdentifierSchema,
  eventType: z.enum([
    "DRAFT_CONFIRMED",
    "CANCEL_CONFIRMED",
    "STATE_UNKNOWN",
    "RECONCILIATION_REQUIRED",
  ]),
  localStateEffect: z.literal("RECONCILIATION_ASSERTION_ONLY"),
}).strict();

export const EvidenceReferenceAssertionSchema = z.object({
  ...AssertionBaseShape,
  kind: z.literal("EVIDENCE_REFERENCE"),
  subject: z.string().trim().min(1).max(300),
  sourceUrl: PublicHttpUrlSchema,
  quotedText: z.string().trim().min(1).max(5_000),
  localFetchVerified: z.literal(false),
  evidenceEffect: z.literal("REQUIRES_LOCAL_FETCH"),
}).strict();

export const ProviderAssertionSchema = z.discriminatedUnion("kind", [
  AccountDiscoveryAssertionSchema,
  ContactIdentityAssertionSchema,
  EmploymentAssertionSchema,
  EmailDiscoveryAssertionSchema,
  EmailVerificationAssertionSchema,
  WebsiteContentAssertionSchema,
  TransportDraftAssertionSchema,
  TransportEventAssertionSchema,
  EvidenceReferenceAssertionSchema,
]);

export type ProviderAssertion = z.infer<typeof ProviderAssertionSchema>;

const assertionsAllowedByOperation: Record<ProviderOperation, ReadonlySet<ProviderAssertionKind>> = {
  ACCOUNT_DISCOVERY: new Set(["ACCOUNT_DISCOVERY"]),
  CONTACT_SEARCH: new Set(["CONTACT_IDENTITY", "EMPLOYMENT"]),
  PERSON_ENRICHMENT: new Set(["CONTACT_IDENTITY", "EMPLOYMENT", "EMAIL_DISCOVERY"]),
  WORK_EMAIL_DISCOVERY: new Set(["EMAIL_DISCOVERY"]),
  EMAIL_VERIFICATION: new Set(["EMAIL_VERIFICATION"]),
  WEBSITE_CRAWL: new Set(["WEBSITE_CONTENT"]),
  OUTREACH_DRAFT: new Set(["TRANSPORT_DRAFT"]),
  OUTREACH_RECONCILE: new Set(["TRANSPORT_EVENT"]),
  OUTREACH_CANCEL: new Set(["TRANSPORT_EVENT"]),
  EVIDENCE_SEARCH: new Set(["EVIDENCE_REFERENCE"]),
};

export const ProviderResponseSchema = z.object({
  providerId: ProviderIdSchema,
  providerRunId: IdentifierSchema,
  operation: ProviderOperationSchema,
  result: z.enum(["ASSERTIONS_RETURNED", "NO_MATCH", "PARTIAL"]),
  assertions: z.array(ProviderAssertionSchema).max(100),
  rawPayloadHash: Sha256Schema,
  retryAfterSeconds: z.number().int().nonnegative().max(86_400).nullable(),
}).strict().superRefine((value, context) => {
  if (value.result === "ASSERTIONS_RETURNED" && value.assertions.length === 0) {
    context.addIssue({ code: "custom", path: ["assertions"], message: "Returned assertions cannot be empty" });
  }
  if (value.result === "NO_MATCH" && value.assertions.length !== 0) {
    context.addIssue({ code: "custom", path: ["assertions"], message: "NO_MATCH cannot contain assertions" });
  }
  const allowedKinds = assertionsAllowedByOperation[value.operation];
  value.assertions.forEach((assertion, index) => {
    if (assertion.providerId !== value.providerId) {
      context.addIssue({ code: "custom", path: ["assertions", index, "providerId"], message: "Provider mismatch" });
    }
    if (assertion.providerRunId !== value.providerRunId) {
      context.addIssue({ code: "custom", path: ["assertions", index, "providerRunId"], message: "Run mismatch" });
    }
    if (!allowedKinds.has(assertion.kind)) {
      context.addIssue({ code: "custom", path: ["assertions", index, "kind"], message: "Assertion kind is not allowed" });
    }
    if (Date.parse(assertion.expiresAt) <= Date.parse(assertion.observedAt)) {
      context.addIssue({ code: "custom", path: ["assertions", index, "expiresAt"], message: "Assertion is expired" });
    }
  });
});

export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

export const ProviderCostSchema = z.object({
  costUnits: z.number().nonnegative(),
  usd: z.number().nonnegative(),
  currency: z.literal("USD"),
}).strict();

export const ProviderHealthSchema = z.object({
  state: z.enum(["HEALTHY", "DEGRADED", "NOT_CONFIGURED", "DISABLED"]),
  checkedAt: DateTimeSchema,
  detail: z.string().trim().min(1).max(500),
}).strict();

export const ProviderAdapterExecutionSchema = z.object({
  response: z.unknown(),
  actualCost: ProviderCostSchema,
  upstreamRequestId: IdentifierSchema.nullable(),
  networkAttempted: z.boolean(),
  externalWriteAttempted: z.boolean(),
}).strict();

export type ProviderAdapterExecution = z.infer<typeof ProviderAdapterExecutionSchema>;

export const ProviderDataClassSchema = z.enum([
  "PUBLIC_COMPANY_IDENTITY",
  "PUBLIC_LOCATION",
  "PUBLIC_WEBSITE_CONTENT",
  "PUBLIC_PERSON_IDENTITY",
  "CURRENT_EMPLOYMENT_ASSERTION",
  "B2B_WORK_EMAIL",
  "HASHED_EMAIL",
  "APPROVED_MESSAGE",
  "LOCAL_LINKAGE_IDS",
]);

export const ProhibitedExternalFieldSchema = z.enum([
  "API_CREDENTIAL",
  "DNC_DATABASE",
  "REPLY_BODY",
  "PRIVATE_CASE",
  "QUOTE",
  "CUSTOMER_NOTE",
  "UNPUBLISHED_PRODUCT_DATA",
  "FULL_CRM",
  "PERSONAL_EMAIL",
  "PHONE_NUMBER",
]);

export const ProviderManifestSchema = z.object({
  providerId: ProviderIdSchema,
  displayName: z.string().trim().min(1).max(100),
  capabilities: z.array(ProviderCapabilitySchema).min(1).max(10),
  implementationState: z.enum(["DISABLED_STUB", "FIXTURE_SHADOW", "OFFICIAL_API_ADAPTER"]),
  featureFlag: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  activation: z.object({
    featureFlagEnabled: z.boolean(),
    configured: z.boolean(),
    authorization: z.enum([
      "NOT_GRANTED",
      "SHADOW_APPROVED",
      "CAMPAIGN_SCOPED",
      "NOT_REQUIRED_FIXTURE",
    ]),
  }).strict(),
  networkPolicy: z.enum(["DENY", "OFFICIAL_API_ONLY"]),
  officialApiOnly: z.literal(true),
  externalWriteAllowed: z.boolean(),
  dataBoundary: z.object({
    allowedDataClasses: z.array(ProviderDataClassSchema).max(10),
    prohibitedFields: z.array(ProhibitedExternalFieldSchema).min(10).max(10),
    personalEmailAllowed: z.literal(false),
    phoneAllowed: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Capabilities must be unique" });
  }
  if (new Set(value.dataBoundary.prohibitedFields).size !== value.dataBoundary.prohibitedFields.length) {
    context.addIssue({ code: "custom", path: ["dataBoundary", "prohibitedFields"], message: "Fields must be unique" });
  }
  if (value.implementationState === "DISABLED_STUB") {
    if (value.activation.featureFlagEnabled || value.activation.configured) {
      context.addIssue({ code: "custom", path: ["activation"], message: "Disabled stubs cannot be activated" });
    }
    if (value.networkPolicy !== "DENY" || value.externalWriteAllowed) {
      context.addIssue({ code: "custom", path: ["networkPolicy"], message: "Disabled stubs deny all external I/O" });
    }
  }
});

export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export interface StrictProviderAdapter {
  readonly manifest: ProviderManifest;
  readonly requestSchema: typeof ProviderRequestSchema;
  readonly responseSchema: typeof ProviderResponseSchema;
  health(): Promise<ProviderHealth>;
  estimateCost(request: ProviderRequest): ProviderCost;
  execute(request: ProviderRequest, signal: AbortSignal): Promise<ProviderAdapterExecution>;
}

export function operationCapability(operation: ProviderOperation): ProviderCapability {
  return operation;
}

export function responseAssertionCounts(response: ProviderResponse | null): Record<ProviderAssertionKind, number> {
  const counts = Object.fromEntries(
    ProviderAssertionKindSchema.options.map((kind) => [kind, 0]),
  ) as Record<ProviderAssertionKind, number>;
  for (const assertion of response?.assertions ?? []) counts[assertion.kind] += 1;
  return counts;
}
