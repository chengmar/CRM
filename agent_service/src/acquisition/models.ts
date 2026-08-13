import { z } from "zod";

export const QUALIFICATION_POLICY_VERSION = "qualification-policy-v2" as const;
export const EMPLOYMENT_TTL_DAYS = 90;
export const EMAIL_VERIFICATION_TTL_DAYS = 30;
export const ACTIVE_INTENT_TTL_DAYS = 365;

export const qualificationTracks = ["ACTIVE_INTENT", "ICP_FIT", "WATCHLIST"] as const;
export const qualificationTrackSchema = z.enum(qualificationTracks);
export type QualificationTrack = z.infer<typeof qualificationTrackSchema>;

export const buyerTypes = [
  "SYSTEM_INTEGRATOR_EPC",
  "DISTRIBUTOR",
  "END_USER_FACTORY",
] as const;
export const buyerTypeSchema = z.enum(buyerTypes);
export type BuyerType = z.infer<typeof buyerTypeSchema>;

export const roleFamilies = [
  "OWNER_EXECUTIVE",
  "TECHNICAL_ENGINEERING",
  "PROJECT",
  "PROCUREMENT_SOURCING",
  "PRODUCT",
  "PLANT_OPERATIONS",
  "EHS",
  "MAINTENANCE",
  "OTHER",
] as const;
export const roleFamilySchema = z.enum(roleFamilies);
export type RoleFamily = z.infer<typeof roleFamilySchema>;

export const seniorityLevels = [
  "OWNER_C_SUITE",
  "VP_DIRECTOR_HEAD",
  "MANAGER",
  "SPECIALIST",
  "OTHER",
] as const;
export const seniorityLevelSchema = z.enum(seniorityLevels);
export type SeniorityLevel = z.infer<typeof seniorityLevelSchema>;

export const emailVerificationStatuses = ["VALID", "RISKY", "UNKNOWN", "INVALID"] as const;
export const emailVerificationStatusSchema = z.enum(emailVerificationStatuses);
export type AcquisitionEmailVerificationStatus = z.infer<typeof emailVerificationStatusSchema>;

export const recipientTierSchema = z.enum(["A", "B", "C"]);
export type RecipientTier = z.infer<typeof recipientTierSchema>;

export const evidenceClaimTypes = [
  "ACCOUNT_IDENTITY",
  "BUSINESS_SCENARIO",
  "BUYER_TYPE",
  "ACTIVE_INTENT",
  "CONTACT_EMPLOYMENT",
  "OTHER",
] as const;
export const evidenceClaimTypeSchema = z.enum(evidenceClaimTypes);
export type EvidenceClaimType = z.infer<typeof evidenceClaimTypeSchema>;

export const qualificationUses = [
  "ACTIVE_INTENT",
  "ICP_IDENTITY",
  "ICP_BUSINESS_SCENARIO",
  "ICP_BUYER_TYPE",
  "WHY_CONTACT",
] as const;
export const qualificationUseSchema = z.enum(qualificationUses);
export type QualificationUse = z.infer<typeof qualificationUseSchema>;

export const signalTypes = [
  "TENDER",
  "SUPPLIER_REPLACEMENT",
  "CURRENT_PROJECT",
  "PLANT_EXPANSION",
  "NEW_PLANT",
  "NEW_LINE",
  "AIR_OR_ENVIRONMENTAL_PERMIT",
  "EHS_OR_ENGINEERING_HIRING",
  "PRODUCT_APPLICATION_SIGNAL",
  "EXISTING_EQUIPMENT",
  "DISTRIBUTOR_PORTFOLIO_GAP",
  "TRADE_SHOW_PARTICIPATION",
  "EPC_PROJECT_AWARD",
] as const;
export const signalTypeSchema = z.enum(signalTypes);
export type SignalType = z.infer<typeof signalTypeSchema>;

export const authorityClasses = [
  "T1_COMPANY_OFFICIAL",
  "T2_GOVERNMENT",
  "T2_REGULATOR",
  "T2_EXCHANGE",
  "T2_PROJECT_OWNER",
  "T2_OFFICIAL_EPC",
  "T3_SEARCH",
  "T3_DIRECTORY",
  "T3_SOCIAL",
  "T3_MEDIA",
  "OTHER",
] as const;
export const authorityClassSchema = z.enum(authorityClasses);
export type AuthorityClass = z.infer<typeof authorityClassSchema>;

export const sourceKinds = [
  "OFFICIAL_WEBSITE",
  "AUTHORITY_DOCUMENT",
  "SEARCH_SNIPPET",
  "DIRECTORY",
  "SOCIAL",
  "MEDIA",
  "LICENSED_PROVIDER",
  "PUBLIC_WEB",
] as const;
export const sourceKindSchema = z.enum(sourceKinds);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const evidenceStatuses = ["CURRENT", "CANCELLED", "EXPIRED", "SUPERSEDED"] as const;
export const evidenceStatusSchema = z.enum(evidenceStatuses);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const humanReviewStatuses = ["APPROVED", "REJECTED", "UNREVIEWED"] as const;
export const humanReviewStatusSchema = z.enum(humanReviewStatuses);
export type HumanReviewStatus = z.infer<typeof humanReviewStatusSchema>;

export const subjectRoles = ["BUYER", "PROJECT_OWNER", "SUPPLIER", "UNKNOWN"] as const;
export const subjectRoleSchema = z.enum(subjectRoles);
export type SubjectRole = z.infer<typeof subjectRoleSchema>;

const idSchema = z.string().trim().min(1).max(200);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const publisherDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i);

export const evidenceFactSchema = z
  .object({
    id: idSchema,
    subjectEntityId: idSchema,
    claimType: evidenceClaimTypeSchema,
    signalType: signalTypeSchema.nullable().optional(),
    publisherDomain: publisherDomainSchema,
    independenceKey: idSchema,
    originalDocumentKey: idSchema.nullable().optional(),
    authorityClass: authorityClassSchema,
    authorityAllowlisted: z.boolean(),
    sourceKind: sourceKindSchema,
    subjectRole: subjectRoleSchema,
    exactQuote: z.string().trim().min(1).max(20_000),
    entityBound: z.boolean(),
    effectiveAt: isoDateTimeSchema.nullable().optional(),
    observedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    status: evidenceStatusSchema,
    confidence: z.number().finite().min(0).max(1),
    humanReview: humanReviewStatusSchema,
    allowedQualificationUses: z.array(qualificationUseSchema).max(qualificationUses.length),
    allowedForOutreach: z.boolean(),
  })
  .strict();
export type EvidenceFact = z.infer<typeof evidenceFactSchema>;

export const employmentAssertionSchema = z
  .object({
    accountId: idSchema,
    status: z.enum(["CURRENT", "FORMER", "UNKNOWN", "CONFLICT"]),
    observedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    confidence: z.number().finite().min(0).max(1),
    assertionIds: z.array(idSchema).min(1).max(20),
    conflict: z.boolean(),
  })
  .strict();
export type EmploymentAssertion = z.infer<typeof employmentAssertionSchema>;

export const contactEmailSchema = z
  .object({
    address: z.string().trim().email().max(320),
    status: emailVerificationStatusSchema,
    workEmail: z.boolean(),
    roleAddress: z.boolean(),
    disposable: z.boolean(),
    catchAll: z.boolean(),
    domainMatchesAccount: z.boolean(),
    discoverySourceKey: idSchema,
    verifierSourceKey: idSchema,
    independentlyVerified: z.boolean(),
    observedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    confidence: z.number().finite().min(0).max(1),
    assertionIds: z.array(idSchema).min(1).max(20),
    conflict: z.boolean(),
    officiallyPublished: z.boolean().default(false),
    officialSourceUrl: z.string().trim().url().max(2_000).nullable().default(null),
    officialObservedAt: isoDateTimeSchema.nullable().default(null),
    officialEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  })
  .strict();
export type ContactEmail = z.infer<typeof contactEmailSchema>;

export const contactCandidateSchema = z
  .object({
    id: idSchema,
    accountId: idSchema,
    name: z.string().trim().min(1).max(200),
    named: z.boolean(),
    title: z.string().trim().min(1).max(300),
    roleFamily: roleFamilySchema,
    seniority: seniorityLevelSchema,
    employment: employmentAssertionSchema,
    email: contactEmailSchema,
    evidenceConfidence: z.number().finite().min(0).max(1),
    lastEvidenceAt: isoDateTimeSchema,
    dncMatch: z.boolean(),
    excluded: z.boolean(),
    ownershipConflict: z.boolean(),
    conflicts: z.array(z.string().trim().min(1).max(500)).max(20),
    recipientTier: recipientTierSchema.default("A"),
  })
  .strict();
export type ContactCandidate = z.infer<typeof contactCandidateSchema>;

export const accountQualificationSchema = z
  .object({
    id: idSchema,
    buyerType: buyerTypeSchema,
    officialDomains: z.array(publisherDomainSchema).min(1).max(20),
    identityVerified: z.boolean(),
    identityFactIds: z.array(idSchema).max(50),
    businessScenarioVerified: z.boolean(),
    businessScenarioFactIds: z.array(idSchema).max(50),
    buyerTypeMatchesPlay: z.boolean(),
    buyerTypeFactIds: z.array(idSchema).max(50),
    dncMatch: z.boolean(),
    excluded: z.boolean(),
    ownershipConflict: z.boolean(),
  })
  .strict();
export type AccountQualification = z.infer<typeof accountQualificationSchema>;

export const sellerReadinessSchema = z
  .object({
    sellerContextId: idSchema,
    sellerContextApproved: z.boolean(),
    offerId: idSchema,
    offerApproved: z.boolean(),
  })
  .strict();
export type SellerReadiness = z.infer<typeof sellerReadinessSchema>;

export const groundedMessageReadinessSchema = z
  .object({
    draftText: z.string().trim().min(1).max(50_000),
    grounded: z.boolean(),
    citedFactIds: z.array(idSchema).max(100),
    unsupportedFactIds: z.array(idSchema).max(100),
  })
  .strict();
export type GroundedMessageReadiness = z.infer<typeof groundedMessageReadinessSchema>;

export const qualificationInputSchema = z
  .object({
    policyVersion: z.string().trim().min(1).max(100),
    asOf: isoDateTimeSchema,
    rankScore: z.number().finite().min(0).max(100),
    account: accountQualificationSchema,
    contact: contactCandidateSchema,
    evidenceFacts: z.array(evidenceFactSchema).max(1_000),
    seller: sellerReadinessSchema,
    message: groundedMessageReadinessSchema,
  })
  .strict();
export type QualificationInput = z.infer<typeof qualificationInputSchema>;

export const qualificationBlockerCodes = [
  "POLICY_VERSION_STALE",
  "ACCOUNT_IDENTITY_UNVERIFIED",
  "ACCOUNT_IDENTITY_EVIDENCE_MISSING",
  "BUSINESS_SCENARIO_UNVERIFIED",
  "BUSINESS_SCENARIO_EVIDENCE_MISSING",
  "BUYER_TYPE_MISMATCH",
  "BUYER_TYPE_EVIDENCE_MISSING",
  "INDEPENDENT_PUBLISHERS_INSUFFICIENT",
  "CONTACT_NOT_NAMED",
  "CONTACT_ACCOUNT_MISMATCH",
  "CONTACT_ROLE_IRRELEVANT",
  "EMPLOYMENT_NOT_CURRENT",
  "EMPLOYMENT_EXPIRED",
  "EMPLOYMENT_CONFLICT",
  "EMAIL_NOT_VALID",
  "EMAIL_NOT_WORK",
  "EMAIL_VERIFICATION_EXPIRED",
  "EMAIL_NOT_INDEPENDENT",
  "EMAIL_DOMAIN_MISMATCH",
  "EMAIL_ROLE_ADDRESS",
  "EMAIL_DISPOSABLE",
  "EMAIL_CATCH_ALL",
  "EMAIL_CONFLICT",
  "RECIPIENT_TIER_C",
  "EMAIL_OFFICIAL_PUBLICATION_MISSING",
  "DNC_MATCH",
  "EXCLUSION_MATCH",
  "OWNERSHIP_CONFLICT",
  "SELLER_CONTEXT_UNAPPROVED",
  "OFFER_UNAPPROVED",
  "MESSAGE_NOT_GROUNDED",
  "MESSAGE_FACTS_UNSUPPORTED",
  "ICP_FIT_LANGUAGE_UNSUPPORTED",
  "ACTIVE_INTENT_MISSING",
  "ACTIVE_INTENT_STALE",
  "ACTIVE_INTENT_ENTITY_MISMATCH",
  "ACTIVE_INTENT_SOURCE_NOT_ALLOWED",
  "ACTIVE_INTENT_T2_REVIEW_REQUIRED",
] as const;
export const qualificationBlockerCodeSchema = z.enum(qualificationBlockerCodes);
export type QualificationBlockerCode = z.infer<typeof qualificationBlockerCodeSchema>;

export interface QualificationBlocker {
  code: QualificationBlockerCode;
  message: string;
  evidenceIds: string[];
}

export type RequiredReviewPolicy = "REVIEW_ALL" | "NOT_REVIEWABLE";

export interface QualificationDecision {
  track: QualificationTrack;
  policyVersion: typeof QUALIFICATION_POLICY_VERSION;
  eligible: boolean;
  blockers: QualificationBlocker[];
  laneBlockers: {
    activeIntent: QualificationBlocker[];
    icpFit: QualificationBlocker[];
  };
  rankScore: number;
  whyNowFactIds: string[];
  whyContactAssertionIds: string[];
  independentPublisherKeys: string[];
  requiredReviewPolicy: RequiredReviewPolicy;
}

export function parseQualificationInput(input: unknown): QualificationInput {
  return qualificationInputSchema.parse(input);
}

export function parseContactCandidates(input: unknown): ContactCandidate[] {
  return z.array(contactCandidateSchema).max(10_000).parse(input);
}
