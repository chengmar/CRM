export const leadStatuses = [
  "NEW",
  "VERIFYING",
  "ENRICHING",
  "ENRICHMENT_EXHAUSTED",
  "REJECTED",
  "READY_FOR_REVIEW",
  "APPROVED",
  "CONTACTED",
  "REPLIED",
  "INQUIRY_RECEIVED",
  "HUMAN_TAKEOVER",
  "DO_NOT_CONTACT",
] as const;

export type LeadStatus = (typeof leadStatuses)[number];

export const messageStatuses = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "SENDING",
  "UNKNOWN_RECONCILIATION_REQUIRED",
  "SENT",
  "DELIVERED",
  "BOUNCED",
  "REPLIED",
  "CANCELLED",
  "FAILED",
] as const;

export type MessageStatus = (typeof messageStatuses)[number];

export const inboundClasses = [
  "P1_INQUIRY",
  "P2_INTEREST",
  "REFERRAL",
  "WRONG_PERSON",
  "NEEDS_INFO",
  "NOT_FIT",
  "SPAM",
  "AMBIGUOUS",
  "OTHER_REPLY",
  "AUTO_REPLY",
  "NEGATIVE",
  "UNSUBSCRIBE",
  "BOUNCE",
  "SOFT_BOUNCE",
  "UNKNOWN",
] as const;

export type InboundClass = (typeof inboundClasses)[number];

export type EmailVerificationStatus =
  | "VALID"
  | "RISKY"
  | "INVALID"
  | "UNKNOWN";

export const DEMAND_POLICY_VERSION = "deterministic-demand-v1";

export interface ScoreInput {
  fitScore: number;
  intentScore: number;
  demandEvidenceQualified: boolean;
  demandPolicyVersion: string;
  activityScore: number;
  contactScore: number;
  channelScore: number;
  independentSourceCount: number;
  lastActivityAt?: string | null;
  namedContact: boolean;
  employmentVerified: boolean;
  emailStatus: EmailVerificationStatus;
  roleAddress: boolean;
  disposableAddress: boolean;
  catchAll?: boolean;
  dncMatch: boolean;
}

export interface ScoreResult {
  totalScore: number;
  grade: "GOLD" | "SILVER" | "BRONZE" | "REJECT";
  eligibleForReview: boolean;
  reasons: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: string;
  sourceDate?: string | null;
  query: string;
}

export type PublicEmailExtractionMethod = "mailto" | "cloudflare" | "text";

export interface WebsiteEvidenceScope {
  id: string;
  text: string;
  ambiguous: boolean;
  emails: Array<{
    email: string;
    method: PublicEmailExtractionMethod;
  }>;
}

export interface WebsiteAssessment {
  url: string;
  domain: string;
  reachable: boolean;
  parked: boolean;
  title: string;
  text: string;
  emails: string[];
  phones: string[];
  recentActivityAt?: string | null;
  activitySignals: string[];
  activityScore: number;
  pages: Array<{
    url: string;
    title: string;
    text: string;
    emails?: string[];
    emailEvidence?: Array<{
      email: string;
      context: string;
      method?: PublicEmailExtractionMethod;
      scopeId?: string;
    }>;
    contactContexts?: string[];
    evidenceScopes?: WebsiteEvidenceScope[];
  }>;
}

export interface InboundClassification {
  classification: InboundClass;
  confidence: number;
  reason: string;
  shouldNotify: boolean;
  shouldTakeover: boolean;
  shouldStopAutomation: boolean;
}
