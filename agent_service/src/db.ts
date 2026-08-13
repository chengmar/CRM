import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  DEMAND_POLICY_VERSION,
  type EmailVerificationStatus,
  type InboundClass,
  type LeadStatus,
  type MessageStatus,
} from "./types.js";
import { assertLeadTransition, assertMessageTransition } from "./state-machine.js";
import { ProviderResponseSchema } from "./acquisition/providers/contracts.js";
import {
  RECIPIENT_TIER_POLICY_VERSION,
  classifyRecipientTier,
  outreachQualificationSatisfied,
  type OfficialMailboxEvidence,
  type RecipientTier,
} from "./acquisition/recipient-tier.js";
import { QUALIFICATION_POLICY_VERSION } from "./acquisition/models.js";
import { collapseIndependentSources } from "./acquisition/source-independence.js";
import {
  selectDailyResearchPlay as chooseDailyResearchPlay,
  type DailyPlaySelectionCandidate,
  type DailyPlaySelectionDecision,
} from "./acquisition/daily-play-selection.js";
import {
  analyzeBounceDiagnostic,
  type BounceDiagnosticCategory,
} from "./inbound/bounce-diagnostics.js";

export const LATEST_SCHEMA_VERSION = 19;
export const MESSAGE_REVIEW_CARD_TTL_MS = 24 * 60 * 60 * 1_000;
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_BACKOFF_BASE_MS = 30_000;
export const NOTIFICATION_BACKOFF_MAX_MS = 60 * 60 * 1_000;
const OUTBOUND_POLICY_BLOCK_PREFIX = "POLICY_BLOCKED_V1:";

function lexicalPrefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index];
    if (codePoint === undefined) continue;
    const value = codePoint.codePointAt(0);
    if (value === undefined || value >= 0x10ffff) continue;
    const nextValue = value === 0xd7ff ? 0xe000 : value + 1;
    return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(nextValue)}`;
  }
  return null;
}

interface StoredOutboundPolicyBlock {
  version: 1;
  blockedAt: string;
  reasons: string[];
  previousFailure?: string;
}

export interface NotificationOutboxSummary {
  pendingCount: number;
  dueCount: number;
  deadLetterCount: number;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
}

export interface NotificationFailureResult {
  status: "PENDING" | "DEAD_LETTER";
  attempts: number;
  nextAttemptAt: string | null;
  deadLetteredAt: string | null;
}

export type IndependentOfficialEmailVerifier = "HUNTER" | "BOUNCER";

const INDEPENDENT_OFFICIAL_EMAIL_VERIFIERS = {
  HUNTER: {
    providerRegistryId: "provider_hunter",
    providerKey: "hunter",
    sourceUri: "https://hunter.io/email-verifier",
  },
  BOUNCER: {
    providerRegistryId: "provider_bouncer",
    providerKey: "bouncer",
    sourceUri: "https://api.usebouncer.com/v1.1/email/verify",
  },
} as const satisfies Record<IndependentOfficialEmailVerifier, {
  providerRegistryId: string;
  providerKey: string;
  sourceUri: string;
}>;

export type JobLane = "REALTIME" | "OPERATIONS" | "RESEARCH";

export interface JobEnqueueOptions {
  lane?: JobLane;
  priority?: number;
  dedupeKey?: string;
}

export interface JobFollowup {
  jobType: string;
  payload: Record<string, unknown>;
  runAfter?: string;
  options?: JobEnqueueOptions;
}

export interface JobNotificationOutbox {
  eventType: string;
  channel: "feishu";
  destination: string;
  payload: Record<string, unknown>;
}

export interface JobClaimOptions {
  workerId: string;
  lane: JobLane;
  leaseDurationMs?: number;
}

export type ClaimedJob = Record<string, unknown> & {
  id: string;
  job_type: string;
  lane: JobLane;
  priority: number;
  worker_id: string;
  lease_token: string;
  lease_expires_at: string;
};

export interface EnrichmentQueueState {
  currentPass: number | null;
  remainingInPass: number;
  remainingEligible: number;
  nextRunAt: string | null;
}

export interface LeadAutomationGuardOptions {
  campaignId?: string;
  allowedStatuses: readonly LeadStatus[];
  expectedEnrichmentAttempts?: number;
  additionalDncValues?: Array<{ type: string; value: string | null | undefined }>;
}

export type LeadAutomationGuardTarget = string | {
  campaignId: string;
  domain: string;
  allowMissing?: boolean;
};

export type LeadAutomationGuardResult<T> =
  | { applied: true; value: T }
  | { applied: false; reason: "missing" | "campaign" | "state" | "attempt" | "dnc" | "duplicate" };

const DEFAULT_JOB_LEASE_MS = 5 * 60_000;
const leadAutomationRuntime = new AsyncLocalStorage<{ active: boolean }>();

function assertLeadAutomationDatabaseAccess(): void {
  if (leadAutomationRuntime.getStore()?.active === false) {
    throw new Error("Expired lead automation guard context cannot access the database");
  }
}

function guardSqliteIterator<T extends object>(iterator: T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  let proxy: T;
  proxy = new Proxy(iterator, {
    get(target, property) {
      if (property === Symbol.iterator) return () => proxy;
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const guarded = (...args: unknown[]) => {
        assertLeadAutomationDatabaseAccess();
        return Reflect.apply(value, target, args) as unknown;
      };
      methods.set(property, guarded);
      return guarded;
    },
  });
  return proxy;
}

function guardSqliteStatement(statement: StatementSync): StatementSync {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const guarded = (...args: unknown[]) => {
        assertLeadAutomationDatabaseAccess();
        const result = Reflect.apply(value, target, args) as unknown;
        return property === "iterate" && result !== null && typeof result === "object"
          ? guardSqliteIterator(result)
          : result;
      };
      methods.set(property, guarded);
      return guarded;
    },
  });
}

function guardSqliteDatabase(database: DatabaseSync): DatabaseSync {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const guarded = (...args: unknown[]) => {
        assertLeadAutomationDatabaseAccess();
        const result = Reflect.apply(value, target, args) as unknown;
        return property === "prepare"
          ? guardSqliteStatement(result as StatementSync)
          : result;
      };
      methods.set(property, guarded);
      return guarded;
    },
  });
}

function defaultJobRoute(jobType: string): { lane: JobLane; priority: number } {
  if (jobType === "PROCESS_WHATSAPP_WEBHOOK" || /(?:WEBHOOK|INBOUND|BOUNCE)/i.test(jobType)) {
    return { lane: "REALTIME", priority: 100 };
  }
  if (jobType === "BUILD_EMAIL_SEQUENCE" || jobType === "STAGE_GROUNDED_MESSAGE") {
    return { lane: "OPERATIONS", priority: 80 };
  }
  if (jobType === "SYNC_BITABLE") return { lane: "OPERATIONS", priority: 70 };
  if (jobType === "DISCOVER_CAMPAIGN") return { lane: "RESEARCH", priority: 20 };
  if (jobType === "ENRICH_CONTACTS" || /(?:DISCOVER|RESEARCH|ENRICH)/i.test(jobType)) {
    return { lane: "RESEARCH", priority: 10 };
  }
  return { lane: "OPERATIONS", priority: 50 };
}

function normalizedMessageDestination(channel: string, value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return channel === "whatsapp" ? normalized.replace(/\D/g, "") : normalized;
}

function normalizedDncValue(valueType: string, value: string): string {
  return valueType === "whatsapp"
    ? normalizedMessageDestination("whatsapp", value)
    : value.trim().toLowerCase();
}

export interface DatabaseHealth {
  ok: boolean;
  quickCheck: string[];
  foreignKeyViolations: number;
}

export interface CampaignInput {
  name: string;
  market: string;
  product: string;
  buyerType: string;
  targetCount: number;
  createdBy: string;
  dailyLimit: number;
  hourlyLimit: number;
  followupDays: number[];
}

export interface DailyResearchPlayFilter {
  market?: string;
  product?: string;
  buyerType?: string;
}

export interface DailyResearchPlaySelectionInput {
  asOf: string;
  filter?: DailyResearchPlayFilter;
  explorationShare?: number;
  acceptedAllocationPolicyVersions?: string[];
}

export interface DiscoveryCandidateInput {
  campaignId: string;
  domain: string;
  company: string;
  website: string;
  round: number;
  stage: string;
  outcome: string;
  reason: string;
  sourceCount: number;
  fitScore?: number;
  intentScore?: number;
  activityScore?: number;
  buyingLikelihood?: string;
  recommendedOffer?: string;
  evidence?: unknown;
}

export interface LeadInput {
  campaignId?: string | null;
  company: string;
  domain: string;
  website: string;
  country: string;
  buyerType: string;
  product: string;
  fitScore: number;
  intentScore: number;
  activityScore: number;
  contactScore: number;
  channelScore: number;
  totalScore: number;
  grade: string;
  lastActivityAt?: string | null;
  demandEvidenceQualified: boolean;
  demandPolicyVersion: string;
  demandStage: string;
  demandEvidence: unknown;
  sendEligible: boolean;
  eligibilityReasons: string[];
}

export interface ContactInput {
  leadId: string;
  name: string;
  title: string;
  email?: string | null;
  whatsapp?: string | null;
  linkedin?: string | null;
  sourceUrl: string;
  employmentVerifiedAt?: string | null;
  emailStatus: EmailVerificationStatus;
  emailRisk: string;
  roleAddress: boolean;
  disposableAddress: boolean;
  catchAll: boolean;
  whatsappOptInAt?: string | null;
  verificationNotes?: string | null;
  officialMailboxEvidence?: OfficialMailboxEvidence | null;
}

interface ExistingContactVerification {
  id: string;
  email: string | null;
  whatsapp: string | null;
  employment_verified_at: string | null;
  email_status: EmailVerificationStatus;
  email_risk: string;
  role_address: number;
  disposable_address: number;
  catch_all: number;
  whatsapp_opt_in_at: string | null;
  verification_notes: string | null;
  recipient_tier: RecipientTier;
  recipient_evidence_url: string | null;
  recipient_evidence_observed_at: string | null;
  recipient_evidence_expires_at: string | null;
  recipient_evidence_hash: string | null;
  recipient_policy_version: string;
}

function mergeEmailStatus(
  existing: EmailVerificationStatus,
  incoming: EmailVerificationStatus,
): EmailVerificationStatus {
  if (existing === "INVALID" || incoming === "INVALID") return "INVALID";
  if (existing === "VALID" || incoming === "VALID") return "VALID";
  if (existing === "RISKY" || incoming === "RISKY") return "RISKY";
  return "UNKNOWN";
}

function appendVerificationNotes(...values: Array<string | null | undefined>): string | null {
  const notes = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return notes.length > 0 ? notes.join("; ").slice(0, 4000) : null;
}

function mergeDiscoveryEvidence(existingJson: string, incoming: unknown): unknown {
  let existing: unknown = [];
  try {
    existing = JSON.parse(existingJson) as unknown;
  } catch {
    existing = [];
  }
  if (incoming === undefined) return existing;
  const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : null;
  const incomingRecord = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? incoming as Record<string, unknown>
    : null;
  if (existingRecord && incomingRecord) return { ...existingRecord, ...incomingRecord };
  return incoming;
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function canonicalHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sanitizeOutboundPolicyReason(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function parseStoredOutboundPolicyBlock(value: unknown): StoredOutboundPolicyBlock | null {
  const text = String(value ?? "");
  if (!text.startsWith(OUTBOUND_POLICY_BLOCK_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(OUTBOUND_POLICY_BLOCK_PREFIX.length)) as
      Partial<StoredOutboundPolicyBlock>;
    if (parsed.version !== 1 || !parsed.blockedAt || !Number.isFinite(Date.parse(parsed.blockedAt))) {
      return null;
    }
    if (!Array.isArray(parsed.reasons) || parsed.reasons.some((reason) => typeof reason !== "string")) {
      return null;
    }
    return {
      version: 1,
      blockedAt: parsed.blockedAt,
      reasons: parsed.reasons.map(sanitizeOutboundPolicyReason).filter(Boolean),
      ...(typeof parsed.previousFailure === "string" && parsed.previousFailure.trim()
        ? { previousFailure: sanitizeOutboundPolicyReason(parsed.previousFailure) }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Database JSON constraints normally make this unreachable; fail closed below.
  }
  throw new Error("Stored JSON object is invalid");
}

function normalizedUniqueValues(values: readonly string[] = [], uppercase = false): string[] {
  return [...new Set(values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => uppercase ? value.toUpperCase() : value.toLowerCase()))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeAccountDomain(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    try {
      normalized = new URL(normalized).hostname.toLowerCase();
    } catch {
      throw new Error(`Invalid account domain: ${value}`);
    }
  }
  normalized = normalized.replace(/^www\./, "").replace(/\.+$/, "");
  if (!normalized || /[\s\/@:]/.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid account domain: ${value}`);
  }
  return normalized;
}

export interface OutboundMessageInput {
  campaignId?: string | null;
  leadId: string;
  contactId: string;
  channel: "email" | "whatsapp";
  destination: string;
  subject: string;
  body: string;
  sequenceIndex: number;
  scheduledAt?: string | null;
  status?: MessageStatus;
}

export interface MessageClaimPolicy {
  allowRiskyEmail?: boolean;
  requireGmailPilotActivation?: boolean;
  maximumSequenceIndex?: number;
  minimumLeadScore?: number;
  minimumSourceCount?: number;
  globalHourlyLimit?: number;
  globalDailyLimit?: number;
  minimumIntervalSeconds?: number;
  hardBounceWindowSize?: number;
  hardBounceMinimumSample?: number;
  maxHardBounceRate?: number;
  allowAuditedDeliverabilityRecovery?: boolean;
  requireFreshImapMonitoring?: boolean;
  imapHealthMaxAgeSeconds?: number;
  imapFailureThreshold?: number;
  now?: Date;
}

export type BounceReviewDisposition =
  | "CONFIRMED_RECIPIENT_FAILURE"
  | "REMOTE_INFRASTRUCTURE_FAILURE"
  | "SENDER_INFRASTRUCTURE_FAILURE"
  | "MISCLASSIFIED";

export interface BounceIncidentRecord {
  id: string;
  inbound_message_id: string | null;
  outbound_message_id: string;
  lead_id: string;
  contact_id: string;
  diagnostic_category: BounceDiagnosticCategory;
  enhanced_status_code: string | null;
  diagnostic_code: string | null;
  evidence_sha256: string;
  evidence_excerpt: string;
  created_at: string;
  review_id: string | null;
  review_disposition: BounceReviewDisposition | null;
  reviewed_by: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
}

export interface DeliverabilityRecoveryState {
  required: boolean;
  bounceStats: { sent: number; bounced: number; rate: number };
  requiredSuccessfulMessages: number;
  unresolvedIncidents: number;
  authorizationId: string | null;
  authorizationExpiresAt: string | null;
  authorizedMessages: number;
  claimedMessages: number;
  remainingMessages: number;
  invalidatedByNewBounce: boolean;
}

export interface DueMessageCursor {
  dueAt: string;
  sequenceIndex: number;
  messageId: string;
}

export interface OutboundPolicyBlockSummary {
  blockedMessages: number;
  oldestBlockedAgeSeconds: number | null;
  topReasons: Array<{ reason: string; count: number }>;
}

export interface InboundMessageInput {
  channel: "email" | "whatsapp" | "form";
  providerId: string;
  threadId?: string | null;
  fromAddress: string;
  toAddress?: string | null;
  subject?: string | null;
  bodyText: string;
  receivedAt: string;
  classification: InboundClass;
  confidence: number;
  reason: string;
  leadId?: string | null;
  contactId?: string | null;
  outboundMessageId?: string | null;
  rawHeaders?: Record<string, unknown> | null;
}

export interface ImapMessageFailureInput {
  uidValidity: string;
  uid: number;
  maxAttempts: number;
  sourceSha256: string;
  sourceSize: number;
  preview: Record<string, unknown>;
  errorClass: string;
  errorMessage: string;
}

export interface ImapMessageFailureRecord extends Record<string, unknown> {
  id: string;
  uid_validity: string;
  uid: number;
  status: "RETRY_PENDING" | "QUARANTINED" | "RESOLVED" | "UNREPLAYABLE";
  attempts: number;
  max_attempts: number;
  quarantine_episode: number;
  source_sha256: string;
  source_size: number;
  preview_json: string;
  last_error_class: string;
  last_error_message: string;
  first_failed_at: string;
  last_failed_at: string;
  quarantined_at: string | null;
  replay_requested_at: string | null;
  replay_requested_by: string | null;
  resolved_at: string | null;
}

export interface ImapReplayRequestResult {
  requested: boolean;
  reason: string;
  record: ImapMessageFailureRecord | null;
}

export interface AccountInput {
  domain: string;
  displayName: string;
  legalName?: string | null;
  website?: string | null;
  countryCode?: string | null;
  accountType?: "COMPANY" | "GROUP" | "DISTRIBUTOR" | "INTEGRATOR" | "END_USER" | "OTHER";
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface PlayInput {
  key: string;
  name: string;
  country: string;
  buyerArchetype: string;
  application: string;
  productFamily: string;
  roleFamily: string;
  qualificationTrack: "ACTIVE_INTENT" | "ICP_FIT" | "WATCHLIST";
  offer: string;
  channel: "EMAIL" | "WHATSAPP" | "LINKEDIN" | "MULTI_CHANNEL";
  status?: "DRAFT" | "EVIDENCE_REVIEW" | "SHADOW" | "APPROVED" | "READY_TO_STAGE" |
    "STAGED_PAUSED" | "ACTIVE" | "PAUSED" | "STOPPED" | "KILLED";
  approvalPolicy?: "REVIEW_ALL" | "REVIEW_HIGH_RISK" | "AUTO_SEND_ELIGIBLE" | "PAUSED";
  definition: Record<string, unknown>;
  createdBy: string;
}

export interface PlayEnrollmentInput {
  accountId: string;
  playVersionId: string;
  campaignId?: string | null;
  status?: "PROSPECT" | "RESEARCHING" | "QUALIFIED" | "WATCHLIST" | "READY_FOR_REVIEW" |
    "APPROVED" | "ACTIVE" | "HUMAN_TAKEOVER" | "EXCLUDED" | "STOPPED";
  qualificationTrack?: "ACTIVE_INTENT" | "ICP_FIT" | "WATCHLIST";
  source?: string;
  idempotencyKey?: string;
}

export interface ExclusionInput {
  exclusionType: "OUT_OF_ICP" | "COMPETITOR" | "UNSUPPORTED_MARKET" | "NOT_BUYER" |
    "DUPLICATE" | "DATA_QUALITY" | "TEMPORARY" | "OTHER";
  reason: string;
  source: string;
  accountId?: string | null;
  personId?: string | null;
  facilityId?: string | null;
  playId?: string | null;
  scopeValue?: string | null;
  startsAt?: string;
  expiresAt?: string | null;
  idempotencyKey?: string;
}

export interface ActiveExclusionQuery {
  accountId?: string | null;
  personId?: string | null;
  facilityId?: string | null;
  playId?: string | null;
  scopeValue?: string | null;
  exclusionType?: ExclusionInput["exclusionType"];
}

export interface InquiryIntakeInput {
  source: "EMAIL" | "WHATSAPP" | "WEB_FORM" | "MANUAL" | "OTHER";
  providerEventId?: string | null;
  messageId?: string | null;
  contentHash?: string | null;
  sender: string;
  recipient?: string | null;
  subject?: string | null;
  bodyText: string;
  receivedAt: string;
  classification?: string | null;
  accountId?: string | null;
  personId?: string | null;
  contactPointId?: string | null;
  leadId?: string | null;
  outboundMessageId?: string | null;
  correlationMethod?: string | null;
  correlationConfidence?: number | null;
  rawHeaders?: Record<string, unknown> | null;
}

export interface InquiryFactInput {
  fieldName: string;
  normalizedValue: string;
  unit?: string | null;
  exactEvidenceSpan: string;
  confidence: number;
  extractionVersion: string;
}

export interface InboundCorrelation {
  leadId: string;
  contactId: string;
  outboundMessageId: string | null;
  correlationMethod:
    | "exact_provider_reference"
    | "thread_reference"
    | "sender_address"
    | "explicit_legacy_ids";
}

export interface CanonicalInboundContext {
  accountId: string;
  personId: string | null;
  contactPointId: string | null;
}

export type OpportunityStage = "NEW" | "INQUIRY_QUALIFIED" | "QUALIFIED" | "NEEDS_INFO" |
  "TECHNICAL_REVIEW" | "TECHNICAL_DISCOVERY" | "QUOTE_PENDING" | "QUOTED" |
  "NEGOTIATION" | "WON" | "LOST";

export interface OpportunityInput {
  idempotencyKey: string;
  source: string;
  accountId?: string | null;
  personId?: string | null;
  intakeId?: string | null;
  enrollmentId?: string | null;
  stage?: OpportunityStage;
  owner?: string | null;
  firstResponseDueAt?: string | null;
}

export interface SalesTaskInput {
  idempotencyKey: string;
  taskType: "CALL" | "LINKEDIN_REVIEW" | "CONTACT_RESEARCH" | "EMPLOYMENT_REVERIFY" |
    "ACCOUNT_RESEARCH" | "DRAFT_REVIEW" | "INQUIRY_FOLLOWUP" | "TECHNICAL_REVIEW" | "QUOTE_FOLLOWUP";
  owner: string;
  dueAt: string;
  sourceSignal?: string | null;
  accountId?: string | null;
  personId?: string | null;
  playId?: string | null;
  enrollmentId?: string | null;
  opportunityId?: string | null;
  payload?: Record<string, unknown>;
}

export interface QualificationRunInput {
  idempotencyKey: string;
  accountId?: string | null;
  intakeId?: string | null;
  enrollmentId?: string | null;
  qualificationTrack: "ACTIVE_INTENT" | "ICP_FIT" | "WATCHLIST";
  policyVersion: string;
  decision: "QUALIFIED" | "NEEDS_INFO" | "NOT_FIT" | "WATCHLIST" | "BLOCKED" | "ERROR";
  reason?: string;
  evidenceFactIds?: readonly string[];
  result: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export interface AcquisitionFoundationSummary {
  schemaVersion: number;
  accounts: number;
  accountDomains: number;
  facilities: number;
  people: number;
  employments: number;
  contactPoints: number;
  plays: number;
  playVersions: number;
  playEnrollments: number;
  activeExclusions: number;
  providerRuns: number;
  inquiryIntakes: number;
  quarantinedIntakes: number;
  inboundProspects: number;
  opportunities: number;
  openSalesTasks: number;
  approvedClaims: number;
  contentAssets: number;
  contentVersions: number;
  openContentQuestions: number;
}

export type WorkflowActorType = "AGENT" | "HUMAN" | "SYSTEM";
export type WorkflowRole = "ENGINEERING" | "COMPLIANCE" | "LOCALIZATION" |
  "CONTENT_REVIEW" | "PUBLISHER" | "INBOUND_REVIEW" | "SALES" | "SALES_MANAGER" |
  "CAMPAIGN_APPROVER" | "BUDGET_APPROVER" | "MARKET_REVIEW" | "EXPERIMENT_REVIEW" |
  "MESSAGE_REVIEWER";

export interface WorkflowAuthorization {
  actor: string;
  actorType: WorkflowActorType;
  roles?: readonly WorkflowRole[];
}

export type ApprovedClaimStatus = "DRAFT" | "ENGINEERING_REVIEW" | "APPROVED" | "STALE" | "REVOKED";

export interface ApprovedClaimInput {
  claimKey: string;
  claimType: string;
  statement: string;
  sourceDocumentId?: string | null;
  sourceHash: string;
  visibility?: "PUBLIC" | "PRIVATE";
  allowedMarkets?: readonly string[];
  allowedChannels?: readonly string[];
  expiresAt?: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface ContentAssetInput {
  assetKey: string;
  assetType: string;
  title: string;
  defaultLocale: string;
  visibility?: "PUBLIC" | "PRIVATE";
  targetMarkets?: readonly string[];
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export type ContentVersionStatus = "DRAFT" | "TECHNICAL_REVIEW" | "LOCALIZATION_REVIEW" |
  "APPROVED" | "PUBLISHED" | "STALE";

export interface ContentVersionInput {
  assetId: string;
  locale: string;
  body: string;
  approvedClaimIds?: readonly string[];
  createdBy: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TranslationInput {
  contentVersionId: string;
  locale: string;
  body: string;
  createdBy: string;
  sourceHash: string;
  terminologySnapshotHash?: string | null;
}

export interface TerminologyGlossaryInput {
  locale: string;
  sourceTerm: string;
  approvedTerm: string;
  definition?: string | null;
  unitPolicy?: string | null;
  createdBy: string;
  idempotencyKey?: string;
}

export interface ContentQuestionInput {
  idempotencyKey: string;
  question: string;
  sourceType: "INQUIRY" | "LOST_REASON" | "SALES_QUESTION" | "OTHER";
  intakeId?: string | null;
  opportunityId?: string | null;
  contentAssetId?: string | null;
  evidenceSpan?: string | null;
  market?: string | null;
  locale?: string | null;
  priority?: number;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface InboundProspectReviewInput {
  fullName?: string | null;
  companyName?: string | null;
  workEmail?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  productInterest?: string | null;
  application?: string | null;
  landing?: string | null;
  contentAssetId?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  consentStatus?: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
  metadata?: Record<string, unknown>;
}

export interface InboundMessageLinkInput {
  intakeId: string;
  inboundMessageId?: string | null;
  outboundMessageId?: string | null;
  correlationMethod: string;
  correlationConfidence: number;
  idempotencyKey: string;
}

export interface QuoteInput {
  opportunityId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  grossMarginBps?: number | null;
  terms?: Record<string, unknown>;
  expiresAt?: string | null;
  sourceTouchpointId?: string | null;
}

export type CampaignBriefStatus = "PLAN_DRAFT" | "PLAN_NEEDS_INPUT" | "PLAN_APPROVED" |
  "BUDGET_PENDING" | "BUDGET_APPROVED" | "QUEUED" | "RESEARCHING" |
  "SHADOW_COMPLETE" | "READY_FOR_SEND_EXPERIMENT" | "CANCELLED";

export interface CampaignDraftInput {
  briefKey: string;
  brief: Record<string, unknown>;
  createdBy: string;
  status?: "PLAN_DRAFT" | "PLAN_NEEDS_INPUT";
  parserVersion?: string | null;
  sourceTextHash?: string | null;
}

export interface CampaignScopedApprovalInput {
  briefId: string;
  versionId: string;
  scope: "SHADOW_PLAN" | "PROVIDER_BUDGET" | "EXTERNAL_SEND" | "CONTENT_PUBLICATION";
  actionId: string;
  authorizationSource: string;
  budgetHash?: string | null;
  reason?: string | null;
}

export interface CampaignSendAuthorizationInput {
  campaignApprovalId: string;
  briefId: string;
  versionId: string;
  briefHash: string;
  campaignId: string;
  market: string;
  transport: "SMTP";
  totalLimit: number;
  dailyLimit: number;
  hourlyLimit: number;
  maximumSequenceIndex?: number;
  validFrom: string;
  expiresAt: string;
  policyVersion: string;
  actionId: string;
  authorizationSource: string;
  reason?: string | null;
}

export interface CampaignMessageAuthorizationInput {
  campaignSendAuthorizationId: string;
  messageVersionId: string;
  scheduledAt?: string | null;
  evaluatorVersion: string;
}

export interface CampaignProviderBindingInput {
  campaignId: string;
  briefId: string;
  versionId: string;
  briefHash: string;
  createdBy: string;
}

export interface ProviderRunBeginInput {
  campaignId: string;
  versionId: string;
  providerKey: string;
  operation: string;
  requestHash: string;
  requestedCount: number;
  chargeable: boolean;
  estimatedUnits?: number;
  estimatedCostMicros?: number;
  staleAfterSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderRunCompleteInput {
  providerRunId: string;
  providerAttemptId: string;
  returnedCount: number;
  resultHash: string;
  response: Record<string, unknown>;
  cacheTtlSeconds: number;
  units: number;
  costMicros: number;
  currency?: string;
  usageIdempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderRunFailInput {
  providerRunId: string;
  providerAttemptId: string;
  errorClass: string;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
  responseHash?: string | null;
}

export interface IndependentEmailVerificationPersistenceInput {
  contactId: string;
  campaignId: string;
  versionId: string;
  providerRunId: string;
  discoveryAssertionId: string;
  verificationAssertionId: string;
  emailHash: string;
  discoverySourceKey: "LOCAL_PUBLIC_WEB";
  verifierSourceKey: IndependentOfficialEmailVerifier;
  discoverySourceUrl: string;
  discoveryEvidenceHash: string;
  providerMailboxVerdict:
    | "VALID_ASSERTION"
    | "INVALID_ASSERTION"
    | "RISKY_ASSERTION"
    | "UNKNOWN_ASSERTION";
  catchAll: boolean;
  disposable: boolean;
  roleMailbox: boolean;
  confidence: number;
  rawPayloadHash: string;
  observedAt: string;
  expiresAt: string;
  creditUnits: number;
  estimatedCostMicros: number;
}

export interface IndependentEmailVerificationRecord {
  discoveryAssertionId: string;
  verificationAssertionId: string;
  providerRunId: string;
  discoverySourceKey: "LOCAL_PUBLIC_WEB";
  verifierSourceKey: IndependentOfficialEmailVerifier;
  independentlyVerified: true;
  emailHash: string;
  providerMailboxVerdict: "VALID_ASSERTION";
  confidence: number;
  observedAt: string;
  expiresAt: string;
}

export interface IndependentEmailVerificationQuery {
  contactId: string;
  email: string;
  campaignId: string;
  versionId: string;
  at?: string;
}

export interface CampaignForecastPersistenceInput {
  idempotencyKey: string;
  versionId: string;
  forecast: Record<string, unknown>;
  basis: readonly string[];
  sampleSize: number;
  uncertainty: "HIGH" | "MEDIUM" | "LOW";
  reliable: boolean;
  createdBy: string;
}

export interface MarketEvidencePersistenceInput {
  idempotencyKey: string;
  country: string;
  period: string;
  hsRevision: string;
  metric: string;
  value?: number | null;
  unit: string;
  sourceUrl: string;
  authority: string;
  retrievedAt: string;
  contentHash: string;
  confidence: number;
  license: string;
  humanReview: "APPROVED" | "PENDING" | "REJECTED";
  expiresAt: string;
  createdBy: string;
}

export interface MarketOpportunitySnapshotInput {
  idempotencyKey: string;
  country: string;
  productFamily: string;
  period: string;
  policyVersion: string;
  score?: number | null;
  confidence: number;
  evidenceIds?: readonly string[];
  snapshot: Record<string, unknown>;
  createdBy: string;
}

export interface PlayAllocationSuggestionInput {
  idempotencyKey: string;
  playId: string;
  snapshotId?: string | null;
  policyVersion: string;
  recommendedUnits: number;
  recommendedShare: number;
  recommendation: string;
  reasons?: readonly string[];
  createdBy: string;
}

export interface PersonalizationPlanPersistenceInput {
  planKey: string;
  accountId?: string | null;
  personId?: string | null;
  enrollmentId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  qualificationTrack: "ACTIVE_INTENT" | "ICP_FIT" | "WATCHLIST";
  qualificationPolicyVersion: string;
  dossierVersionId?: string | null;
  sellerFactSetVersion: string;
  locale: string;
  plan: Record<string, unknown>;
  factIds?: readonly string[];
  createdBy: string;
  status?: "DRAFT" | "VALID" | "NEEDS_REWRITE";
}

export interface MessageVersionPersistenceInput {
  messageKey: string;
  outboundMessageId?: string | null;
  personalizationPlanId: string;
  subject: string;
  body: string;
  destination: string;
  sequenceIndex: number;
  generationMode: string;
  promptVersion: string;
  model: string;
  templateVersion: string;
  lintVersion: string;
  lintResult: Record<string, unknown>;
  angle: string;
  locale: string;
  experimentVariant?: string | null;
  dossierVersionId?: string | null;
  sellerFactSetVersion: string;
  factIds?: readonly string[];
  createdBy: string;
  status?: "GENERATED" | "NEEDS_REWRITE" | "LINT_FAILED" | "PENDING_APPROVAL";
  expectedReviewHash?: string;
}

export type GroundedMessageReviewDecision = "APPROVE_CONTENT" | "NEEDS_REWRITE";

export interface GroundedMessageReviewInput {
  reviewCardId: string;
  messageVersionId: string;
  reviewHash: string;
  decision: GroundedMessageReviewDecision;
  actionId: string;
  reason?: string | null;
}

export interface ExperimentDefinitionInput {
  experimentKey: string;
  hypothesis: string;
  primaryVariable: string;
  arms: readonly string[];
  allocationSalt: string;
  createdBy: string;
  definition?: Record<string, unknown>;
}

export interface SignalObservationInput {
  idempotencyKey: string;
  accountId: string;
  personId?: string | null;
  signalType: string;
  sourceUrl: string;
  exactQuote: string;
  publishedAt?: string | null;
  observedAt: string;
  expiresAt?: string | null;
  confidence: number;
  authorityClass: string;
  entityMatch: "MATCHED" | "AMBIGUOUS" | "REJECTED";
  sourceDocumentId?: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface RuleVersionPersistenceInput {
  ruleKey: string;
  condition: Record<string, unknown>;
  actions: readonly string[];
  createdBy: string;
}

export interface ManualEngagementEventInput {
  idempotencyKey: string;
  accountId: string;
  personId?: string | null;
  contactPointId?: string | null;
  playId?: string | null;
  enrollmentId?: string | null;
  messageVersionId?: string | null;
  channel: "LINKEDIN" | "CALL" | "EMAIL" | "WHATSAPP" | "OTHER";
  eventType: string;
  direction?: "INBOUND" | "OUTBOUND" | "NONE";
  outcome?: string | null;
  occurredAt: string;
  externalReference?: string | null;
  durationSeconds?: number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentDatabaseOptions {
  readOnly?: boolean;
}

export class AgentDatabase {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly readOnly: boolean;
  private transactionDepth = 0;
  private transactionSavepointSequence = 0;

  constructor(databasePath: string, options: AgentDatabaseOptions = {}) {
    this.databasePath = databasePath;
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = guardSqliteDatabase(this.readOnly
      ? new DatabaseSync(this.databasePath, { readOnly: true })
      : new DatabaseSync(this.databasePath));
    if (this.readOnly) {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA query_only = ON");
      try {
        const hasMigrations = Boolean(this.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        ).get());
        const migrationVersion = hasMigrations
          ? Number((this.db.prepare(
              "SELECT coalesce(max(version), 0) AS version FROM schema_migrations",
            ).get() as { version: number }).version)
          : 0;
        const userVersionRow = this.db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        const userVersion = Number(Object.values(userVersionRow)[0] ?? 0);
        const current = Math.max(migrationVersion, userVersion);
        if (current > LATEST_SCHEMA_VERSION) {
          throw new Error(
            `Database schema version ${current} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
          );
        }
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.setSettingIfAbsent("outbound_paused", "true");
    this.setSettingIfAbsent("daily_research_enabled", "false");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const current = this.getSchemaVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
      );
    }
    this.applyMigration(1, "initial production schema", () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        product TEXT NOT NULL,
        buyer_type TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_by TEXT NOT NULL,
        daily_limit INTEGER NOT NULL,
        hourly_limit INTEGER NOT NULL,
        followup_days_json TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        paused_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        campaign_id TEXT REFERENCES campaigns(id),
        company TEXT NOT NULL,
        domain TEXT NOT NULL,
        website TEXT NOT NULL,
        country TEXT NOT NULL,
        buyer_type TEXT NOT NULL,
        product TEXT NOT NULL,
        fit_score INTEGER NOT NULL DEFAULT 0,
        intent_score INTEGER NOT NULL DEFAULT 0,
        activity_score INTEGER NOT NULL DEFAULT 0,
        contact_score INTEGER NOT NULL DEFAULT 0,
        channel_score INTEGER NOT NULL DEFAULT 0,
        total_score INTEGER NOT NULL DEFAULT 0,
        grade TEXT NOT NULL DEFAULT 'REJECT',
        status TEXT NOT NULL DEFAULT 'NEW',
        last_activity_at TEXT,
        last_verified_at TEXT,
        send_eligible INTEGER NOT NULL DEFAULT 0,
        eligibility_reasons_json TEXT NOT NULL DEFAULT '[]',
        human_takeover INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(domain, campaign_id)
      );

      CREATE TABLE IF NOT EXISTS lead_sources (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_date TEXT,
        evidence TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(lead_id, source_url)
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        email TEXT,
        whatsapp TEXT,
        linkedin TEXT,
        source_url TEXT NOT NULL,
        employment_verified_at TEXT,
        email_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        email_risk TEXT NOT NULL DEFAULT '',
        role_address INTEGER NOT NULL DEFAULT 0,
        disposable_address INTEGER NOT NULL DEFAULT 0,
        catch_all INTEGER NOT NULL DEFAULT 0,
        whatsapp_opt_in_at TEXT,
        verification_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(lead_id, email),
        UNIQUE(lead_id, whatsapp)
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        campaign_id TEXT REFERENCES campaigns(id),
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        sequence_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        approved_by TEXT,
        approved_at TEXT,
        scheduled_at TEXT,
        sent_at TEXT,
        provider_message_id TEXT,
        thread_id TEXT,
        parent_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(lead_id, contact_id, channel, sequence_index)
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        provider_id TEXT NOT NULL UNIQUE,
        thread_id TEXT,
        lead_id TEXT REFERENCES leads(id),
        contact_id TEXT REFERENCES contacts(id),
        from_address TEXT NOT NULL,
        to_address TEXT,
        subject TEXT,
        body_text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        classification TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        raw_headers_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dnc (
        id TEXT PRIMARY KEY,
        value_type TEXT NOT NULL,
        value TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(value_type, value)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        event_id TEXT REFERENCES events(id),
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        dead_lettered_at TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        payload_json TEXT NOT NULL,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_metrics (
        source_type TEXT PRIMARY KEY,
        leads INTEGER NOT NULL DEFAULT 0,
        replies INTEGER NOT NULL DEFAULT 0,
        inquiries INTEGER NOT NULL DEFAULT 0,
        bounces INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
      CREATE INDEX IF NOT EXISTS idx_outbound_due ON outbound_messages(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_sent ON outbound_messages(sent_at);
      CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_messages(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);
    `));
    this.applyMigration(2, "auditable deep discovery", () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_candidates (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        company TEXT NOT NULL,
        website TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source_count INTEGER NOT NULL DEFAULT 0,
        fit_score INTEGER NOT NULL DEFAULT 0,
        intent_score INTEGER NOT NULL DEFAULT 0,
        activity_score INTEGER NOT NULL DEFAULT 0,
        buying_likelihood TEXT NOT NULL DEFAULT 'UNKNOWN',
        recommended_offer TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, domain)
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_campaign_outcome
        ON discovery_candidates(campaign_id, outcome, updated_at);
    `));
    this.applyMigration(3, "channel-less contact identity deduplication", () => this.db.exec(`
      DELETE FROM contacts
      WHERE email IS NULL AND whatsapp IS NULL
        AND EXISTS (
          SELECT 1 FROM contacts older
          WHERE older.lead_id=contacts.lead_id
            AND lower(trim(older.name))=lower(trim(contacts.name))
            AND lower(trim(older.title))=lower(trim(contacts.title))
            AND (
              older.created_at < contacts.created_at OR
              (older.created_at = contacts.created_at AND older.id < contacts.id)
            )
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_identity_without_channel
        ON contacts(lead_id, lower(trim(name)), lower(trim(title)))
        WHERE email IS NULL AND whatsapp IS NULL;
    `));
    this.applyMigration(4, "idempotent inbound processing and source outcomes", () => this.db.exec(`
      ALTER TABLE inbound_messages ADD COLUMN processed_at TEXT;

      CREATE TABLE source_outcomes (
        source_type TEXT NOT NULL,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_type, lead_id, outcome)
      );

      INSERT OR IGNORE INTO source_outcomes(source_type, lead_id, outcome, created_at)
      SELECT DISTINCT ls.source_type, i.lead_id, 'reply', i.received_at
      FROM inbound_messages i
      JOIN lead_sources ls ON ls.lead_id=i.lead_id
      WHERE i.lead_id IS NOT NULL
        AND i.classification IN ('P1_INQUIRY','P2_INTEREST','OTHER_REPLY','NEGATIVE','UNSUBSCRIBE');

      INSERT OR IGNORE INTO source_outcomes(source_type, lead_id, outcome, created_at)
      SELECT DISTINCT ls.source_type, i.lead_id, 'inquiry', i.received_at
      FROM inbound_messages i
      JOIN lead_sources ls ON ls.lead_id=i.lead_id
      WHERE i.lead_id IS NOT NULL AND i.classification IN ('P1_INQUIRY','P2_INTEREST');

      INSERT OR IGNORE INTO source_outcomes(source_type, lead_id, outcome, created_at)
      SELECT DISTINCT ls.source_type, i.lead_id, 'bounce', i.received_at
      FROM inbound_messages i
      JOIN lead_sources ls ON ls.lead_id=i.lead_id
      WHERE i.lead_id IS NOT NULL AND i.channel='email' AND i.classification='BOUNCE';

      DELETE FROM source_metrics;
      INSERT INTO source_metrics(source_type, leads, replies, inquiries, bounces, updated_at)
      SELECT sources.source_type,
        COUNT(DISTINCT sources.lead_id),
        COUNT(DISTINCT CASE WHEN outcomes.outcome='reply' THEN outcomes.lead_id END),
        COUNT(DISTINCT CASE WHEN outcomes.outcome='inquiry' THEN outcomes.lead_id END),
        COUNT(DISTINCT CASE WHEN outcomes.outcome='bounce' THEN outcomes.lead_id END),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM (SELECT DISTINCT source_type, lead_id FROM lead_sources) sources
      LEFT JOIN source_outcomes outcomes
        ON outcomes.source_type=sources.source_type AND outcomes.lead_id=sources.lead_id
      GROUP BY sources.source_type;
    `));
    this.applyMigration(5, "fail-closed deterministic demand evidence", () => this.db.exec(`
      ALTER TABLE leads ADD COLUMN demand_evidence_qualified INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE leads ADD COLUMN demand_policy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE leads ADD COLUMN demand_stage TEXT NOT NULL DEFAULT 'INDUSTRY_FIT';
      ALTER TABLE leads ADD COLUMN demand_evidence_json TEXT NOT NULL DEFAULT '[]';

      UPDATE leads SET send_eligible=0;
      CREATE INDEX IF NOT EXISTS idx_leads_review_gate
        ON leads(status, send_eligible, demand_evidence_qualified, demand_policy_version);
    `));
    this.applyMigration(6, "leased priority job lanes", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'QUEUED',
          payload_json TEXT NOT NULL,
          result_json TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          run_after TEXT NOT NULL,
          locked_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          lane TEXT NOT NULL DEFAULT 'OPERATIONS',
          priority INTEGER NOT NULL DEFAULT 50,
          worker_id TEXT,
          lease_token TEXT,
          lease_expires_at TEXT
        );
      `);
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("lane")) {
        this.db.exec("ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'OPERATIONS'");
      }
      if (!columns.has("priority")) {
        this.db.exec("ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50");
      }
      if (!columns.has("worker_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN worker_id TEXT");
      if (!columns.has("lease_token")) this.db.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT");
      if (!columns.has("lease_expires_at")) {
        this.db.exec("ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT");
      }
      this.db.exec(`
        UPDATE jobs
        SET lane = CASE
          WHEN job_type='PROCESS_WHATSAPP_WEBHOOK'
            OR upper(job_type) LIKE '%WEBHOOK%'
            OR upper(job_type) LIKE '%INBOUND%'
            OR upper(job_type) LIKE '%BOUNCE%' THEN 'REALTIME'
          WHEN job_type IN ('DISCOVER_CAMPAIGN', 'ENRICH_CONTACTS')
            OR upper(job_type) LIKE '%DISCOVER%'
            OR upper(job_type) LIKE '%RESEARCH%'
            OR upper(job_type) LIKE '%ENRICH%' THEN 'RESEARCH'
          ELSE 'OPERATIONS'
        END,
        priority = CASE
          WHEN job_type='PROCESS_WHATSAPP_WEBHOOK' THEN 100
          WHEN job_type='BUILD_EMAIL_SEQUENCE' THEN 80
          WHEN job_type='SYNC_BITABLE' THEN 70
          WHEN job_type='DISCOVER_CAMPAIGN' THEN 20
          WHEN job_type='ENRICH_CONTACTS' THEN 10
          ELSE 50
        END;

        UPDATE jobs
        SET worker_id=COALESCE(worker_id, 'legacy-worker'),
            lease_token=COALESCE(lease_token, 'legacy-' || id),
            lease_expires_at=COALESCE(lease_expires_at, locked_at, updated_at, created_at)
        WHERE status='RUNNING';

        CREATE INDEX IF NOT EXISTS idx_jobs_claim
          ON jobs(status, lane, priority DESC, run_after, created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_lease
          ON jobs(status, lease_expires_at);
      `);
    });
    this.applyMigration(7, "outbound recipient ownership integrity", () => {
      const tableNames = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((table) => table.name),
      );
      if (!tableNames.has("outbound_messages") || !tableNames.has("leads") || !tableNames.has("contacts")) return;
      const leadColumns = new Set(
        (this.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      const contactColumns = new Set(
        (this.db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      const messageColumns = new Set(
        (this.db.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (
        !["id", "campaign_id"].every((column) => leadColumns.has(column)) ||
        !["id", "lead_id", "email", "whatsapp"].every((column) => contactColumns.has(column)) ||
        !["lead_id", "contact_id", "campaign_id", "channel", "destination", "status", "failure_reason", "updated_at"]
          .every((column) => messageColumns.has(column))
      ) return;
      this.db.exec(`
        UPDATE outbound_messages
        SET status='CANCELLED',
            failure_reason='recipient ownership integrity migration',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','FAILED')
          AND NOT EXISTS (
            SELECT 1 FROM leads l JOIN contacts c ON c.id=outbound_messages.contact_id
            WHERE l.id=outbound_messages.lead_id
              AND c.lead_id=outbound_messages.lead_id
              AND outbound_messages.campaign_id IS l.campaign_id
              AND (
                (outbound_messages.channel='email'
                  AND lower(trim(outbound_messages.destination))=lower(trim(c.email)))
                OR
                (outbound_messages.channel='whatsapp'
                  AND replace(replace(replace(replace(replace(lower(trim(outbound_messages.destination)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                    =replace(replace(replace(replace(replace(lower(trim(c.whatsapp)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''))
              )
          );

        CREATE TRIGGER IF NOT EXISTS trg_outbound_recipient_integrity_insert
        BEFORE INSERT ON outbound_messages
        WHEN NOT EXISTS (
          SELECT 1 FROM leads l JOIN contacts c ON c.id=NEW.contact_id
          WHERE l.id=NEW.lead_id AND c.lead_id=NEW.lead_id
            AND NEW.campaign_id IS l.campaign_id
            AND (
              (NEW.channel='email' AND lower(trim(NEW.destination))=lower(trim(c.email)))
              OR
              (NEW.channel='whatsapp'
                AND replace(replace(replace(replace(replace(lower(trim(NEW.destination)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                  =replace(replace(replace(replace(replace(lower(trim(c.whatsapp)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''))
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'outbound recipient ownership mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_outbound_recipient_integrity_update
        BEFORE UPDATE OF campaign_id, lead_id, contact_id, channel, destination ON outbound_messages
        WHEN NOT EXISTS (
          SELECT 1 FROM leads l JOIN contacts c ON c.id=NEW.contact_id
          WHERE l.id=NEW.lead_id AND c.lead_id=NEW.lead_id
            AND NEW.campaign_id IS l.campaign_id
            AND (
              (NEW.channel='email' AND lower(trim(NEW.destination))=lower(trim(c.email)))
              OR
              (NEW.channel='whatsapp'
                AND replace(replace(replace(replace(replace(lower(trim(NEW.destination)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                  =replace(replace(replace(replace(replace(lower(trim(c.whatsapp)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''))
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'outbound recipient ownership mismatch');
        END;
      `);
    });
    this.applyMigration(8, "persistent contact enrichment rounds", () => {
      const tableNames = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((table) => table.name),
      );
      if (!tableNames.has("leads")) return;
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("enrichment_attempts")) {
        this.db.exec("ALTER TABLE leads ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0");
        columns.add("enrichment_attempts");
      }
      if (!columns.has("enrichment_next_at")) {
        this.db.exec("ALTER TABLE leads ADD COLUMN enrichment_next_at TEXT");
        columns.add("enrichment_next_at");
      }
      if (["campaign_id", "status", "human_takeover", "enrichment_attempts", "enrichment_next_at"]
        .every((column) => columns.has(column))) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_leads_enrichment_queue
            ON leads(campaign_id, status, human_takeover, enrichment_attempts, enrichment_next_at);
        `);
      }
    });
    this.applyMigration(9, "active job deduplication", () => {
      const tableNames = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((table) => table.name),
      );
      const migrationNow = this.now();
      if (tableNames.has("leads")) {
        const leadColumns = new Set(
          (this.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>).map((column) => column.name),
        );
        if (["status", "enrichment_attempts", "enrichment_next_at", "updated_at"]
          .every((column) => leadColumns.has(column))) {
          this.db.prepare(
            `UPDATE leads
             SET status='ENRICHMENT_EXHAUSTED', enrichment_next_at=NULL, updated_at=?
             WHERE status='ENRICHING' AND enrichment_attempts>=3`,
          ).run(migrationNow);
        }
      }
      if (!tableNames.has("jobs")) return;
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("dedupe_key")) this.db.exec("ALTER TABLE jobs ADD COLUMN dedupe_key TEXT");
      this.db.prepare(
        `UPDATE jobs
         SET status='FAILED', last_error=?, locked_at=NULL, worker_id=NULL,
             lease_token=NULL, lease_expires_at=NULL, updated_at=?
         WHERE status='QUEUED' AND attempts>=max_attempts`,
      ).run("queued job was already at maximum attempts during schema v9 migration", migrationNow);
      this.db.prepare(
        `UPDATE jobs
         SET status='FAILED', last_error=?, locked_at=NULL, worker_id=NULL,
             lease_token=NULL, lease_expires_at=NULL, updated_at=?
         WHERE status='RUNNING' AND attempts>=max_attempts
           AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`,
      ).run("job lease expired at maximum attempts during schema v9 migration", migrationNow, migrationNow);
      const enrichmentJobs = this.db.prepare(
        `SELECT id, status, payload_json FROM jobs
         WHERE job_type='ENRICH_CONTACTS' AND status IN ('QUEUED','RUNNING')
         ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END, created_at, id`,
      ).all() as Array<{ id: string; status: string; payload_json: string }>;
      const retained = new Set<string>();
      for (const job of enrichmentJobs) {
        let payload: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(job.payload_json) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          // Invalid JSON is handled by the same fail-closed branch as non-object JSON.
        }
        if (!payload) {
          this.db.prepare(
            `UPDATE jobs SET status='FAILED', last_error=?, locked_at=NULL, worker_id=NULL,
               lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          ).run("invalid enrichment payload during active-job deduplication migration", migrationNow, job.id);
          continue;
        }
        const campaignId = String(payload.campaignId ?? "").trim();
        if (!campaignId) {
          this.db.prepare(
            `UPDATE jobs SET status='FAILED', last_error=?, locked_at=NULL, worker_id=NULL,
               lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          ).run("missing campaign id during active-job deduplication migration", migrationNow, job.id);
          continue;
        }
        const dedupeKey = `contact-enrichment:${campaignId}`;
        if (retained.has(dedupeKey)) {
          this.db.prepare(
            `UPDATE jobs SET status='FAILED', last_error=?, locked_at=NULL, worker_id=NULL,
               lease_token=NULL, lease_expires_at=NULL WHERE id=?`,
          ).run("duplicate active enrichment job cancelled during schema v9 migration", job.id);
          continue;
        }
        retained.add(dedupeKey);
        this.db.prepare("UPDATE jobs SET dedupe_key=? WHERE id=?").run(dedupeKey, job.id);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe
          ON jobs(dedupe_key)
          WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING');
      `);
    });
    this.applyMigration(10, "canonical acquisition foundation", () => {
      const hasColumns = (table: string, columns: readonly string[]): boolean => {
        const tableExists = Boolean(this.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ).get(table));
        if (!tableExists) return false;
        const available = new Set(
          (this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        return columns.every((column) => available.has(column));
      };
      const legacyCompatibilityReady =
        hasColumns("campaigns", [
          "id", "name", "market", "product", "buyer_type", "status", "created_by", "created_at", "updated_at",
        ]) &&
        hasColumns("leads", [
          "id", "campaign_id", "company", "domain", "website", "country", "buyer_type", "product", "status",
          "created_at", "updated_at",
        ]) &&
        hasColumns("lead_sources", [
          "id", "lead_id", "source_url", "source_type", "source_date", "created_at",
        ]) &&
        hasColumns("contacts", [
          "id", "lead_id", "name", "title", "email", "whatsapp", "linkedin", "source_url",
          "employment_verified_at", "email_status", "whatsapp_opt_in_at", "created_at", "updated_at",
        ]);
      this.db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
        legal_name TEXT,
        account_type TEXT NOT NULL DEFAULT 'COMPANY'
          CHECK(account_type IN ('COMPANY','GROUP','DISTRIBUTOR','INTEGRATOR','END_USER','OTHER')),
        website TEXT,
        country_code TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'NEW'
          CHECK(lifecycle_status IN ('NEW','RESEARCHING','QUALIFIED','WATCHLIST','CUSTOMER','EXCLUDED','ARCHIVED')),
        legacy_primary_lead_id TEXT UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE account_domains (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        domain TEXT NOT NULL COLLATE NOCASE UNIQUE
          CHECK(length(trim(domain)) > 0 AND domain=lower(trim(domain))
            AND instr(domain, ' ') = 0 AND instr(domain, '/') = 0 AND instr(domain, '@') = 0),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
        verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
          CHECK(verification_status IN ('UNVERIFIED','VERIFIED','CONFLICTED','STALE')),
        source TEXT NOT NULL DEFAULT 'LOCAL' CHECK(length(trim(source)) > 0),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;
      CREATE UNIQUE INDEX idx_account_domains_primary
        ON account_domains(account_id) WHERE is_primary=1;

      CREATE TABLE account_locations (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        location_type TEXT NOT NULL DEFAULT 'OTHER'
          CHECK(location_type IN ('HEADQUARTERS','OFFICE','FACILITY','WAREHOUSE','OTHER')),
        address_line TEXT,
        city TEXT,
        region TEXT,
        postal_code TEXT,
        country_code TEXT NOT NULL CHECK(length(trim(country_code)) > 0),
        latitude REAL CHECK(latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
        longitude REAL CHECK(longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(account_id, location_type, address_line, city, country_code)
      ) STRICT;

      CREATE TABLE account_identifiers (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        identifier_type TEXT NOT NULL CHECK(length(trim(identifier_type)) > 0),
        identifier_value TEXT NOT NULL CHECK(length(trim(identifier_value)) > 0),
        normalized_value TEXT NOT NULL CHECK(length(trim(normalized_value)) > 0),
        issuer TEXT,
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(identifier_type, normalized_value)
      ) STRICT;

      CREATE TABLE plays (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        play_key TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(play_key)) > 0),
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        country TEXT NOT NULL CHECK(length(trim(country)) > 0),
        buyer_archetype TEXT NOT NULL CHECK(length(trim(buyer_archetype)) > 0),
        application TEXT NOT NULL CHECK(length(trim(application)) > 0),
        product_family TEXT NOT NULL CHECK(length(trim(product_family)) > 0),
        role_family TEXT NOT NULL CHECK(length(trim(role_family)) > 0),
        qualification_track TEXT NOT NULL
          CHECK(qualification_track IN ('ACTIVE_INTENT','ICP_FIT','WATCHLIST')),
        offer TEXT NOT NULL CHECK(length(trim(offer)) > 0),
        channel TEXT NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP','LINKEDIN','MULTI_CHANNEL')),
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK(status IN ('DRAFT','EVIDENCE_REVIEW','SHADOW','APPROVED','READY_TO_STAGE',
            'STAGED_PAUSED','ACTIVE','PAUSED','STOPPED','KILLED')),
        approval_policy TEXT NOT NULL DEFAULT 'REVIEW_ALL'
          CHECK(approval_policy IN ('REVIEW_ALL','REVIEW_HIGH_RISK','AUTO_SEND_ELIGIBLE','PAUSED')),
        legacy_campaign_id TEXT UNIQUE REFERENCES campaigns(id) ON DELETE SET NULL,
        created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE play_versions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE RESTRICT,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        definition_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(definition_json)),
        content_hash TEXT NOT NULL CHECK(length(content_hash) >= 16),
        policy_version TEXT NOT NULL DEFAULT 'acquisition-foundation-v1' CHECK(length(trim(policy_version)) > 0),
        created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(play_id, version_number),
        UNIQUE(play_id, content_hash)
      ) STRICT;

      CREATE TABLE campaign_play_links (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        play_version_id TEXT NOT NULL REFERENCES play_versions(id) ON DELETE RESTRICT,
        is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0,1)),
        linked_by TEXT NOT NULL CHECK(length(trim(linked_by)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(campaign_id, play_version_id)
      ) STRICT;
      CREATE UNIQUE INDEX idx_campaign_play_primary
        ON campaign_play_links(campaign_id) WHERE is_primary=1;

      CREATE TABLE lead_account_links (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        resolution_method TEXT NOT NULL
          CHECK(resolution_method IN ('NORMALIZED_DOMAIN','MANUAL','PROVIDER_ID','LEGACY_FALLBACK')),
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE play_enrollments (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        play_version_id TEXT NOT NULL REFERENCES play_versions(id) ON DELETE RESTRICT,
        campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
        legacy_lead_id TEXT UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'PROSPECT'
          CHECK(status IN ('PROSPECT','RESEARCHING','QUALIFIED','WATCHLIST','READY_FOR_REVIEW',
            'APPROVED','ACTIVE','HUMAN_TAKEOVER','EXCLUDED','STOPPED')),
        qualification_track TEXT NOT NULL
          CHECK(qualification_track IN ('ACTIVE_INTENT','ICP_FIT','WATCHLIST')),
        source TEXT NOT NULL DEFAULT 'LOCAL' CHECK(length(trim(source)) > 0),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        enrolled_at TEXT NOT NULL CHECK(length(enrolled_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(account_id, play_version_id)
      ) STRICT;

      CREATE TABLE source_documents (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        facility_id TEXT REFERENCES facilities(id) ON DELETE SET NULL,
        document_type TEXT NOT NULL
          CHECK(document_type IN ('WEB_PAGE','PDF','DOC','DOCX','API_RECORD','EMAIL','FORM','MANUAL','OTHER')),
        source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
        publisher TEXT,
        publisher_domain TEXT,
        independence_key TEXT NOT NULL CHECK(length(trim(independence_key)) > 0),
        authority_class TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK(authority_class IN ('ACCOUNT_OFFICIAL','GOVERNMENT','REGULATOR','EXCHANGE','PROJECT_OWNER',
            'LICENSED_PROVIDER','INDEPENDENT_MEDIA','SEARCH_INDEX','UNKNOWN')),
        published_at TEXT,
        retrieved_at TEXT NOT NULL CHECK(length(retrieved_at) >= 20),
        expires_at TEXT,
        content_hash TEXT,
        mime_type TEXT,
        status TEXT NOT NULL DEFAULT 'METADATA_ONLY'
          CHECK(status IN ('FETCHED','METADATA_ONLY','PARTIAL','FAILED','STALE')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(source_url, content_hash)
      ) STRICT;

      CREATE TABLE account_sources (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
        source_type TEXT NOT NULL CHECK(length(trim(source_type)) > 0),
        publisher_domain TEXT,
        independence_key TEXT NOT NULL CHECK(length(trim(independence_key)) > 0),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(account_id, source_url, source_type)
      ) STRICT;

      CREATE TABLE facilities (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        facility_type TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK(facility_type IN ('PLANT','WORKSHOP','WAREHOUSE','PROJECT_SITE','OFFICE','UNKNOWN')),
        address_line TEXT,
        city TEXT,
        region TEXT,
        country_code TEXT,
        status TEXT NOT NULL DEFAULT 'UNVERIFIED'
          CHECK(status IN ('UNVERIFIED','VERIFIED','STALE','CLOSED','CONFLICTED')),
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(account_id, name, address_line)
      ) STRICT;

      CREATE TABLE facility_identifiers (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        facility_id TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        identifier_type TEXT NOT NULL CHECK(length(trim(identifier_type)) > 0),
        identifier_value TEXT NOT NULL CHECK(length(trim(identifier_value)) > 0),
        normalized_value TEXT NOT NULL CHECK(length(trim(normalized_value)) > 0),
        issuer TEXT,
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(identifier_type, normalized_value)
      ) STRICT;

      CREATE TABLE facility_processes (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        facility_id TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        process_type TEXT NOT NULL CHECK(length(trim(process_type)) > 0),
        production_line TEXT,
        product_requirement TEXT,
        operating_conditions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(operating_conditions_json)),
        evidence_fact_id TEXT REFERENCES evidence_facts(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(facility_id, process_type, production_line, evidence_fact_id)
      ) STRICT;

      CREATE TABLE people (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
        normalized_name TEXT NOT NULL,
        identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED'
          CHECK(identity_status IN ('UNRESOLVED','ASSERTED','VERIFIED','CONFLICTED','MERGED')),
        legacy_contact_id TEXT UNIQUE REFERENCES contacts(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE employments (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        title TEXT,
        role_family TEXT,
        status TEXT NOT NULL DEFAULT 'UNVERIFIED'
          CHECK(status IN ('UNVERIFIED','VERIFIED','STALE','CONFLICTED','ENDED')),
        is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
        source_url TEXT,
        source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        verified_at TEXT,
        expires_at TEXT,
        legacy_contact_id TEXT UNIQUE REFERENCES contacts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(person_id, account_id, title, observed_at)
      ) STRICT;

      CREATE TABLE contact_points (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('EMAIL','WHATSAPP','PHONE','LINKEDIN','OTHER')),
        value TEXT NOT NULL CHECK(length(trim(value)) > 0),
        normalized_value TEXT NOT NULL CHECK(length(trim(normalized_value)) > 0),
        source_url TEXT,
        verification_status TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK(verification_status IN ('UNKNOWN','UNVERIFIED','VALID','RISKY','INVALID','STALE','CONFLICTED')),
        consent_status TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK(consent_status IN ('UNKNOWN','OPTED_IN','OPTED_OUT','REVOKED')),
        send_eligible INTEGER NOT NULL DEFAULT 0 CHECK(send_eligible IN (0,1)),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        verified_at TEXT,
        expires_at TEXT,
        legacy_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(person_id, kind, normalized_value)
      ) STRICT;
      CREATE INDEX idx_contact_points_lookup ON contact_points(kind, normalized_value);

      CREATE TABLE page_snapshots (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        snapshot_version INTEGER NOT NULL CHECK(snapshot_version > 0),
        final_url TEXT NOT NULL CHECK(length(trim(final_url)) > 0),
        http_status INTEGER CHECK(http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
        fetched_at TEXT NOT NULL CHECK(length(fetched_at) >= 20),
        content_hash TEXT NOT NULL CHECK(length(content_hash) >= 16),
        byte_length INTEGER NOT NULL DEFAULT 0 CHECK(byte_length >= 0),
        storage_ref TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(extraction_status IN ('PENDING','COMPLETE','PARTIAL','FAILED','SKIPPED')),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(source_document_id, snapshot_version),
        UNIQUE(source_document_id, content_hash)
      ) STRICT;

      CREATE TABLE evidence_facts (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        facility_id TEXT REFERENCES facilities(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        employment_id TEXT REFERENCES employments(id) ON DELETE SET NULL,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('ACCOUNT','FACILITY','PERSON','EMPLOYMENT','MARKET','SELLER','OTHER')),
        subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
        predicate TEXT NOT NULL CHECK(length(trim(predicate)) > 0),
        value_text TEXT,
        value_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value_json)),
        publisher TEXT NOT NULL CHECK(length(trim(publisher)) > 0),
        independence_key TEXT NOT NULL CHECK(length(trim(independence_key)) > 0),
        authority_class TEXT NOT NULL
          CHECK(authority_class IN ('ACCOUNT_OFFICIAL','GOVERNMENT','REGULATOR','EXCHANGE','PROJECT_OWNER',
            'LICENSED_PROVIDER','INDEPENDENT_MEDIA','SEARCH_INDEX','UNKNOWN')),
        source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
        exact_quote TEXT NOT NULL CHECK(length(trim(exact_quote)) > 0),
        fact_date TEXT,
        retrieved_at TEXT NOT NULL CHECK(length(retrieved_at) >= 20),
        expires_at TEXT,
        content_hash TEXT NOT NULL CHECK(length(content_hash) >= 16),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        human_review_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(human_review_status IN ('PENDING','APPROVED','REJECTED','STALE')),
        allowed_for_outreach INTEGER NOT NULL DEFAULT 0 CHECK(allowed_for_outreach IN (0,1)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(source_document_id, subject_type, subject_id, predicate, content_hash)
      ) STRICT;
      CREATE INDEX idx_evidence_facts_subject ON evidence_facts(subject_type, subject_id, predicate);
      CREATE INDEX idx_evidence_facts_independence ON evidence_facts(independence_key, predicate);

      CREATE TABLE company_dossiers (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','READY','STALE','REJECTED')),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE dossier_versions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        dossier_id TEXT NOT NULL REFERENCES company_dossiers(id) ON DELETE RESTRICT,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        dossier_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(dossier_json)),
        evidence_fact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_fact_ids_json)),
        policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
        content_hash TEXT NOT NULL CHECK(length(content_hash) >= 16),
        created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(dossier_id, version_number),
        UNIQUE(dossier_id, content_hash)
      ) STRICT;

      CREATE TABLE exclusions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        exclusion_type TEXT NOT NULL
          CHECK(exclusion_type IN ('OUT_OF_ICP','COMPETITOR','UNSUPPORTED_MARKET','NOT_BUYER',
            'DUPLICATE','DATA_QUALITY','TEMPORARY','OTHER')),
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
        facility_id TEXT REFERENCES facilities(id) ON DELETE CASCADE,
        play_id TEXT REFERENCES plays(id) ON DELETE CASCADE,
        scope_value TEXT,
        reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
        source TEXT NOT NULL CHECK(length(trim(source)) > 0),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','EXPIRED','REVOKED')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        starts_at TEXT NOT NULL CHECK(length(starts_at) >= 20),
        expires_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        CHECK((account_id IS NOT NULL) + (person_id IS NOT NULL) + (facility_id IS NOT NULL)
          + (play_id IS NOT NULL) + (scope_value IS NOT NULL) = 1)
      ) STRICT;
      CREATE INDEX idx_exclusions_account_active ON exclusions(account_id, status, expires_at);
      CREATE INDEX idx_exclusions_person_active ON exclusions(person_id, status, expires_at);

      CREATE TABLE provider_registry (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_key TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(provider_key)) > 0),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
        provider_kind TEXT NOT NULL
          CHECK(provider_kind IN ('COMPANY_DATA','CONTACT_DATA','EMAIL_VERIFICATION','CRAWLER',
            'MARKET_DATA','TRANSPORT','LEGACY_IMPORT','OTHER')),
        status TEXT NOT NULL DEFAULT 'DISABLED'
          CHECK(status IN ('ENABLED','DISABLED','DEGRADED','BLOCKED')),
        capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
        policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
        terms_checked_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;

      CREATE TABLE provider_runs (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK(length(trim(operation)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        play_version_id TEXT REFERENCES play_versions(id) ON DELETE SET NULL,
        status TEXT NOT NULL
          CHECK(status IN ('PLANNED','RUNNING','SUCCEEDED','PARTIAL','FAILED','SKIPPED','BUDGET_BLOCKED','DISABLED')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        request_hash TEXT NOT NULL CHECK(length(request_hash) >= 16),
        requested_count INTEGER NOT NULL DEFAULT 0 CHECK(requested_count >= 0),
        returned_count INTEGER NOT NULL DEFAULT 0 CHECK(returned_count >= 0),
        result_hash TEXT,
        error_class TEXT,
        started_at TEXT NOT NULL CHECK(length(started_at) >= 20),
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;
      CREATE INDEX idx_provider_runs_provider_time ON provider_runs(provider_id, started_at);

      CREATE TABLE provider_attempts (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_run_id TEXT NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
        status TEXT NOT NULL
          CHECK(status IN ('RUNNING','SUCCEEDED','FAILED','RETRYABLE','RATE_LIMITED',
            'BUDGET_BLOCKED','UNKNOWN_RECONCILIATION_REQUIRED')),
        provider_request_id TEXT,
        http_status INTEGER CHECK(http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
        retry_after_seconds INTEGER CHECK(retry_after_seconds IS NULL OR retry_after_seconds >= 0),
        error_class TEXT,
        request_hash TEXT NOT NULL CHECK(length(request_hash) >= 16),
        response_hash TEXT,
        started_at TEXT NOT NULL CHECK(length(started_at) >= 20),
        completed_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(provider_run_id, attempt_number),
        UNIQUE(provider_run_id, provider_request_id)
      ) STRICT;

      CREATE TABLE provider_assertions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
        provider_run_id TEXT REFERENCES provider_runs(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        facility_id TEXT REFERENCES facilities(id) ON DELETE CASCADE,
        person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
        employment_id TEXT REFERENCES employments(id) ON DELETE CASCADE,
        contact_point_id TEXT REFERENCES contact_points(id) ON DELETE CASCADE,
        attribute TEXT NOT NULL CHECK(length(trim(attribute)) > 0),
        value_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value_json)),
        value_hash TEXT,
        source_uri TEXT,
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        result TEXT NOT NULL
          CHECK(result IN ('ASSERTED','CONFIRMED','CONFLICTED','REJECTED','STALE','ERROR')),
        raw_payload_hash TEXT,
        credit_units REAL NOT NULL DEFAULT 0 CHECK(credit_units >= 0),
        estimated_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(estimated_cost_micros >= 0),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        CHECK((account_id IS NOT NULL) + (facility_id IS NOT NULL) + (person_id IS NOT NULL)
          + (employment_id IS NOT NULL) + (contact_point_id IS NOT NULL) >= 1)
      ) STRICT;

      CREATE TABLE contact_provider_assertions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
        provider_run_id TEXT REFERENCES provider_runs(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
        employment_id TEXT REFERENCES employments(id) ON DELETE CASCADE,
        contact_point_id TEXT REFERENCES contact_points(id) ON DELETE CASCADE,
        assertion_type TEXT NOT NULL
          CHECK(assertion_type IN ('IDENTITY','EMPLOYMENT','EMAIL_DISCOVERY','EMAIL_VERIFICATION',
            'PHONE_DISCOVERY','LINKEDIN_PROFILE','CONSENT','OTHER')),
        attribute TEXT NOT NULL CHECK(length(trim(attribute)) > 0),
        value_hash TEXT,
        source_uri TEXT,
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        result TEXT NOT NULL
          CHECK(result IN ('ASSERTED','CONFIRMED','CONFLICTED','REJECTED','STALE','ERROR')),
        raw_payload_hash TEXT,
        credit_units REAL NOT NULL DEFAULT 0 CHECK(credit_units >= 0),
        estimated_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(estimated_cost_micros >= 0),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        CHECK((person_id IS NOT NULL) + (employment_id IS NOT NULL) + (contact_point_id IS NOT NULL) >= 1)
      ) STRICT;

      CREATE TABLE provider_budgets (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK(length(trim(operation)) > 0),
        scope_type TEXT NOT NULL CHECK(scope_type IN ('GLOBAL','PLAY','ACCOUNT')),
        play_id TEXT REFERENCES plays(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        period_start TEXT NOT NULL CHECK(length(period_start) >= 10),
        period_end TEXT NOT NULL CHECK(length(period_end) >= 10 AND period_end > period_start),
        max_units REAL NOT NULL CHECK(max_units >= 0),
        max_cost_micros INTEGER NOT NULL CHECK(max_cost_micros >= 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency)=3 AND currency=upper(currency)),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        approved_by TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        CHECK((scope_type='GLOBAL' AND play_id IS NULL AND account_id IS NULL)
          OR (scope_type='PLAY' AND play_id IS NOT NULL AND account_id IS NULL)
          OR (scope_type='ACCOUNT' AND account_id IS NOT NULL AND play_id IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX idx_provider_budgets_scope
        ON provider_budgets(provider_id, operation, scope_type,
          coalesce(play_id, ''), coalesce(account_id, ''), period_start, period_end);

      CREATE TABLE resource_usage (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        provider_id TEXT REFERENCES provider_registry(id) ON DELETE SET NULL,
        provider_run_id TEXT REFERENCES provider_runs(id) ON DELETE SET NULL,
        play_version_id TEXT REFERENCES play_versions(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        resource_type TEXT NOT NULL CHECK(length(trim(resource_type)) > 0),
        operation TEXT NOT NULL CHECK(length(trim(operation)) > 0),
        units REAL NOT NULL DEFAULT 0 CHECK(units >= 0),
        cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency)=3 AND currency=upper(currency)),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        occurred_at TEXT NOT NULL CHECK(length(occurred_at) >= 20),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
      ) STRICT;
      CREATE INDEX idx_resource_usage_provider_time ON resource_usage(provider_id, occurred_at);

      CREATE TABLE inquiry_intakes (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        source TEXT NOT NULL CHECK(source IN ('EMAIL','WHATSAPP','WEB_FORM','MANUAL','OTHER')),
        provider_event_id TEXT,
        message_id TEXT,
        content_hash TEXT NOT NULL CHECK(length(content_hash) >= 16),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        normalized_sender TEXT NOT NULL CHECK(length(trim(normalized_sender)) > 0),
        recipient TEXT,
        subject TEXT,
        body_text TEXT NOT NULL CHECK(length(body_text) <= 32768),
        received_at TEXT NOT NULL CHECK(length(received_at) >= 20),
        classification TEXT CHECK(classification IS NULL OR classification IN (
          'P1_INQUIRY','P2_INTEREST','OTHER_REPLY','NEGATIVE','UNSUBSCRIBE','BOUNCE','SOFT_BOUNCE',
          'DELIVERY_NOTICE','AUTO_REPLY','REFERRAL','WRONG_PERSON','NEEDS_INFO','NOT_FIT','SPAM','AMBIGUOUS')),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        contact_point_id TEXT REFERENCES contact_points(id) ON DELETE SET NULL,
        legacy_lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
        outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE SET NULL,
        correlation_method TEXT,
        correlation_confidence REAL CHECK(correlation_confidence IS NULL OR correlation_confidence BETWEEN 0 AND 1),
        intake_status TEXT NOT NULL DEFAULT 'QUARANTINED'
          CHECK(intake_status IN ('RECEIVED','UNMATCHED','QUARANTINED','MATCHED','QUALIFIED',
            'REJECTED','PROCESSED','DUPLICATE')),
        quarantine_reason TEXT,
        duplicate_of TEXT REFERENCES inquiry_intakes(id) ON DELETE SET NULL,
        raw_headers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(raw_headers_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
      ) STRICT;
      CREATE UNIQUE INDEX idx_inquiry_provider_event
        ON inquiry_intakes(source, provider_event_id) WHERE provider_event_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_inquiry_message_id
        ON inquiry_intakes(source, message_id) WHERE message_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_inquiry_content_hash
        ON inquiry_intakes(source, content_hash);
      CREATE INDEX idx_inquiry_status_time ON inquiry_intakes(intake_status, received_at);

      CREATE TABLE inquiry_facts (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        intake_id TEXT NOT NULL REFERENCES inquiry_intakes(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL CHECK(length(trim(field_name)) > 0),
        normalized_value TEXT NOT NULL,
        unit TEXT,
        exact_evidence_span TEXT NOT NULL CHECK(length(trim(exact_evidence_span)) > 0),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        extraction_version TEXT NOT NULL CHECK(length(trim(extraction_version)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        UNIQUE(intake_id, field_name, normalized_value, exact_evidence_span, extraction_version)
      ) STRICT;

      CREATE TABLE qualification_runs (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        intake_id TEXT REFERENCES inquiry_intakes(id) ON DELETE SET NULL,
        enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
        qualification_track TEXT NOT NULL
          CHECK(qualification_track IN ('ACTIVE_INTENT','ICP_FIT','WATCHLIST')),
        policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
        status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETE','FAILED','STALE')),
        decision TEXT NOT NULL
          CHECK(decision IN ('QUALIFIED','NEEDS_INFO','NOT_FIT','WATCHLIST','BLOCKED','ERROR')),
        reason TEXT NOT NULL DEFAULT '',
        evidence_fact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_fact_ids_json)),
        result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        started_at TEXT NOT NULL CHECK(length(started_at) >= 20),
        completed_at TEXT,
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        CHECK((account_id IS NOT NULL) + (intake_id IS NOT NULL) + (enrollment_id IS NOT NULL) >= 1)
      ) STRICT;

      CREATE TABLE opportunities (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        intake_id TEXT REFERENCES inquiry_intakes(id) ON DELETE SET NULL,
        enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK(length(trim(source)) > 0),
        stage TEXT NOT NULL DEFAULT 'NEW'
          CHECK(stage IN ('NEW','INQUIRY_QUALIFIED','QUALIFIED','NEEDS_INFO','TECHNICAL_REVIEW',
            'TECHNICAL_DISCOVERY','QUOTE_PENDING','QUOTED','NEGOTIATION','WON','LOST')),
        owner TEXT,
        first_response_due_at TEXT,
        quoted_at TEXT,
        closed_at TEXT,
        lost_reason TEXT,
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        CHECK((account_id IS NOT NULL) + (intake_id IS NOT NULL) + (enrollment_id IS NOT NULL) >= 1)
      ) STRICT;
      CREATE INDEX idx_opportunities_stage ON opportunities(stage, updated_at);

      CREATE TABLE quotes (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
        currency TEXT NOT NULL CHECK(length(currency)=3 AND currency=upper(currency)),
        gross_margin_bps INTEGER CHECK(gross_margin_bps IS NULL OR gross_margin_bps BETWEEN -10000 AND 10000),
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK(status IN ('DRAFT','APPROVED','SUBMITTED','ACCEPTED','REJECTED','EXPIRED','WITHDRAWN')),
        created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
        approved_by TEXT,
        approved_at TEXT,
        quoted_at TEXT,
        terms_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(terms_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        UNIQUE(opportunity_id, version_number)
      ) STRICT;

      CREATE TABLE sales_tasks (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        play_id TEXT REFERENCES plays(id) ON DELETE SET NULL,
        enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
        opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
        task_type TEXT NOT NULL
          CHECK(task_type IN ('CALL','LINKEDIN_REVIEW','CONTACT_RESEARCH','EMPLOYMENT_REVERIFY',
            'ACCOUNT_RESEARCH','DRAFT_REVIEW','INQUIRY_FOLLOWUP','TECHNICAL_REVIEW','QUOTE_FOLLOWUP')),
        status TEXT NOT NULL DEFAULT 'OPEN'
          CHECK(status IN ('OPEN','IN_PROGRESS','DONE','SNOOZED','CANCELLED')),
        owner TEXT NOT NULL CHECK(length(trim(owner)) > 0),
        due_at TEXT NOT NULL CHECK(length(due_at) >= 20),
        source_signal TEXT,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('CONTACT_FOUND','REFERRAL','WRONG_PERSON',
          'NOT_RELEVANT','NO_RESPONSE','OPPORTUNITY_CREATED','DATA_CORRECTED','COMPLETED_OTHER')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        completed_at TEXT,
        CHECK((account_id IS NOT NULL) + (person_id IS NOT NULL) + (play_id IS NOT NULL)
          + (enrollment_id IS NOT NULL) + (opportunity_id IS NOT NULL) >= 1)
      ) STRICT;
      CREATE INDEX idx_sales_tasks_queue ON sales_tasks(status, owner, due_at);

      CREATE TABLE touchpoints (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        contact_point_id TEXT REFERENCES contact_points(id) ON DELETE SET NULL,
        opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
        enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK(length(trim(source)) > 0),
        medium TEXT NOT NULL CHECK(length(trim(medium)) > 0),
        campaign TEXT,
        content TEXT,
        landing TEXT,
        referrer TEXT,
        attribution_position TEXT NOT NULL DEFAULT 'UNSPECIFIED'
          CHECK(attribution_position IN ('FIRST','LAST','ASSIST','UNSPECIFIED')),
        occurred_at TEXT NOT NULL CHECK(length(occurred_at) >= 20),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        CHECK((account_id IS NOT NULL) + (person_id IS NOT NULL) + (opportunity_id IS NOT NULL)
          + (enrollment_id IS NOT NULL) >= 1)
      ) STRICT;

      CREATE TABLE consents (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
        contact_point_id TEXT REFERENCES contact_points(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP','PHONE','SMS','OTHER')),
        status TEXT NOT NULL CHECK(status IN ('UNKNOWN','OPTED_IN','OPTED_OUT','REVOKED')),
        lawful_basis TEXT NOT NULL CHECK(length(trim(lawful_basis)) > 0),
        scope TEXT NOT NULL CHECK(length(trim(scope)) > 0),
        source TEXT NOT NULL CHECK(length(trim(source)) > 0),
        observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
        expires_at TEXT,
        revoked_at TEXT,
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
        evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
        CHECK((account_id IS NOT NULL) + (person_id IS NOT NULL) + (contact_point_id IS NOT NULL) >= 1)
      ) STRICT;
      `);

      if (legacyCompatibilityReady) this.db.exec(`
        INSERT INTO provider_registry(
          id, provider_key, display_name, provider_kind, status, capabilities_json,
          policy_json, created_at, updated_at
        ) VALUES (
          'provider_legacy_local', 'legacy-local', 'Legacy local compatibility import',
          'LEGACY_IMPORT', 'DISABLED', '[]',
          '{"externalCalls":false,"sendEligible":false}',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );

        WITH normalized AS (
          SELECT l.*,
            CASE
              WHEN lower(rtrim(trim(l.domain), '.')) LIKE 'www.%'
                THEN substr(lower(rtrim(trim(l.domain), '.')), 5)
              ELSE lower(rtrim(trim(l.domain), '.'))
            END AS normalized_domain
          FROM leads l
        ), ranked AS (
          SELECT normalized.*,
            CASE WHEN normalized_domain='' THEN 'lead:' || id ELSE normalized_domain END AS domain_key,
            row_number() OVER (
              PARTITION BY CASE WHEN normalized_domain='' THEN 'lead:' || id ELSE normalized_domain END
              ORDER BY created_at, id
            ) AS domain_rank
          FROM normalized
        )
        INSERT INTO accounts(
          id, display_name, legal_name, account_type, website, country_code,
          lifecycle_status, legacy_primary_lead_id, metadata_json, created_at, updated_at
        )
        SELECT
          'account_legacy:' || domain_key,
          CASE WHEN length(trim(company)) > 0 THEN trim(company) ELSE 'Unresolved legacy account' END,
          nullif(trim(company), ''),
          CASE
            WHEN lower(buyer_type) LIKE '%distributor%' THEN 'DISTRIBUTOR'
            WHEN lower(buyer_type) LIKE '%integrator%' THEN 'INTEGRATOR'
            WHEN lower(buyer_type) LIKE '%end user%' THEN 'END_USER'
            ELSE 'COMPANY'
          END,
          nullif(trim(website), ''), nullif(trim(country), ''),
          CASE
            WHEN status='REJECTED' THEN 'EXCLUDED'
            WHEN status IN ('READY_FOR_REVIEW','APPROVED','CONTACTED','HUMAN_TAKEOVER') THEN 'QUALIFIED'
            ELSE 'RESEARCHING'
          END,
          id, json_object('migration', 'v10', 'legacyLeadId', id),
          created_at, updated_at
        FROM ranked WHERE domain_rank=1;

        WITH normalized AS (
          SELECT id,
            CASE
              WHEN lower(rtrim(trim(domain), '.')) LIKE 'www.%'
                THEN substr(lower(rtrim(trim(domain), '.')), 5)
              ELSE lower(rtrim(trim(domain), '.'))
            END AS normalized_domain,
            created_at, updated_at
          FROM leads
        )
        INSERT OR IGNORE INTO account_domains(
          id, account_id, domain, is_primary, verification_status, source,
          observed_at, created_at, updated_at
        )
        SELECT 'account_domain_legacy:' || normalized_domain,
          'account_legacy:' || normalized_domain, normalized_domain, 1, 'UNVERIFIED',
          'legacy_lead', created_at, created_at, updated_at
        FROM normalized WHERE normalized_domain <> '';

        WITH normalized AS (
          SELECT id,
            CASE
              WHEN lower(rtrim(trim(domain), '.')) LIKE 'www.%'
                THEN substr(lower(rtrim(trim(domain), '.')), 5)
              ELSE lower(rtrim(trim(domain), '.'))
            END AS normalized_domain,
            created_at, updated_at
          FROM leads
        )
        INSERT INTO lead_account_links(
          id, lead_id, account_id, resolution_method, confidence, created_at, updated_at
        )
        SELECT 'lead_account_link:' || id, id,
          'account_legacy:' || CASE WHEN normalized_domain='' THEN 'lead:' || id ELSE normalized_domain END,
          CASE WHEN normalized_domain='' THEN 'LEGACY_FALLBACK' ELSE 'NORMALIZED_DOMAIN' END,
          CASE WHEN normalized_domain='' THEN 0.0 ELSE 0.8 END,
          created_at, updated_at
        FROM normalized;

        INSERT INTO source_documents(
          id, account_id, document_type, source_url, publisher, publisher_domain,
          independence_key, authority_class, published_at, retrieved_at, status,
          idempotency_key, metadata_json, created_at, updated_at
        )
        SELECT 'source_document_legacy:' || ls.id, lal.account_id,
          CASE
            WHEN lower(ls.source_url) LIKE '%.pdf%' THEN 'PDF'
            WHEN lower(ls.source_url) LIKE 'http%' THEN 'WEB_PAGE'
            ELSE 'OTHER'
          END,
          ls.source_url, null, null, lower(trim(ls.source_url)),
          CASE WHEN lower(ls.source_type) LIKE '%official%' THEN 'ACCOUNT_OFFICIAL' ELSE 'UNKNOWN' END,
          ls.source_date, ls.created_at, 'METADATA_ONLY', 'legacy-lead-source:' || ls.id,
          json_object('legacySourceId', ls.id, 'sourceType', ls.source_type),
          ls.created_at, ls.created_at
        FROM lead_sources ls JOIN lead_account_links lal ON lal.lead_id=ls.lead_id;

        INSERT INTO account_sources(
          id, account_id, source_document_id, source_url, source_type,
          publisher_domain, independence_key, observed_at, created_at
        )
        SELECT 'account_source_legacy:' || ls.id, lal.account_id,
          'source_document_legacy:' || ls.id, ls.source_url, ls.source_type,
          null, lower(trim(ls.source_url)), ls.created_at, ls.created_at
        FROM lead_sources ls JOIN lead_account_links lal ON lal.lead_id=ls.lead_id;

        INSERT INTO plays(
          id, play_key, name, country, buyer_archetype, application, product_family,
          role_family, qualification_track, offer, channel, status, approval_policy,
          legacy_campaign_id, created_by, created_at, updated_at
        )
        SELECT 'play_legacy:' || id, 'legacy-campaign:' || id,
          CASE WHEN length(trim(name)) > 0 THEN trim(name) ELSE 'Legacy campaign ' || id END,
          CASE WHEN length(trim(market)) > 0 THEN trim(market) ELSE 'UNKNOWN' END,
          CASE WHEN length(trim(buyer_type)) > 0 THEN trim(buyer_type) ELSE 'UNKNOWN' END,
          'LEGACY_UNSPECIFIED',
          CASE WHEN length(trim(product)) > 0 THEN trim(product) ELSE 'UNKNOWN' END,
          'LEGACY_UNSPECIFIED', 'WATCHLIST', 'LEGACY_UNSPECIFIED', 'EMAIL',
          CASE WHEN status='PAUSED' THEN 'PAUSED' WHEN status='STOPPED' THEN 'STOPPED' ELSE 'DRAFT' END,
          'REVIEW_ALL', id,
          CASE WHEN length(trim(created_by)) > 0 THEN created_by ELSE 'legacy_migration' END,
          created_at, updated_at
        FROM campaigns;

        INSERT INTO play_versions(
          id, play_id, version_number, definition_json, content_hash,
          policy_version, created_by, created_at
        )
        SELECT 'play_version_legacy:' || id || ':1', 'play_legacy:' || id, 1,
          json_object(
            'country', market, 'buyerArchetype', buyer_type,
            'application', 'LEGACY_UNSPECIFIED', 'productFamily', product,
            'roleFamily', 'LEGACY_UNSPECIFIED', 'qualificationTrack', 'WATCHLIST',
            'offer', 'LEGACY_UNSPECIFIED', 'channel', 'EMAIL', 'legacyCampaignId', id
          ),
          'legacy-campaign-v1:' || id, 'legacy-compatibility-v1',
          CASE WHEN length(trim(created_by)) > 0 THEN created_by ELSE 'legacy_migration' END,
          created_at
        FROM campaigns;

        INSERT INTO campaign_play_links(
          id, campaign_id, play_version_id, is_primary, linked_by, created_at
        )
        SELECT 'campaign_play_link_legacy:' || id, id,
          'play_version_legacy:' || id || ':1', 1, 'legacy_migration', created_at
        FROM campaigns;

        INSERT OR IGNORE INTO play_enrollments(
          id, account_id, play_version_id, campaign_id, legacy_lead_id, status,
          qualification_track, source, idempotency_key, enrolled_at, updated_at
        )
        SELECT 'play_enrollment_legacy:' || l.id, lal.account_id,
          'play_version_legacy:' || l.campaign_id || ':1', l.campaign_id, l.id,
          CASE
            WHEN l.status='READY_FOR_REVIEW' THEN 'READY_FOR_REVIEW'
            WHEN l.status='APPROVED' THEN 'APPROVED'
            WHEN l.status='HUMAN_TAKEOVER' THEN 'HUMAN_TAKEOVER'
            WHEN l.status='REJECTED' THEN 'STOPPED'
            WHEN l.status='ENRICHING' THEN 'RESEARCHING'
            ELSE 'WATCHLIST'
          END,
          'WATCHLIST', 'legacy_lead', 'legacy-lead-enrollment:' || l.id,
          l.created_at, l.updated_at
        FROM leads l
        JOIN lead_account_links lal ON lal.lead_id=l.id
        WHERE l.campaign_id IS NOT NULL;

        INSERT INTO people(
          id, display_name, normalized_name, identity_status, legacy_contact_id,
          metadata_json, created_at, updated_at
        )
        SELECT 'person_legacy:' || id,
          CASE WHEN length(trim(name)) > 0 THEN trim(name) ELSE 'Unresolved legacy contact' END,
          lower(trim(name)),
          CASE WHEN length(trim(name)) > 0 THEN 'ASSERTED' ELSE 'UNRESOLVED' END,
          id, json_object('migration', 'v10', 'legacyContactId', id), created_at, updated_at
        FROM contacts;

        INSERT INTO employments(
          id, person_id, account_id, title, role_family, status, is_current,
          source_url, observed_at, verified_at, expires_at, legacy_contact_id,
          created_at, updated_at
        )
        SELECT 'employment_legacy:' || c.id, 'person_legacy:' || c.id, lal.account_id,
          nullif(trim(c.title), ''), null,
          CASE WHEN c.employment_verified_at IS NULL THEN 'UNVERIFIED' ELSE 'STALE' END,
          0, nullif(trim(c.source_url), ''),
          coalesce(c.employment_verified_at, c.updated_at, c.created_at),
          c.employment_verified_at, c.employment_verified_at, c.id,
          c.created_at, c.updated_at
        FROM contacts c JOIN lead_account_links lal ON lal.lead_id=c.lead_id;

        INSERT INTO contact_points(
          id, person_id, kind, value, normalized_value, source_url,
          verification_status, consent_status, send_eligible, observed_at,
          legacy_contact_id, metadata_json, created_at, updated_at
        )
        SELECT 'contact_point_legacy:email:' || c.id || ':' || lower(trim(c.email)),
          'person_legacy:' || c.id, 'EMAIL', trim(c.email), lower(trim(c.email)),
          nullif(trim(c.source_url), ''),
          CASE c.email_status
            WHEN 'VALID' THEN 'VALID' WHEN 'RISKY' THEN 'RISKY'
            WHEN 'INVALID' THEN 'INVALID' ELSE 'UNKNOWN'
          END,
          'UNKNOWN', 0, c.created_at, c.id,
          '{"legacyImport":true,"sendEligible":false}', c.created_at, c.updated_at
        FROM contacts c WHERE c.email IS NOT NULL AND length(trim(c.email)) > 0;

        INSERT INTO contact_points(
          id, person_id, kind, value, normalized_value, source_url,
          verification_status, consent_status, send_eligible, observed_at,
          legacy_contact_id, metadata_json, created_at, updated_at
        )
        SELECT 'contact_point_legacy:whatsapp:' || c.id || ':' ||
            replace(replace(replace(replace(replace(trim(c.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
          'person_legacy:' || c.id, 'WHATSAPP', trim(c.whatsapp),
          replace(replace(replace(replace(replace(trim(c.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
          nullif(trim(c.source_url), ''), 'UNKNOWN',
          CASE WHEN c.whatsapp_opt_in_at IS NULL THEN 'UNKNOWN' ELSE 'OPTED_IN' END,
          0, c.created_at, c.id, '{"legacyImport":true,"sendEligible":false}',
          c.created_at, c.updated_at
        FROM contacts c WHERE c.whatsapp IS NOT NULL AND
          length(replace(replace(replace(replace(replace(trim(c.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')) > 0;

        INSERT INTO contact_points(
          id, person_id, kind, value, normalized_value, source_url,
          verification_status, consent_status, send_eligible, observed_at,
          legacy_contact_id, metadata_json, created_at, updated_at
        )
        SELECT 'contact_point_legacy:linkedin:' || c.id || ':' || lower(trim(c.linkedin)),
          'person_legacy:' || c.id, 'LINKEDIN', trim(c.linkedin), lower(trim(c.linkedin)),
          nullif(trim(c.source_url), ''), 'UNKNOWN', 'UNKNOWN', 0, c.created_at, c.id,
          '{"legacyImport":true,"sendEligible":false}', c.created_at, c.updated_at
        FROM contacts c WHERE c.linkedin IS NOT NULL AND length(trim(c.linkedin)) > 0;

        INSERT INTO contact_provider_assertions(
          id, provider_id, person_id, contact_point_id, assertion_type, attribute,
          value_hash, source_uri, observed_at, expires_at, confidence, result,
          credit_units, estimated_cost_micros, idempotency_key, created_at
        )
        SELECT 'contact_assertion_legacy:' || cp.id, 'provider_legacy_local', cp.person_id, cp.id,
          CASE cp.kind
            WHEN 'EMAIL' THEN 'EMAIL_DISCOVERY'
            WHEN 'LINKEDIN' THEN 'LINKEDIN_PROFILE'
            WHEN 'WHATSAPP' THEN 'PHONE_DISCOVERY'
            ELSE 'OTHER'
          END,
          lower(cp.kind), null, cp.source_url, cp.observed_at, cp.observed_at,
          CASE WHEN cp.verification_status IN ('VALID','RISKY') THEN 0.5 ELSE 0.0 END,
          'STALE', 0, 0, 'legacy-contact-point:' || cp.id, cp.created_at
        FROM contact_points cp WHERE cp.legacy_contact_id IS NOT NULL;

        INSERT INTO consents(
          id, account_id, person_id, contact_point_id, channel, status, lawful_basis,
          scope, source, observed_at, idempotency_key, evidence_json, created_at, updated_at
        )
        SELECT 'consent_legacy:whatsapp:' || c.id, lal.account_id, 'person_legacy:' || c.id,
          cp.id, 'WHATSAPP', 'OPTED_IN', 'EXPLICIT', 'LEGACY_WHATSAPP', 'legacy_contact',
          c.whatsapp_opt_in_at, 'legacy-whatsapp-opt-in:' || c.id,
          json_object('legacyContactId', c.id), c.whatsapp_opt_in_at, c.whatsapp_opt_in_at
        FROM contacts c
        JOIN lead_account_links lal ON lal.lead_id=c.lead_id
        JOIN contact_points cp ON cp.legacy_contact_id=c.id AND cp.kind='WHATSAPP'
        WHERE c.whatsapp_opt_in_at IS NOT NULL;

        CREATE TRIGGER trg_play_versions_immutable_update
        BEFORE UPDATE ON play_versions BEGIN
          SELECT RAISE(ABORT, 'play versions are immutable');
        END;
        CREATE TRIGGER trg_play_versions_immutable_delete
        BEFORE DELETE ON play_versions BEGIN
          SELECT RAISE(ABORT, 'play versions are immutable');
        END;
        CREATE TRIGGER trg_dossier_versions_immutable_update
        BEFORE UPDATE ON dossier_versions BEGIN
          SELECT RAISE(ABORT, 'dossier versions are immutable');
        END;
        CREATE TRIGGER trg_dossier_versions_immutable_delete
        BEFORE DELETE ON dossier_versions BEGIN
          SELECT RAISE(ABORT, 'dossier versions are immutable');
        END;
      `);

      if (legacyCompatibilityReady) this.db.exec(`
        CREATE TRIGGER trg_v10_campaign_compatibility_insert
        AFTER INSERT ON campaigns BEGIN
          INSERT OR IGNORE INTO plays(
            id, play_key, name, country, buyer_archetype, application, product_family,
            role_family, qualification_track, offer, channel, status, approval_policy,
            legacy_campaign_id, created_by, created_at, updated_at
          ) VALUES (
            'play_legacy:' || NEW.id, 'legacy-campaign:' || NEW.id,
            CASE WHEN length(trim(NEW.name)) > 0 THEN trim(NEW.name) ELSE 'Legacy campaign ' || NEW.id END,
            CASE WHEN length(trim(NEW.market)) > 0 THEN trim(NEW.market) ELSE 'UNKNOWN' END,
            CASE WHEN length(trim(NEW.buyer_type)) > 0 THEN trim(NEW.buyer_type) ELSE 'UNKNOWN' END,
            'LEGACY_UNSPECIFIED',
            CASE WHEN length(trim(NEW.product)) > 0 THEN trim(NEW.product) ELSE 'UNKNOWN' END,
            'LEGACY_UNSPECIFIED', 'WATCHLIST', 'LEGACY_UNSPECIFIED', 'EMAIL', 'DRAFT',
            'REVIEW_ALL', NEW.id,
            CASE WHEN length(trim(NEW.created_by)) > 0 THEN NEW.created_by ELSE 'legacy_compatibility' END,
            NEW.created_at, NEW.updated_at
          );
          INSERT OR IGNORE INTO play_versions(
            id, play_id, version_number, definition_json, content_hash,
            policy_version, created_by, created_at
          ) VALUES (
            'play_version_legacy:' || NEW.id || ':1', 'play_legacy:' || NEW.id, 1,
            json_object(
              'country', NEW.market, 'buyerArchetype', NEW.buyer_type,
              'application', 'LEGACY_UNSPECIFIED', 'productFamily', NEW.product,
              'roleFamily', 'LEGACY_UNSPECIFIED', 'qualificationTrack', 'WATCHLIST',
              'offer', 'LEGACY_UNSPECIFIED', 'channel', 'EMAIL', 'legacyCampaignId', NEW.id
            ),
            'legacy-campaign-v1:' || NEW.id, 'legacy-compatibility-v1',
            CASE WHEN length(trim(NEW.created_by)) > 0 THEN NEW.created_by ELSE 'legacy_compatibility' END,
            NEW.created_at
          );
          INSERT OR IGNORE INTO campaign_play_links(
            id, campaign_id, play_version_id, is_primary, linked_by, created_at
          ) VALUES (
            'campaign_play_link_legacy:' || NEW.id, NEW.id,
            'play_version_legacy:' || NEW.id || ':1', 1, 'legacy_compatibility', NEW.created_at
          );
        END;

        CREATE TRIGGER trg_v10_lead_compatibility_insert
        AFTER INSERT ON leads BEGIN
          INSERT OR IGNORE INTO accounts(
            id, display_name, legal_name, account_type, website, country_code,
            lifecycle_status, legacy_primary_lead_id, metadata_json, created_at, updated_at
          ) VALUES (
            'account_legacy:' || CASE
              WHEN length(CASE
                WHEN lower(rtrim(trim(NEW.domain), '.')) LIKE 'www.%'
                  THEN substr(lower(rtrim(trim(NEW.domain), '.')), 5)
                ELSE lower(rtrim(trim(NEW.domain), '.')) END)=0
                THEN 'lead:' || NEW.id
              ELSE CASE
                WHEN lower(rtrim(trim(NEW.domain), '.')) LIKE 'www.%'
                  THEN substr(lower(rtrim(trim(NEW.domain), '.')), 5)
                ELSE lower(rtrim(trim(NEW.domain), '.')) END
            END,
            CASE WHEN length(trim(NEW.company)) > 0 THEN trim(NEW.company) ELSE 'Unresolved legacy account' END,
            nullif(trim(NEW.company), ''),
            CASE
              WHEN lower(NEW.buyer_type) LIKE '%distributor%' THEN 'DISTRIBUTOR'
              WHEN lower(NEW.buyer_type) LIKE '%integrator%' THEN 'INTEGRATOR'
              WHEN lower(NEW.buyer_type) LIKE '%end user%' THEN 'END_USER'
              ELSE 'COMPANY'
            END,
            nullif(trim(NEW.website), ''), nullif(trim(NEW.country), ''), 'RESEARCHING', NEW.id,
            json_object('compatibilityTrigger', 'v10', 'legacyLeadId', NEW.id),
            NEW.created_at, NEW.updated_at
          );
          INSERT OR IGNORE INTO account_domains(
            id, account_id, domain, is_primary, verification_status, source,
            observed_at, created_at, updated_at
          )
          SELECT 'account_domain_legacy:' || normalized_domain,
            'account_legacy:' || normalized_domain, normalized_domain, 1, 'UNVERIFIED',
            'legacy_lead', NEW.created_at, NEW.created_at, NEW.updated_at
          FROM (
            SELECT CASE
              WHEN lower(rtrim(trim(NEW.domain), '.')) LIKE 'www.%'
                THEN substr(lower(rtrim(trim(NEW.domain), '.')), 5)
              ELSE lower(rtrim(trim(NEW.domain), '.'))
            END AS normalized_domain
          ) WHERE normalized_domain <> '';
          INSERT INTO lead_account_links(
            id, lead_id, account_id, resolution_method, confidence, created_at, updated_at
          ) VALUES (
            'lead_account_link:' || NEW.id, NEW.id,
            'account_legacy:' || CASE
              WHEN length(CASE
                WHEN lower(rtrim(trim(NEW.domain), '.')) LIKE 'www.%'
                  THEN substr(lower(rtrim(trim(NEW.domain), '.')), 5)
                ELSE lower(rtrim(trim(NEW.domain), '.')) END)=0
                THEN 'lead:' || NEW.id
              ELSE CASE
                WHEN lower(rtrim(trim(NEW.domain), '.')) LIKE 'www.%'
                  THEN substr(lower(rtrim(trim(NEW.domain), '.')), 5)
                ELSE lower(rtrim(trim(NEW.domain), '.')) END
            END,
            CASE WHEN length(trim(NEW.domain))=0 THEN 'LEGACY_FALLBACK' ELSE 'NORMALIZED_DOMAIN' END,
            CASE WHEN length(trim(NEW.domain))=0 THEN 0.0 ELSE 0.8 END,
            NEW.created_at, NEW.updated_at
          );
          INSERT OR IGNORE INTO play_enrollments(
            id, account_id, play_version_id, campaign_id, legacy_lead_id, status,
            qualification_track, source, idempotency_key, enrolled_at, updated_at
          )
          SELECT 'play_enrollment_legacy:' || NEW.id, lal.account_id,
            'play_version_legacy:' || NEW.campaign_id || ':1', NEW.campaign_id, NEW.id,
            CASE
              WHEN NEW.status='READY_FOR_REVIEW' THEN 'READY_FOR_REVIEW'
              WHEN NEW.status='APPROVED' THEN 'APPROVED'
              WHEN NEW.status='HUMAN_TAKEOVER' THEN 'HUMAN_TAKEOVER'
              WHEN NEW.status='REJECTED' THEN 'STOPPED'
              WHEN NEW.status='ENRICHING' THEN 'RESEARCHING'
              ELSE 'WATCHLIST'
            END,
            'WATCHLIST', 'legacy_lead', 'legacy-lead-enrollment:' || NEW.id,
            NEW.created_at, NEW.updated_at
          FROM lead_account_links lal
          WHERE lal.lead_id=NEW.id AND NEW.campaign_id IS NOT NULL;
        END;

        CREATE TRIGGER trg_v10_lead_compatibility_update
        AFTER UPDATE OF company, website, country ON leads BEGIN
          UPDATE accounts
          SET display_name=CASE WHEN length(trim(NEW.company)) > 0 THEN trim(NEW.company) ELSE display_name END,
              legal_name=coalesce(nullif(trim(NEW.company), ''), legal_name),
              website=coalesce(nullif(trim(NEW.website), ''), website),
              country_code=coalesce(nullif(trim(NEW.country), ''), country_code),
              updated_at=NEW.updated_at
          WHERE id=(SELECT account_id FROM lead_account_links WHERE lead_id=NEW.id);
        END;

        CREATE TRIGGER trg_v10_lead_source_compatibility_insert
        AFTER INSERT ON lead_sources BEGIN
          INSERT OR IGNORE INTO source_documents(
            id, account_id, document_type, source_url, publisher, publisher_domain,
            independence_key, authority_class, published_at, retrieved_at, status,
            idempotency_key, metadata_json, created_at, updated_at
          )
          SELECT 'source_document_legacy:' || NEW.id, lal.account_id,
            CASE
              WHEN lower(NEW.source_url) LIKE '%.pdf%' THEN 'PDF'
              WHEN lower(NEW.source_url) LIKE 'http%' THEN 'WEB_PAGE'
              ELSE 'OTHER'
            END,
            NEW.source_url, null, null, lower(trim(NEW.source_url)),
            CASE WHEN lower(NEW.source_type) LIKE '%official%' THEN 'ACCOUNT_OFFICIAL' ELSE 'UNKNOWN' END,
            NEW.source_date, NEW.created_at, 'METADATA_ONLY', 'legacy-lead-source:' || NEW.id,
            json_object('legacySourceId', NEW.id, 'sourceType', NEW.source_type),
            NEW.created_at, NEW.created_at
          FROM lead_account_links lal WHERE lal.lead_id=NEW.lead_id;
          INSERT OR IGNORE INTO account_sources(
            id, account_id, source_document_id, source_url, source_type,
            publisher_domain, independence_key, observed_at, created_at
          )
          SELECT 'account_source_legacy:' || NEW.id, lal.account_id,
            'source_document_legacy:' || NEW.id, NEW.source_url, NEW.source_type,
            null, lower(trim(NEW.source_url)), NEW.created_at, NEW.created_at
          FROM lead_account_links lal WHERE lal.lead_id=NEW.lead_id;
        END;

        CREATE TRIGGER trg_v10_contact_compatibility_insert
        AFTER INSERT ON contacts BEGIN
          INSERT INTO people(
            id, display_name, normalized_name, identity_status, legacy_contact_id,
            metadata_json, created_at, updated_at
          ) VALUES (
            'person_legacy:' || NEW.id,
            CASE WHEN length(trim(NEW.name)) > 0 THEN trim(NEW.name) ELSE 'Unresolved legacy contact' END,
            lower(trim(NEW.name)),
            CASE WHEN length(trim(NEW.name)) > 0 THEN 'ASSERTED' ELSE 'UNRESOLVED' END,
            NEW.id, json_object('compatibilityTrigger', 'v10', 'legacyContactId', NEW.id),
            NEW.created_at, NEW.updated_at
          );
          INSERT INTO employments(
            id, person_id, account_id, title, role_family, status, is_current,
            source_url, observed_at, verified_at, expires_at, legacy_contact_id,
            created_at, updated_at
          )
          SELECT 'employment_legacy:' || NEW.id, 'person_legacy:' || NEW.id, lal.account_id,
            nullif(trim(NEW.title), ''), null,
            CASE WHEN NEW.employment_verified_at IS NULL THEN 'UNVERIFIED' ELSE 'STALE' END,
            0, nullif(trim(NEW.source_url), ''),
            coalesce(NEW.employment_verified_at, NEW.updated_at, NEW.created_at),
            NEW.employment_verified_at, NEW.employment_verified_at, NEW.id,
            NEW.created_at, NEW.updated_at
          FROM lead_account_links lal WHERE lal.lead_id=NEW.lead_id;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:email:' || NEW.id || ':' || lower(trim(NEW.email)),
            'person_legacy:' || NEW.id, 'EMAIL', trim(NEW.email), lower(trim(NEW.email)),
            nullif(trim(NEW.source_url), ''),
            CASE NEW.email_status
              WHEN 'VALID' THEN 'VALID' WHEN 'RISKY' THEN 'RISKY'
              WHEN 'INVALID' THEN 'INVALID' ELSE 'UNKNOWN'
            END,
            'UNKNOWN', 0, NEW.created_at, NEW.id,
            '{"legacyImport":true,"sendEligible":false}', NEW.created_at, NEW.updated_at
          WHERE NEW.email IS NOT NULL AND length(trim(NEW.email)) > 0;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:whatsapp:' || NEW.id || ':' ||
              replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
            'person_legacy:' || NEW.id, 'WHATSAPP', trim(NEW.whatsapp),
            replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
            nullif(trim(NEW.source_url), ''), 'UNKNOWN',
            CASE WHEN NEW.whatsapp_opt_in_at IS NULL THEN 'UNKNOWN' ELSE 'OPTED_IN' END,
            0, NEW.created_at, NEW.id, '{"legacyImport":true,"sendEligible":false}',
            NEW.created_at, NEW.updated_at
          WHERE NEW.whatsapp IS NOT NULL AND
            length(replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')) > 0;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:linkedin:' || NEW.id || ':' || lower(trim(NEW.linkedin)),
            'person_legacy:' || NEW.id, 'LINKEDIN', trim(NEW.linkedin), lower(trim(NEW.linkedin)),
            nullif(trim(NEW.source_url), ''), 'UNKNOWN', 'UNKNOWN', 0, NEW.created_at,
            NEW.id, '{"legacyImport":true,"sendEligible":false}', NEW.created_at, NEW.updated_at
          WHERE NEW.linkedin IS NOT NULL AND length(trim(NEW.linkedin)) > 0;
        END;

        CREATE TRIGGER trg_v10_contact_compatibility_update
        AFTER UPDATE OF name, title, email, whatsapp, linkedin, source_url,
          employment_verified_at, email_status, whatsapp_opt_in_at ON contacts BEGIN
          UPDATE people
          SET display_name=CASE WHEN length(trim(NEW.name)) > 0 THEN trim(NEW.name) ELSE display_name END,
              normalized_name=lower(trim(NEW.name)),
              identity_status=CASE WHEN length(trim(NEW.name)) > 0 THEN 'ASSERTED' ELSE 'UNRESOLVED' END,
              updated_at=NEW.updated_at
          WHERE legacy_contact_id=NEW.id;
          UPDATE employments
          SET title=nullif(trim(NEW.title), ''), source_url=nullif(trim(NEW.source_url), ''),
              status=CASE WHEN NEW.employment_verified_at IS NULL THEN 'UNVERIFIED' ELSE 'STALE' END,
              is_current=0,
              observed_at=coalesce(NEW.employment_verified_at, NEW.updated_at, NEW.created_at),
              verified_at=NEW.employment_verified_at, expires_at=NEW.employment_verified_at,
              updated_at=NEW.updated_at
          WHERE legacy_contact_id=NEW.id;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:email:' || NEW.id || ':' || lower(trim(NEW.email)),
            'person_legacy:' || NEW.id, 'EMAIL', trim(NEW.email), lower(trim(NEW.email)),
            nullif(trim(NEW.source_url), ''),
            CASE NEW.email_status
              WHEN 'VALID' THEN 'VALID' WHEN 'RISKY' THEN 'RISKY'
              WHEN 'INVALID' THEN 'INVALID' ELSE 'UNKNOWN'
            END,
            'UNKNOWN', 0, NEW.updated_at, NEW.id,
            '{"legacyImport":true,"sendEligible":false}', NEW.updated_at, NEW.updated_at
          WHERE NEW.email IS NOT NULL AND length(trim(NEW.email)) > 0;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:whatsapp:' || NEW.id || ':' ||
              replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
            'person_legacy:' || NEW.id, 'WHATSAPP', trim(NEW.whatsapp),
            replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''),
            nullif(trim(NEW.source_url), ''), 'UNKNOWN',
            CASE WHEN NEW.whatsapp_opt_in_at IS NULL THEN 'UNKNOWN' ELSE 'OPTED_IN' END,
            0, NEW.updated_at, NEW.id, '{"legacyImport":true,"sendEligible":false}',
            NEW.updated_at, NEW.updated_at
          WHERE NEW.whatsapp IS NOT NULL AND
            length(replace(replace(replace(replace(replace(trim(NEW.whatsapp), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')) > 0;
          INSERT OR IGNORE INTO contact_points(
            id, person_id, kind, value, normalized_value, source_url,
            verification_status, consent_status, send_eligible, observed_at,
            legacy_contact_id, metadata_json, created_at, updated_at
          )
          SELECT 'contact_point_legacy:linkedin:' || NEW.id || ':' || lower(trim(NEW.linkedin)),
            'person_legacy:' || NEW.id, 'LINKEDIN', trim(NEW.linkedin), lower(trim(NEW.linkedin)),
            nullif(trim(NEW.source_url), ''), 'UNKNOWN', 'UNKNOWN', 0, NEW.updated_at,
            NEW.id, '{"legacyImport":true,"sendEligible":false}', NEW.updated_at, NEW.updated_at
          WHERE NEW.linkedin IS NOT NULL AND length(trim(NEW.linkedin)) > 0;
        END;

        CREATE TRIGGER trg_v10_contact_point_legacy_assertion_insert
        AFTER INSERT ON contact_points
        WHEN NEW.legacy_contact_id IS NOT NULL BEGIN
          INSERT OR IGNORE INTO contact_provider_assertions(
            id, provider_id, person_id, contact_point_id, assertion_type, attribute,
            value_hash, source_uri, observed_at, expires_at, confidence, result,
            credit_units, estimated_cost_micros, idempotency_key, created_at
          ) VALUES (
            'contact_assertion_legacy:' || NEW.id, 'provider_legacy_local', NEW.person_id, NEW.id,
            CASE NEW.kind
              WHEN 'EMAIL' THEN 'EMAIL_DISCOVERY'
              WHEN 'LINKEDIN' THEN 'LINKEDIN_PROFILE'
              WHEN 'WHATSAPP' THEN 'PHONE_DISCOVERY'
              ELSE 'OTHER'
            END,
            lower(NEW.kind), null, NEW.source_url, NEW.observed_at, NEW.observed_at,
            CASE WHEN NEW.verification_status IN ('VALID','RISKY') THEN 0.5 ELSE 0.0 END,
            'STALE', 0, 0, 'legacy-contact-point:' || NEW.id, NEW.created_at
          );
        END;
      `);

      if (!legacyCompatibilityReady) this.db.exec(`
        INSERT INTO provider_registry(
          id, provider_key, display_name, provider_kind, status, capabilities_json,
          policy_json, created_at, updated_at
        ) VALUES (
          'provider_legacy_local', 'legacy-local', 'Legacy local compatibility import',
          'LEGACY_IMPORT', 'DISABLED', '[]',
          '{"externalCalls":false,"sendEligible":false}',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
        CREATE TRIGGER trg_play_versions_immutable_update
        BEFORE UPDATE ON play_versions BEGIN
          SELECT RAISE(ABORT, 'play versions are immutable');
        END;
        CREATE TRIGGER trg_play_versions_immutable_delete
        BEFORE DELETE ON play_versions BEGIN
          SELECT RAISE(ABORT, 'play versions are immutable');
        END;
        CREATE TRIGGER trg_dossier_versions_immutable_update
        BEFORE UPDATE ON dossier_versions BEGIN
          SELECT RAISE(ABORT, 'dossier versions are immutable');
        END;
        CREATE TRIGGER trg_dossier_versions_immutable_delete
        BEFORE DELETE ON dossier_versions BEGIN
          SELECT RAISE(ABORT, 'dossier versions are immutable');
        END;
      `);
    });
    this.applyMigration(11, "auditable inbound prospect and approved content lifecycle", () => {
      const addColumn = (table: string, column: string, definition: string): void => {
        const tables = new Set(
          (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        if (!tables.has(table)) return;
        const columns = new Set(
          (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };

      addColumn("inquiry_intakes", "quarantine_decision",
        "TEXT CHECK(quarantine_decision IS NULL OR quarantine_decision IN ('ACCEPTED','REJECTED'))");
      addColumn("inquiry_intakes", "quarantine_reviewed_by", "TEXT");
      addColumn("inquiry_intakes", "quarantine_reviewed_at", "TEXT");
      addColumn("inquiry_intakes", "quarantine_review_reason", "TEXT");
      addColumn("opportunities", "won_quote_id", "TEXT REFERENCES quotes(id) ON DELETE SET NULL");
      addColumn("opportunities", "won_amount_minor", "INTEGER CHECK(won_amount_minor IS NULL OR won_amount_minor >= 0)");
      addColumn("opportunities", "won_currency",
        "TEXT CHECK(won_currency IS NULL OR (length(won_currency)=3 AND won_currency=upper(won_currency)))");
      addColumn("opportunities", "won_gross_margin_bps",
        "INTEGER CHECK(won_gross_margin_bps IS NULL OR won_gross_margin_bps BETWEEN -10000 AND 10000)");
      addColumn("opportunities", "won_by", "TEXT");
      addColumn("quotes", "idempotency_key", "TEXT");
      addColumn("quotes", "expires_at", "TEXT");
      addColumn("quotes", "submitted_at", "TEXT");
      addColumn("quotes", "accepted_at", "TEXT");
      addColumn("quotes", "rejected_at", "TEXT");
      addColumn("quotes", "source_touchpoint_id", "TEXT REFERENCES touchpoints(id) ON DELETE SET NULL");
      addColumn("quotes", "updated_by", "TEXT");

      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_idempotency
          ON quotes(idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS approved_claims (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          claim_key TEXT NOT NULL CHECK(length(trim(claim_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          claim_type TEXT NOT NULL CHECK(length(trim(claim_type)) > 0),
          statement TEXT NOT NULL CHECK(length(trim(statement)) > 0),
          source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
          source_hash TEXT NOT NULL CHECK(length(trim(source_hash)) >= 16),
          visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK(visibility IN ('PUBLIC','PRIVATE')),
          allowed_markets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_markets_json)),
          allowed_channels_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_channels_json)),
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','ENGINEERING_REVIEW','APPROVED','STALE','REVOKED')),
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          submitted_at TEXT,
          approved_by TEXT,
          approved_actor_type TEXT CHECK(approved_actor_type IS NULL OR approved_actor_type='HUMAN'),
          approved_at TEXT,
          expires_at TEXT,
          stale_at TEXT,
          revoked_at TEXT,
          review_reason TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
          UNIQUE(claim_key, version_number),
          UNIQUE(claim_key, content_hash),
          CHECK(status NOT IN ('APPROVED','STALE','REVOKED') OR
            (approved_by IS NOT NULL AND approved_actor_type='HUMAN' AND approved_at IS NOT NULL))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_approved_claims_review
          ON approved_claims(status, claim_type, updated_at);

        CREATE TABLE IF NOT EXISTS content_assets (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          asset_key TEXT NOT NULL UNIQUE CHECK(length(trim(asset_key)) > 0),
          asset_type TEXT NOT NULL CHECK(length(trim(asset_type)) > 0),
          title TEXT NOT NULL CHECK(length(trim(title)) > 0),
          default_locale TEXT NOT NULL CHECK(length(trim(default_locale)) > 0),
          visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK(visibility IN ('PUBLIC','PRIVATE')),
          target_markets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(target_markets_json)),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS content_versions (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          asset_id TEXT NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          locale TEXT NOT NULL CHECK(length(trim(locale)) > 0),
          body TEXT NOT NULL CHECK(length(trim(body)) > 0),
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','TECHNICAL_REVIEW','LOCALIZATION_REVIEW','APPROVED','PUBLISHED','STALE')),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          technical_reviewed_by TEXT,
          technical_reviewed_at TEXT,
          localization_reviewed_by TEXT,
          localization_reviewed_at TEXT,
          approved_by TEXT,
          approved_at TEXT,
          published_by TEXT,
          published_actor_type TEXT CHECK(published_actor_type IS NULL OR published_actor_type='HUMAN'),
          published_at TEXT,
          expires_at TEXT,
          stale_at TEXT,
          review_reason TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
          UNIQUE(asset_id, version_number),
          UNIQUE(asset_id, content_hash),
          CHECK(status!='PUBLISHED' OR
            (published_by IS NOT NULL AND published_actor_type='HUMAN' AND published_at IS NOT NULL))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_content_versions_review
          ON content_versions(status, locale, updated_at);

        CREATE TABLE IF NOT EXISTS content_version_claims (
          content_version_id TEXT NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
          approved_claim_id TEXT NOT NULL REFERENCES approved_claims(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          PRIMARY KEY(content_version_id, approved_claim_id)
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS translations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          content_version_id TEXT NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
          locale TEXT NOT NULL CHECK(length(trim(locale)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          body TEXT NOT NULL CHECK(length(trim(body)) > 0),
          source_hash TEXT NOT NULL CHECK(length(source_hash) >= 16),
          translation_hash TEXT NOT NULL CHECK(length(translation_hash) = 64),
          terminology_snapshot_hash TEXT,
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','LOCALIZATION_REVIEW','APPROVED','STALE','REVOKED')),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          reviewed_by TEXT,
          reviewed_at TEXT,
          approved_by TEXT,
          approved_at TEXT,
          review_reason TEXT,
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
          UNIQUE(content_version_id, locale, version_number),
          UNIQUE(content_version_id, locale, translation_hash),
          CHECK(status NOT IN ('APPROVED','STALE','REVOKED') OR
            (approved_by IS NOT NULL AND approved_at IS NOT NULL))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_translations_review ON translations(status, locale, updated_at);

        CREATE TABLE IF NOT EXISTS terminology_glossary (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          locale TEXT NOT NULL CHECK(length(trim(locale)) > 0),
          source_term TEXT NOT NULL CHECK(length(trim(source_term)) > 0),
          approved_term TEXT NOT NULL CHECK(length(trim(approved_term)) > 0),
          definition TEXT,
          unit_policy TEXT,
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','STALE','REVOKED')),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          approved_by TEXT,
          approved_at TEXT,
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
          UNIQUE(locale, source_term, approved_term)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS content_questions (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          question TEXT NOT NULL CHECK(length(trim(question)) > 0),
          source_type TEXT NOT NULL CHECK(source_type IN ('INQUIRY','LOST_REASON','SALES_QUESTION','OTHER')),
          intake_id TEXT REFERENCES inquiry_intakes(id) ON DELETE SET NULL,
          opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
          content_asset_id TEXT REFERENCES content_assets(id) ON DELETE SET NULL,
          evidence_span TEXT,
          market TEXT,
          locale TEXT,
          priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
          status TEXT NOT NULL DEFAULT 'OPEN'
            CHECK(status IN ('OPEN','PROPOSED','APPROVED','RESOLVED','DISMISSED')),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_content_questions_queue
          ON content_questions(status, priority DESC, created_at);

        CREATE TABLE IF NOT EXISTS inbound_prospects (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          intake_id TEXT NOT NULL UNIQUE REFERENCES inquiry_intakes(id) ON DELETE RESTRICT,
          account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
          content_asset_id TEXT REFERENCES content_assets(id) ON DELETE SET NULL,
          full_name TEXT,
          company_name TEXT,
          work_email TEXT,
          phone TEXT,
          country_code TEXT,
          product_interest TEXT,
          application TEXT,
          landing TEXT,
          referrer TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          consent_status TEXT NOT NULL DEFAULT 'UNKNOWN'
            CHECK(consent_status IN ('UNKNOWN','OPTED_IN','OPTED_OUT')),
          prospect_status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
            CHECK(prospect_status IN ('PENDING_VERIFICATION','VERIFIED','MERGED','REJECTED')),
          send_eligible INTEGER NOT NULL DEFAULT 0 CHECK(send_eligible=0),
          accepted_by TEXT NOT NULL CHECK(length(trim(accepted_by)) > 0),
          accepted_at TEXT NOT NULL CHECK(length(accepted_at) >= 20),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_inbound_prospects_status
          ON inbound_prospects(prospect_status, accepted_at);

        CREATE TABLE IF NOT EXISTS inbound_message_links (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          intake_id TEXT NOT NULL REFERENCES inquiry_intakes(id) ON DELETE CASCADE,
          inbound_message_id TEXT,
          outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE SET NULL,
          correlation_method TEXT NOT NULL CHECK(length(trim(correlation_method)) > 0),
          correlation_confidence REAL NOT NULL CHECK(correlation_confidence BETWEEN 0 AND 1),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          CHECK(inbound_message_id IS NOT NULL OR outbound_message_id IS NOT NULL)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_inbound_message_links_intake ON inbound_message_links(intake_id);
        CREATE INDEX IF NOT EXISTS idx_inbound_message_links_inbound ON inbound_message_links(inbound_message_id);
        CREATE INDEX IF NOT EXISTS idx_inbound_message_links_outbound ON inbound_message_links(outbound_message_id);

        CREATE TRIGGER IF NOT EXISTS trg_approved_claim_status_transition
        BEFORE UPDATE OF status ON approved_claims
        WHEN OLD.status != NEW.status AND NOT (
          (OLD.status='DRAFT' AND NEW.status='ENGINEERING_REVIEW') OR
          (OLD.status='ENGINEERING_REVIEW' AND NEW.status='APPROVED') OR
          (OLD.status='APPROVED' AND NEW.status IN ('STALE','REVOKED'))
        ) BEGIN
          SELECT RAISE(ABORT, 'invalid approved claim status transition');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_approved_claim_version_immutable
        BEFORE UPDATE OF claim_key, version_number, claim_type, statement, source_document_id,
          source_hash, visibility, allowed_markets_json, allowed_channels_json, content_hash
        ON approved_claims BEGIN
          SELECT RAISE(ABORT, 'approved claim versions are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_content_version_status_transition
        BEFORE UPDATE OF status ON content_versions
        WHEN OLD.status != NEW.status AND NOT (
          (OLD.status='DRAFT' AND NEW.status='TECHNICAL_REVIEW') OR
          (OLD.status='TECHNICAL_REVIEW' AND NEW.status='LOCALIZATION_REVIEW') OR
          (OLD.status='LOCALIZATION_REVIEW' AND NEW.status='APPROVED') OR
          (OLD.status='APPROVED' AND NEW.status='PUBLISHED') OR
          (OLD.status IN ('APPROVED','PUBLISHED') AND NEW.status='STALE')
        ) BEGIN
          SELECT RAISE(ABORT, 'invalid content version status transition');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_content_version_body_immutable
        BEFORE UPDATE OF asset_id, version_number, locale, body, content_hash
        ON content_versions BEGIN
          SELECT RAISE(ABORT, 'content versions are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_content_version_human_publish
        BEFORE UPDATE OF status ON content_versions
        WHEN NEW.status='PUBLISHED' AND (
          NEW.published_by IS NULL OR NEW.published_actor_type IS NOT 'HUMAN' OR NEW.published_at IS NULL
        ) BEGIN
          SELECT RAISE(ABORT, 'content publication requires an authorized human');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_translation_status_transition
        BEFORE UPDATE OF status ON translations
        WHEN OLD.status != NEW.status AND NOT (
          (OLD.status='DRAFT' AND NEW.status='LOCALIZATION_REVIEW') OR
          (OLD.status='LOCALIZATION_REVIEW' AND NEW.status='APPROVED') OR
          (OLD.status='APPROVED' AND NEW.status IN ('STALE','REVOKED'))
        ) BEGIN
          SELECT RAISE(ABORT, 'invalid translation status transition');
        END;

        CREATE VIEW IF NOT EXISTS externally_usable_approved_claims AS
          SELECT * FROM approved_claims
          WHERE visibility='PUBLIC' AND status='APPROVED'
            AND approved_by IS NOT NULL AND approved_actor_type='HUMAN' AND approved_at IS NOT NULL
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

        CREATE VIEW IF NOT EXISTS externally_usable_content_versions AS
          SELECT cv.* FROM content_versions cv
          JOIN content_assets ca ON ca.id=cv.asset_id
          WHERE ca.visibility='PUBLIC' AND cv.status IN ('APPROVED','PUBLISHED')
            AND cv.approved_by IS NOT NULL AND cv.approved_at IS NOT NULL
            AND (cv.expires_at IS NULL OR cv.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            AND NOT EXISTS (
              SELECT 1 FROM content_version_claims cvc
              LEFT JOIN externally_usable_approved_claims claim ON claim.id=cvc.approved_claim_id
              WHERE cvc.content_version_id=cv.id AND claim.id IS NULL
            );
      `);
    });
    this.applyMigration(12, "versioned acquisition planning and learning ledger", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS campaign_briefs (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          brief_key TEXT NOT NULL UNIQUE CHECK(length(trim(brief_key)) > 0),
          current_version_id TEXT,
          status TEXT NOT NULL DEFAULT 'PLAN_DRAFT' CHECK(status IN (
            'PLAN_DRAFT','PLAN_NEEDS_INPUT','PLAN_APPROVED','BUDGET_PENDING','BUDGET_APPROVED',
            'QUEUED','RESEARCHING','SHADOW_COMPLETE','READY_FOR_SEND_EXPERIMENT','CANCELLED')),
          shadow_authorized INTEGER NOT NULL DEFAULT 0 CHECK(shadow_authorized IN (0,1)),
          provider_budget_authorized INTEGER NOT NULL DEFAULT 0 CHECK(provider_budget_authorized IN (0,1)),
          external_send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(external_send_authorized IN (0,1)),
          content_publish_authorized INTEGER NOT NULL DEFAULT 0 CHECK(content_publish_authorized IN (0,1)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS campaign_versions (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          brief_id TEXT NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          brief_json TEXT NOT NULL CHECK(json_valid(brief_json)),
          brief_hash TEXT NOT NULL CHECK(length(brief_hash)=64),
          parser_version TEXT,
          source_text_hash TEXT CHECK(source_text_hash IS NULL OR length(source_text_hash)>=16),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          external_actions_authorized INTEGER NOT NULL DEFAULT 0 CHECK(external_actions_authorized=0),
          send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(send_authorized=0),
          publish_authorized INTEGER NOT NULL DEFAULT 0 CHECK(publish_authorized=0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(brief_id, version_number),
          UNIQUE(brief_id, brief_hash)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_campaign_versions_brief ON campaign_versions(brief_id, version_number DESC);

        CREATE TABLE IF NOT EXISTS campaign_approvals (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          brief_id TEXT NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
          version_id TEXT NOT NULL REFERENCES campaign_versions(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK(scope IN (
            'SHADOW_PLAN','PROVIDER_BUDGET','EXTERNAL_SEND','CONTENT_PUBLICATION')),
          action_id TEXT NOT NULL UNIQUE CHECK(length(trim(action_id)) > 0),
          brief_hash TEXT NOT NULL CHECK(length(brief_hash)=64),
          budget_hash TEXT CHECK(budget_hash IS NULL OR length(budget_hash)=64),
          approved_by TEXT NOT NULL CHECK(length(trim(approved_by)) > 0),
          approved_actor_type TEXT NOT NULL CHECK(approved_actor_type='HUMAN'),
          authorization_source TEXT NOT NULL CHECK(length(trim(authorization_source)) > 0),
          reason TEXT,
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(version_id, scope)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_campaign_approvals_current ON campaign_approvals(brief_id, version_id, scope);

        CREATE TABLE IF NOT EXISTS campaign_forecasts (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          version_id TEXT NOT NULL REFERENCES campaign_versions(id) ON DELETE CASCADE,
          forecast_json TEXT NOT NULL CHECK(json_valid(forecast_json)),
          basis TEXT NOT NULL CHECK(length(trim(basis)) > 0),
          sample_size INTEGER NOT NULL DEFAULT 0 CHECK(sample_size >= 0),
          uncertainty TEXT NOT NULL CHECK(length(trim(uncertainty)) > 0),
          reliable INTEGER NOT NULL DEFAULT 0 CHECK(reliable IN (0,1)),
          forecast_hash TEXT NOT NULL CHECK(length(forecast_hash)=64),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(version_id, forecast_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS budget_reservations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          version_id TEXT NOT NULL REFERENCES campaign_versions(id) ON DELETE CASCADE,
          budget_type TEXT NOT NULL CHECK(budget_type IN ('PROVIDER','LLM','RESEARCH','OTHER')),
          provider_key TEXT,
          reserved_units REAL NOT NULL DEFAULT 0 CHECK(reserved_units >= 0),
          reserved_amount_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_amount_micros >= 0),
          currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency)=3 AND currency=upper(currency)),
          status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK(status IN ('PENDING','APPROVED','RELEASED','CONSUMED','EXPIRED','CANCELLED')),
          authorized INTEGER NOT NULL DEFAULT 0 CHECK(authorized IN (0,1)),
          authorized_by TEXT,
          authorized_at TEXT,
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          updated_at TEXT NOT NULL CHECK(length(updated_at) >= 20),
          CHECK(authorized=0 OR (authorized_by IS NOT NULL AND authorized_at IS NOT NULL))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS parse_feedback (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          brief_id TEXT REFERENCES campaign_briefs(id) ON DELETE CASCADE,
          version_id TEXT REFERENCES campaign_versions(id) ON DELETE SET NULL,
          source_text_hash TEXT NOT NULL CHECK(length(source_text_hash)>=16),
          parser_version TEXT NOT NULL CHECK(length(trim(parser_version)) > 0),
          field_path TEXT,
          feedback_type TEXT NOT NULL CHECK(feedback_type IN (
            'CORRECTION','MISSING_FIELD','WRONG_SEGMENT','WRONG_ROLE','WRONG_TRANSPORT','OTHER')),
          feedback_json TEXT NOT NULL CHECK(json_valid(feedback_json)),
          provided_by TEXT NOT NULL CHECK(length(trim(provided_by)) > 0),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;

        CREATE VIEW IF NOT EXISTS campaign_budget_reservations AS SELECT * FROM budget_reservations;
        CREATE VIEW IF NOT EXISTS campaign_parse_feedback AS SELECT * FROM parse_feedback;

        CREATE TABLE IF NOT EXISTS market_opportunity_snapshots (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          country TEXT NOT NULL CHECK(length(trim(country))=2 AND country=upper(country)),
          product_family TEXT NOT NULL CHECK(length(trim(product_family)) > 0),
          period TEXT NOT NULL CHECK(length(trim(period)) > 0),
          policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
          score REAL,
          confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
          evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_ids_json)),
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
          snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
          publication_authorized INTEGER NOT NULL DEFAULT 0 CHECK(publication_authorized=0),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(country, product_family, period, policy_version, snapshot_hash)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_market_snapshot_scope
          ON market_opportunity_snapshots(country, product_family, period);

        CREATE TABLE IF NOT EXISTS market_evidence (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          country TEXT NOT NULL CHECK(length(trim(country))=2 AND country=upper(country)),
          period TEXT NOT NULL CHECK(length(trim(period)) > 0),
          hs_revision TEXT NOT NULL CHECK(length(trim(hs_revision)) > 0),
          metric TEXT NOT NULL CHECK(length(trim(metric)) > 0),
          value REAL,
          unit TEXT NOT NULL CHECK(length(trim(unit)) > 0),
          source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
          authority TEXT NOT NULL CHECK(length(trim(authority)) > 0),
          retrieved_at TEXT NOT NULL CHECK(length(retrieved_at) >= 20),
          content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
          confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
          license TEXT NOT NULL CHECK(length(trim(license)) > 0),
          human_review TEXT NOT NULL CHECK(human_review IN ('APPROVED','PENDING','REJECTED')),
          expires_at TEXT NOT NULL CHECK(length(expires_at) >= 20),
          record_hash TEXT NOT NULL CHECK(length(record_hash)=64),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_market_evidence_scope ON market_evidence(country, metric, expires_at);

        CREATE TABLE IF NOT EXISTS hs_code_candidates (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          candidate_key TEXT NOT NULL CHECK(length(trim(candidate_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          country TEXT NOT NULL CHECK(length(trim(country))=2 AND country=upper(country)),
          product_family TEXT NOT NULL CHECK(length(trim(product_family)) > 0),
          hs_revision TEXT NOT NULL CHECK(length(trim(hs_revision)) > 0),
          code TEXT NOT NULL CHECK(length(trim(code)) BETWEEN 4 AND 10),
          status TEXT NOT NULL DEFAULT 'CANDIDATE'
            CHECK(status IN ('CANDIDATE','HUMAN_CONFIRMED','REJECTED','STALE')),
          proposed_by TEXT NOT NULL CHECK(length(trim(proposed_by)) > 0),
          confirmed_by TEXT,
          confirmed_actor_type TEXT CHECK(confirmed_actor_type IS NULL OR confirmed_actor_type='HUMAN'),
          confirmed_at TEXT,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_ids_json)),
          version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
          publication_authorized INTEGER NOT NULL DEFAULT 0 CHECK(publication_authorized=0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(candidate_key, version_number),
          UNIQUE(candidate_key, version_hash),
          CHECK(status!='HUMAN_CONFIRMED' OR
            (confirmed_by IS NOT NULL AND confirmed_actor_type='HUMAN' AND confirmed_at IS NOT NULL))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS regulatory_requirements (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          requirement_key TEXT NOT NULL CHECK(length(trim(requirement_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          country TEXT NOT NULL CHECK(length(trim(country))=2 AND country=upper(country)),
          product_family TEXT NOT NULL CHECK(length(trim(product_family)) > 0),
          requirement_type TEXT NOT NULL CHECK(length(trim(requirement_type)) > 0),
          statement TEXT NOT NULL CHECK(length(trim(statement)) > 0),
          evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_ids_json)),
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','COMPLIANCE_REVIEW','APPROVED','STALE','REVOKED')),
          approved_by TEXT,
          approved_actor_type TEXT CHECK(approved_actor_type IS NULL OR approved_actor_type='HUMAN'),
          approved_at TEXT,
          expires_at TEXT,
          version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
          publication_authorized INTEGER NOT NULL DEFAULT 0 CHECK(publication_authorized=0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(requirement_key, version_number),
          UNIQUE(requirement_key, version_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS offer_playbooks (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          offer_key TEXT NOT NULL CHECK(length(trim(offer_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          product_family TEXT NOT NULL CHECK(length(trim(product_family)) > 0),
          target_markets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(target_markets_json)),
          playbook_json TEXT NOT NULL CHECK(json_valid(playbook_json)),
          approved_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(approved_claim_ids_json)),
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','ENGINEERING_REVIEW','APPROVED','STALE','REVOKED')),
          approved_by TEXT,
          approved_at TEXT,
          version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
          publication_authorized INTEGER NOT NULL DEFAULT 0 CHECK(publication_authorized=0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(offer_key, version_number),
          UNIQUE(offer_key, version_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS play_allocations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
          snapshot_id TEXT REFERENCES market_opportunity_snapshots(id) ON DELETE SET NULL,
          policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
          recommended_units INTEGER NOT NULL CHECK(recommended_units >= 0),
          recommended_share REAL NOT NULL CHECK(recommended_share BETWEEN 0 AND 1),
          recommendation TEXT NOT NULL CHECK(length(trim(recommendation)) > 0),
          reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reasons_json)),
          suggestion_hash TEXT NOT NULL CHECK(length(suggestion_hash)=64),
          applied INTEGER NOT NULL DEFAULT 0 CHECK(applied=0),
          requires_human_approval INTEGER NOT NULL DEFAULT 1 CHECK(requires_human_approval=1),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_play_allocations_review ON play_allocations(play_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS personalization_plans (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          plan_key TEXT NOT NULL CHECK(length(trim(plan_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
          enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
          legacy_lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
          legacy_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
          qualification_track TEXT NOT NULL CHECK(qualification_track IN ('ACTIVE_INTENT','ICP_FIT','WATCHLIST')),
          qualification_policy_version TEXT NOT NULL CHECK(length(trim(qualification_policy_version)) > 0),
          dossier_version_id TEXT REFERENCES dossier_versions(id) ON DELETE SET NULL,
          seller_fact_set_version TEXT NOT NULL CHECK(length(trim(seller_fact_set_version)) > 0),
          locale TEXT NOT NULL CHECK(length(trim(locale)) > 0),
          plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
          fact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(fact_ids_json)),
          plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','VALID','NEEDS_REWRITE','SUPERSEDED')),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(plan_key, version_number),
          UNIQUE(plan_key, plan_hash),
          CHECK((account_id IS NOT NULL) + (legacy_lead_id IS NOT NULL) >= 1)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS message_versions (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          message_key TEXT NOT NULL CHECK(length(trim(message_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE SET NULL,
          personalization_plan_id TEXT NOT NULL REFERENCES personalization_plans(id) ON DELETE RESTRICT,
          subject TEXT NOT NULL,
          body TEXT NOT NULL CHECK(length(trim(body)) > 0),
          destination TEXT NOT NULL CHECK(length(trim(destination)) > 0),
          sequence_index INTEGER NOT NULL DEFAULT 0 CHECK(sequence_index >= 0),
          generation_mode TEXT NOT NULL CHECK(length(trim(generation_mode)) > 0),
          prompt_version TEXT NOT NULL CHECK(length(trim(prompt_version)) > 0),
          model TEXT NOT NULL CHECK(length(trim(model)) > 0),
          template_version TEXT NOT NULL CHECK(length(trim(template_version)) > 0),
          lint_version TEXT NOT NULL CHECK(length(trim(lint_version)) > 0),
          lint_result_json TEXT NOT NULL CHECK(json_valid(lint_result_json)),
          angle TEXT NOT NULL,
          locale TEXT NOT NULL CHECK(length(trim(locale)) > 0),
          experiment_variant TEXT,
          dossier_version_id TEXT REFERENCES dossier_versions(id) ON DELETE SET NULL,
          seller_fact_set_version TEXT NOT NULL CHECK(length(trim(seller_fact_set_version)) > 0),
          fact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(fact_ids_json)),
          content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
          review_hash TEXT NOT NULL CHECK(length(review_hash)=64),
          status TEXT NOT NULL DEFAULT 'NEEDS_REWRITE' CHECK(status IN (
            'GENERATED','NEEDS_REWRITE','LINT_FAILED','PENDING_APPROVAL','APPROVED','SUPERSEDED')),
          send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(send_authorized=0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          superseded_at TEXT,
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(message_key, version_number),
          UNIQUE(message_key, review_hash)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_message_versions_review ON message_versions(status, created_at);

        CREATE TABLE IF NOT EXISTS message_fact_links (
          message_version_id TEXT NOT NULL REFERENCES message_versions(id) ON DELETE CASCADE,
          fact_type TEXT NOT NULL CHECK(fact_type IN ('EVIDENCE_FACT','APPROVED_CLAIM','SELLER_FACT','OTHER')),
          fact_id TEXT NOT NULL CHECK(length(trim(fact_id)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          PRIMARY KEY(message_version_id, fact_type, fact_id)
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          experiment_key TEXT NOT NULL CHECK(length(trim(experiment_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          hypothesis TEXT NOT NULL CHECK(length(trim(hypothesis)) > 0),
          primary_variable TEXT NOT NULL CHECK(length(trim(primary_variable)) > 0),
          arms_json TEXT NOT NULL CHECK(json_valid(arms_json)),
          allocation_salt TEXT NOT NULL CHECK(length(trim(allocation_salt)) >= 8),
          definition_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(definition_json)),
          definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64),
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','SHADOW','APPROVED','ACTIVE','PAUSED','COMPLETE','KILLED')),
          external_send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(external_send_authorized=0),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(experiment_key, version_number),
          UNIQUE(experiment_key, definition_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS experiment_assignments (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
          experiment_key TEXT NOT NULL CHECK(length(trim(experiment_key)) > 0),
          subject_type TEXT NOT NULL CHECK(length(trim(subject_type)) > 0),
          subject_id TEXT NOT NULL CHECK(length(trim(subject_id)) > 0),
          arm TEXT NOT NULL CHECK(length(trim(arm)) > 0),
          assignment_hash TEXT NOT NULL CHECK(length(assignment_hash)=64),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(experiment_key, subject_type, subject_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_experiment_assignments_arm ON experiment_assignments(experiment_id, arm);

        CREATE TABLE IF NOT EXISTS experiment_outcomes (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id) ON DELETE CASCADE,
          outcome_type TEXT NOT NULL CHECK(length(trim(outcome_type)) > 0),
          outcome_value REAL,
          occurred_at TEXT NOT NULL CHECK(length(occurred_at) >= 20),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS signal_observations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
          source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
          signal_type TEXT NOT NULL CHECK(length(trim(signal_type)) > 0),
          source_url TEXT NOT NULL CHECK(length(trim(source_url)) > 0),
          exact_quote TEXT NOT NULL CHECK(length(trim(exact_quote)) > 0),
          published_at TEXT,
          observed_at TEXT NOT NULL CHECK(length(observed_at) >= 20),
          expires_at TEXT,
          confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
          authority_class TEXT NOT NULL CHECK(length(trim(authority_class)) > 0),
          entity_match TEXT NOT NULL CHECK(entity_match IN ('MATCHED','AMBIGUOUS','REJECTED')),
          status TEXT NOT NULL DEFAULT 'OBSERVED' CHECK(status IN ('OBSERVED','VALID','STALE','REJECTED')),
          observation_hash TEXT NOT NULL CHECK(length(observation_hash)=64),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_signal_observations_account
          ON signal_observations(account_id, signal_type, observed_at DESC);

        CREATE TABLE IF NOT EXISTS rule_versions (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          rule_key TEXT NOT NULL CHECK(length(trim(rule_key)) > 0),
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          condition_json TEXT NOT NULL CHECK(json_valid(condition_json)),
          actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
          version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SHADOW','APPROVED','STALE','REVOKED')),
          created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(rule_key, version_number),
          UNIQUE(rule_key, version_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS manual_engagement_events (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
          contact_point_id TEXT REFERENCES contact_points(id) ON DELETE SET NULL,
          play_id TEXT REFERENCES plays(id) ON DELETE SET NULL,
          enrollment_id TEXT REFERENCES play_enrollments(id) ON DELETE SET NULL,
          message_version_id TEXT REFERENCES message_versions(id) ON DELETE SET NULL,
          channel TEXT NOT NULL CHECK(channel IN ('LINKEDIN','CALL','EMAIL','WHATSAPP','OTHER')),
          event_type TEXT NOT NULL CHECK(length(trim(event_type)) > 0),
          direction TEXT NOT NULL DEFAULT 'NONE' CHECK(direction IN ('INBOUND','OUTBOUND','NONE')),
          outcome TEXT,
          occurred_at TEXT NOT NULL CHECK(length(occurred_at) >= 20),
          external_reference TEXT,
          duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds >= 0),
          notes TEXT,
          manual_actor TEXT NOT NULL CHECK(length(trim(manual_actor)) > 0),
          actor_type TEXT NOT NULL CHECK(actor_type='HUMAN'),
          external_write_performed INTEGER NOT NULL DEFAULT 0 CHECK(external_write_performed=0),
          event_hash TEXT NOT NULL CHECK(length(event_hash)=64),
          idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_manual_engagement_timeline
          ON manual_engagement_events(account_id, occurred_at DESC);

        CREATE TRIGGER IF NOT EXISTS trg_campaign_versions_immutable_update
        BEFORE UPDATE ON campaign_versions BEGIN
          SELECT RAISE(ABORT, 'campaign versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_versions_immutable_delete
        BEFORE DELETE ON campaign_versions BEGIN
          SELECT RAISE(ABORT, 'campaign versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_approvals_immutable_update
        BEFORE UPDATE ON campaign_approvals BEGIN
          SELECT RAISE(ABORT, 'campaign approvals are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_approvals_immutable_delete
        BEFORE DELETE ON campaign_approvals BEGIN
          SELECT RAISE(ABORT, 'campaign approvals are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_market_snapshots_immutable_update
        BEFORE UPDATE ON market_opportunity_snapshots BEGIN
          SELECT RAISE(ABORT, 'market snapshots are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_market_evidence_immutable_update
        BEFORE UPDATE ON market_evidence BEGIN
          SELECT RAISE(ABORT, 'market evidence is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_play_allocations_suggestion_only
        BEFORE UPDATE ON play_allocations BEGIN
          SELECT RAISE(ABORT, 'play allocation suggestions are immutable and cannot be applied automatically');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_personalization_plans_immutable_update
        BEFORE UPDATE ON personalization_plans BEGIN
          SELECT RAISE(ABORT, 'personalization plan versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_message_versions_immutable_update
        BEFORE UPDATE ON message_versions BEGIN
          SELECT RAISE(ABORT, 'message versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_experiments_immutable_update
        BEFORE UPDATE ON experiments BEGIN
          SELECT RAISE(ABORT, 'experiment versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_experiment_assignments_immutable_update
        BEFORE UPDATE ON experiment_assignments BEGIN
          SELECT RAISE(ABORT, 'experiment assignments are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_signal_observations_immutable_update
        BEFORE UPDATE ON signal_observations BEGIN
          SELECT RAISE(ABORT, 'signal observations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_rule_versions_immutable_update
        BEFORE UPDATE ON rule_versions BEGIN
          SELECT RAISE(ABORT, 'rule versions are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_rule_versions_allowed_actions_insert
        BEFORE INSERT ON rule_versions
        WHEN EXISTS (
          SELECT 1 FROM json_each(NEW.actions_json)
          WHERE value NOT IN (
            'ENQUEUE_ACCOUNT_RESEARCH','REVERIFY_EMPLOYMENT','REVERIFY_CONTACT_POINT',
            'CREATE_MANUAL_CALL_TASK','CREATE_MANUAL_LINKEDIN_TASK','CREATE_MANUAL_EMAIL_TASK',
            'NOTIFY_OWNER','FREEZE_OUTREACH','MOVE_TO_WATCHLIST'))
        BEGIN
          SELECT RAISE(ABORT, 'rule action is not allowlisted');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_manual_engagement_events_immutable_update
        BEFORE UPDATE ON manual_engagement_events BEGIN
          SELECT RAISE(ABORT, 'manual engagement events are immutable');
        END;
      `);

      const immutableDeleteTables = [
        "campaign_forecasts",
        "parse_feedback",
        "market_opportunity_snapshots",
        "market_evidence",
        "hs_code_candidates",
        "regulatory_requirements",
        "offer_playbooks",
        "play_allocations",
        "personalization_plans",
        "message_versions",
        "message_fact_links",
        "experiments",
        "experiment_assignments",
        "experiment_outcomes",
        "signal_observations",
        "rule_versions",
        "manual_engagement_events",
      ] as const;
      for (const table of immutableDeleteTables) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_v12_${table}_immutable_delete
          BEFORE DELETE ON ${table} BEGIN
            SELECT RAISE(ABORT, '${table} records are immutable');
          END;
        `);
      }
      const missingImmutableUpdateTables = [
        "campaign_forecasts",
        "parse_feedback",
        "hs_code_candidates",
        "regulatory_requirements",
        "offer_playbooks",
        "message_fact_links",
        "experiment_outcomes",
      ] as const;
      for (const table of missingImmutableUpdateTables) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_v12_${table}_immutable_update
          BEFORE UPDATE ON ${table} BEGIN
            SELECT RAISE(ABORT, '${table} records are immutable');
          END;
        `);
      }

      const outboundTables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (outboundTables.has("outbound_messages")) {
        const outboundColumns = new Set(
          (this.db.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        if (!outboundColumns.has("current_version_id")) {
          this.db.exec("ALTER TABLE outbound_messages ADD COLUMN current_version_id TEXT REFERENCES message_versions(id) ON DELETE SET NULL");
        }
      }
    });
    this.applyMigration(13, "local grounded message review decisions", () => this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_versions_review_identity
        ON message_versions(id, review_hash, content_hash);

      CREATE TABLE IF NOT EXISTS message_review_cards (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        message_version_id TEXT NOT NULL,
        review_hash TEXT NOT NULL CHECK(length(review_hash)=64),
        content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
        issued_at TEXT NOT NULL CHECK(length(issued_at) >= 20),
        expires_at TEXT NOT NULL CHECK(length(expires_at) >= 20 AND expires_at > issued_at),
        external_send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(external_send_authorized=0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        FOREIGN KEY(message_version_id, review_hash, content_hash)
          REFERENCES message_versions(id, review_hash, content_hash) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_message_review_cards_active
        ON message_review_cards(message_version_id, review_hash, expires_at);

      CREATE TABLE IF NOT EXISTS message_review_decisions (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        review_card_id TEXT NOT NULL UNIQUE REFERENCES message_review_cards(id) ON DELETE RESTRICT,
        message_version_id TEXT NOT NULL UNIQUE,
        review_hash TEXT NOT NULL CHECK(length(review_hash)=64),
        content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
        decision TEXT NOT NULL CHECK(decision IN ('APPROVE_CONTENT','NEEDS_REWRITE')),
        derived_status TEXT NOT NULL CHECK(derived_status IN ('APPROVED','NEEDS_REWRITE')),
        action_id TEXT NOT NULL UNIQUE CHECK(length(trim(action_id)) > 0),
        actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
        actor_type TEXT NOT NULL CHECK(actor_type='HUMAN'),
        actor_role TEXT NOT NULL CHECK(actor_role='MESSAGE_REVIEWER'),
        reason TEXT NOT NULL DEFAULT '',
        external_send_authorized INTEGER NOT NULL DEFAULT 0 CHECK(external_send_authorized=0),
        created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
        CHECK((decision='APPROVE_CONTENT' AND derived_status='APPROVED')
          OR (decision='NEEDS_REWRITE' AND derived_status='NEEDS_REWRITE')),
        FOREIGN KEY(message_version_id, review_hash, content_hash)
          REFERENCES message_versions(id, review_hash, content_hash) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_message_review_decisions_status
        ON message_review_decisions(derived_status, created_at);

      CREATE VIEW IF NOT EXISTS grounded_message_review_states AS
      SELECT mv.id AS message_version_id,
        mv.message_key,
        mv.version_number,
        mv.review_hash,
        mv.content_hash,
        mv.status AS persisted_status,
        coalesce(d.derived_status, mv.status) AS derived_status,
        d.decision,
        d.id AS decision_id,
        d.action_id,
        d.actor,
        d.created_at AS reviewed_at,
        0 AS external_send_authorized
      FROM message_versions mv
      LEFT JOIN message_review_decisions d ON d.message_version_id=mv.id;

      CREATE TRIGGER IF NOT EXISTS trg_message_review_cards_grounded_insert
      BEFORE INSERT ON message_review_cards
      WHEN NOT EXISTS (
        SELECT 1 FROM message_versions mv
        JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
        WHERE mv.id=NEW.message_version_id
          AND mv.review_hash=NEW.review_hash
          AND mv.content_hash=NEW.content_hash
          AND mv.status='PENDING_APPROVAL'
          AND mv.send_authorized=0
          AND pp.status='VALID'
          AND pp.qualification_track IN ('ACTIVE_INTENT','ICP_FIT')
          AND json_extract(mv.lint_result_json, '$.passed')=1
          AND lower(mv.generation_mode) NOT LIKE '%generic%'
          AND lower(mv.generation_mode) NOT LIKE '%fallback%'
          AND lower(mv.generation_mode) NOT LIKE '%diagnostic%'
      )
      BEGIN
        SELECT RAISE(ABORT, 'only a grounded pending message version can receive a review card');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_review_decisions_current_insert
      BEFORE INSERT ON message_review_decisions
      WHEN NOT EXISTS (
        SELECT 1
        FROM message_review_cards rc
        JOIN message_versions mv ON mv.id=rc.message_version_id
        WHERE rc.id=NEW.review_card_id
          AND rc.message_version_id=NEW.message_version_id
          AND rc.review_hash=NEW.review_hash
          AND rc.content_hash=NEW.content_hash
          AND rc.expires_at>NEW.created_at
          AND mv.status='PENDING_APPROVAL'
          AND mv.send_authorized=0
          AND NOT EXISTS (
            SELECT 1 FROM message_versions newer
            WHERE newer.message_key=mv.message_key AND newer.version_number>mv.version_number
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'message review card is stale, expired, or not pending');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_message_review_cards_immutable_update
      BEFORE UPDATE ON message_review_cards BEGIN
        SELECT RAISE(ABORT, 'message review cards are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_review_cards_immutable_delete
      BEFORE DELETE ON message_review_cards BEGIN
        SELECT RAISE(ABORT, 'message review cards are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_review_decisions_immutable_update
      BEFORE UPDATE ON message_review_decisions BEGIN
        SELECT RAISE(ABORT, 'message review decisions are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_review_decisions_immutable_delete
      BEFORE DELETE ON message_review_decisions BEGIN
        SELECT RAISE(ABORT, 'message review decisions are immutable');
      END;
    `));
    this.applyMigration(14, "campaign autonomous send authorization ledger", () => {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_message_versions_review_identity
          ON message_versions(id, review_hash, content_hash);

        CREATE TABLE IF NOT EXISTS campaign_provider_bindings (
          campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
          brief_id TEXT NOT NULL REFERENCES campaign_briefs(id) ON DELETE RESTRICT,
          version_id TEXT NOT NULL UNIQUE REFERENCES campaign_versions(id) ON DELETE RESTRICT,
          brief_hash TEXT NOT NULL CHECK(length(brief_hash)=64),
          bound_by TEXT NOT NULL CHECK(length(trim(bound_by)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS provider_response_cache (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          provider_run_id TEXT NOT NULL REFERENCES provider_runs(id) ON DELETE RESTRICT,
          provider_attempt_id TEXT NOT NULL UNIQUE REFERENCES provider_attempts(id) ON DELETE RESTRICT,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
          version_id TEXT NOT NULL REFERENCES campaign_versions(id) ON DELETE RESTRICT,
          provider_id TEXT NOT NULL REFERENCES provider_registry(id) ON DELETE RESTRICT,
          request_hash TEXT NOT NULL CHECK(length(request_hash) >= 16),
          response_json TEXT NOT NULL CHECK(json_valid(response_json)),
          response_hash TEXT NOT NULL CHECK(length(response_hash) >= 16),
          expires_at TEXT NOT NULL CHECK(length(expires_at) >= 20),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_provider_response_cache_lookup
          ON provider_response_cache(campaign_id, version_id, provider_id, request_hash, expires_at);

        CREATE TABLE IF NOT EXISTS campaign_send_authorizations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          campaign_approval_id TEXT NOT NULL REFERENCES campaign_approvals(id) ON DELETE RESTRICT,
          brief_id TEXT NOT NULL REFERENCES campaign_briefs(id) ON DELETE RESTRICT,
          version_id TEXT NOT NULL REFERENCES campaign_versions(id) ON DELETE RESTRICT,
          brief_hash TEXT NOT NULL CHECK(length(brief_hash)=64),
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
          market TEXT NOT NULL CHECK(length(trim(market)) > 0),
          transport TEXT NOT NULL CHECK(transport='SMTP'),
          total_limit INTEGER NOT NULL CHECK(total_limit > 0),
          daily_limit INTEGER NOT NULL CHECK(daily_limit > 0 AND daily_limit <= total_limit),
          hourly_limit INTEGER NOT NULL CHECK(hourly_limit > 0 AND hourly_limit <= daily_limit),
          maximum_sequence_index INTEGER NOT NULL DEFAULT 0 CHECK(maximum_sequence_index=0),
          valid_from TEXT NOT NULL CHECK(length(valid_from) >= 20),
          expires_at TEXT NOT NULL CHECK(length(expires_at) >= 20 AND expires_at > valid_from),
          policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
          policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
          policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
          action_id TEXT NOT NULL UNIQUE CHECK(length(trim(action_id)) > 0),
          authorized_by TEXT NOT NULL CHECK(length(trim(authorized_by)) > 0),
          authorized_actor_type TEXT NOT NULL CHECK(authorized_actor_type='HUMAN'),
          authorization_source TEXT NOT NULL CHECK(length(trim(authorization_source)) > 0),
          reason TEXT,
          external_send_authorized INTEGER NOT NULL DEFAULT 1 CHECK(external_send_authorized=1),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          UNIQUE(version_id, campaign_id, policy_hash)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_campaign_send_authorizations_scope
          ON campaign_send_authorizations(campaign_id, valid_from, expires_at);

        CREATE TABLE IF NOT EXISTS campaign_send_authorization_revocations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          campaign_send_authorization_id TEXT NOT NULL UNIQUE
            REFERENCES campaign_send_authorizations(id) ON DELETE RESTRICT,
          action_id TEXT NOT NULL UNIQUE CHECK(length(trim(action_id)) > 0),
          revoked_by TEXT NOT NULL CHECK(length(trim(revoked_by)) > 0),
          revoked_actor_type TEXT NOT NULL CHECK(revoked_actor_type='HUMAN'),
          reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS campaign_message_authorizations (
          id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
          campaign_send_authorization_id TEXT NOT NULL
            REFERENCES campaign_send_authorizations(id) ON DELETE RESTRICT,
          outbound_message_id TEXT NOT NULL UNIQUE REFERENCES outbound_messages(id) ON DELETE RESTRICT,
          message_version_id TEXT NOT NULL UNIQUE,
          review_hash TEXT NOT NULL CHECK(length(review_hash)=64),
          content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
          policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
          decision TEXT NOT NULL CHECK(decision='AUTO_SEND_ELIGIBLE'),
          evaluator_version TEXT NOT NULL CHECK(length(trim(evaluator_version)) > 0),
          evaluated_by TEXT NOT NULL CHECK(evaluated_by='SYSTEM'),
          send_authorized INTEGER NOT NULL DEFAULT 1 CHECK(send_authorized=1),
          decision_hash TEXT NOT NULL UNIQUE CHECK(length(decision_hash)=64),
          created_at TEXT NOT NULL CHECK(length(created_at) >= 20),
          FOREIGN KEY(message_version_id, review_hash, content_hash)
            REFERENCES message_versions(id, review_hash, content_hash) ON DELETE RESTRICT,
          UNIQUE(campaign_send_authorization_id, message_version_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_campaign_message_authorizations_campaign
          ON campaign_message_authorizations(campaign_send_authorization_id, created_at);

        CREATE TRIGGER IF NOT EXISTS trg_campaign_provider_bindings_immutable_update
        BEFORE UPDATE ON campaign_provider_bindings BEGIN
          SELECT RAISE(ABORT, 'campaign provider bindings are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_provider_bindings_immutable_delete
        BEFORE DELETE ON campaign_provider_bindings BEGIN
          SELECT RAISE(ABORT, 'campaign provider bindings are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_provider_response_cache_immutable_update
        BEFORE UPDATE ON provider_response_cache BEGIN
          SELECT RAISE(ABORT, 'provider response cache records are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_provider_response_cache_immutable_delete
        BEFORE DELETE ON provider_response_cache BEGIN
          SELECT RAISE(ABORT, 'provider response cache records are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_campaign_send_authorizations_immutable_update
        BEFORE UPDATE ON campaign_send_authorizations BEGIN
          SELECT RAISE(ABORT, 'campaign send authorizations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_send_authorizations_immutable_delete
        BEFORE DELETE ON campaign_send_authorizations BEGIN
          SELECT RAISE(ABORT, 'campaign send authorizations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_send_revocations_immutable_update
        BEFORE UPDATE ON campaign_send_authorization_revocations BEGIN
          SELECT RAISE(ABORT, 'campaign send authorization revocations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_send_revocations_immutable_delete
        BEFORE DELETE ON campaign_send_authorization_revocations BEGIN
          SELECT RAISE(ABORT, 'campaign send authorization revocations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_message_authorizations_immutable_update
        BEFORE UPDATE ON campaign_message_authorizations BEGIN
          SELECT RAISE(ABORT, 'campaign message authorizations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_campaign_message_authorizations_immutable_delete
        BEFORE DELETE ON campaign_message_authorizations BEGIN
          SELECT RAISE(ABORT, 'campaign message authorizations are immutable');
        END;
      `);

      const tables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (tables.has("provider_registry")) {
        const now = this.now();
        this.db.prepare(
          `INSERT OR IGNORE INTO provider_registry(
             id, provider_key, display_name, provider_kind, status, capabilities_json,
             policy_json, terms_checked_at, created_at, updated_at
           ) VALUES ('provider_searxng', 'searxng', 'SearXNG evidence search', 'MARKET_DATA',
             'ENABLED', '["EVIDENCE_SEARCH"]',
             '{"chargeable":false,"costMicrosPerRequest":0,"readOnly":true}', null, ?, ?)`,
        ).run(now, now);
        this.db.prepare(
          `INSERT OR IGNORE INTO provider_registry(
             id, provider_key, display_name, provider_kind, status, capabilities_json,
             policy_json, terms_checked_at, created_at, updated_at
           ) VALUES ('provider_local_public_web', 'local-public-web', 'Local public web crawler', 'CRAWLER',
             'ENABLED', '["WEBSITE_CRAWL"]',
             '{"chargeable":false,"costMicrosPerRequest":0,"readOnly":true}', null, ?, ?)`,
        ).run(now, now);
      }
      if (tables.has("outbound_messages")) {
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        if (!columns.has("authorization_mode")) {
          this.db.exec("ALTER TABLE outbound_messages ADD COLUMN authorization_mode TEXT NOT NULL DEFAULT 'LEAD_REVIEW' CHECK(authorization_mode IN ('LEAD_REVIEW','CAMPAIGN_POLICY'))");
        }
        if (!columns.has("campaign_send_authorization_id")) {
          this.db.exec("ALTER TABLE outbound_messages ADD COLUMN campaign_send_authorization_id TEXT REFERENCES campaign_send_authorizations(id) ON DELETE RESTRICT");
        }
        if (!columns.has("campaign_message_authorization_id")) {
          this.db.exec("ALTER TABLE outbound_messages ADD COLUMN campaign_message_authorization_id TEXT REFERENCES campaign_message_authorizations(id) ON DELETE RESTRICT");
        }
      }
      if (tables.has("provider_runs")) {
        const providerRunColumns = new Set(
          (this.db.prepare("PRAGMA table_info(provider_runs)").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        if (!providerRunColumns.has("campaign_id")) {
          this.db.exec("ALTER TABLE provider_runs ADD COLUMN campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL");
        }
        if (!providerRunColumns.has("campaign_version_id")) {
          this.db.exec("ALTER TABLE provider_runs ADD COLUMN campaign_version_id TEXT REFERENCES campaign_versions(id) ON DELETE SET NULL");
        }
      }

      const requiredRuntimeTables = [
        "campaigns", "leads", "contacts", "outbound_messages", "campaign_briefs",
        "campaign_versions", "campaign_approvals", "personalization_plans", "message_versions",
      ];
      if (requiredRuntimeTables.every((table) => tables.has(table))) {
        const outboundColumns = new Set(
          (this.db.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        const requiredOutboundColumns = [
          "campaign_id", "lead_id", "contact_id", "channel", "destination", "subject", "body",
          "sequence_index", "status", "current_version_id", "authorization_mode",
          "campaign_send_authorization_id", "campaign_message_authorization_id",
        ];
        if (requiredOutboundColumns.every((column) => outboundColumns.has(column))) {
          this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS trg_campaign_provider_binding_exact_insert
            BEFORE INSERT ON campaign_provider_bindings
            WHEN NOT EXISTS (
              SELECT 1
              FROM campaign_versions cv
              JOIN campaign_briefs cb ON cb.id=cv.brief_id
              JOIN campaigns cmp ON cmp.id=NEW.campaign_id
              WHERE cv.id=NEW.version_id
                AND cv.brief_id=NEW.brief_id
                AND cv.brief_hash=NEW.brief_hash
                AND cb.current_version_id=NEW.version_id
                AND cb.shadow_authorized=1
                AND cb.provider_budget_authorized=1
                AND EXISTS (
                  SELECT 1 FROM campaign_approvals ca
                  WHERE ca.brief_id=NEW.brief_id AND ca.version_id=NEW.version_id
                    AND ca.scope='PROVIDER_BUDGET' AND ca.approved_actor_type='HUMAN'
                )
            ) BEGIN
              SELECT RAISE(ABORT, 'provider campaign binding is not an exact current budget-authorized brief');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_campaign_send_authorization_exact_insert
            BEFORE INSERT ON campaign_send_authorizations
            WHEN NOT EXISTS (
              SELECT 1
              FROM campaign_approvals ca
              JOIN campaign_versions cv ON cv.id=ca.version_id AND cv.brief_id=ca.brief_id
              JOIN campaign_briefs cb ON cb.id=ca.brief_id
              JOIN campaigns cmp ON cmp.id=NEW.campaign_id
              WHERE ca.id=NEW.campaign_approval_id
                AND ca.scope='EXTERNAL_SEND'
                AND ca.approved_actor_type='HUMAN'
                AND ca.brief_id=NEW.brief_id
                AND ca.version_id=NEW.version_id
                AND ca.brief_hash=NEW.brief_hash
                AND cv.brief_hash=NEW.brief_hash
                AND cb.current_version_id=NEW.version_id
                AND cb.external_send_authorized=1
                AND lower(trim(cmp.market))=lower(trim(NEW.market))
                AND upper(json_extract(cv.brief_json, '$.transport'))='SMTP'
                AND lower(trim(json_extract(cv.brief_json, '$.market')))=lower(trim(NEW.market))
            ) BEGIN
              SELECT RAISE(ABORT, 'campaign send authorization is not bound to an exact current external-send approval');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_campaign_message_authorization_exact_insert
            BEFORE INSERT ON campaign_message_authorizations
            WHEN NOT EXISTS (
              SELECT 1
              FROM campaign_send_authorizations csa
              JOIN campaign_briefs cb ON cb.id=csa.brief_id
              JOIN message_versions mv ON mv.id=NEW.message_version_id
              JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
              JOIN outbound_messages om ON om.id=NEW.outbound_message_id
              JOIN leads l ON l.id=om.lead_id
              JOIN contacts c ON c.id=om.contact_id AND c.lead_id=l.id
              WHERE csa.id=NEW.campaign_send_authorization_id
                AND csa.policy_hash=NEW.policy_hash
                AND csa.external_send_authorized=1
                AND cb.current_version_id=csa.version_id
                AND cb.external_send_authorized=1
                AND NOT EXISTS (
                  SELECT 1 FROM campaign_send_authorization_revocations r
                  WHERE r.campaign_send_authorization_id=csa.id
                )
                AND mv.review_hash=NEW.review_hash
                AND mv.content_hash=NEW.content_hash
                AND mv.status='PENDING_APPROVAL'
                AND mv.send_authorized=0
                AND pp.status='VALID'
                AND pp.qualification_track IN ('ACTIVE_INTENT','ICP_FIT')
                AND json_extract(mv.lint_result_json, '$.passed')=1
                AND lower(mv.generation_mode) NOT LIKE '%generic%'
                AND lower(mv.generation_mode) NOT LIKE '%fallback%'
                AND lower(mv.generation_mode) NOT LIKE '%diagnostic%'
                AND NOT EXISTS (
                  SELECT 1 FROM message_versions newer
                  WHERE newer.message_key=mv.message_key AND newer.version_number>mv.version_number
                )
                AND om.current_version_id=mv.id
                AND om.campaign_id=csa.campaign_id
                AND om.campaign_id=l.campaign_id
                AND om.channel='email'
                AND lower(trim(om.destination))=lower(trim(mv.destination))
                AND lower(trim(om.destination))=lower(trim(c.email))
                AND om.subject=mv.subject
                AND om.body=mv.body
                AND om.sequence_index=mv.sequence_index
                AND om.sequence_index<=csa.maximum_sequence_index
                AND om.status IN ('DRAFT','PENDING_APPROVAL')
                AND l.send_eligible=1
                AND l.demand_evidence_qualified=1
                AND l.demand_policy_version='${DEMAND_POLICY_VERSION}'
                AND l.human_takeover=0
                AND l.status IN ('READY_FOR_REVIEW','APPROVED','CONTACTED')
                AND c.email_status='VALID'
                AND c.role_address=0 AND c.disposable_address=0 AND c.catch_all=0
                AND c.employment_verified_at IS NOT NULL
            ) BEGIN
              SELECT RAISE(ABORT, 'campaign message authorization is not bound to an eligible current grounded message');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_campaign_authorized_outbound_immutable_update
            BEFORE UPDATE OF campaign_id, lead_id, contact_id, channel, destination, subject, body,
              sequence_index, current_version_id, authorization_mode,
              campaign_send_authorization_id, campaign_message_authorization_id
            ON outbound_messages
            WHEN OLD.authorization_mode='CAMPAIGN_POLICY'
            BEGIN
              SELECT RAISE(ABORT, 'campaign-authorized outbound identity is immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS trg_campaign_authorized_outbound_immutable_delete
            BEFORE DELETE ON outbound_messages
            WHEN OLD.authorization_mode='CAMPAIGN_POLICY'
            BEGIN
              SELECT RAISE(ABORT, 'campaign-authorized outbound records are immutable');
            END;
          `);
        }
      }
    });
    this.applyMigration(15, "strict Hunter verification provenance and provider leases", () => {
      const tables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (tables.has("provider_registry")) {
        const now = this.now();
        this.db.prepare(
          `INSERT OR IGNORE INTO provider_registry(
             id, provider_key, display_name, provider_kind, status, capabilities_json,
             policy_json, terms_checked_at, created_at, updated_at
           ) VALUES ('provider_hunter', 'hunter', 'Hunter email verifier', 'EMAIL_VERIFICATION',
             'ENABLED', '["EMAIL_VERIFICATION"]',
             '{"chargeable":true,"readOnly":true,"finderEnabled":false,"independentVerificationOnly":true}',
             null, ?, ?)`,
        ).run(now, now);
      }

      if (tables.has("campaign_provider_bindings")) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_v15_campaign_provider_binding_shadow_insert
          BEFORE INSERT ON campaign_provider_bindings
          WHEN NOT EXISTS (
            SELECT 1 FROM campaign_approvals approval
            JOIN campaign_briefs brief ON brief.id=approval.brief_id
            WHERE approval.brief_id=NEW.brief_id
              AND approval.version_id=NEW.version_id
              AND approval.scope='SHADOW_PLAN'
              AND approval.approved_actor_type='HUMAN'
              AND brief.current_version_id=NEW.version_id
          ) BEGIN
            SELECT RAISE(ABORT, 'provider campaign binding requires exact current human shadow approval');
          END;
        `);
      }

      if (tables.has("contact_provider_assertions")) {
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(contact_provider_assertions)").all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        const addColumn = (name: string, definition: string): void => {
          if (!columns.has(name)) {
            this.db.exec(`ALTER TABLE contact_provider_assertions ADD COLUMN ${name} ${definition}`);
          }
        };
        addColumn("provider_assertion_id", "TEXT");
        addColumn("discovery_assertion_id", "TEXT");
        addColumn("discovery_provider_id", "TEXT REFERENCES provider_registry(id) ON DELETE RESTRICT");
        addColumn("verification_provider_id", "TEXT REFERENCES provider_registry(id) ON DELETE RESTRICT");
        addColumn("mailbox_verdict", `TEXT CHECK(mailbox_verdict IS NULL OR mailbox_verdict IN (
          'VALID_ASSERTION','INVALID_ASSERTION','RISKY_ASSERTION','UNKNOWN_ASSERTION'))`);
        addColumn("independently_verified", "INTEGER NOT NULL DEFAULT 0 CHECK(independently_verified IN (0,1))");
        addColumn("campaign_id", "TEXT REFERENCES campaigns(id) ON DELETE RESTRICT");
        addColumn("campaign_version_id", "TEXT REFERENCES campaign_versions(id) ON DELETE RESTRICT");
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_provider_assertion_external_id
            ON contact_provider_assertions(provider_id, provider_assertion_id)
            WHERE provider_assertion_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_contact_provider_independent_email
            ON contact_provider_assertions(contact_point_id, assertion_type, mailbox_verdict,
              independently_verified, expires_at);

          CREATE TRIGGER IF NOT EXISTS trg_v15_strict_contact_assertion_immutable_update
          BEFORE UPDATE ON contact_provider_assertions
          WHEN OLD.provider_assertion_id IS NOT NULL BEGIN
            SELECT RAISE(ABORT, 'strict contact provider assertions are immutable');
          END;
          CREATE TRIGGER IF NOT EXISTS trg_v15_strict_contact_assertion_immutable_delete
          BEFORE DELETE ON contact_provider_assertions
          WHEN OLD.provider_assertion_id IS NOT NULL BEGIN
            SELECT RAISE(ABORT, 'strict contact provider assertions are immutable');
          END;
        `);
      }

      if (tables.has("campaign_message_authorizations") && tables.has("contact_provider_assertions")) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_v15_campaign_message_independent_email_insert
          BEFORE INSERT ON campaign_message_authorizations
          WHEN NOT EXISTS (
            SELECT 1
            FROM campaign_send_authorizations csa
            JOIN outbound_messages om ON om.id=NEW.outbound_message_id
            JOIN contacts c ON c.id=om.contact_id AND c.lead_id=om.lead_id
            JOIN contact_points cp ON cp.legacy_contact_id=c.id AND cp.kind='EMAIL'
              AND lower(trim(cp.normalized_value))=lower(trim(c.email))
            JOIN contact_provider_assertions verification
              ON verification.contact_point_id=cp.id
              AND verification.assertion_type='EMAIL_VERIFICATION'
            JOIN contact_provider_assertions discovery
              ON discovery.contact_point_id=cp.id
              AND discovery.assertion_type='EMAIL_DISCOVERY'
              AND discovery.provider_assertion_id=verification.discovery_assertion_id
              AND discovery.provider_id=verification.discovery_provider_id
              AND discovery.value_hash=verification.value_hash
            JOIN provider_registry discovery_provider ON discovery_provider.id=discovery.provider_id
            JOIN provider_registry verifier_provider ON verifier_provider.id=verification.provider_id
            WHERE csa.id=NEW.campaign_send_authorization_id
              AND verification.campaign_id=csa.campaign_id
              AND verification.campaign_version_id=csa.version_id
              AND verification.verification_provider_id=verification.provider_id
              AND verification.discovery_provider_id<>verification.provider_id
              AND verification.independently_verified=1
              AND verification.mailbox_verdict='VALID_ASSERTION'
              AND verification.result='CONFIRMED'
              AND verification.expires_at>NEW.created_at
              AND discovery.result IN ('ASSERTED','CONFIRMED')
              AND discovery.expires_at>NEW.created_at
              AND lower(discovery_provider.provider_key)='local-public-web'
              AND lower(verifier_provider.provider_key)='hunter'
              AND discovery.source_uri=c.source_url
          ) BEGIN
            SELECT RAISE(ABORT, 'campaign message requires current independent public-web email verification');
          END;
        `);
      }
    });
    this.applyMigration(16, "independent official email verifier provenance", () => {
      const tables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (tables.has("provider_registry")) {
        const now = this.now();
        this.db.prepare(
          `INSERT OR IGNORE INTO provider_registry(
             id, provider_key, display_name, provider_kind, status, capabilities_json,
             policy_json, terms_checked_at, created_at, updated_at
           ) VALUES ('provider_bouncer', 'bouncer', 'Bouncer email verifier', 'EMAIL_VERIFICATION',
             'ENABLED', '["EMAIL_VERIFICATION"]',
             '{"chargeable":true,"readOnly":true,"finderEnabled":false,"independentVerificationOnly":true}',
             null, ?, ?)`,
        ).run(now, now);
      }

      if (tables.has("contact_provider_assertions")) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_contact_provider_assertion_external_id;
          CREATE UNIQUE INDEX idx_contact_provider_assertion_external_id
            ON contact_provider_assertions(provider_id, provider_assertion_id)
            WHERE provider_assertion_id IS NOT NULL
              AND provider_id<>'provider_local_public_web';
          CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_provider_local_observation
            ON contact_provider_assertions(provider_id, provider_assertion_id, observed_at)
            WHERE provider_assertion_id IS NOT NULL
              AND provider_id='provider_local_public_web';
        `);
      }

      if (tables.has("campaign_message_authorizations") && tables.has("contact_provider_assertions")) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS trg_v15_campaign_message_independent_email_insert;
          DROP TRIGGER IF EXISTS trg_v16_campaign_message_independent_email_insert;
          CREATE TRIGGER trg_v16_campaign_message_independent_email_insert
          BEFORE INSERT ON campaign_message_authorizations
          WHEN NOT EXISTS (
            SELECT 1
            FROM campaign_send_authorizations csa
            JOIN outbound_messages om ON om.id=NEW.outbound_message_id
            JOIN contacts c ON c.id=om.contact_id AND c.lead_id=om.lead_id
            JOIN contact_points cp ON cp.legacy_contact_id=c.id AND cp.kind='EMAIL'
              AND lower(trim(cp.normalized_value))=lower(trim(c.email))
            JOIN contact_provider_assertions verification
              ON verification.contact_point_id=cp.id
              AND verification.assertion_type='EMAIL_VERIFICATION'
            JOIN contact_provider_assertions discovery
              ON discovery.contact_point_id=cp.id
              AND discovery.assertion_type='EMAIL_DISCOVERY'
              AND discovery.provider_assertion_id=verification.discovery_assertion_id
              AND discovery.provider_id=verification.discovery_provider_id
              AND discovery.value_hash=verification.value_hash
            JOIN provider_registry discovery_provider ON discovery_provider.id=discovery.provider_id
            JOIN provider_registry verifier_provider ON verifier_provider.id=verification.provider_id
            JOIN provider_runs verification_run
              ON verification_run.id=verification.provider_run_id
              AND verification_run.provider_id=verification.provider_id
            WHERE csa.id=NEW.campaign_send_authorization_id
              AND discovery.campaign_id=csa.campaign_id
              AND discovery.campaign_version_id=csa.version_id
              AND verification.campaign_id=csa.campaign_id
              AND verification.campaign_version_id=csa.version_id
              AND verification_run.campaign_id=csa.campaign_id
              AND verification_run.campaign_version_id=csa.version_id
              AND verification_run.status='SUCCEEDED'
              AND verification.verification_provider_id=verification.provider_id
              AND verification.discovery_provider_id<>verification.provider_id
              AND verification.independently_verified=1
              AND verification.mailbox_verdict='VALID_ASSERTION'
              AND verification.result='CONFIRMED'
              AND verification.expires_at>NEW.created_at
              AND discovery.result IN ('ASSERTED','CONFIRMED')
              AND discovery.expires_at>NEW.created_at
              AND lower(discovery_provider.provider_key)='local-public-web'
              AND lower(verifier_provider.provider_key) IN ('hunter','bouncer')
              AND verification.source_uri=CASE lower(verifier_provider.provider_key)
                WHEN 'hunter' THEN 'https://hunter.io/email-verifier'
                WHEN 'bouncer' THEN 'https://api.usebouncer.com/v1.1/email/verify'
              END
              AND discovery.source_uri=c.source_url
          ) BEGIN
            SELECT RAISE(ABORT, 'campaign message requires current public-web discovery plus independent official verifier confirmation');
          END;
        `);
      }
    });
    this.applyMigration(17, "tiered recipient policy and ICP-fit outreach lane", () => {
      const tables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (tables.has("contacts")) {
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>).map((row) => row.name),
        );
        if (!columns.has("recipient_tier")) {
          this.db.exec("ALTER TABLE contacts ADD COLUMN recipient_tier TEXT NOT NULL DEFAULT 'C' CHECK(recipient_tier IN ('A','B','C'))");
        }
        if (!columns.has("recipient_evidence_url")) {
          this.db.exec("ALTER TABLE contacts ADD COLUMN recipient_evidence_url TEXT");
        }
        if (!columns.has("recipient_evidence_observed_at")) {
          this.db.exec("ALTER TABLE contacts ADD COLUMN recipient_evidence_observed_at TEXT");
        }
        if (!columns.has("recipient_evidence_expires_at")) {
          this.db.exec("ALTER TABLE contacts ADD COLUMN recipient_evidence_expires_at TEXT");
        }
        if (!columns.has("recipient_evidence_hash")) {
          this.db.exec("ALTER TABLE contacts ADD COLUMN recipient_evidence_hash TEXT");
        }
        if (!columns.has("recipient_policy_version")) {
          this.db.exec(`ALTER TABLE contacts ADD COLUMN recipient_policy_version TEXT NOT NULL DEFAULT '${RECIPIENT_TIER_POLICY_VERSION}'`);
        }

        const contacts = this.db.prepare(
          `SELECT c.*, l.domain
           FROM contacts c JOIN leads l ON l.id=c.lead_id`,
        ).all() as Array<Record<string, unknown>>;
        const now = new Date(this.now());
        for (const contact of contacts) {
          const published = contact.email ? this.db.prepare(
            `SELECT source_url, evidence, created_at
             FROM lead_sources
             WHERE lead_id=? AND lower(source_url)=lower(?)
               AND lower(source_type)='official_website'
               AND instr(lower(evidence), lower(?))>0
             ORDER BY created_at DESC LIMIT 1`,
          ).get(String(contact.lead_id), String(contact.source_url), String(contact.email)) as
            | { source_url: string; evidence: string; created_at: string }
            | undefined : undefined;
          const decision = classifyRecipientTier({
            accountDomain: String(contact.domain),
            email: contact.email ? String(contact.email) : null,
            name: String(contact.name ?? ""),
            title: String(contact.title ?? ""),
            employmentVerifiedAt: contact.employment_verified_at ? String(contact.employment_verified_at) : null,
            emailStatus: String(contact.email_status) as EmailVerificationStatus,
            roleAddress: Boolean(contact.role_address),
            disposableAddress: Boolean(contact.disposable_address),
            catchAll: Boolean(contact.catch_all),
            officialMailboxEvidence: published ? {
              sourceUrl: published.source_url,
              exactText: published.evidence,
              observedAt: published.created_at,
            } : contact.employment_verified_at ? {
              sourceUrl: String(contact.source_url),
              exactText: "",
              observedAt: String(contact.employment_verified_at),
            } : null,
            asOf: now,
          });
          this.db.prepare(
            `UPDATE contacts SET recipient_tier=?, recipient_evidence_url=?,
               recipient_evidence_observed_at=?, recipient_evidence_expires_at=?,
               recipient_evidence_hash=?, recipient_policy_version=? WHERE id=?`,
          ).run(
            decision.tier,
            decision.evidenceUrl,
            decision.evidenceObservedAt,
            decision.evidenceExpiresAt,
            decision.evidenceHash,
            decision.policyVersion,
            String(contact.id),
          );
        }
      }

      if (tables.has("leads")) {
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>).map((row) => row.name),
        );
        if (!columns.has("outreach_qualification_track")) {
          this.db.exec("ALTER TABLE leads ADD COLUMN outreach_qualification_track TEXT NOT NULL DEFAULT 'WATCHLIST' CHECK(outreach_qualification_track IN ('ACTIVE_INTENT','ICP_FIT','WATCHLIST'))");
        }
        if (!columns.has("outreach_qualification_policy_version")) {
          this.db.exec("ALTER TABLE leads ADD COLUMN outreach_qualification_policy_version TEXT NOT NULL DEFAULT ''");
        }
        if (columns.has("demand_evidence_qualified") && columns.has("demand_policy_version")) {
          this.db.prepare(
            `UPDATE leads SET outreach_qualification_track='ACTIVE_INTENT',
               outreach_qualification_policy_version=?
             WHERE demand_evidence_qualified=1 AND demand_policy_version=?`,
          ).run(QUALIFICATION_POLICY_VERSION, DEMAND_POLICY_VERSION);
        }
      }

      if (tables.has("campaign_message_authorizations") && tables.has("contact_provider_assertions")) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS trg_campaign_message_authorization_exact_insert;
          CREATE TRIGGER trg_campaign_message_authorization_exact_insert
          BEFORE INSERT ON campaign_message_authorizations
          WHEN NOT EXISTS (
            SELECT 1
            FROM campaign_send_authorizations csa
            JOIN campaign_briefs cb ON cb.id=csa.brief_id
            JOIN message_versions mv ON mv.id=NEW.message_version_id
            JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
            JOIN outbound_messages om ON om.id=NEW.outbound_message_id
            JOIN leads l ON l.id=om.lead_id
            JOIN contacts c ON c.id=om.contact_id AND c.lead_id=l.id
            WHERE csa.id=NEW.campaign_send_authorization_id
              AND csa.policy_hash=NEW.policy_hash
              AND csa.external_send_authorized=1
              AND cb.current_version_id=csa.version_id
              AND cb.external_send_authorized=1
              AND NOT EXISTS (
                SELECT 1 FROM campaign_send_authorization_revocations r
                WHERE r.campaign_send_authorization_id=csa.id
              )
              AND mv.review_hash=NEW.review_hash
              AND mv.content_hash=NEW.content_hash
              AND mv.status='PENDING_APPROVAL'
              AND mv.send_authorized=0
              AND pp.status='VALID'
              AND pp.qualification_track IN ('ACTIVE_INTENT','ICP_FIT')
              AND json_extract(mv.lint_result_json, '$.passed')=1
              AND lower(mv.generation_mode) NOT LIKE '%generic%'
              AND lower(mv.generation_mode) NOT LIKE '%fallback%'
              AND lower(mv.generation_mode) NOT LIKE '%diagnostic%'
              AND NOT EXISTS (
                SELECT 1 FROM message_versions newer
                WHERE newer.message_key=mv.message_key AND newer.version_number>mv.version_number
              )
              AND om.current_version_id=mv.id
              AND om.campaign_id=csa.campaign_id
              AND om.campaign_id=l.campaign_id
              AND om.channel='email'
              AND lower(trim(om.destination))=lower(trim(mv.destination))
              AND lower(trim(om.destination))=lower(trim(c.email))
              AND om.subject=mv.subject
              AND om.body=mv.body
              AND om.sequence_index=mv.sequence_index
              AND om.sequence_index<=csa.maximum_sequence_index
              AND om.status IN ('DRAFT','PENDING_APPROVAL')
              AND l.send_eligible=1
              AND (
                (l.demand_evidence_qualified=1 AND l.demand_policy_version='${DEMAND_POLICY_VERSION}')
                OR
                (l.outreach_qualification_track='ICP_FIT'
                  AND l.outreach_qualification_policy_version='${QUALIFICATION_POLICY_VERSION}')
              )
              AND l.human_takeover=0
              AND l.status IN ('READY_FOR_REVIEW','APPROVED','CONTACTED')
              AND (
                (c.recipient_tier='A' AND c.email_status='VALID' AND c.role_address=0
                  AND c.disposable_address=0 AND c.catch_all=0 AND c.employment_verified_at IS NOT NULL
                  AND julianday(c.employment_verified_at) BETWEEN julianday(NEW.created_at)-90 AND julianday(NEW.created_at))
                OR
                (c.recipient_tier='B' AND c.email_status<>'INVALID' AND c.role_address=1
                  AND c.disposable_address=0 AND c.recipient_policy_version='${RECIPIENT_TIER_POLICY_VERSION}'
                  AND length(c.recipient_evidence_hash)=64
                  AND c.recipient_evidence_expires_at>NEW.created_at)
              )
          ) BEGIN
            SELECT RAISE(ABORT, 'campaign message authorization is not bound to an eligible tiered grounded message');
          END;

          DROP TRIGGER IF EXISTS trg_v16_campaign_message_independent_email_insert;
          DROP TRIGGER IF EXISTS trg_v17_campaign_message_recipient_tier_insert;
          CREATE TRIGGER trg_v17_campaign_message_recipient_tier_insert
          BEFORE INSERT ON campaign_message_authorizations
          WHEN NOT EXISTS (
            SELECT 1
            FROM campaign_send_authorizations csa
            JOIN outbound_messages om ON om.id=NEW.outbound_message_id
            JOIN leads l ON l.id=om.lead_id
            JOIN contacts c ON c.id=om.contact_id AND c.lead_id=om.lead_id
            WHERE csa.id=NEW.campaign_send_authorization_id
              AND (
                (
                  c.recipient_tier='B'
                  AND c.email_status<>'INVALID'
                  AND c.role_address=1
                  AND c.disposable_address=0
                  AND c.recipient_policy_version='${RECIPIENT_TIER_POLICY_VERSION}'
                  AND length(c.recipient_evidence_hash)=64
                  AND c.recipient_evidence_observed_at<=NEW.created_at
                  AND c.recipient_evidence_expires_at>NEW.created_at
                  AND EXISTS (
                    SELECT 1 FROM lead_sources ls
                    WHERE ls.lead_id=l.id
                      AND lower(ls.source_type)='official_website'
                      AND lower(ls.source_url)=lower(c.recipient_evidence_url)
                      AND instr(lower(ls.evidence), lower(c.email))>0
                  )
                )
                OR
                (
                  c.recipient_tier='A'
                  AND c.email_status='VALID'
                  AND c.role_address=0
                  AND c.disposable_address=0
                  AND c.catch_all=0
                  AND c.employment_verified_at IS NOT NULL
                  AND julianday(c.employment_verified_at) BETWEEN julianday(NEW.created_at)-90 AND julianday(NEW.created_at)
                  AND EXISTS (
                    SELECT 1
                    FROM contact_points cp
                    JOIN contact_provider_assertions verification
                      ON verification.contact_point_id=cp.id
                      AND verification.assertion_type='EMAIL_VERIFICATION'
                    JOIN contact_provider_assertions discovery
                      ON discovery.contact_point_id=cp.id
                      AND discovery.assertion_type='EMAIL_DISCOVERY'
                      AND discovery.provider_assertion_id=verification.discovery_assertion_id
                      AND discovery.provider_id=verification.discovery_provider_id
                      AND discovery.value_hash=verification.value_hash
                    JOIN provider_registry discovery_provider ON discovery_provider.id=discovery.provider_id
                    JOIN provider_registry verifier_provider ON verifier_provider.id=verification.provider_id
                    JOIN provider_runs verification_run
                      ON verification_run.id=verification.provider_run_id
                      AND verification_run.provider_id=verification.provider_id
                    WHERE cp.legacy_contact_id=c.id AND cp.kind='EMAIL'
                      AND lower(trim(cp.normalized_value))=lower(trim(c.email))
                      AND discovery.campaign_id=csa.campaign_id
                      AND discovery.campaign_version_id=csa.version_id
                      AND verification.campaign_id=csa.campaign_id
                      AND verification.campaign_version_id=csa.version_id
                      AND verification_run.campaign_id=csa.campaign_id
                      AND verification_run.campaign_version_id=csa.version_id
                      AND verification_run.status='SUCCEEDED'
                      AND verification.verification_provider_id=verification.provider_id
                      AND verification.discovery_provider_id<>verification.provider_id
                      AND verification.independently_verified=1
                      AND verification.mailbox_verdict='VALID_ASSERTION'
                      AND verification.result='CONFIRMED'
                      AND verification.expires_at>NEW.created_at
                      AND discovery.result IN ('ASSERTED','CONFIRMED')
                      AND discovery.expires_at>NEW.created_at
                      AND lower(discovery_provider.provider_key)='local-public-web'
                      AND lower(verifier_provider.provider_key) IN ('hunter','bouncer')
                      AND verification.source_uri=CASE lower(verifier_provider.provider_key)
                        WHEN 'hunter' THEN 'https://hunter.io/email-verifier'
                        WHEN 'bouncer' THEN 'https://api.usebouncer.com/v1.1/email/verify'
                      END
                      AND discovery.source_uri=c.source_url
                  )
                )
              )
          ) BEGIN
            SELECT RAISE(ABORT, 'campaign message requires a current tier A verifier or tier B official publication');
          END;
        `);
      }
    });
    this.applyMigration(18, "IMAP runtime health and poison-message quarantine", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS imap_message_failures (
          id TEXT PRIMARY KEY,
          uid_validity TEXT NOT NULL,
          uid INTEGER NOT NULL CHECK(uid > 0),
          status TEXT NOT NULL CHECK(status IN ('RETRY_PENDING','QUARANTINED','RESOLVED','UNREPLAYABLE')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
          quarantine_episode INTEGER NOT NULL DEFAULT 0 CHECK(quarantine_episode >= 0),
          source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
          source_size INTEGER NOT NULL DEFAULT 0 CHECK(source_size >= 0),
          preview_json TEXT NOT NULL DEFAULT '{}',
          last_error_class TEXT NOT NULL,
          last_error_message TEXT NOT NULL,
          first_failed_at TEXT NOT NULL,
          last_failed_at TEXT NOT NULL,
          quarantined_at TEXT,
          replay_requested_at TEXT,
          replay_requested_by TEXT,
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(uid_validity, uid)
        );

        CREATE INDEX IF NOT EXISTS idx_imap_message_failures_retry
          ON imap_message_failures(uid_validity, status, uid);
        CREATE INDEX IF NOT EXISTS idx_imap_message_failures_quarantine
          ON imap_message_failures(status, quarantined_at DESC);
      `);
    });
    this.applyMigration(19, "audited bounce incidents and controlled deliverability recovery", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS email_bounce_incidents (
          id TEXT PRIMARY KEY,
          inbound_message_id TEXT UNIQUE REFERENCES inbound_messages(id) ON DELETE RESTRICT,
          outbound_message_id TEXT NOT NULL UNIQUE REFERENCES outbound_messages(id) ON DELETE RESTRICT,
          lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
          contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
          diagnostic_category TEXT NOT NULL CHECK(diagnostic_category IN (
            'RECIPIENT_INVALID','RECIPIENT_MAILBOX_UNAVAILABLE',
            'REMOTE_FORWARDING_INFRASTRUCTURE','POLICY_REJECTION','UNCLASSIFIED_HARD_FAILURE'
          )),
          enhanced_status_code TEXT,
          diagnostic_code TEXT,
          evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
          evidence_excerpt TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS email_bounce_incident_reviews (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL UNIQUE REFERENCES email_bounce_incidents(id) ON DELETE RESTRICT,
          disposition TEXT NOT NULL CHECK(disposition IN (
            'CONFIRMED_RECIPIENT_FAILURE','REMOTE_INFRASTRUCTURE_FAILURE',
            'SENDER_INFRASTRUCTURE_FAILURE','MISCLASSIFIED'
          )),
          reviewed_by TEXT NOT NULL CHECK(length(trim(reviewed_by))>0),
          review_reason TEXT NOT NULL CHECK(length(trim(review_reason))>0),
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deliverability_recovery_authorizations (
          id TEXT PRIMARY KEY,
          incident_review_id TEXT NOT NULL REFERENCES email_bounce_incident_reviews(id) ON DELETE RESTRICT,
          authorized_by TEXT NOT NULL CHECK(length(trim(authorized_by))>0),
          authorization_reason TEXT NOT NULL CHECK(length(trim(authorization_reason))>0),
          max_messages INTEGER NOT NULL CHECK(max_messages>0 AND max_messages<=50),
          valid_from TEXT NOT NULL,
          expires_at TEXT NOT NULL CHECK(expires_at>valid_from),
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deliverability_recovery_claims (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES deliverability_recovery_authorizations(id) ON DELETE RESTRICT,
          outbound_message_id TEXT NOT NULL UNIQUE REFERENCES outbound_messages(id) ON DELETE RESTRICT,
          claimed_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_email_bounce_incidents_created
          ON email_bounce_incidents(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_deliverability_recovery_active
          ON deliverability_recovery_authorizations(valid_from, expires_at);
        CREATE INDEX IF NOT EXISTS idx_deliverability_recovery_claims_authorization
          ON deliverability_recovery_claims(authorization_id, claimed_at);

        CREATE TRIGGER IF NOT EXISTS trg_email_bounce_incidents_immutable_update
          BEFORE UPDATE ON email_bounce_incidents BEGIN
            SELECT RAISE(ABORT, 'email bounce incidents are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_email_bounce_incidents_immutable_delete
          BEFORE DELETE ON email_bounce_incidents BEGIN
            SELECT RAISE(ABORT, 'email bounce incidents are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_email_bounce_reviews_immutable_update
          BEFORE UPDATE ON email_bounce_incident_reviews BEGIN
            SELECT RAISE(ABORT, 'email bounce reviews are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_email_bounce_reviews_immutable_delete
          BEFORE DELETE ON email_bounce_incident_reviews BEGIN
            SELECT RAISE(ABORT, 'email bounce reviews are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_deliverability_recovery_authorizations_immutable_update
          BEFORE UPDATE ON deliverability_recovery_authorizations BEGIN
            SELECT RAISE(ABORT, 'deliverability recovery authorizations are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_deliverability_recovery_authorizations_immutable_delete
          BEFORE DELETE ON deliverability_recovery_authorizations BEGIN
            SELECT RAISE(ABORT, 'deliverability recovery authorizations are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_deliverability_recovery_claims_immutable_update
          BEFORE UPDATE ON deliverability_recovery_claims BEGIN
            SELECT RAISE(ABORT, 'deliverability recovery claims are immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_deliverability_recovery_claims_immutable_delete
          BEFORE DELETE ON deliverability_recovery_claims BEGIN
            SELECT RAISE(ABORT, 'deliverability recovery claims are immutable');
          END;
      `);

      const tableNames = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((table) => table.name),
      );
      if (!["outbound_messages", "leads", "contacts"].every((table) => tableNames.has(table))) return;
      const outboundColumns = new Set(
        (this.db.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!["id", "lead_id", "contact_id", "sent_at", "failure_reason", "channel", "status"]
        .every((column) => outboundColumns.has(column))) return;
      const inboundColumns = tableNames.has("inbound_messages")
        ? new Set(
            (this.db.prepare("PRAGMA table_info(inbound_messages)").all() as Array<{ name: string }>)
              .map((column) => column.name),
          )
        : new Set<string>();
      const canCorrelateInbound = [
        "id", "body_text", "reason", "received_at", "classification", "lead_id", "contact_id",
      ].every((column) => inboundColumns.has(column));
      const bounced = this.db.prepare(
        `SELECT id, lead_id, contact_id, sent_at, failure_reason
         FROM outbound_messages WHERE channel='email' AND status='BOUNCED'`,
      ).all() as Array<Record<string, unknown>>;
      for (const message of bounced) {
        const inbound = canCorrelateInbound
          ? this.db.prepare(
              `SELECT id, body_text, reason, received_at
               FROM inbound_messages
               WHERE classification='BOUNCE' AND lead_id=? AND contact_id=?
               ORDER BY abs(julianday(received_at)-julianday(?)), received_at
               LIMIT 1`,
            ).get(
              String(message.lead_id),
              String(message.contact_id),
              String(message.sent_at ?? this.now()),
            ) as Record<string, unknown> | undefined
          : undefined;
        const evidence = [
          String(inbound?.body_text ?? ""),
          String(inbound?.reason ?? message.failure_reason ?? "historical hard delivery failure"),
        ].filter(Boolean).join("\n");
        const diagnostic = analyzeBounceDiagnostic(evidence);
        this.db.prepare(
          `INSERT OR IGNORE INTO email_bounce_incidents(
             id, inbound_message_id, outbound_message_id, lead_id, contact_id,
             diagnostic_category, enhanced_status_code, diagnostic_code,
             evidence_sha256, evidence_excerpt, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          this.id("bounce"),
          inbound?.id ? String(inbound.id) : null,
          String(message.id),
          String(message.lead_id),
          String(message.contact_id),
          diagnostic.category,
          diagnostic.enhancedStatusCode,
          diagnostic.diagnosticCode,
          diagnostic.evidenceSha256,
          diagnostic.evidenceExcerpt,
          String(inbound?.received_at ?? message.sent_at ?? this.now()),
        );
      }
    });
    this.ensureNotificationOutboxV18Compatibility();
    this.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
  }

  private ensureNotificationOutboxV18Compatibility(): void {
    const tableExists = Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notifications'",
    ).get());
    if (!tableExists) return;
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("next_attempt_at")) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT");
    }
    if (!columns.has("dead_lettered_at")) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN dead_lettered_at TEXT");
    }
    this.db.prepare(
      `UPDATE notifications
       SET status='DEAD_LETTER', dead_lettered_at=COALESCE(dead_lettered_at, updated_at, created_at),
           next_attempt_at=NULL, updated_at=COALESCE(updated_at, created_at)
       WHERE status='PENDING' AND attempts>=?`,
    ).run(NOTIFICATION_MAX_ATTEMPTS);
    this.db.exec(`
      UPDATE notifications
      SET next_attempt_at=COALESCE(next_attempt_at, created_at)
      WHERE status='PENDING' AND next_attempt_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_notifications_due
        ON notifications(status, next_attempt_at, attempts, created_at);
    `);
  }

  private applyMigration(version: number, name: string, operation: () => void): void {
    const applied = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
      .get(version);
    if (applied) return;
    this.transaction(() => {
      operation();
      this.db
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, name, this.now());
    });
  }

  getSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return Number(row.version);
  }

  getMigrationStatus(): {
    currentVersion: number;
    latestVersion: number;
    applied: Array<{ version: number; name: string; appliedAt: string }>;
  } {
    const applied = this.db
      .prepare(
        "SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version",
      )
      .all() as Array<{ version: number; name: string; appliedAt: string }>;
    return {
      currentVersion: this.getSchemaVersion(),
      latestVersion: LATEST_SCHEMA_VERSION,
      applied,
    };
  }

  checkIntegrity(): DatabaseHealth {
    const quickRows = this.db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const quickCheck = quickRows.map((row) => String(Object.values(row)[0] ?? "unknown"));
    const foreignKeyViolations = (
      this.db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>
    ).length;
    return {
      ok: quickCheck.length === 1 && quickCheck[0] === "ok" && foreignKeyViolations === 0,
      quickCheck,
      foreignKeyViolations,
    };
  }

  backupTo(destinationPath: string): {
    destination: string;
    bytes: number;
    schemaVersion: number;
    integrity: DatabaseHealth;
  } {
    const destination = path.resolve(destinationPath);
    if (this.databasePath !== ":memory:" && path.resolve(this.databasePath) === destination) {
      throw new Error("Database backup destination must differ from the source database");
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { force: true });
    const escaped = destination.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);

    const snapshot = new DatabaseSync(destination, { readOnly: true });
    let integrity: DatabaseHealth;
    try {
      const quickRows = snapshot.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
      const quickCheck = quickRows.map((row) => String(Object.values(row)[0] ?? "unknown"));
      const foreignKeyViolations = (
        snapshot.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>
      ).length;
      integrity = {
        ok: quickCheck.length === 1 && quickCheck[0] === "ok" && foreignKeyViolations === 0,
        quickCheck,
        foreignKeyViolations,
      };
    } finally {
      snapshot.close();
    }
    if (!integrity.ok) {
      fs.rmSync(destination, { force: true });
      throw new Error(`Database backup integrity check failed: ${JSON.stringify(integrity)}`);
    }
    return {
      destination,
      bytes: fs.statSync(destination).size,
      schemaVersion: this.getSchemaVersion(),
      integrity,
    };
  }

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private assertWorkflowAuthorization(
    authorization: WorkflowAuthorization,
    operation: string,
    options: { human?: boolean; roles?: readonly WorkflowRole[] } = {},
  ): string {
    const actor = authorization.actor?.trim();
    if (!actor) throw new Error(`${operation} requires an identified actor`);
    if (!new Set<WorkflowActorType>(["AGENT", "HUMAN", "SYSTEM"]).has(authorization.actorType)) {
      throw new Error(`${operation} has an invalid actor type`);
    }
    if (options.human && authorization.actorType !== "HUMAN") {
      throw new Error(`${operation} requires an authorized human`);
    }
    if (options.roles && options.roles.length > 0) {
      const actual = new Set(authorization.roles ?? []);
      if (!options.roles.some((role) => actual.has(role))) {
        throw new Error(`${operation} requires one of these roles: ${options.roles.join(", ")}`);
      }
    }
    return actor;
  }

  private independentSourceCounts(leadIdsInput: readonly string[]): Map<string, number> {
    const leadIds = [...new Set(leadIdsInput.map((leadId) => leadId.trim()).filter(Boolean))];
    const counts = new Map(leadIds.map((leadId) => [leadId, 0]));
    if (leadIds.length === 0) return counts;
    const placeholders = leadIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT lal.lead_id, account_source.id, account_source.source_url,
              COALESCE(account_source.publisher_domain, document.publisher_domain) AS publisher_domain,
              COALESCE(account_source.independence_key, document.independence_key) AS independence_key,
              COALESCE(
                NULLIF(trim(CAST(json_extract(document.metadata_json, '$.originalDocumentKey') AS TEXT)), ''),
                NULLIF(trim(CAST(json_extract(document.metadata_json, '$.original_document_key') AS TEXT)), '')
              ) AS original_document_key
       FROM lead_account_links lal
       JOIN account_sources account_source ON account_source.account_id=lal.account_id
       LEFT JOIN source_documents document ON document.id=account_source.source_document_id
       WHERE lal.lead_id IN (${placeholders})
         AND lower(trim(account_source.source_type)) NOT IN ('search_index','email_verification')`,
    ).all(...leadIds) as Array<{
      lead_id: string;
      id: string;
      source_url: string;
      publisher_domain: string | null;
      independence_key: string | null;
      original_document_key: string | null;
    }>;
    const byLead = new Map<string, typeof rows>();
    for (const row of rows) {
      const sources = byLead.get(row.lead_id) ?? [];
      sources.push(row);
      byLead.set(row.lead_id, sources);
    }
    for (const leadId of leadIds) {
      const sources = byLead.get(leadId) ?? [];
      counts.set(leadId, collapseIndependentSources(sources.map((source) => ({
        id: source.id,
        sourceUrl: source.source_url,
        publisherDomain: source.publisher_domain,
        independenceKey: source.independence_key,
        originalDocumentKey: source.original_document_key,
      }))).length);
    }
    return counts;
  }

  private attachIndependentSourceCounts<T extends Record<string, unknown>>(
    rows: readonly T[],
    leadIdField: keyof T,
  ): T[] {
    const counts = this.independentSourceCounts(rows.map((row) => String(row[leadIdField] ?? "")));
    return rows.map((row) => ({
      ...row,
      source_count: counts.get(String(row[leadIdField] ?? "")) ?? 0,
    }));
  }

  runInTransaction<T>(operation: () => T): T {
    return this.transaction(operation);
  }

  private transaction<T>(operation: () => T): T {
    const savepointName = this.transactionDepth > 0
      ? `agent_database_tx_${++this.transactionSavepointSequence}`
      : null;
    if (savepointName) {
      this.db.exec(`SAVEPOINT "${savepointName}"`);
    } else {
      this.db.exec("BEGIN IMMEDIATE");
    }
    this.transactionDepth += 1;
    try {
      const result = operation();
      if (savepointName) {
        this.db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
      } else {
        this.db.exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (savepointName) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT "${savepointName}"`);
        } finally {
          this.db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
        }
      } else {
        this.db.exec("ROLLBACK");
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private runSynchronousLeadAutomationOperation<T>(operation: () => T): T {
    const runtime = { active: true };
    try {
      return leadAutomationRuntime.run(runtime, () => {
        const value = operation();
        if (value !== null && (typeof value === "object" || typeof value === "function") &&
          typeof (value as { then?: unknown }).then === "function") {
          throw new Error("Lead automation guard operations must be synchronous");
        }
        return value;
      });
    } finally {
      runtime.active = false;
    }
  }

  recordEvent(
    entityType: string,
    entityId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown> = {},
  ): string {
    const id = this.id("evt");
    this.db
      .prepare(
        `INSERT INTO events(id, entity_type, entity_id, event_type, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, entityType, entityId, eventType, actor, JSON.stringify(payload), this.now());
    return id;
  }

  saveCampaignDraft(input: CampaignDraftInput): {
    briefId: string;
    versionId: string;
    versionNumber: number;
    briefHash: string;
    created: boolean;
  } {
    const briefKey = input.briefKey.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    const status = input.status ?? "PLAN_DRAFT";
    if (!briefKey || !createdBy) throw new Error("Campaign brief key and creator are required");
    const sourceTextHash = input.sourceTextHash?.trim().toLowerCase() || null;
    if (sourceTextHash && sourceTextHash.length < 16) throw new Error("Campaign source text hash is too short");
    const briefJson = canonicalJson(input.brief);
    const briefHash = canonicalHash(input.brief);
    return this.transaction(() => {
      let brief = this.db.prepare("SELECT id FROM campaign_briefs WHERE brief_key=?")
        .get(briefKey) as { id: string } | undefined;
      if (!brief) {
        const briefId = this.id("cbrief");
        const now = this.now();
        this.db.prepare(
          `INSERT INTO campaign_briefs(id, brief_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(briefId, briefKey, status, now, now);
        brief = { id: briefId };
        this.recordEvent("campaign_brief", briefId, "CAMPAIGN_BRIEF_CREATED", createdBy, { briefKey });
      }
      const existing = this.db.prepare(
        `SELECT id, version_number FROM campaign_versions WHERE brief_id=? AND brief_hash=?`,
      ).get(brief.id, briefHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return {
          briefId: brief.id,
          versionId: existing.id,
          versionNumber: existing.version_number,
          briefHash,
          created: false,
        };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM campaign_versions WHERE brief_id=?",
      ).get(brief.id) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const versionId = this.id("cbriefv");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO campaign_versions(
           id, brief_id, version_number, brief_json, brief_hash, parser_version,
           source_text_hash, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        brief.id,
        versionNumber,
        briefJson,
        briefHash,
        input.parserVersion?.trim() || null,
        sourceTextHash,
        createdBy,
        now,
      );
      this.db.prepare(
        `UPDATE campaign_briefs SET current_version_id=?, status=?, shadow_authorized=0,
           provider_budget_authorized=0, external_send_authorized=0,
           content_publish_authorized=0, updated_at=? WHERE id=?`,
      ).run(versionId, status, now, brief.id);
      this.recordEvent("campaign_brief", brief.id, "CAMPAIGN_BRIEF_VERSION_CREATED", createdBy, {
        versionId,
        versionNumber,
        briefHash,
        approvalsInvalidated: versionNumber > 1,
      });
      return { briefId: brief.id, versionId, versionNumber, briefHash, created: true };
    });
  }

  saveCampaignScopedApproval(
    input: CampaignScopedApprovalInput,
    authorization: WorkflowAuthorization,
  ): { id: string; created: boolean; scope: CampaignScopedApprovalInput["scope"] } {
    const requiredRoles: Record<CampaignScopedApprovalInput["scope"], readonly WorkflowRole[]> = {
      SHADOW_PLAN: ["CAMPAIGN_APPROVER", "SALES_MANAGER"],
      PROVIDER_BUDGET: ["BUDGET_APPROVER", "SALES_MANAGER"],
      EXTERNAL_SEND: ["SALES_MANAGER"],
      CONTENT_PUBLICATION: ["PUBLISHER"],
    };
    const actor = this.assertWorkflowAuthorization(authorization, `Campaign approval ${input.scope}`, {
      human: true,
      roles: requiredRoles[input.scope],
    });
    const actionId = input.actionId.trim();
    const authorizationSource = input.authorizationSource.trim();
    if (!actionId || !authorizationSource) {
      throw new Error("Campaign approval action id and authorization source are required");
    }
    if (input.scope === "PROVIDER_BUDGET" && (!input.budgetHash || input.budgetHash.length !== 64)) {
      throw new Error("Provider budget approval requires the exact 64-character budget hash");
    }
    return this.transaction(() => {
      const replay = this.db.prepare(
        "SELECT id, brief_id, version_id, scope FROM campaign_approvals WHERE action_id=?",
      ).get(actionId) as {
        id: string;
        brief_id: string;
        version_id: string;
        scope: CampaignScopedApprovalInput["scope"];
      } | undefined;
      if (replay) {
        if (replay.scope !== input.scope || replay.brief_id !== input.briefId ||
          replay.version_id !== input.versionId) {
          throw new Error("Campaign approval action id was reused for different review material");
        }
        return { id: replay.id, created: false, scope: replay.scope };
      }
      const version = this.db.prepare(
        `SELECT cv.brief_id, cv.brief_hash, cv.brief_json, cb.current_version_id
         FROM campaign_versions cv JOIN campaign_briefs cb ON cb.id=cv.brief_id
         WHERE cv.id=? AND cv.brief_id=?`,
      ).get(input.versionId, input.briefId) as {
        brief_id: string;
        brief_hash: string;
        brief_json: string;
        current_version_id: string | null;
      } | undefined;
      if (!version) throw new Error("Campaign brief version does not belong to the supplied brief");
      if (version.current_version_id !== input.versionId) {
        throw new Error("A stale campaign brief version cannot be approved");
      }
      if (input.scope === "PROVIDER_BUDGET") {
        const brief = parseJsonRecord(version.brief_json);
        const expectedBudgetHash = canonicalHash({
          providerBudget: brief.providerBudget ?? null,
          llmBudget: brief.llmBudget ?? null,
        });
        if (input.budgetHash?.trim().toLowerCase() !== expectedBudgetHash) {
          throw new Error("Provider budget approval hash does not match the current campaign budget");
        }
      }
      const existingScope = this.db.prepare(
        "SELECT id FROM campaign_approvals WHERE version_id=? AND scope=?",
      ).get(input.versionId, input.scope) as { id: string } | undefined;
      if (existingScope) return { id: existingScope.id, created: false, scope: input.scope };
      const id = this.id("capproval");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO campaign_approvals(
           id, brief_id, version_id, scope, action_id, brief_hash, budget_hash,
           approved_by, approved_actor_type, authorization_source, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', ?, ?, ?)`,
      ).run(
        id,
        input.briefId,
        input.versionId,
        input.scope,
        actionId,
        version.brief_hash,
        input.budgetHash?.trim().toLowerCase() || null,
        actor,
        authorizationSource,
        input.reason?.trim().slice(0, 2000) || null,
        now,
      );
      const status = input.scope === "SHADOW_PLAN"
        ? "PLAN_APPROVED"
        : input.scope === "PROVIDER_BUDGET"
          ? "BUDGET_APPROVED"
          : input.scope === "EXTERNAL_SEND"
            ? "READY_FOR_SEND_EXPERIMENT"
            : null;
      this.db.prepare(
        `UPDATE campaign_briefs SET
           status=coalesce(?, status),
           shadow_authorized=CASE WHEN ?='SHADOW_PLAN' THEN 1 ELSE shadow_authorized END,
           provider_budget_authorized=CASE WHEN ?='PROVIDER_BUDGET' THEN 1 ELSE provider_budget_authorized END,
           external_send_authorized=CASE WHEN ?='EXTERNAL_SEND' THEN 1 ELSE external_send_authorized END,
           content_publish_authorized=CASE WHEN ?='CONTENT_PUBLICATION' THEN 1 ELSE content_publish_authorized END,
           updated_at=? WHERE id=? AND current_version_id=?`,
      ).run(status, input.scope, input.scope, input.scope, input.scope, now, input.briefId, input.versionId);
      this.recordEvent("campaign_brief", input.briefId, "CAMPAIGN_SCOPE_APPROVED", actor, {
        approvalId: id,
        versionId: input.versionId,
        scope: input.scope,
        authorizationSource,
      });
      return { id, created: true, scope: input.scope };
    });
  }

  bindProviderCampaign(input: CampaignProviderBindingInput): { created: boolean } {
    const campaignId = input.campaignId.trim();
    const briefId = input.briefId.trim();
    const versionId = input.versionId.trim();
    const briefHash = input.briefHash.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    if (!campaignId || !briefId || !versionId || !createdBy || !/^[a-f0-9]{64}$/.test(briefHash)) {
      throw new Error("Provider campaign binding requires exact campaign, brief, version, hash, and actor");
    }
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT brief_id, version_id, brief_hash FROM campaign_provider_bindings WHERE campaign_id=?",
      ).get(campaignId) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.brief_id !== briefId || existing.version_id !== versionId || existing.brief_hash !== briefHash) {
          throw new Error("Campaign is already immutably bound to another provider brief version");
        }
        return { created: false };
      }
      const material = this.db.prepare(
        `SELECT cv.brief_json, cv.brief_hash, cb.current_version_id,
                cb.shadow_authorized, cb.provider_budget_authorized,
                ca.budget_hash, ca.approved_actor_type,
                shadow_ca.approved_actor_type AS shadow_approved_actor_type
         FROM campaign_versions cv
         JOIN campaign_briefs cb ON cb.id=cv.brief_id
         JOIN campaign_approvals ca ON ca.brief_id=cv.brief_id AND ca.version_id=cv.id
           AND ca.scope='PROVIDER_BUDGET'
         JOIN campaign_approvals shadow_ca ON shadow_ca.brief_id=cv.brief_id
           AND shadow_ca.version_id=cv.id AND shadow_ca.scope='SHADOW_PLAN'
         JOIN campaigns cmp ON cmp.id=?
         WHERE cv.id=? AND cv.brief_id=?`,
      ).get(campaignId, versionId, briefId) as Record<string, unknown> | undefined;
      if (!material || material.brief_hash !== briefHash || material.current_version_id !== versionId ||
        !material.shadow_authorized || !material.provider_budget_authorized ||
        material.approved_actor_type !== "HUMAN" || material.shadow_approved_actor_type !== "HUMAN") {
        throw new Error("Provider campaign binding requires an exact current human-approved budget scope");
      }
      const brief = parseJsonRecord(String(material.brief_json));
      const allowedProviders = Array.isArray(
        (brief.providerBudget as Record<string, unknown> | undefined)?.allowedProviders,
      )
        ? ((brief.providerBudget as Record<string, unknown>).allowedProviders as unknown[])
          .map((provider) => String(provider).trim().toLowerCase()).filter(Boolean)
        : [];
      const selectedVerifiers = ["hunter", "bouncer"]
        .filter((provider) => allowedProviders.includes(provider));
      if (selectedVerifiers.length > 1) {
        throw new Error("Provider campaign binding permits at most one independent email verifier");
      }
      const expectedBudgetHash = canonicalHash({
        providerBudget: brief.providerBudget ?? null,
        llmBudget: brief.llmBudget ?? null,
      });
      if (material.budget_hash !== expectedBudgetHash) {
        throw new Error("Provider campaign binding budget hash is stale");
      }
      const now = this.now();
      this.db.prepare(
        `INSERT INTO campaign_provider_bindings(
           campaign_id, brief_id, version_id, brief_hash, bound_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(campaignId, briefId, versionId, briefHash, createdBy, now);
      this.recordEvent("campaign", campaignId, "CAMPAIGN_PROVIDER_BOUND", createdBy, {
        briefId,
        versionId,
        briefHash,
        budgetHash: expectedBudgetHash,
      });
      return { created: true };
    });
  }

  getAuthorizedProviderCampaignContext(
    campaignIdInput: string,
    providerKeyInput: string,
    options: { chargeable: boolean },
  ): Record<string, unknown> {
    const campaignId = campaignIdInput.trim();
    const providerKey = providerKeyInput.trim().toLowerCase();
    if (!campaignId || !providerKey) throw new Error("Provider campaign context requires campaign and provider");
    const row = this.db.prepare(
      `SELECT cpb.campaign_id, cpb.brief_id, cpb.version_id,
              cpb.brief_hash AS binding_brief_hash, cv.brief_hash AS version_brief_hash,
              cv.brief_json, cb.current_version_id, cb.shadow_authorized,
              cb.provider_budget_authorized, ca.id AS budget_approval_id,
              ca.budget_hash, ca.approved_actor_type,
              shadow_ca.approved_actor_type AS shadow_approved_actor_type,
              pr.id AS provider_id, pr.provider_key, pr.status AS provider_status,
              pr.capabilities_json, pr.policy_json
       FROM campaign_provider_bindings cpb
       JOIN campaign_versions cv ON cv.id=cpb.version_id AND cv.brief_id=cpb.brief_id
       JOIN campaign_briefs cb ON cb.id=cpb.brief_id
       JOIN campaign_approvals ca ON ca.brief_id=cpb.brief_id AND ca.version_id=cpb.version_id
         AND ca.scope='PROVIDER_BUDGET'
       JOIN campaign_approvals shadow_ca ON shadow_ca.brief_id=cpb.brief_id
         AND shadow_ca.version_id=cpb.version_id AND shadow_ca.scope='SHADOW_PLAN'
       JOIN provider_registry pr ON lower(pr.provider_key)=?
       WHERE cpb.campaign_id=?`,
    ).get(providerKey, campaignId) as Record<string, unknown> | undefined;
    if (!row || row.current_version_id !== row.version_id ||
      row.binding_brief_hash !== row.version_brief_hash ||
      !row.shadow_authorized || !row.provider_budget_authorized ||
      row.approved_actor_type !== "HUMAN" || row.shadow_approved_actor_type !== "HUMAN" ||
      row.provider_status !== "ENABLED") {
      throw new Error("Provider campaign context is missing, stale, disabled, or unauthorized");
    }
    const brief = parseJsonRecord(String(row.brief_json));
    const providerBudget = brief.providerBudget && typeof brief.providerBudget === "object" &&
      !Array.isArray(brief.providerBudget)
      ? brief.providerBudget as Record<string, unknown>
      : null;
    if (!providerBudget || providerBudget.requiresSeparateApproval !== true ||
      !Array.isArray(providerBudget.allowedProviders)) {
      throw new Error("Campaign Provider Budget is absent or invalid");
    }
    const allowedProviders = providerBudget.allowedProviders
      .map((value) => String(value).trim().toLowerCase()).filter(Boolean);
    const selectedVerifiers = ["hunter", "bouncer"]
      .filter((provider) => allowedProviders.includes(provider));
    if (selectedVerifiers.length > 1) {
      throw new Error("Campaign Provider Budget permits at most one independent email verifier");
    }
    if (!allowedProviders.includes(providerKey)) {
      throw new Error("Provider is not included in the exact approved campaign budget");
    }
    const maxUnits = Number(providerBudget.maxUnits);
    const maxAmountUsd = Number(providerBudget.maxAmountUsd);
    if (!Number.isFinite(maxUnits) || maxUnits < 0 || !Number.isFinite(maxAmountUsd) || maxAmountUsd < 0) {
      throw new Error("Campaign Provider Budget caps are invalid");
    }
    const expectedBudgetHash = canonicalHash({
      providerBudget: brief.providerBudget ?? null,
      llmBudget: brief.llmBudget ?? null,
    });
    if (row.budget_hash !== expectedBudgetHash) {
      throw new Error("Campaign Provider Budget approval hash is stale");
    }
    const budgetMode = String(providerBudget.mode ?? "");
    const providerPolicy = parseJsonRecord(String(row.policy_json));
    if (typeof providerPolicy.chargeable !== "boolean" ||
      providerPolicy.chargeable !== options.chargeable) {
      throw new Error("Provider chargeability does not match the immutable registry policy");
    }
    if (options.chargeable) {
      if (budgetMode !== "CAPPED" || (maxUnits === 0 && maxAmountUsd === 0)) {
        throw new Error("Chargeable provider requires a positive CAPPED Provider Budget");
      }
    } else if (new Set(["searxng", "local-public-web"]).has(providerKey) &&
      !((budgetMode === "ZERO_COST" && maxUnits === 0 && maxAmountUsd === 0) || budgetMode === "CAPPED")) {
      throw new Error("Zero-cost public-web providers require an approved ZERO_COST or CAPPED campaign budget");
    }
    return {
      ...row,
      providerKey,
      providerBudget,
      providerBudgetHash: expectedBudgetHash,
      chargeable: providerPolicy.chargeable,
    };
  }

  beginProviderRun(input: ProviderRunBeginInput): {
    status: "STARTED" | "CACHED" | "IN_FLIGHT";
    providerRunId: string;
    providerAttemptId: string | null;
    attemptNumber: number | null;
    response: Record<string, unknown> | null;
    cacheExpiresAt: string | null;
  } {
    const providerKey = input.providerKey.trim().toLowerCase();
    const operation = input.operation.trim();
    const requestHash = input.requestHash.trim().toLowerCase();
    const requestedCount = Math.trunc(input.requestedCount);
    const estimatedUnits = input.chargeable
      ? Number(input.estimatedUnits ?? requestedCount)
      : 0;
    const estimatedCostMicros = input.chargeable
      ? Math.trunc(input.estimatedCostMicros ?? 0)
      : 0;
    const staleAfterSeconds = Math.trunc(input.staleAfterSeconds ?? 300);
    if (!providerKey || !operation || !/^[a-f0-9]{16,}$/.test(requestHash) ||
      !Number.isSafeInteger(requestedCount) || requestedCount < 0 ||
      !Number.isFinite(estimatedUnits) || estimatedUnits < 0 ||
      !Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0 ||
      !Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1 || staleAfterSeconds > 86_400) {
      throw new Error("Provider run requires provider, operation, request hash, and requested count");
    }
    const context = this.getAuthorizedProviderCampaignContext(
      input.campaignId,
      providerKey,
      { chargeable: input.chargeable },
    );
    if (context.version_id !== input.versionId.trim()) {
      throw new Error("Provider request version does not match the authorized campaign binding");
    }
    const idempotencyKey = `campaign-provider:${input.campaignId.trim()}:${input.versionId.trim()}:${providerKey}:${requestHash}`;
    return this.transaction(() => {
      const now = this.now();
      let run = this.db.prepare(
        `SELECT * FROM provider_runs WHERE idempotency_key=?`,
      ).get(idempotencyKey) as Record<string, unknown> | undefined;
      if (run && (run.request_hash !== requestHash || run.provider_id !== context.provider_id ||
        run.campaign_id !== input.campaignId.trim() || run.campaign_version_id !== input.versionId.trim())) {
        throw new Error("Provider run idempotency key resolved to different request material");
      }
      if (run && new Set(["SUCCEEDED", "PARTIAL"]).has(String(run.status))) {
        const cached = this.db.prepare(
          `SELECT response_json, expires_at FROM provider_response_cache
           WHERE provider_run_id=? AND request_hash=? AND expires_at>?
           ORDER BY created_at DESC LIMIT 1`,
        ).get(String(run.id), requestHash, now) as Record<string, unknown> | undefined;
        if (cached) {
          return {
            status: "CACHED" as const,
            providerRunId: String(run.id),
            providerAttemptId: null,
            attemptNumber: null,
            response: parseJsonRecord(String(cached.response_json)),
            cacheExpiresAt: String(cached.expires_at),
          };
        }
      }
      if (run?.status === "RUNNING") {
        const runningAttempt = this.db.prepare(
          `SELECT id, attempt_number FROM provider_attempts
           WHERE provider_run_id=? AND status='RUNNING'
           ORDER BY attempt_number DESC LIMIT 1`,
        ).get(String(run.id)) as { id: string; attempt_number: number } | undefined;
        const leaseTimestamp = Date.parse(String(run.updated_at ?? run.started_at ?? ""));
        const leaseExpired = !Number.isFinite(leaseTimestamp) ||
          Date.parse(now) - leaseTimestamp >= staleAfterSeconds * 1_000;
        if (!leaseExpired) {
          return {
            status: "IN_FLIGHT" as const,
            providerRunId: String(run.id),
            providerAttemptId: runningAttempt?.id ?? null,
            attemptNumber: runningAttempt?.attempt_number ?? null,
            response: null,
            cacheExpiresAt: null,
          };
        }
        this.db.prepare(
          `UPDATE provider_attempts SET status='FAILED',
             error_class='STALE_PROVIDER_RUN_LEASE_EXPIRED', completed_at=?
           WHERE provider_run_id=? AND status='RUNNING'`,
        ).run(now, String(run.id));
        this.db.prepare(
          `UPDATE provider_runs SET status='FAILED',
             error_class='STALE_PROVIDER_RUN_LEASE_EXPIRED', completed_at=?, updated_at=?
           WHERE id=? AND status='RUNNING'`,
        ).run(now, now, String(run.id));
        this.recordEvent("provider_run", String(run.id), "PROVIDER_RUN_STALE_LEASE_RECOVERED", "system", {
          staleAttemptId: runningAttempt?.id ?? null,
          staleAfterSeconds,
          requestHash,
        });
        run = this.db.prepare("SELECT * FROM provider_runs WHERE id=?").get(String(run.id)) as Record<string, unknown>;
      }

      if (input.chargeable) {
        const providerBudget = context.providerBudget as Record<string, unknown>;
        const maxUnits = Number(providerBudget.maxUnits);
        const maxCostMicros = Math.floor(Number(providerBudget.maxAmountUsd) * 1_000_000 + 0.000_001);
        const committed = this.db.prepare(
          `SELECT coalesce(sum(usage.units), 0) AS units,
                  coalesce(sum(usage.cost_micros), 0) AS cost_micros
           FROM resource_usage usage
           JOIN provider_runs provider_run ON provider_run.id=usage.provider_run_id
           WHERE provider_run.campaign_id=? AND provider_run.campaign_version_id=?`,
        ).get(
          input.campaignId.trim(),
          input.versionId.trim(),
        ) as { units: number; cost_micros: number };
        const reserved = this.db.prepare(
          `SELECT coalesce(sum(CAST(json_extract(metadata_json, '$.reservedUnits') AS REAL)), 0) AS units,
                  coalesce(sum(CAST(json_extract(metadata_json, '$.reservedCostMicros') AS INTEGER)), 0) AS cost_micros
           FROM provider_runs
           WHERE campaign_id=? AND campaign_version_id=? AND status='RUNNING'`,
        ).get(
          input.campaignId.trim(),
          input.versionId.trim(),
        ) as { units: number; cost_micros: number };
        if (Number(committed.units) + Number(reserved.units) + estimatedUnits > maxUnits ||
          Number(committed.cost_micros) + Number(reserved.cost_micros) + estimatedCostMicros > maxCostMicros) {
          throw new Error("Campaign Provider Budget is exhausted for this chargeable request");
        }
      }

      let providerRunId: string;
      if (!run) {
        providerRunId = this.id("providerrun");
        this.db.prepare(
          `INSERT INTO provider_runs(
             id, provider_id, operation, status, idempotency_key, request_hash,
             requested_count, returned_count, started_at, metadata_json, created_at, updated_at,
             campaign_id, campaign_version_id
           ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        ).run(
          providerRunId,
          String(context.provider_id),
          operation,
          idempotencyKey,
          requestHash,
          requestedCount,
          now,
          canonicalJson({
            ...(input.metadata ?? {}),
            campaignId: input.campaignId.trim(),
            versionId: input.versionId.trim(),
            providerBudgetHash: context.providerBudgetHash,
            chargeable: input.chargeable,
            reservedUnits: estimatedUnits,
            reservedCostMicros: estimatedCostMicros,
            staleAfterSeconds,
          }),
          now,
          now,
          input.campaignId.trim(),
          input.versionId.trim(),
        );
        run = { id: providerRunId };
      } else {
        providerRunId = String(run.id);
        const existingMetadata = parseJsonRecord(String(run.metadata_json ?? "{}"));
        this.db.prepare(
          `UPDATE provider_runs SET status='RUNNING', error_class=NULL, completed_at=NULL,
             metadata_json=?, updated_at=?
           WHERE id=? AND status IN ('FAILED','PARTIAL','SUCCEEDED','SKIPPED')`,
        ).run(canonicalJson({
          ...existingMetadata,
          ...(input.metadata ?? {}),
          campaignId: input.campaignId.trim(),
          versionId: input.versionId.trim(),
          providerBudgetHash: context.providerBudgetHash,
          chargeable: input.chargeable,
          reservedUnits: estimatedUnits,
          reservedCostMicros: estimatedCostMicros,
          staleAfterSeconds,
        }), now, providerRunId);
      }
      const attemptRow = this.db.prepare(
        "SELECT coalesce(max(attempt_number), 0) AS attempt_number FROM provider_attempts WHERE provider_run_id=?",
      ).get(providerRunId) as { attempt_number: number };
      const attemptNumber = Number(attemptRow.attempt_number) + 1;
      const providerAttemptId = this.id("providerattempt");
      this.db.prepare(
        `INSERT INTO provider_attempts(
           id, provider_run_id, attempt_number, status, request_hash, started_at, created_at
         ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`,
      ).run(providerAttemptId, providerRunId, attemptNumber, requestHash, now, now);
      this.recordEvent("provider_run", providerRunId, "PROVIDER_RUN_STARTED", "system", {
        providerAttemptId,
        attemptNumber,
        campaignId: input.campaignId.trim(),
        versionId: input.versionId.trim(),
        providerKey,
        requestHash,
      });
      return {
        status: "STARTED" as const,
        providerRunId,
        providerAttemptId,
        attemptNumber,
        response: null,
        cacheExpiresAt: null,
      };
    });
  }

  completeProviderRun(input: ProviderRunCompleteInput): { created: boolean; cacheExpiresAt: string } {
    const returnedCount = Math.trunc(input.returnedCount);
    const cacheTtlSeconds = Math.trunc(input.cacheTtlSeconds);
    const units = Number(input.units);
    const costMicros = Math.trunc(input.costMicros);
    const currency = (input.currency ?? "USD").trim().toUpperCase();
    if (!Number.isSafeInteger(returnedCount) || returnedCount < 0 ||
      !Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds <= 0 || cacheTtlSeconds > 30 * 86_400 ||
      !Number.isFinite(units) || units < 0 || !Number.isSafeInteger(costMicros) || costMicros < 0 ||
      !/^[A-Z]{3}$/.test(currency) || !/^[a-f0-9]{16,}$/.test(input.resultHash.trim().toLowerCase()) ||
      !input.usageIdempotencyKey.trim()) {
      throw new Error("Provider completion metrics, cache TTL, result hash, or usage key are invalid");
    }
    const responseJson = canonicalJson(input.response);
    const responseHash = canonicalHash(input.response);
    return this.transaction(() => {
      const run = this.db.prepare(
        `SELECT pr.*, registry.provider_key
         FROM provider_runs pr JOIN provider_registry registry ON registry.id=pr.provider_id
         WHERE pr.id=?`,
      ).get(input.providerRunId.trim()) as Record<string, unknown> | undefined;
      const attempt = this.db.prepare(
        "SELECT * FROM provider_attempts WHERE id=? AND provider_run_id=?",
      ).get(input.providerAttemptId.trim(), input.providerRunId.trim()) as Record<string, unknown> | undefined;
      if (!run || !attempt) throw new Error("Provider run or attempt not found");
      const existingCache = this.db.prepare(
        "SELECT expires_at, response_hash FROM provider_response_cache WHERE provider_attempt_id=?",
      ).get(input.providerAttemptId.trim()) as Record<string, unknown> | undefined;
      if (existingCache) {
        if (existingCache.response_hash !== responseHash) {
          throw new Error("Provider completion replay changed the cached response");
        }
        return { created: false, cacheExpiresAt: String(existingCache.expires_at) };
      }
      if (run.status !== "RUNNING" || attempt.status !== "RUNNING") {
        throw new Error("Only a running provider attempt can complete");
      }
      if (new Set(["searxng", "local-public-web"]).has(String(run.provider_key).toLowerCase()) &&
        (units !== 0 || costMicros !== 0)) {
        throw new Error("Zero-cost public-web provider usage must remain explicitly zero cost");
      }
      const existingMetadata = parseJsonRecord(String(run.metadata_json));
      if (existingMetadata.chargeable === true &&
        (units > Number(existingMetadata.reservedUnits ?? 0) ||
          costMicros > Number(existingMetadata.reservedCostMicros ?? 0))) {
        throw new Error("Provider actual usage exceeds the campaign budget reservation");
      }
      const now = this.now();
      const cacheExpiresAt = new Date(Date.parse(now) + cacheTtlSeconds * 1000).toISOString();
      this.db.prepare(
        `UPDATE provider_attempts SET status='SUCCEEDED', response_hash=?, completed_at=? WHERE id=?`,
      ).run(responseHash, now, input.providerAttemptId.trim());
      this.db.prepare(
        `UPDATE provider_runs SET status='SUCCEEDED', returned_count=?, result_hash=?,
           error_class=NULL, completed_at=?, metadata_json=?, updated_at=? WHERE id=?`,
      ).run(
        returnedCount,
        input.resultHash.trim().toLowerCase(),
        now,
        canonicalJson({ ...existingMetadata, ...(input.metadata ?? {}), cacheExpiresAt, responseHash }),
        now,
        input.providerRunId.trim(),
      );
      this.db.prepare(
        `INSERT INTO resource_usage(
           id, provider_id, provider_run_id, resource_type, operation, units,
           cost_micros, currency, idempotency_key, occurred_at, metadata_json, created_at
         ) VALUES (?, ?, ?, 'PROVIDER_REQUEST', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.id("usage"),
        String(run.provider_id),
        input.providerRunId.trim(),
        String(run.operation),
        units,
        costMicros,
        currency,
        input.usageIdempotencyKey.trim(),
        now,
        canonicalJson({ campaignId: run.campaign_id, versionId: run.campaign_version_id }),
        now,
      );
      this.db.prepare(
        `INSERT INTO provider_response_cache(
           id, provider_run_id, provider_attempt_id, campaign_id, version_id, provider_id,
           request_hash, response_json, response_hash, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.id("providercache"),
        input.providerRunId.trim(),
        input.providerAttemptId.trim(),
        String(run.campaign_id),
        String(run.campaign_version_id),
        String(run.provider_id),
        String(run.request_hash),
        responseJson,
        responseHash,
        cacheExpiresAt,
        now,
      );
      this.recordEvent("provider_run", input.providerRunId.trim(), "PROVIDER_RUN_SUCCEEDED", "system", {
        providerAttemptId: input.providerAttemptId.trim(),
        returnedCount,
        resultHash: input.resultHash.trim().toLowerCase(),
        responseHash,
        units,
        costMicros,
        cacheExpiresAt,
      });
      return { created: true, cacheExpiresAt };
    });
  }

  failProviderRun(input: ProviderRunFailInput): { changed: boolean } {
    const errorClass = input.errorClass.trim();
    if (!input.providerRunId.trim() || !input.providerAttemptId.trim() || !errorClass) {
      throw new Error("Provider failure requires run, attempt, and error class");
    }
    return this.transaction(() => {
      const now = this.now();
      const attempt = this.db.prepare(
        `UPDATE provider_attempts SET status='FAILED', http_status=?, retry_after_seconds=?,
           error_class=?, response_hash=?, completed_at=?
         WHERE id=? AND provider_run_id=? AND status='RUNNING'`,
      ).run(
        input.httpStatus ?? null,
        input.retryAfterSeconds ?? null,
        errorClass.slice(0, 200),
        input.responseHash?.trim() || null,
        now,
        input.providerAttemptId.trim(),
        input.providerRunId.trim(),
      );
      if (attempt.changes !== 1) return { changed: false };
      this.db.prepare(
        `UPDATE provider_runs SET status='FAILED', error_class=?, completed_at=?, updated_at=?
         WHERE id=? AND status='RUNNING'`,
      ).run(errorClass.slice(0, 200), now, now, input.providerRunId.trim());
      this.recordEvent("provider_run", input.providerRunId.trim(), "PROVIDER_RUN_FAILED", "system", {
        providerAttemptId: input.providerAttemptId.trim(),
        errorClass,
        httpStatus: input.httpStatus ?? null,
        retryAfterSeconds: input.retryAfterSeconds ?? null,
      });
      return { changed: true };
    });
  }

  persistIndependentEmailVerification(
    input: IndependentEmailVerificationPersistenceInput,
  ): { discoveryCreated: boolean; verificationCreated: boolean } {
    const verifierMetadata = INDEPENDENT_OFFICIAL_EMAIL_VERIFIERS[
      input.verifierSourceKey as IndependentOfficialEmailVerifier
    ];
    const requiredIds = [
      input.contactId,
      input.campaignId,
      input.versionId,
      input.providerRunId,
      input.discoveryAssertionId,
      input.verificationAssertionId,
    ].map((value) => value.trim());
    const observedAtMs = Date.parse(input.observedAt);
    const expiresAtMs = Date.parse(input.expiresAt);
    let discoverySourceUrl: URL;
    try {
      discoverySourceUrl = new URL(input.discoverySourceUrl);
    } catch {
      throw new Error("Independent email verification requires a public discovery URL");
    }
    if (requiredIds.some((value) => !value || value.length > 200) ||
      !/^[a-f0-9]{64}$/.test(input.emailHash) ||
      !/^[a-f0-9]{64}$/.test(input.discoveryEvidenceHash) ||
      !/^[a-f0-9]{64}$/.test(input.rawPayloadHash) ||
      input.discoverySourceKey !== "LOCAL_PUBLIC_WEB" || !verifierMetadata ||
      !new Set(["http:", "https:"]).has(discoverySourceUrl.protocol) ||
      discoverySourceUrl.username !== "" || discoverySourceUrl.password !== "" ||
      !Number.isFinite(observedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= observedAtMs ||
      !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 ||
      !Number.isFinite(input.creditUnits) || input.creditUnits < 0 ||
      !Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0) {
      throw new Error("Independent email verification provenance is invalid");
    }
    if (input.providerMailboxVerdict === "VALID_ASSERTION" &&
      (input.catchAll || input.disposable || input.roleMailbox)) {
      throw new Error("Risky mailbox flags cannot be persisted as independently VALID");
    }

    return this.transaction(() => {
      const material = this.db.prepare(
        `SELECT c.email, c.source_url, cp.id AS contact_point_id, cp.person_id,
                provider_run.status AS provider_run_status,
                provider_run.operation, provider_run.campaign_id,
                provider_run.campaign_version_id, provider.id AS provider_id,
                provider.provider_key, cache.response_json
         FROM contacts c
         JOIN contact_points cp ON cp.legacy_contact_id=c.id AND cp.kind='EMAIL'
           AND lower(trim(cp.normalized_value))=lower(trim(c.email))
         JOIN provider_runs provider_run ON provider_run.id=?
         JOIN provider_registry provider ON provider.id=provider_run.provider_id
         JOIN provider_response_cache cache ON cache.provider_run_id=provider_run.id
         WHERE c.id=?
         ORDER BY cache.created_at DESC LIMIT 1`,
      ).get(input.providerRunId.trim(), input.contactId.trim()) as Record<string, unknown> | undefined;
      const normalizedEmail = String(material?.email ?? "").trim().toLowerCase();
      const emailHash = crypto.createHash("sha256").update(normalizedEmail).digest("hex");
      if (!material || !normalizedEmail || emailHash !== input.emailHash ||
        material.provider_run_status !== "SUCCEEDED" || material.operation !== "EMAIL_VERIFICATION" ||
        material.campaign_id !== input.campaignId.trim() ||
        material.campaign_version_id !== input.versionId.trim() ||
        material.provider_id !== verifierMetadata.providerRegistryId ||
        String(material.provider_key).toLowerCase() !== verifierMetadata.providerKey ||
        String(material.source_url ?? "") !== discoverySourceUrl.toString()) {
        throw new Error("Independent email verification does not match the contact or provider run");
      }
      const cachedResponseResult = ProviderResponseSchema.safeParse(
        parseJsonRecord(String(material.response_json)),
      );
      if (!cachedResponseResult.success) {
        throw new Error("Independent email verification provider response contract is invalid");
      }
      const cachedResponse = cachedResponseResult.data;
      const cachedAssertion = cachedResponse.assertions.find((assertion) =>
        assertion.kind === "EMAIL_VERIFICATION" &&
        assertion.assertionId === input.verificationAssertionId.trim());
      if (!cachedAssertion || cachedResponse.providerId !== input.verifierSourceKey ||
        cachedResponse.operation !== "EMAIL_VERIFICATION" ||
        cachedResponse.result !== "ASSERTIONS_RETURNED" ||
        cachedResponse.rawPayloadHash !== input.rawPayloadHash ||
        cachedAssertion.kind !== "EMAIL_VERIFICATION" ||
        cachedAssertion.providerId !== input.verifierSourceKey ||
        cachedAssertion.accountId !== input.campaignId.trim() ||
        cachedAssertion.sourceUri !== verifierMetadata.sourceUri ||
        cachedAssertion.emailHash !== input.emailHash ||
        cachedAssertion.discoveryAssertionId !== input.discoveryAssertionId.trim() ||
        cachedAssertion.discoveryProviderId !== "LOCAL_PUBLIC_WEB" ||
        cachedAssertion.verificationProviderId !== input.verifierSourceKey ||
        cachedAssertion.providerMailboxVerdict !== input.providerMailboxVerdict ||
        Boolean(cachedAssertion.catchAll) !== input.catchAll ||
        Boolean(cachedAssertion.disposable) !== input.disposable ||
        Boolean(cachedAssertion.roleMailbox) !== input.roleMailbox ||
        Number(cachedAssertion.confidence) !== input.confidence ||
        Number(cachedAssertion.creditUnits) !== input.creditUnits ||
        Math.round(Number(cachedAssertion.estimatedUsd) * 1_000_000) !== input.estimatedCostMicros ||
        cachedAssertion.rawPayloadHash !== input.rawPayloadHash ||
        cachedAssertion.observedAt !== input.observedAt || cachedAssertion.expiresAt !== input.expiresAt) {
        throw new Error("Independent email verification is not present in the immutable provider response");
      }
      const providers = this.db.prepare(
        `SELECT provider_key, id FROM provider_registry
         WHERE id IN ('provider_local_public_web', ?)`,
      ).all(verifierMetadata.providerRegistryId) as Array<{ provider_key: string; id: string }>;
      const discoveryProviderId = providers.find((row) =>
        row.id === "provider_local_public_web" && row.provider_key.toLowerCase() === "local-public-web")?.id;
      const verificationProviderId = providers.find((row) =>
        row.id === verifierMetadata.providerRegistryId &&
        row.provider_key.toLowerCase() === verifierMetadata.providerKey)?.id;
      if (!discoveryProviderId || !verificationProviderId || discoveryProviderId === verificationProviderId) {
        throw new Error("Independent email verification providers are unavailable or not independent");
      }

      const discoveryRowId = `strict_discovery_${canonicalHash({
        contactId: input.contactId.trim(),
        assertionId: input.discoveryAssertionId.trim(),
        verificationAssertionId: input.verificationAssertionId.trim(),
      }).slice(0, 48)}`;
      const verificationRowId = `strict_verification_${canonicalHash({
        contactId: input.contactId.trim(),
        assertionId: input.verificationAssertionId.trim(),
        ...(input.verifierSourceKey === "HUNTER" ? {} : { verifierSourceKey: input.verifierSourceKey }),
      }).slice(0, 48)}`;
      const now = this.now();
      const discoveryInsert = this.db.prepare(
        `INSERT OR IGNORE INTO contact_provider_assertions(
           id, provider_id, person_id, contact_point_id, assertion_type, attribute,
           value_hash, source_uri, observed_at, expires_at, confidence, result,
           raw_payload_hash, credit_units, estimated_cost_micros, idempotency_key, created_at,
           provider_assertion_id, discovery_assertion_id, discovery_provider_id,
           verification_provider_id, mailbox_verdict, independently_verified,
           campaign_id, campaign_version_id
         ) VALUES (?, ?, ?, ?, 'EMAIL_DISCOVERY', 'work_email_public_web_discovery',
           ?, ?, ?, ?, 1, 'ASSERTED', ?, 0, 0, ?, ?, ?, null, ?, null, null, 0, ?, ?)`,
      ).run(
        discoveryRowId,
        discoveryProviderId,
        String(material.person_id),
        String(material.contact_point_id),
        input.emailHash,
        discoverySourceUrl.toString(),
        input.observedAt,
        input.expiresAt,
        input.discoveryEvidenceHash,
        `strict-email-discovery:${input.contactId.trim()}:${input.discoveryAssertionId.trim()}:${input.verificationAssertionId.trim()}`,
        now,
        input.discoveryAssertionId.trim(),
        discoveryProviderId,
        input.campaignId.trim(),
        input.versionId.trim(),
      );
      const verificationResult = input.providerMailboxVerdict === "VALID_ASSERTION"
        ? "CONFIRMED"
        : input.providerMailboxVerdict === "INVALID_ASSERTION"
          ? "REJECTED"
          : "ASSERTED";
      const verificationInsert = this.db.prepare(
        `INSERT OR IGNORE INTO contact_provider_assertions(
           id, provider_id, provider_run_id, person_id, contact_point_id,
           assertion_type, attribute, value_hash, source_uri, observed_at, expires_at,
           confidence, result, raw_payload_hash, credit_units, estimated_cost_micros,
           idempotency_key, created_at, provider_assertion_id, discovery_assertion_id,
           discovery_provider_id, verification_provider_id, mailbox_verdict,
           independently_verified, campaign_id, campaign_version_id
         ) VALUES (?, ?, ?, ?, ?, 'EMAIL_VERIFICATION', 'work_email_independent_verification',
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        verificationRowId,
        verificationProviderId,
        input.providerRunId.trim(),
        String(material.person_id),
        String(material.contact_point_id),
        input.emailHash,
        verifierMetadata.sourceUri,
        input.observedAt,
        input.expiresAt,
        input.confidence,
        verificationResult,
        input.rawPayloadHash,
        input.creditUnits,
        input.estimatedCostMicros,
        input.verifierSourceKey === "HUNTER"
          ? `strict-email-verification:${input.contactId.trim()}:${input.verificationAssertionId.trim()}`
          : `strict-email-verification:bouncer:${input.contactId.trim()}:${input.verificationAssertionId.trim()}`,
        now,
        input.verificationAssertionId.trim(),
        input.discoveryAssertionId.trim(),
        discoveryProviderId,
        verificationProviderId,
        input.providerMailboxVerdict,
        input.campaignId.trim(),
        input.versionId.trim(),
      );
      const storedDiscovery = this.db.prepare(
        `SELECT provider_id, provider_assertion_id, value_hash, source_uri,
                discovery_provider_id, campaign_id, campaign_version_id
         FROM contact_provider_assertions WHERE id=?`,
      ).get(discoveryRowId) as Record<string, unknown> | undefined;
      const discoveryMismatches = !storedDiscovery
        ? ["missing"]
        : [
          storedDiscovery.provider_id !== discoveryProviderId ? "provider" : null,
          storedDiscovery.provider_assertion_id !== input.discoveryAssertionId.trim() ? "assertion" : null,
          storedDiscovery.value_hash !== input.emailHash ? "email_hash" : null,
          storedDiscovery.source_uri !== discoverySourceUrl.toString() ? "source_uri" : null,
          storedDiscovery.discovery_provider_id !== discoveryProviderId ? "discovery_provider" : null,
          storedDiscovery.campaign_id !== input.campaignId.trim() ? "campaign" : null,
          storedDiscovery.campaign_version_id !== input.versionId.trim() ? "version" : null,
        ].filter((value): value is string => value !== null);
      if (discoveryMismatches.length > 0) {
        throw new Error(
          `Independent email discovery idempotency replay changed provenance: ${discoveryMismatches.join(",")}`,
        );
      }
      const stored = this.db.prepare(
        `SELECT provider_id, provider_run_id, provider_assertion_id, discovery_assertion_id,
                value_hash, source_uri, result, mailbox_verdict, independently_verified,
                discovery_provider_id, verification_provider_id, campaign_id, campaign_version_id
         FROM contact_provider_assertions WHERE id=?`,
      ).get(verificationRowId) as Record<string, unknown> | undefined;
      if (!stored || stored.provider_id !== verificationProviderId ||
        stored.provider_run_id !== input.providerRunId.trim() ||
        stored.provider_assertion_id !== input.verificationAssertionId.trim() ||
        stored.discovery_assertion_id !== input.discoveryAssertionId.trim() ||
        stored.value_hash !== input.emailHash || stored.source_uri !== verifierMetadata.sourceUri ||
        stored.result !== verificationResult || stored.mailbox_verdict !== input.providerMailboxVerdict ||
        Number(stored.independently_verified) !== 1 ||
        stored.discovery_provider_id !== discoveryProviderId ||
        stored.verification_provider_id !== verificationProviderId ||
        stored.campaign_id !== input.campaignId.trim() || stored.campaign_version_id !== input.versionId.trim()) {
        throw new Error("Independent email verification idempotency replay changed provenance");
      }
      this.recordEvent("contact", input.contactId.trim(), "INDEPENDENT_EMAIL_VERIFICATION_PERSISTED", "system", {
        discoveryAssertionId: input.discoveryAssertionId.trim(),
        verificationAssertionId: input.verificationAssertionId.trim(),
        providerRunId: input.providerRunId.trim(),
        discoverySourceKey: input.discoverySourceKey,
        verifierSourceKey: input.verifierSourceKey,
        emailHash: input.emailHash,
        providerMailboxVerdict: input.providerMailboxVerdict,
      });
      return {
        discoveryCreated: discoveryInsert.changes === 1,
        verificationCreated: verificationInsert.changes === 1,
      };
    });
  }

  getIndependentValidEmailVerification(
    input: IndependentEmailVerificationQuery,
  ): IndependentEmailVerificationRecord | null {
    const email = input.email.trim().toLowerCase();
    const at = input.at ? new Date(input.at).toISOString() : this.now();
    if (!input.contactId.trim() || !email || !input.campaignId.trim() || !input.versionId.trim()) {
      return null;
    }
    const emailHash = crypto.createHash("sha256").update(email).digest("hex");
    const row = this.db.prepare(
      `SELECT discovery.provider_assertion_id AS discovery_assertion_id,
              verification.provider_assertion_id AS verification_assertion_id,
              verification.provider_run_id, verification.value_hash,
              verification.mailbox_verdict, verification.confidence, verification.observed_at,
              verification.expires_at,
              discovery_provider.provider_key AS discovery_provider_key,
              verifier_provider.id AS verifier_provider_id,
              verifier_provider.provider_key AS verifier_provider_key
       FROM contacts contact
       JOIN contact_points point ON point.legacy_contact_id=contact.id AND point.kind='EMAIL'
         AND lower(trim(point.normalized_value))=lower(trim(contact.email))
       JOIN contact_provider_assertions verification
         ON verification.contact_point_id=point.id
         AND verification.assertion_type='EMAIL_VERIFICATION'
       JOIN contact_provider_assertions discovery
         ON discovery.contact_point_id=point.id
         AND discovery.assertion_type='EMAIL_DISCOVERY'
         AND discovery.provider_assertion_id=verification.discovery_assertion_id
         AND discovery.provider_id=verification.discovery_provider_id
         AND discovery.value_hash=verification.value_hash
       JOIN provider_registry discovery_provider ON discovery_provider.id=discovery.provider_id
       JOIN provider_registry verifier_provider ON verifier_provider.id=verification.provider_id
       JOIN provider_runs provider_run ON provider_run.id=verification.provider_run_id
       WHERE contact.id=? AND lower(trim(contact.email))=? AND contact.email_status='VALID'
         AND contact.role_address=0 AND contact.disposable_address=0 AND contact.catch_all=0
         AND verification.value_hash=? AND verification.campaign_id=?
         AND verification.campaign_version_id=?
         AND discovery.campaign_id=verification.campaign_id
         AND discovery.campaign_version_id=verification.campaign_version_id
         AND verification.verification_provider_id=verification.provider_id
         AND verification.discovery_provider_id<>verification.provider_id
         AND verification.independently_verified=1
         AND verification.mailbox_verdict='VALID_ASSERTION'
         AND verification.result='CONFIRMED' AND verification.expires_at>?
         AND discovery.result IN ('ASSERTED','CONFIRMED') AND discovery.expires_at>?
         AND discovery.source_uri=contact.source_url
         AND lower(discovery_provider.provider_key)='local-public-web'
         AND (
           (verifier_provider.id='provider_hunter'
             AND lower(verifier_provider.provider_key)='hunter'
             AND verification.source_uri='https://hunter.io/email-verifier')
           OR
           (verifier_provider.id='provider_bouncer'
             AND lower(verifier_provider.provider_key)='bouncer'
             AND verification.source_uri='https://api.usebouncer.com/v1.1/email/verify')
         )
         AND provider_run.status='SUCCEEDED'
         AND provider_run.provider_id=verification.provider_id
         AND provider_run.campaign_id=verification.campaign_id
         AND provider_run.campaign_version_id=verification.campaign_version_id
       ORDER BY verification.observed_at DESC LIMIT 1`,
    ).get(
      input.contactId.trim(),
      email,
      emailHash,
      input.campaignId.trim(),
      input.versionId.trim(),
      at,
      at,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const verifierSourceKey = String(row.verifier_provider_key).toUpperCase();
    if (verifierSourceKey !== "HUNTER" && verifierSourceKey !== "BOUNCER") return null;
    return {
      discoveryAssertionId: String(row.discovery_assertion_id),
      verificationAssertionId: String(row.verification_assertion_id),
      providerRunId: String(row.provider_run_id),
      discoverySourceKey: "LOCAL_PUBLIC_WEB",
      verifierSourceKey,
      independentlyVerified: true,
      emailHash: String(row.value_hash),
      providerMailboxVerdict: "VALID_ASSERTION",
      confidence: Number(row.confidence),
      observedAt: String(row.observed_at),
      expiresAt: String(row.expires_at),
    };
  }

  saveCampaignSendAuthorization(
    input: CampaignSendAuthorizationInput,
    authorization: WorkflowAuthorization,
  ): { id: string; policyHash: string; created: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Campaign autonomous send authorization", {
      human: true,
      roles: ["SALES_MANAGER"],
    });
    const requiredText = [
      input.campaignApprovalId,
      input.briefId,
      input.versionId,
      input.campaignId,
      input.market,
      input.policyVersion,
      input.actionId,
      input.authorizationSource,
    ];
    if (requiredText.some((value) => !value?.trim())) {
      throw new Error("Campaign send authorization requires complete identifiers and policy metadata");
    }
    const briefHash = input.briefHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(briefHash)) {
      throw new Error("Campaign send authorization requires the exact brief hash");
    }
    const totalLimit = Math.trunc(input.totalLimit);
    const dailyLimit = Math.trunc(input.dailyLimit);
    const hourlyLimit = Math.trunc(input.hourlyLimit);
    const maximumSequenceIndex = Math.trunc(input.maximumSequenceIndex ?? 0);
    if (!Number.isSafeInteger(totalLimit) || !Number.isSafeInteger(dailyLimit) ||
      !Number.isSafeInteger(hourlyLimit) || totalLimit <= 0 || dailyLimit <= 0 || hourlyLimit <= 0 ||
      dailyLimit > totalLimit || hourlyLimit > dailyLimit) {
      throw new Error("Campaign send limits must satisfy 0 < hourly <= daily <= total");
    }
    if (maximumSequenceIndex !== 0) {
      throw new Error("The autonomous send pilot only authorizes sequence index 0");
    }
    const validFromMs = Date.parse(input.validFrom);
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(validFromMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= validFromMs) {
      throw new Error("Campaign send authorization requires a valid bounded time window");
    }
    const policy = {
      briefId: input.briefId.trim(),
      versionId: input.versionId.trim(),
      briefHash,
      campaignId: input.campaignId.trim(),
      market: input.market.trim(),
      transport: input.transport,
      totalLimit,
      dailyLimit,
      hourlyLimit,
      maximumSequenceIndex,
      validFrom: new Date(validFromMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      policyVersion: input.policyVersion.trim(),
      emailStatus: "VALID",
      qualificationTracks: ["ACTIVE_INTENT", "ICP_FIT"],
    };
    const policyJson = canonicalJson(policy);
    const policyHash = canonicalHash(policy);
    return this.transaction(() => {
      const replay = this.db.prepare(
        `SELECT id, campaign_approval_id, brief_id, version_id, campaign_id, policy_hash
         FROM campaign_send_authorizations WHERE action_id=?`,
      ).get(input.actionId.trim()) as Record<string, unknown> | undefined;
      if (replay) {
        if (replay.campaign_approval_id !== input.campaignApprovalId.trim() ||
          replay.brief_id !== input.briefId.trim() || replay.version_id !== input.versionId.trim() ||
          replay.campaign_id !== input.campaignId.trim() || replay.policy_hash !== policyHash) {
          throw new Error("Campaign send authorization action id was reused for different policy material");
        }
        return { id: String(replay.id), policyHash, created: false };
      }

      const approval = this.db.prepare(
        `SELECT ca.id, ca.scope, ca.brief_id, ca.version_id, ca.brief_hash,
                ca.approved_by, ca.approved_actor_type, cv.brief_json,
                cb.current_version_id, cb.external_send_authorized,
                cmp.market AS campaign_market
         FROM campaign_approvals ca
         JOIN campaign_versions cv ON cv.id=ca.version_id AND cv.brief_id=ca.brief_id
         JOIN campaign_briefs cb ON cb.id=ca.brief_id
         JOIN campaigns cmp ON cmp.id=?
         WHERE ca.id=?`,
      ).get(input.campaignId.trim(), input.campaignApprovalId.trim()) as Record<string, unknown> | undefined;
      if (!approval || approval.scope !== "EXTERNAL_SEND" || approval.approved_actor_type !== "HUMAN" ||
        approval.brief_id !== input.briefId.trim() || approval.version_id !== input.versionId.trim() ||
        approval.brief_hash !== briefHash || approval.current_version_id !== input.versionId.trim() ||
        Number(approval.external_send_authorized) !== 1) {
        throw new Error("Campaign send authorization is not bound to an exact current external-send approval");
      }
      const brief = parseJsonRecord(String(approval.brief_json));
      if (String(brief.transport ?? "").toUpperCase() !== "SMTP") {
        throw new Error("Campaign autonomous send authorization requires an SMTP Campaign Brief");
      }
      const normalizedMarket = input.market.trim().toLowerCase();
      if (String(brief.market ?? "").trim().toLowerCase() !== normalizedMarket ||
        String(approval.campaign_market ?? "").trim().toLowerCase() !== normalizedMarket) {
        throw new Error("Campaign send authorization market does not match its brief and execution campaign");
      }

      const id = this.id("csendauth");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO campaign_send_authorizations(
           id, campaign_approval_id, brief_id, version_id, brief_hash, campaign_id,
           market, transport, total_limit, daily_limit, hourly_limit, maximum_sequence_index,
           valid_from, expires_at, policy_version, policy_json, policy_hash, action_id,
           authorized_by, authorized_actor_type, authorization_source, reason,
           external_send_authorized, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SMTP', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', ?, ?, 1, ?)`,
      ).run(
        id,
        input.campaignApprovalId.trim(),
        input.briefId.trim(),
        input.versionId.trim(),
        briefHash,
        input.campaignId.trim(),
        input.market.trim(),
        totalLimit,
        dailyLimit,
        hourlyLimit,
        policy.validFrom,
        policy.expiresAt,
        input.policyVersion.trim(),
        policyJson,
        policyHash,
        input.actionId.trim(),
        actor,
        input.authorizationSource.trim(),
        input.reason?.trim().slice(0, 2000) || null,
        now,
      );
      this.recordEvent("campaign_send_authorization", id, "CAMPAIGN_AUTONOMOUS_SEND_AUTHORIZED", actor, {
        campaignApprovalId: input.campaignApprovalId.trim(),
        briefId: input.briefId.trim(),
        versionId: input.versionId.trim(),
        campaignId: input.campaignId.trim(),
        policyHash,
        totalLimit,
        dailyLimit,
        hourlyLimit,
        maximumSequenceIndex,
        validFrom: policy.validFrom,
        expiresAt: policy.expiresAt,
      });
      return { id, policyHash, created: true };
    });
  }

  revokeCampaignSendAuthorization(
    campaignSendAuthorizationId: string,
    actionId: string,
    reason: string,
    authorization: WorkflowAuthorization,
  ): { id: string; created: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Campaign autonomous send revocation", {
      human: true,
      roles: ["SALES_MANAGER"],
    });
    const authorizationId = campaignSendAuthorizationId.trim();
    const cleanActionId = actionId.trim();
    const cleanReason = reason.trim();
    if (!authorizationId || !cleanActionId || !cleanReason) {
      throw new Error("Campaign send revocation requires authorization id, action id, and reason");
    }
    return this.transaction(() => {
      const replay = this.db.prepare(
        `SELECT id, campaign_send_authorization_id FROM campaign_send_authorization_revocations
         WHERE action_id=?`,
      ).get(cleanActionId) as { id: string; campaign_send_authorization_id: string } | undefined;
      if (replay) {
        if (replay.campaign_send_authorization_id !== authorizationId) {
          throw new Error("Campaign send revocation action id was reused for another authorization");
        }
        return { id: replay.id, created: false };
      }
      const existing = this.db.prepare(
        "SELECT id FROM campaign_send_authorization_revocations WHERE campaign_send_authorization_id=?",
      ).get(authorizationId) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      if (!this.db.prepare("SELECT 1 FROM campaign_send_authorizations WHERE id=?").get(authorizationId)) {
        throw new Error("Campaign send authorization not found");
      }
      const id = this.id("csendrevoke");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO campaign_send_authorization_revocations(
           id, campaign_send_authorization_id, action_id, revoked_by, revoked_actor_type, reason, created_at
         ) VALUES (?, ?, ?, ?, 'HUMAN', ?, ?)`,
      ).run(id, authorizationId, cleanActionId, actor, cleanReason.slice(0, 2000), now);
      this.recordEvent("campaign_send_authorization", authorizationId, "CAMPAIGN_AUTONOMOUS_SEND_REVOKED", actor, {
        revocationId: id,
        reason: cleanReason,
      });
      return { id, created: true };
    });
  }

  authorizeGroundedMessageForCampaign(
    input: CampaignMessageAuthorizationInput,
  ): {
    id: string;
    outboundMessageId: string;
    reviewHash: string;
    policyHash: string;
    created: boolean;
  } {
    const authorizationId = input.campaignSendAuthorizationId.trim();
    const messageVersionId = input.messageVersionId.trim();
    const evaluatorVersion = input.evaluatorVersion.trim();
    if (!authorizationId || !messageVersionId || !evaluatorVersion) {
      throw new Error("Campaign message authorization requires authorization, message version, and evaluator version");
    }
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString() : this.now();
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, outbound_message_id, review_hash, policy_hash
         FROM campaign_message_authorizations
         WHERE campaign_send_authorization_id=? AND message_version_id=?`,
      ).get(authorizationId, messageVersionId) as Record<string, unknown> | undefined;
      if (existing) {
        return {
          id: String(existing.id),
          outboundMessageId: String(existing.outbound_message_id),
          reviewHash: String(existing.review_hash),
          policyHash: String(existing.policy_hash),
          created: false,
        };
      }

      const now = this.now();
      const campaignAuthorization = this.db.prepare(
        `SELECT csa.*, cb.current_version_id, cb.external_send_authorized,
                ca.approved_by, ca.approved_actor_type,
                CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS revoked
         FROM campaign_send_authorizations csa
         JOIN campaign_briefs cb ON cb.id=csa.brief_id
         JOIN campaign_approvals ca ON ca.id=csa.campaign_approval_id
         LEFT JOIN campaign_send_authorization_revocations r
           ON r.campaign_send_authorization_id=csa.id
         WHERE csa.id=?`,
      ).get(authorizationId) as Record<string, unknown> | undefined;
      if (!campaignAuthorization || Number(campaignAuthorization.external_send_authorized) !== 1 ||
        campaignAuthorization.approved_actor_type !== "HUMAN" || Number(campaignAuthorization.revoked) !== 0 ||
        campaignAuthorization.current_version_id !== campaignAuthorization.version_id ||
        String(campaignAuthorization.valid_from) > now || String(campaignAuthorization.expires_at) <= now) {
        throw new Error("Campaign send authorization is inactive, revoked, expired, or stale");
      }

      const message = this.db.prepare(
        `SELECT mv.*, pp.status AS plan_status, pp.qualification_track, pp.legacy_lead_id,
                pp.legacy_contact_id, l.campaign_id AS lead_campaign_id, l.status AS lead_status,
                l.send_eligible, l.demand_evidence_qualified, l.demand_policy_version,
                l.outreach_qualification_track, l.outreach_qualification_policy_version,
                l.human_takeover, l.domain, l.company, l.country,
                c.lead_id AS contact_lead_id, c.name AS contact_name, c.title AS contact_title,
                c.email, c.email_status, c.role_address, c.disposable_address, c.catch_all,
                c.recipient_tier, c.recipient_evidence_url, c.recipient_evidence_observed_at,
                c.recipient_evidence_expires_at, c.recipient_evidence_hash, c.recipient_policy_version,
                c.employment_verified_at, c.source_url AS contact_source_url,
                CASE WHEN EXISTS (
                  SELECT 1 FROM message_versions newer
                  WHERE newer.message_key=mv.message_key AND newer.version_number>mv.version_number
                ) THEN 0 ELSE 1 END AS is_latest
         FROM message_versions mv
         JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
         JOIN leads l ON l.id=pp.legacy_lead_id
         JOIN contacts c ON c.id=pp.legacy_contact_id
         WHERE mv.id=?`,
      ).get(messageVersionId) as Record<string, unknown> | undefined;
      if (!message || message.plan_status !== "VALID" ||
        !new Set(["ACTIVE_INTENT", "ICP_FIT"]).has(String(message.qualification_track)) ||
        message.status !== "PENDING_APPROVAL" || Number(message.send_authorized) !== 0 ||
        Number(message.is_latest) !== 1) {
        throw new Error("Only the latest valid grounded message can receive campaign authorization");
      }
      const lint = parseJsonRecord(String(message.lint_result_json));
      if (lint.passed !== true || /(?:generic|fallback|diagnostic)/i.test(String(message.generation_mode))) {
        throw new Error("Fallback, diagnostic, or lint-failing content cannot receive campaign authorization");
      }
      const contentHash = canonicalHash({ subject: message.subject, body: message.body });
      if (contentHash !== message.content_hash) {
        throw new Error("Grounded message content hash is invalid");
      }
      if (message.lead_campaign_id !== campaignAuthorization.campaign_id ||
        message.contact_lead_id !== message.legacy_lead_id ||
        String(message.country).trim().toLowerCase() !== String(campaignAuthorization.market).trim().toLowerCase()) {
        throw new Error("Grounded message recipient is outside the authorized campaign or market");
      }
      if (!message.send_eligible || !outreachQualificationSatisfied(message) || message.human_takeover ||
        !["READY_FOR_REVIEW", "APPROVED", "CONTACTED"].includes(String(message.lead_status))) {
        throw new Error("Grounded message recipient no longer satisfies the live qualification gates");
      }
      if (Number(message.sequence_index) > Number(campaignAuthorization.maximum_sequence_index)) {
        throw new Error("Grounded message sequence index is outside the campaign authorization");
      }
      if (this.recipientTierPolicyBlockers(message, new Date(now)).length > 0 ||
        normalizedMessageDestination("email", String(message.destination)) !==
          normalizedMessageDestination("email", String(message.email ?? ""))) {
        throw new Error("Campaign autonomous send requires an independently VALID email for tier A or an exact official-site tier B mailbox");
      }
      if (String(message.recipient_tier) === "A" && !this.getIndependentValidEmailVerification({
        contactId: String(message.legacy_contact_id),
        email: String(message.email),
        campaignId: String(campaignAuthorization.campaign_id),
        versionId: String(campaignAuthorization.version_id),
        at: now,
      })) {
        throw new Error(
          "Campaign autonomous send requires current public-web discovery plus an independent official verifier",
        );
      }
      if (this.hasDncMatch([
        { type: "email", value: String(message.destination) },
        { type: "domain", value: String(message.domain) },
        { type: "company", value: String(message.company) },
      ])) {
        throw new Error("Campaign autonomous send recipient matches do-not-contact policy");
      }
      const authorizedCount = this.db.prepare(
        `SELECT count(*) AS count FROM campaign_message_authorizations
         WHERE campaign_send_authorization_id=? AND send_authorized=1`,
      ).get(authorizationId) as { count: number };
      if (Number(authorizedCount.count) >= Number(campaignAuthorization.total_limit)) {
        throw new Error("Campaign autonomous send total authorization limit reached");
      }

      const outbound = this.db.prepare(
        `SELECT * FROM outbound_messages
         WHERE lead_id=? AND contact_id=? AND channel='email' AND sequence_index=?`,
      ).get(
        String(message.legacy_lead_id),
        String(message.legacy_contact_id),
        Number(message.sequence_index),
      ) as
        | Record<string, unknown>
        | undefined;
      let outboundMessageId: string;
      if (outbound) {
        if (!["DRAFT", "PENDING_APPROVAL"].includes(String(outbound.status)) ||
          outbound.campaign_id !== campaignAuthorization.campaign_id) {
          throw new Error("Existing outbound row cannot be rebound to campaign autonomous authorization");
        }
        outboundMessageId = String(outbound.id);
        this.db.prepare(
          `UPDATE outbound_messages SET destination=?, subject=?, body=?, scheduled_at=?,
             current_version_id=?, status='PENDING_APPROVAL', approved_by=NULL, approved_at=NULL,
             updated_at=? WHERE id=?`,
        ).run(
          String(message.destination),
          String(message.subject),
          String(message.body),
          scheduledAt,
          messageVersionId,
          now,
          outboundMessageId,
        );
      } else {
        outboundMessageId = this.createOutboundMessage({
          campaignId: String(campaignAuthorization.campaign_id),
          leadId: String(message.legacy_lead_id),
          contactId: String(message.legacy_contact_id),
          channel: "email",
          destination: String(message.destination),
          subject: String(message.subject),
          body: String(message.body),
          sequenceIndex: Number(message.sequence_index),
          scheduledAt,
          status: "PENDING_APPROVAL",
        });
        this.db.prepare("UPDATE outbound_messages SET current_version_id=?, updated_at=? WHERE id=?")
          .run(messageVersionId, now, outboundMessageId);
      }

      const decisionHash = canonicalHash({
        campaignSendAuthorizationId: authorizationId,
        policyHash: campaignAuthorization.policy_hash,
        outboundMessageId,
        messageVersionId,
        reviewHash: message.review_hash,
        contentHash,
        evaluatorVersion,
        decision: "AUTO_SEND_ELIGIBLE",
      });
      const id = this.id("cmessageauth");
      this.db.prepare(
        `INSERT INTO campaign_message_authorizations(
           id, campaign_send_authorization_id, outbound_message_id, message_version_id,
           review_hash, content_hash, policy_hash, decision, evaluator_version,
           evaluated_by, send_authorized, decision_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'AUTO_SEND_ELIGIBLE', ?, 'SYSTEM', 1, ?, ?)`,
      ).run(
        id,
        authorizationId,
        outboundMessageId,
        messageVersionId,
        String(message.review_hash),
        contentHash,
        String(campaignAuthorization.policy_hash),
        evaluatorVersion,
        decisionHash,
        now,
      );
      const update = this.db.prepare(
        `UPDATE outbound_messages SET status='APPROVED', approved_by=?, approved_at=?,
           authorization_mode='CAMPAIGN_POLICY', campaign_send_authorization_id=?,
           campaign_message_authorization_id=?, updated_at=?
         WHERE id=? AND status='PENDING_APPROVAL'`,
      ).run(
        String(campaignAuthorization.authorized_by),
        now,
        authorizationId,
        id,
        now,
        outboundMessageId,
      );
      if (update.changes !== 1) throw new Error("Outbound message changed during campaign authorization");
      this.db.prepare(
        "UPDATE leads SET status='APPROVED', updated_at=? WHERE id=? AND status='READY_FOR_REVIEW'",
      ).run(now, String(message.legacy_lead_id));
      this.recordEvent("outbound_message", outboundMessageId, "MESSAGE_CAMPAIGN_POLICY_AUTHORIZED", "system", {
        campaignSendAuthorizationId: authorizationId,
        campaignMessageAuthorizationId: id,
        messageVersionId,
        reviewHash: message.review_hash,
        contentHash,
        policyHash: campaignAuthorization.policy_hash,
        evaluatorVersion,
      });
      return {
        id,
        outboundMessageId,
        reviewHash: String(message.review_hash),
        policyHash: String(campaignAuthorization.policy_hash),
        created: true,
      };
    });
  }

  getCurrentCampaignBrief(briefId: string): Record<string, unknown> | null {
    return (this.db.prepare(
      `SELECT cb.*, cv.version_number, cv.brief_json, cv.brief_hash, cv.parser_version,
         cv.source_text_hash, cv.created_by AS version_created_by, cv.created_at AS version_created_at
       FROM campaign_briefs cb
       JOIN campaign_versions cv ON cv.id=cb.current_version_id
       WHERE cb.id=?`,
    ).get(briefId) as Record<string, unknown> | undefined) ?? null;
  }

  saveCampaignForecast(input: CampaignForecastPersistenceInput): {
    id: string;
    forecastHash: string;
    created: boolean;
  } {
    const idempotencyKey = input.idempotencyKey.trim();
    const createdBy = input.createdBy.trim();
    const basis = [...new Set(input.basis.map((item) => item.trim()).filter(Boolean))];
    if (!idempotencyKey || !createdBy || basis.length === 0 ||
      !Number.isSafeInteger(input.sampleSize) || input.sampleSize < 0) {
      throw new Error("Campaign forecast requires a key, creator, basis, and non-negative sample size");
    }
    const forecastHash = canonicalHash(input.forecast);
    return this.transaction(() => {
      const version = this.db.prepare(
        "SELECT brief_hash, brief_json, version_number FROM campaign_versions WHERE id=?",
      ).get(input.versionId) as {
        brief_hash: string;
        brief_json: string;
        version_number: number;
      } | undefined;
      if (!version) throw new Error(`Campaign version not found: ${input.versionId}`);
      const brief = parseJsonRecord(version.brief_json);
      if (input.forecast.briefHash !== version.brief_hash ||
        input.forecast.briefId !== brief.id ||
        input.forecast.briefVersion !== brief.version) {
        throw new Error("Campaign forecast does not match the exact Campaign Brief review material");
      }
      const existing = this.db.prepare(
        "SELECT id, forecast_hash FROM campaign_forecasts WHERE idempotency_key=?",
      ).get(idempotencyKey) as { id: string; forecast_hash: string } | undefined;
      if (existing) {
        if (existing.forecast_hash !== forecastHash) {
          throw new Error("Campaign forecast idempotency key was reused with different content");
        }
        return { id: existing.id, forecastHash, created: false };
      }
      const id = this.id("forecast");
      this.db.prepare(
        `INSERT INTO campaign_forecasts(
           id, version_id, forecast_json, basis, sample_size, uncertainty, reliable,
           forecast_hash, idempotency_key, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.versionId,
        canonicalJson(input.forecast),
        canonicalJson(basis),
        input.sampleSize,
        input.uncertainty,
        input.reliable ? 1 : 0,
        forecastHash,
        idempotencyKey,
        createdBy,
        this.now(),
      );
      this.recordEvent("campaign_forecast", id, "CAMPAIGN_FORECAST_RECORDED", createdBy, {
        versionId: input.versionId,
        forecastHash,
        sampleSize: input.sampleSize,
        uncertainty: input.uncertainty,
        reliable: input.reliable,
      });
      return { id, forecastHash, created: true };
    });
  }

  saveMarketEvidence(input: MarketEvidencePersistenceInput): { id: string; created: boolean } {
    const idempotencyKey = input.idempotencyKey.trim();
    const country = input.country.trim().toUpperCase();
    const createdBy = input.createdBy.trim();
    const contentHash = input.contentHash.trim().toLowerCase();
    if (!idempotencyKey || !/^[A-Z]{2}$/.test(country) || !createdBy || contentHash.length !== 64) {
      throw new Error("Market evidence requires an idempotency key, country, creator, and SHA-256 content hash");
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("Market evidence confidence must be between 0 and 1");
    }
    const recordHash = canonicalHash({
      country,
      period: input.period.trim(),
      hsRevision: input.hsRevision.trim(),
      metric: input.metric.trim().toUpperCase(),
      value: input.value ?? null,
      unit: input.unit.trim(),
      sourceUrl: input.sourceUrl.trim(),
      authority: input.authority.trim().toUpperCase(),
      retrievedAt: input.retrievedAt,
      contentHash,
      confidence: input.confidence,
      license: input.license.trim().toUpperCase(),
      humanReview: input.humanReview,
      expiresAt: input.expiresAt,
    });
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id, record_hash FROM market_evidence WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string; record_hash: string } | undefined;
      if (existing) {
        if (existing.record_hash !== recordHash) {
          throw new Error("Market evidence idempotency key was reused with different content");
        }
        return { id: existing.id, created: false };
      }
      const id = this.id("mevidence");
      this.db.prepare(
        `INSERT INTO market_evidence(
           id, country, period, hs_revision, metric, value, unit, source_url, authority,
           retrieved_at, content_hash, confidence, license, human_review, expires_at,
           record_hash, idempotency_key, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        country,
        input.period.trim(),
        input.hsRevision.trim(),
        input.metric.trim().toUpperCase(),
        input.value ?? null,
        input.unit.trim(),
        input.sourceUrl.trim(),
        input.authority.trim().toUpperCase(),
        input.retrievedAt,
        contentHash,
        input.confidence,
        input.license.trim().toUpperCase(),
        input.humanReview,
        input.expiresAt,
        recordHash,
        idempotencyKey,
        createdBy,
        this.now(),
      );
      this.recordEvent("market_evidence", id, "MARKET_EVIDENCE_RECORDED", createdBy, {
        country,
        metric: input.metric.trim().toUpperCase(),
        humanReview: input.humanReview,
      });
      return { id, created: true };
    });
  }

  saveMarketOpportunitySnapshot(input: MarketOpportunitySnapshotInput): {
    id: string;
    snapshotHash: string;
    created: boolean;
  } {
    const idempotencyKey = input.idempotencyKey.trim();
    const country = input.country.trim().toUpperCase();
    const createdBy = input.createdBy.trim();
    const evidenceIds = [...new Set(input.evidenceIds ?? [])].sort((left, right) => left.localeCompare(right));
    if (!idempotencyKey || !/^[A-Z]{2}$/.test(country) || !input.productFamily.trim() || !createdBy) {
      throw new Error("Market snapshot scope, idempotency key, and creator are required");
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("Market snapshot confidence must be between 0 and 1");
    }
    if (input.score !== null && input.score !== undefined && !Number.isFinite(input.score)) {
      throw new Error("Market snapshot score must be finite when present");
    }
    const snapshotHash = canonicalHash({
      country,
      productFamily: input.productFamily.trim(),
      period: input.period.trim(),
      policyVersion: input.policyVersion.trim(),
      score: input.score ?? null,
      confidence: input.confidence,
      evidenceIds,
      snapshot: input.snapshot,
    });
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id, snapshot_hash FROM market_opportunity_snapshots WHERE idempotency_key=?",
      ).get(idempotencyKey) as { id: string; snapshot_hash: string } | undefined;
      if (existing) {
        if (existing.snapshot_hash !== snapshotHash) {
          throw new Error("Market snapshot idempotency key was reused with different content");
        }
        return { id: existing.id, snapshotHash: existing.snapshot_hash, created: false };
      }
      for (const evidenceId of evidenceIds) {
        if (!this.db.prepare("SELECT 1 FROM market_evidence WHERE id=?").get(evidenceId)) {
          throw new Error(`Market evidence not found: ${evidenceId}`);
        }
      }
      const id = this.id("marketsnap");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO market_opportunity_snapshots(
           id, country, product_family, period, policy_version, score, confidence,
           evidence_ids_json, snapshot_json, snapshot_hash, publication_authorized,
           idempotency_key, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        id,
        country,
        input.productFamily.trim(),
        input.period.trim(),
        input.policyVersion.trim(),
        input.score ?? null,
        input.confidence,
        canonicalJson(evidenceIds),
        canonicalJson(input.snapshot),
        snapshotHash,
        idempotencyKey,
        createdBy,
        now,
      );
      this.recordEvent("market_snapshot", id, "MARKET_OPPORTUNITY_SNAPSHOT_RECORDED", createdBy, {
        country,
        productFamily: input.productFamily.trim(),
        policyVersion: input.policyVersion.trim(),
        publicationAuthorized: false,
      });
      return { id, snapshotHash, created: true };
    });
  }

  savePlayAllocationSuggestion(input: PlayAllocationSuggestionInput): { id: string; created: boolean } {
    const idempotencyKey = input.idempotencyKey.trim();
    const createdBy = input.createdBy.trim();
    if (!idempotencyKey || !createdBy || !Number.isSafeInteger(input.recommendedUnits) ||
      input.recommendedUnits < 0 || !Number.isFinite(input.recommendedShare) ||
      input.recommendedShare < 0 || input.recommendedShare > 1) {
      throw new Error("Play allocation requires valid units, share, idempotency key, and creator");
    }
    const suggestionHash = canonicalHash({
      playId: input.playId,
      snapshotId: input.snapshotId ?? null,
      policyVersion: input.policyVersion.trim(),
      recommendedUnits: input.recommendedUnits,
      recommendedShare: input.recommendedShare,
      recommendation: input.recommendation.trim(),
      reasons: input.reasons ?? [],
    });
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id, suggestion_hash FROM play_allocations WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string; suggestion_hash: string } | undefined;
      if (existing) {
        if (existing.suggestion_hash !== suggestionHash) {
          throw new Error("Play allocation idempotency key was reused with different content");
        }
        return { id: existing.id, created: false };
      }
      if (!this.db.prepare("SELECT 1 FROM plays WHERE id=?").get(input.playId)) {
        throw new Error(`Play not found: ${input.playId}`);
      }
      if (input.snapshotId &&
        !this.db.prepare("SELECT 1 FROM market_opportunity_snapshots WHERE id=?").get(input.snapshotId)) {
        throw new Error(`Market opportunity snapshot not found: ${input.snapshotId}`);
      }
      const id = this.id("allocation");
      this.db.prepare(
        `INSERT INTO play_allocations(
           id, play_id, snapshot_id, policy_version, recommended_units, recommended_share,
           recommendation, reasons_json, suggestion_hash, applied, requires_human_approval,
           idempotency_key, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      ).run(
        id,
        input.playId,
        input.snapshotId ?? null,
        input.policyVersion.trim(),
        input.recommendedUnits,
        input.recommendedShare,
        input.recommendation.trim(),
        canonicalJson(input.reasons ?? []),
        suggestionHash,
        idempotencyKey,
        createdBy,
        this.now(),
      );
      this.recordEvent("play_allocation", id, "PLAY_ALLOCATION_SUGGESTED", createdBy, {
        playId: input.playId,
        applied: false,
        requiresHumanApproval: true,
      });
      return { id, created: true };
    });
  }

  savePersonalizationPlan(input: PersonalizationPlanPersistenceInput): {
    id: string;
    versionNumber: number;
    planHash: string;
    created: boolean;
  } {
    const planKey = input.planKey.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    const locale = input.locale.trim().toLowerCase();
    const factIds = [...new Set(input.factIds ?? [])].sort((left, right) => left.localeCompare(right));
    const status = input.status ?? "DRAFT";
    if (!planKey || !createdBy || !locale || !input.qualificationPolicyVersion.trim() ||
      !input.sellerFactSetVersion.trim()) {
      throw new Error("Personalization plan key, policy, seller fact version, locale, and creator are required");
    }
    if (!input.accountId && !input.leadId) {
      throw new Error("Personalization plan requires a canonical account or legacy lead");
    }
    if (input.qualificationTrack === "WATCHLIST" && status === "VALID") {
      throw new Error("WATCHLIST personalization plans cannot be valid for review");
    }
    const planHash = canonicalHash({
      accountId: input.accountId ?? null,
      personId: input.personId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      leadId: input.leadId ?? null,
      contactId: input.contactId ?? null,
      qualificationTrack: input.qualificationTrack,
      qualificationPolicyVersion: input.qualificationPolicyVersion.trim(),
      dossierVersionId: input.dossierVersionId ?? null,
      sellerFactSetVersion: input.sellerFactSetVersion.trim(),
      locale,
      plan: input.plan,
      factIds,
      status,
    });
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, version_number FROM personalization_plans WHERE plan_key=? AND plan_hash=?`,
      ).get(planKey, planHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, planHash, created: false };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM personalization_plans WHERE plan_key=?",
      ).get(planKey) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("pplan");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO personalization_plans(
           id, plan_key, version_number, account_id, person_id, enrollment_id,
           legacy_lead_id, legacy_contact_id, qualification_track, qualification_policy_version,
           dossier_version_id, seller_fact_set_version, locale, plan_json, fact_ids_json,
           plan_hash, status, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        planKey,
        versionNumber,
        input.accountId ?? null,
        input.personId ?? null,
        input.enrollmentId ?? null,
        input.leadId ?? null,
        input.contactId ?? null,
        input.qualificationTrack,
        input.qualificationPolicyVersion.trim(),
        input.dossierVersionId ?? null,
        input.sellerFactSetVersion.trim(),
        locale,
        canonicalJson(input.plan),
        canonicalJson(factIds),
        planHash,
        status,
        createdBy,
        now,
      );
      this.recordEvent("personalization_plan", id, "PERSONALIZATION_PLAN_VERSION_CREATED", createdBy, {
        planKey,
        versionNumber,
        planHash,
        qualificationTrack: input.qualificationTrack,
        status,
      });
      return { id, versionNumber, planHash, created: true };
    });
  }

  saveQualificationRun(input: QualificationRunInput): { id: string; created: boolean } {
    const idempotencyKey = input.idempotencyKey.trim();
    const policyVersion = input.policyVersion.trim();
    const evidenceFactIds = [...new Set(input.evidenceFactIds ?? [])]
      .sort((left, right) => left.localeCompare(right));
    if (!idempotencyKey || !policyVersion || (!input.accountId && !input.intakeId && !input.enrollmentId)) {
      throw new Error("Qualification run requires an idempotency key, policy, and linked entity");
    }
    const recordHash = canonicalHash({
      accountId: input.accountId ?? null,
      intakeId: input.intakeId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      qualificationTrack: input.qualificationTrack,
      policyVersion,
      decision: input.decision,
      reason: input.reason?.trim() ?? "",
      evidenceFactIds,
      result: input.result,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    });
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id, result_json FROM qualification_runs WHERE idempotency_key=?",
      ).get(idempotencyKey) as { id: string; result_json: string } | undefined;
      if (existing) {
        if (parseJsonRecord(existing.result_json)._recordHash !== recordHash) {
          throw new Error("Qualification run idempotency key was reused with different review material");
        }
        return { id: existing.id, created: false };
      }
      const id = this.id("qualification");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO qualification_runs(
           id, account_id, intake_id, enrollment_id, qualification_track, policy_version,
           status, decision, reason, evidence_fact_ids_json, result_json, idempotency_key,
           started_at, completed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'COMPLETE', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId ?? null,
        input.intakeId ?? null,
        input.enrollmentId ?? null,
        input.qualificationTrack,
        policyVersion,
        input.decision,
        input.reason?.trim().slice(0, 2000) ?? "",
        canonicalJson(evidenceFactIds),
        canonicalJson({ ...input.result, _recordHash: recordHash }),
        idempotencyKey,
        input.startedAt,
        input.completedAt,
        now,
      );
      this.recordEvent("qualification_run", id, "QUALIFICATION_COMPLETED", "qualification-policy", {
        accountId: input.accountId ?? null,
        enrollmentId: input.enrollmentId ?? null,
        qualificationTrack: input.qualificationTrack,
        policyVersion,
        decision: input.decision,
        evidenceFactIds,
        recordHash,
      });
      return { id, created: true };
    });
  }

  saveMessageVersion(input: MessageVersionPersistenceInput): {
    id: string;
    versionNumber: number;
    contentHash: string;
    reviewHash: string;
    created: boolean;
  } {
    const messageKey = input.messageKey.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    const factIds = [...new Set(input.factIds ?? [])].sort((left, right) => left.localeCompare(right));
    const status = input.status ?? "NEEDS_REWRITE";
    if (!messageKey || !createdBy || !input.body.trim() || !input.destination.trim() ||
      !Number.isSafeInteger(input.sequenceIndex) || input.sequenceIndex < 0) {
      throw new Error("Message key, body, destination, sequence index, and creator are required");
    }
    const contentHash = canonicalHash({ subject: input.subject, body: input.body });
    return this.transaction(() => {
      const plan = this.db.prepare(
        `SELECT id, plan_hash, status, qualification_track, qualification_policy_version,
           dossier_version_id, seller_fact_set_version, account_id, person_id,
           legacy_lead_id, legacy_contact_id
         FROM personalization_plans WHERE id=?`,
      ).get(input.personalizationPlanId) as Record<string, unknown> | undefined;
      if (!plan) throw new Error(`Personalization plan not found: ${input.personalizationPlanId}`);
      if (input.dossierVersionId && plan.dossier_version_id !== input.dossierVersionId) {
        throw new Error("Message dossier version does not match its personalization plan");
      }
      if (plan.seller_fact_set_version !== input.sellerFactSetVersion.trim()) {
        throw new Error("Message seller fact set version does not match its personalization plan");
      }
      const lintPassed = input.lintResult.passed === true;
      if (status === "PENDING_APPROVAL" && (
        plan.status !== "VALID" || plan.qualification_track === "WATCHLIST" || !lintPassed ||
        /(?:generic|fallback|diagnostic)/i.test(input.generationMode)
      )) {
        throw new Error("Only a valid grounded, lint-passing, non-fallback message can await approval");
      }
      const reviewHash = canonicalHash({
        planId: input.personalizationPlanId,
        planHash: plan.plan_hash,
        accountId: plan.account_id,
        personId: plan.person_id,
        leadId: plan.legacy_lead_id,
        contactId: plan.legacy_contact_id,
        qualificationTrack: plan.qualification_track,
        qualificationPolicyVersion: plan.qualification_policy_version,
        destination: input.destination.trim().toLowerCase(),
        subject: input.subject,
        body: input.body,
        sequenceIndex: input.sequenceIndex,
        generationMode: input.generationMode.trim(),
        promptVersion: input.promptVersion.trim(),
        model: input.model.trim(),
        templateVersion: input.templateVersion.trim(),
        lintVersion: input.lintVersion.trim(),
        lintResult: input.lintResult,
        angle: input.angle,
        locale: input.locale.trim().toLowerCase(),
        experimentVariant: input.experimentVariant ?? null,
        dossierVersionId: input.dossierVersionId ?? plan.dossier_version_id ?? null,
        sellerFactSetVersion: input.sellerFactSetVersion.trim(),
        factIds,
        contentHash,
      });
      if (input.expectedReviewHash && input.expectedReviewHash.trim().toLowerCase() !== reviewHash) {
        throw new Error("Expected review hash does not match the complete message review material");
      }
      const existing = this.db.prepare(
        `SELECT id, version_number FROM message_versions WHERE message_key=? AND review_hash=?`,
      ).get(messageKey, reviewHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return {
          id: existing.id,
          versionNumber: existing.version_number,
          contentHash,
          reviewHash,
          created: false,
        };
      }
      if (input.outboundMessageId) {
        const outbound = this.db.prepare("SELECT status FROM outbound_messages WHERE id=?")
          .get(input.outboundMessageId) as { status: string } | undefined;
        if (!outbound) throw new Error(`Outbound message not found: ${input.outboundMessageId}`);
        if (new Set(["SENDING", "SENT", "REPLIED", "BOUNCED"]).has(outbound.status)) {
          throw new Error("A dispatched or replied outbound message cannot receive a new content version");
        }
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM message_versions WHERE message_key=?",
      ).get(messageKey) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("messagev");
      const now = this.now();
      const messageParameters: Array<string | number | null> = [
        id,
        messageKey,
        versionNumber,
        input.outboundMessageId ?? null,
        input.personalizationPlanId,
        input.subject,
        input.body,
        input.destination.trim().toLowerCase(),
        input.sequenceIndex,
        input.generationMode.trim(),
        input.promptVersion.trim(),
        input.model.trim(),
        input.templateVersion.trim(),
        input.lintVersion.trim(),
        canonicalJson(input.lintResult),
        input.angle,
        input.locale.trim().toLowerCase(),
        input.experimentVariant?.trim() || null,
        String(input.dossierVersionId ?? plan.dossier_version_id ?? "") || null,
        input.sellerFactSetVersion.trim(),
        canonicalJson(factIds),
        contentHash,
        reviewHash,
        status,
        createdBy,
        now,
      ];
      this.db.prepare(
        `INSERT INTO message_versions(
           id, message_key, version_number, outbound_message_id, personalization_plan_id,
           subject, body, destination, sequence_index, generation_mode, prompt_version, model,
           template_version, lint_version, lint_result_json, angle, locale, experiment_variant,
           dossier_version_id, seller_fact_set_version, fact_ids_json, content_hash, review_hash,
           status, send_authorized, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(...messageParameters);
      const link = this.db.prepare(
        `INSERT INTO message_fact_links(message_version_id, fact_type, fact_id, created_at)
         VALUES (?, 'EVIDENCE_FACT', ?, ?)`,
      );
      for (const factId of factIds) link.run(id, factId, now);
      if (input.outboundMessageId) {
        this.db.prepare("UPDATE outbound_messages SET current_version_id=?, updated_at=? WHERE id=?")
          .run(id, now, input.outboundMessageId);
      }
      this.recordEvent("message_version", id, "MESSAGE_VERSION_CREATED", createdBy, {
        messageKey,
        versionNumber,
        reviewHash,
        contentHash,
        status,
        sendAuthorized: false,
      });
      return { id, versionNumber, contentHash, reviewHash, created: true };
    });
  }

  issueGroundedMessageReviewCard(input: {
    messageVersionId: string;
    reviewHash: string;
  }): { id: string; expiresAt: string; created: boolean } {
    const messageVersionId = input.messageVersionId.trim();
    const reviewHash = input.reviewHash.trim().toLowerCase();
    if (!messageVersionId || !/^[a-f0-9]{64}$/.test(reviewHash)) {
      throw new Error("Message review card requires an exact message version and review hash");
    }
    return this.transaction(() => {
      const message = this.db.prepare(
        `SELECT mv.id, mv.message_key, mv.version_number, mv.subject, mv.body,
           mv.content_hash, mv.review_hash, mv.status, mv.send_authorized,
           mv.generation_mode, mv.lint_result_json, pp.status AS plan_status,
           pp.qualification_track
         FROM message_versions mv
         JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
         WHERE mv.id=?`,
      ).get(messageVersionId) as Record<string, unknown> | undefined;
      if (!message || message.review_hash !== reviewHash) {
        throw new Error("Message review material does not match the exact persisted version");
      }
      const latest = this.db.prepare(
        `SELECT id FROM message_versions WHERE message_key=?
         ORDER BY version_number DESC LIMIT 1`,
      ).get(String(message.message_key)) as { id: string } | undefined;
      const lint = parseJsonRecord(String(message.lint_result_json));
      const contentHash = canonicalHash({ subject: message.subject, body: message.body });
      if (latest?.id !== messageVersionId || message.content_hash !== contentHash ||
        message.status !== "PENDING_APPROVAL" || Number(message.send_authorized) !== 0 ||
        message.plan_status !== "VALID" || message.qualification_track === "WATCHLIST" ||
        lint.passed !== true || /(?:generic|fallback|diagnostic)/i.test(String(message.generation_mode))) {
        throw new Error("Only the latest grounded, lint-passing message version can be reviewed");
      }
      const decided = this.db.prepare(
        "SELECT 1 FROM message_review_decisions WHERE message_version_id=?",
      ).get(messageVersionId);
      if (decided) throw new Error("This exact message version already has a final content decision");

      const issuedAt = this.now();
      const existing = this.db.prepare(
        `SELECT id, expires_at FROM message_review_cards
         WHERE message_version_id=? AND review_hash=? AND content_hash=? AND expires_at>?
         ORDER BY issued_at DESC LIMIT 1`,
      ).get(messageVersionId, reviewHash, contentHash, issuedAt) as
        | { id: string; expires_at: string }
        | undefined;
      if (existing) return { id: existing.id, expiresAt: existing.expires_at, created: false };

      const id = this.id("mreviewcard");
      const expiresAt = new Date(Date.parse(issuedAt) + MESSAGE_REVIEW_CARD_TTL_MS).toISOString();
      this.db.prepare(
        `INSERT INTO message_review_cards(
           id, message_version_id, review_hash, content_hash, issued_at, expires_at,
           external_send_authorized, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, messageVersionId, reviewHash, contentHash, issuedAt, expiresAt, issuedAt);
      this.recordEvent("message_version", messageVersionId, "MESSAGE_REVIEW_CARD_ISSUED", "system", {
        reviewCardId: id,
        reviewHash,
        expiresAt,
        externalSendAuthorized: false,
      });
      return { id, expiresAt, created: true };
    });
  }

  reviewGroundedMessage(
    input: GroundedMessageReviewInput,
    authorization: WorkflowAuthorization,
  ): {
    id: string;
    created: boolean;
    decision: GroundedMessageReviewDecision;
    derivedStatus: "APPROVED" | "NEEDS_REWRITE";
    externalSendAuthorized: false;
  } {
    const actor = this.assertWorkflowAuthorization(authorization, "Grounded message content review", {
      human: true,
      roles: ["MESSAGE_REVIEWER"],
    });
    const reviewCardId = input.reviewCardId.trim();
    const messageVersionId = input.messageVersionId.trim();
    const reviewHash = input.reviewHash.trim().toLowerCase();
    const actionId = input.actionId.trim();
    if (!reviewCardId || !messageVersionId || !actionId || !/^[a-f0-9]{64}$/.test(reviewHash)) {
      throw new Error("Content review requires a card, exact message version, review hash, and action id");
    }
    if (!new Set<GroundedMessageReviewDecision>(["APPROVE_CONTENT", "NEEDS_REWRITE"])
      .has(input.decision)) {
      throw new Error("Unsupported grounded message content decision");
    }
    const reviewedAt = this.now();
    return this.transaction(() => {
      const replay = this.db.prepare(
        `SELECT id, review_card_id, message_version_id, review_hash, decision, derived_status
         FROM message_review_decisions WHERE action_id=?`,
      ).get(actionId) as Record<string, unknown> | undefined;
      if (replay) {
        if (replay.review_card_id !== reviewCardId || replay.message_version_id !== messageVersionId ||
          replay.review_hash !== reviewHash || replay.decision !== input.decision) {
          throw new Error("Message review action id was reused for different review material");
        }
        return {
          id: String(replay.id),
          created: false,
          decision: replay.decision as GroundedMessageReviewDecision,
          derivedStatus: replay.derived_status as "APPROVED" | "NEEDS_REWRITE",
          externalSendAuthorized: false as const,
        };
      }

      const material = this.db.prepare(
        `SELECT rc.id AS review_card_id, rc.message_version_id, rc.review_hash,
           rc.content_hash, rc.expires_at, mv.message_key, mv.version_number,
           mv.subject, mv.body, mv.status, mv.send_authorized, mv.generation_mode,
           mv.lint_result_json, pp.status AS plan_status, pp.qualification_track
         FROM message_review_cards rc
         JOIN message_versions mv ON mv.id=rc.message_version_id
         JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
         WHERE rc.id=?`,
      ).get(reviewCardId) as Record<string, unknown> | undefined;
      if (!material || material.message_version_id !== messageVersionId || material.review_hash !== reviewHash) {
        throw new Error("Review card does not match the exact message version and review hash");
      }
      if (String(material.expires_at) <= reviewedAt) {
        throw new Error("Message review card has expired; issue a new card");
      }
      const latest = this.db.prepare(
        `SELECT id FROM message_versions WHERE message_key=?
         ORDER BY version_number DESC LIMIT 1`,
      ).get(String(material.message_key)) as { id: string } | undefined;
      if (latest?.id !== messageVersionId) {
        throw new Error("Message content changed after this review card was issued");
      }
      const contentHash = canonicalHash({ subject: material.subject, body: material.body });
      const lint = parseJsonRecord(String(material.lint_result_json));
      if (material.content_hash !== contentHash || material.status !== "PENDING_APPROVAL" ||
        Number(material.send_authorized) !== 0 || material.plan_status !== "VALID" ||
        material.qualification_track === "WATCHLIST" || lint.passed !== true ||
        /(?:generic|fallback|diagnostic)/i.test(String(material.generation_mode))) {
        throw new Error("Legacy, changed, or ungrounded message content cannot be approved");
      }

      const prior = this.db.prepare(
        `SELECT id, review_hash, decision, derived_status
         FROM message_review_decisions WHERE message_version_id=?`,
      ).get(messageVersionId) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.review_hash === reviewHash && prior.decision === input.decision) {
          return {
            id: String(prior.id),
            created: false,
            decision: prior.decision as GroundedMessageReviewDecision,
            derivedStatus: prior.derived_status as "APPROVED" | "NEEDS_REWRITE",
            externalSendAuthorized: false as const,
          };
        }
        throw new Error("This exact message version already has a different final content decision");
      }

      const derivedStatus = input.decision === "APPROVE_CONTENT" ? "APPROVED" : "NEEDS_REWRITE";
      const id = this.id("mreview");
      this.db.prepare(
        `INSERT INTO message_review_decisions(
           id, review_card_id, message_version_id, review_hash, content_hash,
           decision, derived_status, action_id, actor, actor_type, actor_role,
           reason, external_send_authorized, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', 'MESSAGE_REVIEWER', ?, 0, ?)`,
      ).run(
        id,
        reviewCardId,
        messageVersionId,
        reviewHash,
        contentHash,
        input.decision,
        derivedStatus,
        actionId,
        actor,
        input.reason?.trim().slice(0, 2000) ?? "",
        reviewedAt,
      );
      this.recordEvent("message_version", messageVersionId, "MESSAGE_CONTENT_REVIEWED", actor, {
        reviewDecisionId: id,
        reviewCardId,
        reviewHash,
        decision: input.decision,
        derivedStatus,
        externalSendAuthorized: false,
      });
      return {
        id,
        created: true,
        decision: input.decision,
        derivedStatus,
        externalSendAuthorized: false as const,
      };
    });
  }

  getGroundedMessageReviewState(messageVersionId: string): Record<string, unknown> | null {
    return (this.db.prepare(
      "SELECT * FROM grounded_message_review_states WHERE message_version_id=?",
    ).get(messageVersionId) as Record<string, unknown> | undefined) ?? null;
  }

  saveExperimentDefinition(input: ExperimentDefinitionInput): {
    id: string;
    versionNumber: number;
    definitionHash: string;
    created: boolean;
  } {
    const experimentKey = input.experimentKey.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    const arms = input.arms.map((arm) => arm.trim()).filter(Boolean);
    if (!experimentKey || !createdBy || !input.hypothesis.trim() || !input.primaryVariable.trim() ||
      input.allocationSalt.trim().length < 8 || arms.length < 2 || new Set(arms).size !== arms.length) {
      throw new Error("Experiment requires a key, hypothesis, one primary variable, salt, and unique arms");
    }
    const definitionHash = canonicalHash({
      hypothesis: input.hypothesis.trim(),
      primaryVariable: input.primaryVariable.trim(),
      arms,
      allocationSalt: input.allocationSalt.trim(),
      definition: input.definition ?? {},
    });
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, version_number FROM experiments WHERE experiment_key=? AND definition_hash=?`,
      ).get(experimentKey, definitionHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, definitionHash, created: false };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM experiments WHERE experiment_key=?",
      ).get(experimentKey) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("experiment");
      this.db.prepare(
        `INSERT INTO experiments(
           id, experiment_key, version_number, hypothesis, primary_variable, arms_json,
           allocation_salt, definition_json, definition_hash, status,
           external_send_authorized, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?)`,
      ).run(
        id,
        experimentKey,
        versionNumber,
        input.hypothesis.trim(),
        input.primaryVariable.trim(),
        canonicalJson(arms),
        input.allocationSalt.trim(),
        canonicalJson(input.definition ?? {}),
        definitionHash,
        createdBy,
        this.now(),
      );
      this.recordEvent("experiment", id, "EXPERIMENT_VERSION_CREATED", createdBy, {
        experimentKey,
        versionNumber,
        definitionHash,
        externalSendAuthorized: false,
      });
      return { id, versionNumber, definitionHash, created: true };
    });
  }

  assignExperimentArm(input: {
    experimentId: string;
    subjectType: string;
    subjectId: string;
  }): { id: string; arm: string; assignmentHash: string; created: boolean } {
    const subjectType = input.subjectType.trim().toUpperCase();
    const subjectId = input.subjectId.trim();
    if (!subjectType || !subjectId) throw new Error("Experiment assignment subject is required");
    return this.transaction(() => {
      const experiment = this.db.prepare(
        `SELECT experiment_key, arms_json, allocation_salt FROM experiments WHERE id=?`,
      ).get(input.experimentId) as {
        experiment_key: string;
        arms_json: string;
        allocation_salt: string;
      } | undefined;
      if (!experiment) throw new Error(`Experiment not found: ${input.experimentId}`);
      const arms = JSON.parse(experiment.arms_json) as string[];
      const existing = this.db.prepare(
        `SELECT id, arm, assignment_hash FROM experiment_assignments
         WHERE experiment_key=? AND subject_type=? AND subject_id=?`,
      ).get(experiment.experiment_key, subjectType, subjectId) as {
        id: string;
        arm: string;
        assignment_hash: string;
      } | undefined;
      if (existing) {
        if (!arms.includes(existing.arm)) {
          throw new Error("Existing stable experiment arm is absent from this definition version");
        }
        return {
          id: existing.id,
          arm: existing.arm,
          assignmentHash: existing.assignment_hash,
          created: false,
        };
      }
      const assignmentHash = canonicalHash({
        experimentKey: experiment.experiment_key,
        allocationSalt: experiment.allocation_salt,
        subjectType,
        subjectId,
      });
      const bucket = Number(BigInt(`0x${assignmentHash.slice(0, 16)}`) % BigInt(arms.length));
      const arm = arms[bucket];
      if (!arm) throw new Error("Experiment has no assignable arms");
      const id = this.id("assignment");
      this.db.prepare(
        `INSERT INTO experiment_assignments(
           id, experiment_id, experiment_key, subject_type, subject_id, arm,
           assignment_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.experimentId,
        experiment.experiment_key,
        subjectType,
        subjectId,
        arm,
        assignmentHash,
        this.now(),
      );
      this.recordEvent("experiment_assignment", id, "EXPERIMENT_ARM_ASSIGNED", "system", {
        experimentId: input.experimentId,
        experimentKey: experiment.experiment_key,
        subjectType,
        subjectId,
        arm,
      });
      return { id, arm, assignmentHash, created: true };
    });
  }

  saveSignalObservation(input: SignalObservationInput): { id: string; created: boolean } {
    const idempotencyKey = input.idempotencyKey.trim();
    const createdBy = input.createdBy.trim();
    if (!idempotencyKey || !createdBy || !input.signalType.trim() || !input.sourceUrl.trim() ||
      !input.exactQuote.trim() || !Number.isFinite(input.confidence) ||
      input.confidence < 0 || input.confidence > 1) {
      throw new Error("Signal observation requires evidence, confidence, idempotency key, and creator");
    }
    const observationHash = canonicalHash({
      accountId: input.accountId,
      personId: input.personId ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      signalType: input.signalType.trim().toUpperCase(),
      sourceUrl: input.sourceUrl.trim(),
      exactQuote: input.exactQuote.trim(),
      publishedAt: input.publishedAt ?? null,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt ?? null,
      confidence: input.confidence,
      authorityClass: input.authorityClass.trim().toUpperCase(),
      entityMatch: input.entityMatch,
      metadata: input.metadata ?? {},
    });
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id, observation_hash FROM signal_observations WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string; observation_hash: string } | undefined;
      if (existing) {
        if (existing.observation_hash !== observationHash) {
          throw new Error("Signal idempotency key was reused with different evidence");
        }
        return { id: existing.id, created: false };
      }
      const id = this.id("signal");
      this.db.prepare(
        `INSERT INTO signal_observations(
           id, account_id, person_id, source_document_id, signal_type, source_url,
           exact_quote, published_at, observed_at, expires_at, confidence, authority_class,
           entity_match, status, observation_hash, idempotency_key, metadata_json,
           created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OBSERVED', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        input.personId ?? null,
        input.sourceDocumentId ?? null,
        input.signalType.trim().toUpperCase(),
        input.sourceUrl.trim(),
        input.exactQuote.trim(),
        input.publishedAt ?? null,
        input.observedAt,
        input.expiresAt ?? null,
        input.confidence,
        input.authorityClass.trim().toUpperCase(),
        input.entityMatch,
        observationHash,
        idempotencyKey,
        canonicalJson(input.metadata ?? {}),
        createdBy,
        this.now(),
      );
      this.recordEvent("signal_observation", id, "SIGNAL_OBSERVED", createdBy, {
        accountId: input.accountId,
        signalType: input.signalType.trim().toUpperCase(),
        entityMatch: input.entityMatch,
      });
      return { id, created: true };
    });
  }

  saveRuleVersion(input: RuleVersionPersistenceInput): {
    id: string;
    versionNumber: number;
    versionHash: string;
    created: boolean;
  } {
    const ruleKey = input.ruleKey.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    const actions = [...new Set(input.actions)];
    const allowedActions = new Set([
      "ENQUEUE_ACCOUNT_RESEARCH",
      "REVERIFY_EMPLOYMENT",
      "REVERIFY_CONTACT_POINT",
      "CREATE_MANUAL_CALL_TASK",
      "CREATE_MANUAL_LINKEDIN_TASK",
      "CREATE_MANUAL_EMAIL_TASK",
      "NOTIFY_OWNER",
      "FREEZE_OUTREACH",
      "MOVE_TO_WATCHLIST",
    ]);
    if (!ruleKey || !createdBy || actions.length === 0 || actions.some((action) => !allowedActions.has(action))) {
      throw new Error("Rule version requires only allowlisted actions");
    }
    const versionHash = canonicalHash({ condition: input.condition, actions });
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id, version_number FROM rule_versions WHERE rule_key=? AND version_hash=?",
      ).get(ruleKey, versionHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, versionHash, created: false };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM rule_versions WHERE rule_key=?",
      ).get(ruleKey) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("rulev");
      this.db.prepare(
        `INSERT INTO rule_versions(
           id, rule_key, version_number, condition_json, actions_json, version_hash,
           status, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
      ).run(
        id,
        ruleKey,
        versionNumber,
        canonicalJson(input.condition),
        canonicalJson(actions),
        versionHash,
        createdBy,
        this.now(),
      );
      this.recordEvent("rule_version", id, "RULE_VERSION_CREATED", createdBy, {
        ruleKey,
        versionNumber,
        versionHash,
        actions,
      });
      return { id, versionNumber, versionHash, created: true };
    });
  }

  saveManualEngagementEvent(
    input: ManualEngagementEventInput,
    authorization: WorkflowAuthorization,
  ): { id: string; created: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Manual engagement recording", {
      human: true,
      roles: ["SALES", "SALES_MANAGER", "INBOUND_REVIEW"],
    });
    const idempotencyKey = input.idempotencyKey.trim();
    const eventType = input.eventType.trim().toUpperCase();
    if (!idempotencyKey || !eventType || (input.durationSeconds !== null &&
      input.durationSeconds !== undefined &&
      (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 0))) {
      throw new Error("Manual engagement event requires an idempotency key, type, and valid duration");
    }
    const eventHash = canonicalHash({
      accountId: input.accountId,
      personId: input.personId ?? null,
      contactPointId: input.contactPointId ?? null,
      playId: input.playId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      messageVersionId: input.messageVersionId ?? null,
      channel: input.channel,
      eventType,
      direction: input.direction ?? "NONE",
      outcome: input.outcome?.trim().toUpperCase() || null,
      occurredAt: input.occurredAt,
      externalReference: input.externalReference?.trim() || null,
      durationSeconds: input.durationSeconds ?? null,
      notes: input.notes?.trim().slice(0, 4000) || null,
      manualActor: actor,
      metadata: input.metadata ?? {},
    });
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id, event_hash FROM manual_engagement_events WHERE idempotency_key=?",
      ).get(idempotencyKey) as { id: string; event_hash: string } | undefined;
      if (existing) {
        if (existing.event_hash !== eventHash) {
          throw new Error("Manual engagement idempotency key was reused with different content");
        }
        return { id: existing.id, created: false };
      }
      const id = this.id("manualevt");
      this.db.prepare(
        `INSERT INTO manual_engagement_events(
           id, account_id, person_id, contact_point_id, play_id, enrollment_id,
           message_version_id, channel, event_type, direction, outcome, occurred_at,
           external_reference, duration_seconds, notes, manual_actor, actor_type,
           external_write_performed, event_hash, idempotency_key, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', 0, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        input.personId ?? null,
        input.contactPointId ?? null,
        input.playId ?? null,
        input.enrollmentId ?? null,
        input.messageVersionId ?? null,
        input.channel,
        eventType,
        input.direction ?? "NONE",
        input.outcome?.trim().toUpperCase() || null,
        input.occurredAt,
        input.externalReference?.trim() || null,
        input.durationSeconds ?? null,
        input.notes?.trim().slice(0, 4000) || null,
        actor,
        eventHash,
        idempotencyKey,
        canonicalJson(input.metadata ?? {}),
        this.now(),
      );
      this.recordEvent("manual_engagement_event", id, "MANUAL_ENGAGEMENT_RECORDED", actor, {
        accountId: input.accountId,
        channel: input.channel,
        eventType,
        externalWritePerformed: false,
      });
      return { id, created: true };
    });
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, this.now());
  }

  setSettings(values: Record<string, string>): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      );
      const now = this.now();
      for (const [key, value] of Object.entries(values)) statement.run(key, value, now);
    });
  }

  setSettingIfAbsent(key: string, value: string): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)",
    ).run(key, value, this.now());
    return Number(result.changes) === 1;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  listSettings(prefix: string): Record<string, string> {
    let rows: Array<{ key: string; value: string }>;
    if (!prefix) {
      rows = this.db
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .all() as Array<{ key: string; value: string }>;
    } else {
      const upperBound = lexicalPrefixUpperBound(prefix);
      rows = upperBound === null
        ? this.db
          .prepare("SELECT key, value FROM settings WHERE key >= ? ORDER BY key")
          .all(prefix) as Array<{ key: string; value: string }>
        : this.db
          .prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ? ORDER BY key")
          .all(prefix, upperBound) as Array<{ key: string; value: string }>;
    }
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  recordImapMessageFailure(input: ImapMessageFailureInput): ImapMessageFailureRecord {
    const uidValidity = input.uidValidity.trim();
    const uid = Math.floor(input.uid);
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
    if (!uidValidity || uid <= 0) throw new Error("IMAP failure requires UIDVALIDITY and a positive UID");
    if (!/^[a-f0-9]{64}$/i.test(input.sourceSha256)) {
      throw new Error("IMAP failure requires a SHA-256 source fingerprint");
    }
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM imap_message_failures WHERE uid_validity=? AND uid=?",
      ).get(uidValidity, uid) as ImapMessageFailureRecord | undefined;
      if (existing?.status === "QUARANTINED" || existing?.status === "UNREPLAYABLE") return existing;
      const now = this.now();
      const attempts = (existing?.attempts ?? 0) + 1;
      const quarantined = attempts >= maxAttempts;
      const status = quarantined ? "QUARANTINED" : "RETRY_PENDING";
      const quarantineEpisode = (existing?.quarantine_episode ?? 0) + (quarantined ? 1 : 0);
      const previewJson = canonicalJson(input.preview);
      if (existing) {
        this.db.prepare(
          `UPDATE imap_message_failures
           SET status=?, attempts=?, max_attempts=?, quarantine_episode=?, source_sha256=?,
               source_size=?, preview_json=?, last_error_class=?, last_error_message=?,
               last_failed_at=?, quarantined_at=?, resolved_at=NULL, updated_at=?
           WHERE id=?`,
        ).run(
          status,
          attempts,
          maxAttempts,
          quarantineEpisode,
          input.sourceSha256.toLowerCase(),
          Math.max(0, Math.floor(input.sourceSize)),
          previewJson,
          input.errorClass.trim().slice(0, 120) || "Error",
          input.errorMessage.trim().slice(0, 500) || "IMAP message processing failed",
          now,
          quarantined ? now : null,
          now,
          existing.id,
        );
      } else {
        this.db.prepare(
          `INSERT INTO imap_message_failures(
             id, uid_validity, uid, status, attempts, max_attempts, quarantine_episode,
             source_sha256, source_size, preview_json, last_error_class, last_error_message,
             first_failed_at, last_failed_at, quarantined_at, replay_requested_at,
             replay_requested_by, resolved_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        ).run(
          this.id("imapfail"),
          uidValidity,
          uid,
          status,
          attempts,
          maxAttempts,
          quarantineEpisode,
          input.sourceSha256.toLowerCase(),
          Math.max(0, Math.floor(input.sourceSize)),
          previewJson,
          input.errorClass.trim().slice(0, 120) || "Error",
          input.errorMessage.trim().slice(0, 500) || "IMAP message processing failed",
          now,
          now,
          quarantined ? now : null,
          now,
          now,
        );
      }
      return this.db.prepare("SELECT * FROM imap_message_failures WHERE uid_validity=? AND uid=?")
        .get(uidValidity, uid) as ImapMessageFailureRecord;
    });
  }

  resolveImapMessageFailure(uidValidity: string, uid: number): boolean {
    const result = this.db.prepare(
      `UPDATE imap_message_failures SET status='RESOLVED', resolved_at=?, updated_at=?
       WHERE uid_validity=? AND uid=? AND status='RETRY_PENDING'`,
    ).run(this.now(), this.now(), uidValidity, uid);
    return Number(result.changes) === 1;
  }

  listImapRetryUids(uidValidity: string, limit = 100): number[] {
    return (this.db.prepare(
      `SELECT uid FROM imap_message_failures
       WHERE uid_validity=? AND status='RETRY_PENDING' ORDER BY uid LIMIT ?`,
    ).all(uidValidity, Math.max(1, limit)) as Array<{ uid: number }>).map((row) => row.uid);
  }

  getImapMessageFailure(uidValidity: string, uid: number): ImapMessageFailureRecord | null {
    return (this.db.prepare(
      "SELECT * FROM imap_message_failures WHERE uid_validity=? AND uid=?",
    ).get(uidValidity, uid) as ImapMessageFailureRecord | undefined) ?? null;
  }

  listQuarantinedImapMessages(limit = 100): ImapMessageFailureRecord[] {
    return this.db.prepare(
      `SELECT * FROM imap_message_failures WHERE status IN ('QUARANTINED','UNREPLAYABLE')
       ORDER BY coalesce(quarantined_at, last_failed_at) DESC LIMIT ?`,
    ).all(Math.max(1, limit)) as ImapMessageFailureRecord[];
  }

  getImapFailureSummary(): {
    retryPending: number;
    quarantined: number;
    unreplayable: number;
    resolved: number;
  } {
    const rows = this.db.prepare(
      "SELECT status, count(*) AS count FROM imap_message_failures GROUP BY status",
    ).all() as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return {
      retryPending: counts.RETRY_PENDING ?? 0,
      quarantined: counts.QUARANTINED ?? 0,
      unreplayable: counts.UNREPLAYABLE ?? 0,
      resolved: counts.RESOLVED ?? 0,
    };
  }

  requestImapMessageReplay(
    id: string,
    actor: string,
    currentUidValidity: string,
  ): ImapReplayRequestResult {
    return this.transaction(() => {
      const record = this.db.prepare(
        "SELECT * FROM imap_message_failures WHERE id=?",
      ).get(id) as ImapMessageFailureRecord | undefined;
      if (!record) return { requested: false, reason: "找不到这条隔离邮件记录。", record: null };
      if (record.uid_validity !== currentUidValidity.trim()) {
        return {
          requested: false,
          reason: "邮箱 UIDVALIDITY 已变化，原邮件定位已失效，不能自动重新处理。",
          record,
        };
      }
      if (record.status === "RETRY_PENDING") {
        return { requested: false, reason: "这封邮件已经在等待重新处理，请勿重复操作。", record };
      }
      if (record.status === "RESOLVED") {
        return { requested: false, reason: "这封邮件已经处理成功，无需再次重放。", record };
      }
      if (record.status !== "QUARANTINED") {
        return { requested: false, reason: "这封邮件的定位已不可重放。", record };
      }
      const now = this.now();
      this.db.prepare(
        `UPDATE imap_message_failures
         SET status='RETRY_PENDING', attempts=0, replay_requested_at=?, replay_requested_by=?,
             resolved_at=NULL, updated_at=? WHERE id=? AND status='QUARANTINED'`,
      ).run(now, actor.trim().slice(0, 200) || "operator", now, id);
      this.recordEvent(
        "imap_message_failure",
        id,
        "IMAP_MESSAGE_REPLAY_REQUESTED",
        actor.trim().slice(0, 200) || "operator",
        { uidValidity: record.uid_validity, uid: record.uid },
      );
      const updated = this.db.prepare("SELECT * FROM imap_message_failures WHERE id=?")
        .get(id) as ImapMessageFailureRecord;
      return { requested: true, reason: "已加入重新处理队列，不会回退或堵塞收件游标。", record: updated };
    });
  }

  expireImapFailuresForUidValidity(uidValidity: string): number {
    const now = this.now();
    const result = this.db.prepare(
      `UPDATE imap_message_failures
       SET status='UNREPLAYABLE', quarantined_at=coalesce(quarantined_at, ?), updated_at=?
       WHERE uid_validity<>? AND status IN ('RETRY_PENDING','QUARANTINED')`,
    ).run(now, now, uidValidity);
    return Number(result.changes);
  }

  upsertAccount(input: AccountInput): string {
    const domain = normalizeAccountDomain(input.domain);
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("Account display name is required");
    return this.transaction(() => {
      const now = this.now();
      const existing = this.db.prepare(
        `SELECT a.id FROM accounts a
         JOIN account_domains d ON d.account_id=a.id
         WHERE d.domain=? COLLATE NOCASE LIMIT 1`,
      ).get(domain) as { id: string } | undefined;
      if (existing) {
        this.db.prepare(
          `UPDATE accounts SET display_name=?, legal_name=coalesce(?, legal_name),
             account_type=?, website=coalesce(?, website),
             country_code=coalesce(?, country_code), metadata_json=?, updated_at=?
           WHERE id=?`,
        ).run(
          displayName,
          input.legalName?.trim() || null,
          input.accountType ?? "COMPANY",
          input.website?.trim() || null,
          input.countryCode?.trim() || null,
          canonicalJson(input.metadata ?? {}),
          now,
          existing.id,
        );
        return existing.id;
      }

      const id = this.id("acct");
      this.db.prepare(
        `INSERT INTO accounts(
           id, display_name, legal_name, account_type, website, country_code,
           lifecycle_status, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`,
      ).run(
        id,
        displayName,
        input.legalName?.trim() || null,
        input.accountType ?? "COMPANY",
        input.website?.trim() || null,
        input.countryCode?.trim() || null,
        canonicalJson(input.metadata ?? {}),
        now,
        now,
      );
      this.db.prepare(
        `INSERT INTO account_domains(
           id, account_id, domain, is_primary, verification_status, source,
           observed_at, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'UNVERIFIED', ?, ?, ?, ?)`,
      ).run(this.id("adom"), id, domain, input.source?.trim() || "local", now, now, now);
      return id;
    });
  }

  getAccountByDomain(domain: string): Record<string, unknown> | null {
    const normalized = normalizeAccountDomain(domain);
    return (this.db.prepare(
      `SELECT a.*, d.domain AS primary_domain, d.verification_status AS domain_verification_status
       FROM accounts a JOIN account_domains d ON d.account_id=a.id
       WHERE d.domain=? COLLATE NOCASE
       ORDER BY d.is_primary DESC, d.created_at LIMIT 1`,
    ).get(normalized) as Record<string, unknown> | undefined) ?? null;
  }

  getAccountAcquisitionProfile(accountId: string): Record<string, unknown> | null {
    return (this.db.prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM account_domains d WHERE d.account_id=a.id) AS domain_count,
         (SELECT COUNT(*) FROM facilities f WHERE f.account_id=a.id) AS facility_count,
         (SELECT COUNT(*) FROM employments e WHERE e.account_id=a.id) AS employment_count,
         (SELECT COUNT(*) FROM play_enrollments pe WHERE pe.account_id=a.id) AS enrollment_count,
         (SELECT COUNT(*) FROM evidence_facts ef WHERE ef.account_id=a.id) AS evidence_fact_count,
         (SELECT COUNT(*) FROM opportunities o WHERE o.account_id=a.id) AS opportunity_count
       FROM accounts a WHERE a.id=?`,
    ).get(accountId) as Record<string, unknown> | undefined) ?? null;
  }

  upsertPlay(input: PlayInput): {
    playId: string;
    playVersionId: string;
    versionNumber: number;
  } {
    const playKey = input.key.trim();
    if (!playKey) throw new Error("Play key is required");
    const definitionJson = canonicalJson({
      ...input.definition,
      country: input.country,
      buyerArchetype: input.buyerArchetype,
      application: input.application,
      productFamily: input.productFamily,
      roleFamily: input.roleFamily,
      qualificationTrack: input.qualificationTrack,
      offer: input.offer,
      channel: input.channel,
    });
    const contentHash = crypto.createHash("sha256").update(definitionJson).digest("hex");
    return this.transaction(() => {
      const now = this.now();
      const existing = this.db.prepare(
        "SELECT id FROM plays WHERE play_key=? COLLATE NOCASE",
      ).get(playKey) as { id: string } | undefined;
      const playId = existing?.id ?? this.id("play");
      if (existing) {
        this.db.prepare(
          `UPDATE plays SET name=?, country=?, buyer_archetype=?, application=?,
             product_family=?, role_family=?, qualification_track=?, offer=?, channel=?,
             status=?, approval_policy=?, updated_at=? WHERE id=?`,
        ).run(
          input.name,
          input.country,
          input.buyerArchetype,
          input.application,
          input.productFamily,
          input.roleFamily,
          input.qualificationTrack,
          input.offer,
          input.channel,
          input.status ?? "DRAFT",
          input.approvalPolicy ?? "REVIEW_ALL",
          now,
          playId,
        );
      } else {
        this.db.prepare(
          `INSERT INTO plays(
             id, play_key, name, country, buyer_archetype, application, product_family,
             role_family, qualification_track, offer, channel, status, approval_policy,
             created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          playId,
          playKey,
          input.name,
          input.country,
          input.buyerArchetype,
          input.application,
          input.productFamily,
          input.roleFamily,
          input.qualificationTrack,
          input.offer,
          input.channel,
          input.status ?? "DRAFT",
          input.approvalPolicy ?? "REVIEW_ALL",
          input.createdBy,
          now,
          now,
        );
      }

      const version = this.db.prepare(
        `SELECT id, version_number FROM play_versions
         WHERE play_id=? AND content_hash=?`,
      ).get(playId, contentHash) as { id: string; version_number: number } | undefined;
      if (version) {
        return { playId, playVersionId: version.id, versionNumber: Number(version.version_number) };
      }
      const row = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) + 1 AS next_version FROM play_versions WHERE play_id=?",
      ).get(playId) as { next_version: number };
      const versionNumber = Number(row.next_version);
      const playVersionId = this.id("playv");
      this.db.prepare(
        `INSERT INTO play_versions(
           id, play_id, version_number, definition_json, content_hash,
           policy_version, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, 'acquisition-foundation-v1', ?, ?)`,
      ).run(playVersionId, playId, versionNumber, definitionJson, contentHash, input.createdBy, now);
      return { playId, playVersionId, versionNumber };
    });
  }

  linkCampaignToPlayVersion(
    campaignId: string,
    playVersionId: string,
    linkedBy: string,
    isPrimary = true,
  ): string {
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM campaign_play_links WHERE campaign_id=? AND play_version_id=?",
      ).get(campaignId, playVersionId) as { id: string } | undefined;
      if (isPrimary) {
        this.db.prepare("UPDATE campaign_play_links SET is_primary=0 WHERE campaign_id=?")
          .run(campaignId);
      }
      if (existing) {
        this.db.prepare("UPDATE campaign_play_links SET is_primary=? WHERE id=?")
          .run(isPrimary ? 1 : 0, existing.id);
        return existing.id;
      }
      const id = this.id("cplay");
      this.db.prepare(
        `INSERT INTO campaign_play_links(
           id, campaign_id, play_version_id, is_primary, linked_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, campaignId, playVersionId, isPrimary ? 1 : 0, linkedBy, this.now());
      return id;
    });
  }

  enrollAccountInPlay(input: PlayEnrollmentInput): { id: string; inserted: boolean } {
    const idempotencyKey = input.idempotencyKey?.trim() || crypto.createHash("sha256")
      .update(`play-enrollment\0${input.accountId}\0${input.playVersionId}`)
      .digest("hex");
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id FROM play_enrollments
         WHERE idempotency_key=? OR (account_id=? AND play_version_id=?) LIMIT 1`,
      ).get(idempotencyKey, input.accountId, input.playVersionId) as { id: string } | undefined;
      if (existing) return { id: existing.id, inserted: false };
      if (input.campaignId) {
        const linked = this.db.prepare(
          "SELECT 1 FROM campaign_play_links WHERE campaign_id=? AND play_version_id=?",
        ).get(input.campaignId, input.playVersionId);
        if (!linked) this.linkCampaignToPlayVersion(input.campaignId, input.playVersionId, "enrollment", false);
      }
      const id = this.id("enroll");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO play_enrollments(
           id, account_id, play_version_id, campaign_id, status, qualification_track,
           source, idempotency_key, enrolled_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId,
        input.playVersionId,
        input.campaignId ?? null,
        input.status ?? "PROSPECT",
        input.qualificationTrack ?? "WATCHLIST",
        input.source?.trim() || "local",
        idempotencyKey,
        now,
        now,
      );
      return { id, inserted: true };
    });
  }

  listAccountPlayEnrollments(accountId: string): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT pe.*, pv.version_number, pv.content_hash, p.play_key, p.name AS play_name,
         p.status AS play_status, p.country, p.buyer_archetype, p.application,
         p.product_family, p.offer, p.channel
       FROM play_enrollments pe
       JOIN play_versions pv ON pv.id=pe.play_version_id
       JOIN plays p ON p.id=pv.play_id
       WHERE pe.account_id=? ORDER BY pe.enrolled_at, pe.id`,
    ).all(accountId) as Array<Record<string, unknown>>;
  }

  addExclusion(input: ExclusionInput): { id: string; inserted: boolean } {
    const scopes = [input.accountId, input.personId, input.facilityId, input.playId, input.scopeValue]
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== "");
    if (scopes.length !== 1) throw new Error("An exclusion must target exactly one scope");
    const scopeValue = input.scopeValue?.trim().toLowerCase() || null;
    const idempotencyKey = input.idempotencyKey?.trim() || crypto.createHash("sha256")
      .update(canonicalJson({
        exclusionType: input.exclusionType,
        accountId: input.accountId ?? null,
        personId: input.personId ?? null,
        facilityId: input.facilityId ?? null,
        playId: input.playId ?? null,
        scopeValue,
        reason: input.reason.trim(),
        source: input.source.trim(),
      }))
      .digest("hex");
    const existing = this.db.prepare("SELECT id FROM exclusions WHERE idempotency_key=?")
      .get(idempotencyKey) as { id: string } | undefined;
    if (existing) return { id: existing.id, inserted: false };
    const id = this.id("excl");
    const now = this.now();
    this.db.prepare(
      `INSERT INTO exclusions(
         id, exclusion_type, account_id, person_id, facility_id, play_id, scope_value,
         reason, source, status, idempotency_key, starts_at, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.exclusionType,
      input.accountId ?? null,
      input.personId ?? null,
      input.facilityId ?? null,
      input.playId ?? null,
      scopeValue,
      input.reason,
      input.source,
      idempotencyKey,
      input.startsAt ?? now,
      input.expiresAt ?? null,
      now,
      now,
    );
    return { id, inserted: true };
  }

  listActiveExclusions(
    query: ActiveExclusionQuery,
    at = this.now(),
  ): Array<Record<string, unknown>> {
    const matches: string[] = [];
    const parameters: string[] = [at, at];
    const addMatch = (column: string, value: string | null | undefined): void => {
      if (!value?.trim()) return;
      matches.push(`${column}=?`);
      parameters.push(column === "scope_value" ? value.trim().toLowerCase() : value);
    };
    addMatch("account_id", query.accountId);
    addMatch("person_id", query.personId);
    addMatch("facility_id", query.facilityId);
    addMatch("play_id", query.playId);
    addMatch("scope_value", query.scopeValue);
    if (matches.length === 0) throw new Error("An active exclusion query requires a scope");
    let sql = `SELECT * FROM exclusions
      WHERE status='ACTIVE' AND starts_at<=? AND (expires_at IS NULL OR expires_at>?)
        AND (${matches.join(" OR ")})`;
    if (query.exclusionType) {
      sql += " AND exclusion_type=?";
      parameters.push(query.exclusionType);
    }
    sql += " ORDER BY created_at, id";
    return this.db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
  }

  hasActiveExclusion(query: ActiveExclusionQuery, at = this.now()): boolean {
    return this.listActiveExclusions(query, at).length > 0;
  }

  upsertApprovedClaim(input: ApprovedClaimInput): {
    id: string;
    versionNumber: number;
    created: boolean;
  } {
    const claimKey = input.claimKey.trim().toLowerCase();
    const claimType = input.claimType.trim().toUpperCase();
    const statement = input.statement.trim();
    const sourceHash = input.sourceHash.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    if (!claimKey || !claimType || !statement || !createdBy) {
      throw new Error("Approved claim key, type, statement, and creator are required");
    }
    if (sourceHash.length < 16) throw new Error("Approved claim source hash is too short");
    const allowedMarkets = normalizedUniqueValues(input.allowedMarkets, true);
    const allowedChannels = normalizedUniqueValues(input.allowedChannels);
    const payload = {
      claimType,
      statement,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceHash,
      visibility: input.visibility ?? "PRIVATE",
      allowedMarkets,
      allowedChannels,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    };
    const contentHash = canonicalHash(payload);
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, version_number FROM approved_claims
         WHERE claim_key=? AND content_hash=?`,
      ).get(claimKey, contentHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, created: false };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM approved_claims WHERE claim_key=?",
      ).get(claimKey) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("claim");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO approved_claims(
           id, claim_key, version_number, claim_type, statement, source_document_id,
           source_hash, visibility, allowed_markets_json, allowed_channels_json,
           status, content_hash, created_by, expires_at, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        claimKey,
        versionNumber,
        claimType,
        statement,
        input.sourceDocumentId ?? null,
        sourceHash,
        input.visibility ?? "PRIVATE",
        canonicalJson(allowedMarkets),
        canonicalJson(allowedChannels),
        contentHash,
        createdBy,
        input.expiresAt ?? null,
        canonicalJson(input.metadata ?? {}),
        now,
        now,
      );
      this.recordEvent("approved_claim", id, "APPROVED_CLAIM_VERSION_CREATED", createdBy, {
        claimKey,
        versionNumber,
        visibility: input.visibility ?? "PRIVATE",
        contentHash,
      });
      return { id, versionNumber, created: true };
    });
  }

  transitionApprovedClaim(
    claimId: string,
    to: ApprovedClaimStatus,
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean; status: ApprovedClaimStatus } {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT status, expires_at FROM approved_claims WHERE id=?")
        .get(claimId) as { status: ApprovedClaimStatus; expires_at: string | null } | undefined;
      if (!row) throw new Error(`Approved claim not found: ${claimId}`);
      if (row.status === to) return { changed: false, status: to };
      const allowed: Record<ApprovedClaimStatus, readonly ApprovedClaimStatus[]> = {
        DRAFT: ["ENGINEERING_REVIEW"],
        ENGINEERING_REVIEW: ["APPROVED"],
        APPROVED: ["STALE", "REVOKED"],
        STALE: [],
        REVOKED: [],
      };
      if (!allowed[row.status].includes(to)) {
        throw new Error(`Invalid approved claim transition: ${row.status} -> ${to}`);
      }
      let actor: string;
      if (to === "APPROVED" || to === "STALE" || to === "REVOKED") {
        actor = this.assertWorkflowAuthorization(authorization, `Claim transition to ${to}`, {
          human: true,
          roles: ["ENGINEERING", "COMPLIANCE"],
        });
      } else {
        actor = this.assertWorkflowAuthorization(authorization, `Claim transition to ${to}`);
      }
      const now = this.now();
      if (to === "APPROVED" && row.expires_at && row.expires_at <= now) {
        throw new Error("An expired claim cannot be approved");
      }
      this.db.prepare(
        `UPDATE approved_claims SET status=?,
           submitted_at=CASE WHEN ?='ENGINEERING_REVIEW' THEN ? ELSE submitted_at END,
           approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END,
           approved_actor_type=CASE WHEN ?='APPROVED' THEN ? ELSE approved_actor_type END,
           approved_at=CASE WHEN ?='APPROVED' THEN ? ELSE approved_at END,
           stale_at=CASE WHEN ?='STALE' THEN ? ELSE stale_at END,
           revoked_at=CASE WHEN ?='REVOKED' THEN ? ELSE revoked_at END,
           review_reason=?, updated_at=? WHERE id=?`,
      ).run(
        to,
        to,
        now,
        to,
        actor,
        to,
        authorization.actorType,
        to,
        now,
        to,
        now,
        to,
        now,
        reason.trim().slice(0, 2000),
        now,
        claimId,
      );
      this.recordEvent("approved_claim", claimId, "APPROVED_CLAIM_STATUS_CHANGED", actor, {
        from: row.status,
        to,
        reason: reason.trim().slice(0, 2000),
      });
      return { changed: true, status: to };
    });
  }

  listApprovedClaimReviewQueue(
    statuses: readonly ApprovedClaimStatus[] = ["DRAFT", "ENGINEERING_REVIEW"],
  ): Array<Record<string, unknown>> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM approved_claims WHERE status IN (${placeholders})
       ORDER BY updated_at, claim_key, version_number`,
    ).all(...statuses) as Array<Record<string, unknown>>;
  }

  listExternallyUsableApprovedClaims(options: {
    market?: string;
    channel?: string;
  } = {}): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      "SELECT * FROM externally_usable_approved_claims ORDER BY claim_key, version_number",
    ).all() as Array<Record<string, unknown>>;
    const market = options.market?.trim().toUpperCase();
    const channel = options.channel?.trim().toLowerCase();
    const parseList = (value: unknown): string[] => {
      try {
        const parsed = JSON.parse(String(value)) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    return rows.filter((row) => {
      const markets = parseList(row.allowed_markets_json).map((value) => value.toUpperCase());
      const channels = parseList(row.allowed_channels_json).map((value) => value.toLowerCase());
      return (!market || markets.length === 0 || markets.includes(market)) &&
        (!channel || channels.length === 0 || channels.includes(channel));
    });
  }

  upsertContentAsset(input: ContentAssetInput): { id: string; created: boolean } {
    const assetKey = input.assetKey.trim().toLowerCase();
    const assetType = input.assetType.trim().toUpperCase();
    const title = input.title.trim();
    const defaultLocale = input.defaultLocale.trim().toLowerCase();
    const createdBy = input.createdBy.trim();
    if (!assetKey || !assetType || !title || !defaultLocale || !createdBy) {
      throw new Error("Content asset key, type, title, locale, and creator are required");
    }
    const targetMarkets = normalizedUniqueValues(input.targetMarkets, true);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM content_assets WHERE asset_key=?")
        .get(assetKey) as Record<string, unknown> | undefined;
      const visibility = input.visibility ?? "PRIVATE";
      const marketsJson = canonicalJson(targetMarkets);
      const metadataJson = canonicalJson(input.metadata ?? {});
      if (existing) {
        const changed = existing.asset_type !== assetType || existing.title !== title ||
          existing.default_locale !== defaultLocale || existing.visibility !== visibility ||
          existing.target_markets_json !== marketsJson || existing.metadata_json !== metadataJson;
        if (!changed) return { id: String(existing.id), created: false };
        this.db.prepare(
          `UPDATE content_assets SET asset_type=?, title=?, default_locale=?, visibility=?,
             target_markets_json=?, metadata_json=?, updated_at=? WHERE id=?`,
        ).run(
          assetType,
          title,
          defaultLocale,
          visibility,
          marketsJson,
          metadataJson,
          this.now(),
          String(existing.id),
        );
        this.recordEvent("content_asset", String(existing.id), "CONTENT_ASSET_UPDATED", createdBy, {
          assetKey,
        });
        return { id: String(existing.id), created: false };
      }
      const id = this.id("content");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO content_assets(
           id, asset_key, asset_type, title, default_locale, visibility, target_markets_json,
           created_by, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        assetKey,
        assetType,
        title,
        defaultLocale,
        visibility,
        marketsJson,
        createdBy,
        metadataJson,
        now,
        now,
      );
      this.recordEvent("content_asset", id, "CONTENT_ASSET_CREATED", createdBy, { assetKey });
      return { id, created: true };
    });
  }

  upsertContentVersion(input: ContentVersionInput): {
    id: string;
    versionNumber: number;
    created: boolean;
  } {
    const locale = input.locale.trim().toLowerCase();
    const body = input.body.trim();
    const createdBy = input.createdBy.trim();
    const claimIds = [...new Set(input.approvedClaimIds ?? [])].sort((left, right) => left.localeCompare(right));
    if (!locale || !body || !createdBy) throw new Error("Content locale, body, and creator are required");
    const contentHash = canonicalHash({
      locale,
      body,
      claimIds,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    });
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM content_assets WHERE id=?").get(input.assetId)) {
        throw new Error(`Content asset not found: ${input.assetId}`);
      }
      for (const claimId of claimIds) {
        if (!this.db.prepare("SELECT 1 FROM approved_claims WHERE id=?").get(claimId)) {
          throw new Error(`Approved claim not found: ${claimId}`);
        }
      }
      const existing = this.db.prepare(
        "SELECT id, version_number FROM content_versions WHERE asset_id=? AND content_hash=?",
      ).get(input.assetId, contentHash) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, created: false };
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM content_versions WHERE asset_id=?",
      ).get(input.assetId) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("contentv");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO content_versions(
           id, asset_id, version_number, locale, body, content_hash, status, created_by,
           expires_at, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.assetId,
        versionNumber,
        locale,
        body,
        contentHash,
        createdBy,
        input.expiresAt ?? null,
        canonicalJson(input.metadata ?? {}),
        now,
        now,
      );
      const link = this.db.prepare(
        `INSERT INTO content_version_claims(content_version_id, approved_claim_id, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const claimId of claimIds) link.run(id, claimId, now);
      this.recordEvent("content_version", id, "CONTENT_VERSION_CREATED", createdBy, {
        assetId: input.assetId,
        versionNumber,
        contentHash,
        approvedClaimIds: claimIds,
      });
      return { id, versionNumber, created: true };
    });
  }

  transitionContentVersion(
    contentVersionId: string,
    to: ContentVersionStatus,
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean; status: ContentVersionStatus } {
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT cv.status, cv.expires_at, ca.visibility
         FROM content_versions cv JOIN content_assets ca ON ca.id=cv.asset_id
         WHERE cv.id=?`,
      ).get(contentVersionId) as {
        status: ContentVersionStatus;
        expires_at: string | null;
        visibility: "PUBLIC" | "PRIVATE";
      } | undefined;
      if (!row) throw new Error(`Content version not found: ${contentVersionId}`);
      if (row.status === to) return { changed: false, status: to };
      const allowed: Record<ContentVersionStatus, readonly ContentVersionStatus[]> = {
        DRAFT: ["TECHNICAL_REVIEW"],
        TECHNICAL_REVIEW: ["LOCALIZATION_REVIEW"],
        LOCALIZATION_REVIEW: ["APPROVED"],
        APPROVED: ["PUBLISHED", "STALE"],
        PUBLISHED: ["STALE"],
        STALE: [],
      };
      if (!allowed[row.status].includes(to)) {
        throw new Error(`Invalid content transition: ${row.status} -> ${to}`);
      }
      let actor: string;
      if (to === "LOCALIZATION_REVIEW") {
        actor = this.assertWorkflowAuthorization(authorization, "Technical content review", {
          human: true,
          roles: ["ENGINEERING", "COMPLIANCE"],
        });
      } else if (to === "APPROVED") {
        actor = this.assertWorkflowAuthorization(authorization, "Content approval", {
          human: true,
          roles: ["LOCALIZATION", "CONTENT_REVIEW"],
        });
      } else if (to === "PUBLISHED") {
        actor = this.assertWorkflowAuthorization(authorization, "Content publication", {
          human: true,
          roles: ["PUBLISHER"],
        });
      } else if (to === "STALE") {
        actor = this.assertWorkflowAuthorization(authorization, "Content invalidation", {
          human: true,
          roles: ["ENGINEERING", "COMPLIANCE", "CONTENT_REVIEW", "PUBLISHER"],
        });
      } else {
        actor = this.assertWorkflowAuthorization(authorization, "Content review submission");
      }
      const now = this.now();
      if ((to === "APPROVED" || to === "PUBLISHED") && row.expires_at && row.expires_at <= now) {
        throw new Error("Expired content cannot be approved or published");
      }
      if ((to === "APPROVED" || to === "PUBLISHED") && row.visibility === "PUBLIC") {
        const invalidClaims = this.db.prepare(
          `SELECT count(*) AS count FROM content_version_claims cvc
           LEFT JOIN externally_usable_approved_claims claim ON claim.id=cvc.approved_claim_id
           WHERE cvc.content_version_id=? AND claim.id IS NULL`,
        ).get(contentVersionId) as { count: number };
        if (Number(invalidClaims.count) > 0) {
          throw new Error("Public content contains private, unapproved, stale, revoked, or expired claims");
        }
      }
      if (to === "PUBLISHED" && row.visibility !== "PUBLIC") {
        throw new Error("Private content cannot be published externally");
      }
      this.db.prepare(
        `UPDATE content_versions SET status=?,
           technical_reviewed_by=CASE WHEN ?='LOCALIZATION_REVIEW' THEN ? ELSE technical_reviewed_by END,
           technical_reviewed_at=CASE WHEN ?='LOCALIZATION_REVIEW' THEN ? ELSE technical_reviewed_at END,
           localization_reviewed_by=CASE WHEN ?='APPROVED' THEN ? ELSE localization_reviewed_by END,
           localization_reviewed_at=CASE WHEN ?='APPROVED' THEN ? ELSE localization_reviewed_at END,
           approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END,
           approved_at=CASE WHEN ?='APPROVED' THEN ? ELSE approved_at END,
           published_by=CASE WHEN ?='PUBLISHED' THEN ? ELSE published_by END,
           published_actor_type=CASE WHEN ?='PUBLISHED' THEN ? ELSE published_actor_type END,
           published_at=CASE WHEN ?='PUBLISHED' THEN ? ELSE published_at END,
           stale_at=CASE WHEN ?='STALE' THEN ? ELSE stale_at END,
           review_reason=?, updated_at=? WHERE id=?`,
      ).run(
        to,
        to,
        actor,
        to,
        now,
        to,
        actor,
        to,
        now,
        to,
        actor,
        to,
        now,
        to,
        actor,
        to,
        authorization.actorType,
        to,
        now,
        to,
        now,
        reason.trim().slice(0, 2000),
        now,
        contentVersionId,
      );
      this.recordEvent("content_version", contentVersionId, "CONTENT_VERSION_STATUS_CHANGED", actor, {
        from: row.status,
        to,
        reason: reason.trim().slice(0, 2000),
      });
      return { changed: true, status: to };
    });
  }

  listContentReviewQueue(
    statuses: readonly ContentVersionStatus[] = ["DRAFT", "TECHNICAL_REVIEW", "LOCALIZATION_REVIEW"],
  ): Array<Record<string, unknown>> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT cv.*, ca.asset_key, ca.asset_type, ca.title, ca.visibility, ca.target_markets_json,
         (SELECT count(*) FROM content_version_claims cvc WHERE cvc.content_version_id=cv.id) AS claim_count
       FROM content_versions cv JOIN content_assets ca ON ca.id=cv.asset_id
       WHERE cv.status IN (${placeholders}) ORDER BY cv.updated_at, ca.asset_key, cv.version_number`,
    ).all(...statuses) as Array<Record<string, unknown>>;
  }

  listExternallyUsableContentVersions(options: {
    market?: string;
    channel?: string;
    locale?: string;
    publishedOnly?: boolean;
  } = {}): Array<Record<string, unknown>> {
    let sql = `SELECT cv.*, ca.asset_key, ca.asset_type, ca.title, ca.visibility,
      ca.target_markets_json FROM externally_usable_content_versions cv
      JOIN content_assets ca ON ca.id=cv.asset_id WHERE 1=1`;
    const parameters: string[] = [];
    if (options.locale) {
      sql += " AND lower(cv.locale)=?";
      parameters.push(options.locale.trim().toLowerCase());
    }
    if (options.publishedOnly) sql += " AND cv.status='PUBLISHED'";
    sql += " ORDER BY ca.asset_key, cv.version_number";
    const rows = this.db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
    const market = options.market?.trim().toUpperCase();
    const channel = options.channel?.trim().toLowerCase();
    const parseList = (value: unknown): string[] => {
      try {
        const parsed = JSON.parse(String(value)) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    return rows.filter((row) => {
      const targetMarkets = parseList(row.target_markets_json).map((value) => value.toUpperCase());
      if (market && targetMarkets.length > 0 && !targetMarkets.includes(market)) return false;
      const claims = this.db.prepare(
        `SELECT claim.allowed_markets_json, claim.allowed_channels_json
         FROM content_version_claims cvc
         JOIN externally_usable_approved_claims claim ON claim.id=cvc.approved_claim_id
         WHERE cvc.content_version_id=?`,
      ).all(String(row.id)) as Array<Record<string, unknown>>;
      return claims.every((claim) => {
        const markets = parseList(claim.allowed_markets_json).map((value) => value.toUpperCase());
        const channels = parseList(claim.allowed_channels_json).map((value) => value.toLowerCase());
        return (!market || markets.length === 0 || markets.includes(market)) &&
          (!channel || channels.length === 0 || channels.includes(channel));
      });
    });
  }

  upsertTranslation(input: TranslationInput): {
    id: string;
    versionNumber: number;
    created: boolean;
  } {
    const locale = input.locale.trim().toLowerCase();
    const body = input.body.trim();
    const createdBy = input.createdBy.trim();
    const sourceHash = input.sourceHash.trim().toLowerCase();
    if (!locale || !body || !createdBy || sourceHash.length < 16) {
      throw new Error("Translation locale, body, creator, and source hash are required");
    }
    const translationHash = canonicalHash({
      locale,
      body,
      sourceHash,
      terminologySnapshotHash: input.terminologySnapshotHash ?? null,
    });
    return this.transaction(() => {
      const source = this.db.prepare("SELECT content_hash FROM content_versions WHERE id=?")
        .get(input.contentVersionId) as { content_hash: string } | undefined;
      if (!source) throw new Error(`Content version not found: ${input.contentVersionId}`);
      if (source.content_hash !== sourceHash) {
        throw new Error("Translation source hash does not match the content version");
      }
      const existing = this.db.prepare(
        `SELECT id, version_number FROM translations
         WHERE content_version_id=? AND locale=? AND translation_hash=?`,
      ).get(input.contentVersionId, locale, translationHash) as
        | { id: string; version_number: number }
        | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, created: false };
      }
      const latest = this.db.prepare(
        `SELECT coalesce(max(version_number), 0) AS version FROM translations
         WHERE content_version_id=? AND locale=?`,
      ).get(input.contentVersionId, locale) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("translation");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO translations(
           id, content_version_id, locale, version_number, body, source_hash, translation_hash,
           terminology_snapshot_hash, status, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      ).run(
        id,
        input.contentVersionId,
        locale,
        versionNumber,
        body,
        sourceHash,
        translationHash,
        input.terminologySnapshotHash ?? null,
        createdBy,
        now,
        now,
      );
      this.recordEvent("translation", id, "TRANSLATION_VERSION_CREATED", createdBy, {
        contentVersionId: input.contentVersionId,
        locale,
        versionNumber,
        translationHash,
      });
      return { id, versionNumber, created: true };
    });
  }

  transitionTranslation(
    translationId: string,
    to: "LOCALIZATION_REVIEW" | "APPROVED" | "STALE" | "REVOKED",
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean; status: string } {
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT t.status, t.source_hash, cv.content_hash
         FROM translations t JOIN content_versions cv ON cv.id=t.content_version_id WHERE t.id=?`,
      ).get(translationId) as { status: string; source_hash: string; content_hash: string } | undefined;
      if (!row) throw new Error(`Translation not found: ${translationId}`);
      if (row.status === to) return { changed: false, status: to };
      const allowed: Record<string, readonly string[]> = {
        DRAFT: ["LOCALIZATION_REVIEW"],
        LOCALIZATION_REVIEW: ["APPROVED"],
        APPROVED: ["STALE", "REVOKED"],
        STALE: [],
        REVOKED: [],
      };
      if (!(allowed[row.status] ?? []).includes(to)) {
        throw new Error(`Invalid translation transition: ${row.status} -> ${to}`);
      }
      const actor = to === "LOCALIZATION_REVIEW"
        ? this.assertWorkflowAuthorization(authorization, "Translation review submission")
        : this.assertWorkflowAuthorization(authorization, `Translation transition to ${to}`, {
          human: true,
          roles: ["LOCALIZATION", "CONTENT_REVIEW"],
        });
      if (to === "APPROVED" && row.source_hash !== row.content_hash) {
        throw new Error("A stale translation source cannot be approved");
      }
      const now = this.now();
      this.db.prepare(
        `UPDATE translations SET status=?,
           reviewed_by=CASE WHEN ?='LOCALIZATION_REVIEW' THEN ? ELSE reviewed_by END,
           reviewed_at=CASE WHEN ?='LOCALIZATION_REVIEW' THEN ? ELSE reviewed_at END,
           approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END,
           approved_at=CASE WHEN ?='APPROVED' THEN ? ELSE approved_at END,
           review_reason=?, updated_at=? WHERE id=?`,
      ).run(to, to, actor, to, now, to, actor, to, now, reason.trim().slice(0, 2000), now, translationId);
      this.recordEvent("translation", translationId, "TRANSLATION_STATUS_CHANGED", actor, {
        from: row.status,
        to,
        reason: reason.trim().slice(0, 2000),
      });
      return { changed: true, status: to };
    });
  }

  upsertTerminologyGlossary(input: TerminologyGlossaryInput): { id: string; created: boolean } {
    const locale = input.locale.trim().toLowerCase();
    const sourceTerm = input.sourceTerm.trim();
    const approvedTerm = input.approvedTerm.trim();
    const createdBy = input.createdBy.trim();
    if (!locale || !sourceTerm || !approvedTerm || !createdBy) {
      throw new Error("Glossary locale, source term, approved term, and creator are required");
    }
    const idempotencyKey = input.idempotencyKey?.trim() || `terminology:${canonicalHash({
      locale,
      sourceTerm: sourceTerm.toLowerCase(),
      approvedTerm,
      definition: input.definition ?? null,
      unitPolicy: input.unitPolicy ?? null,
    })}`;
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM terminology_glossary WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.id("term");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO terminology_glossary(
           id, locale, source_term, approved_term, definition, unit_policy, status,
           created_by, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      ).run(
        id,
        locale,
        sourceTerm,
        approvedTerm,
        input.definition?.trim() || null,
        input.unitPolicy?.trim() || null,
        createdBy,
        idempotencyKey,
        now,
        now,
      );
      this.recordEvent("terminology", id, "TERMINOLOGY_CREATED", createdBy, { locale, sourceTerm });
      return { id, created: true };
    });
  }

  transitionTerminologyGlossary(
    terminologyId: string,
    to: "APPROVED" | "STALE" | "REVOKED",
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean; status: string } {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT status FROM terminology_glossary WHERE id=?")
        .get(terminologyId) as { status: string } | undefined;
      if (!row) throw new Error(`Terminology entry not found: ${terminologyId}`);
      if (row.status === to) return { changed: false, status: to };
      const valid = (row.status === "DRAFT" && to === "APPROVED") ||
        (row.status === "APPROVED" && (to === "STALE" || to === "REVOKED"));
      if (!valid) throw new Error(`Invalid terminology transition: ${row.status} -> ${to}`);
      const actor = this.assertWorkflowAuthorization(authorization, `Terminology transition to ${to}`, {
        human: true,
        roles: ["LOCALIZATION", "CONTENT_REVIEW"],
      });
      const now = this.now();
      this.db.prepare(
        `UPDATE terminology_glossary SET status=?,
           approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END,
           approved_at=CASE WHEN ?='APPROVED' THEN ? ELSE approved_at END,
           updated_at=? WHERE id=?`,
      ).run(to, to, actor, to, now, now, terminologyId);
      this.recordEvent("terminology", terminologyId, "TERMINOLOGY_STATUS_CHANGED", actor, {
        from: row.status,
        to,
        reason: reason.trim().slice(0, 2000),
      });
      return { changed: true, status: to };
    });
  }

  upsertContentQuestion(input: ContentQuestionInput): { id: string; created: boolean } {
    const question = input.question.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    const createdBy = input.createdBy.trim();
    if (!question || !idempotencyKey || !createdBy) {
      throw new Error("Content question, idempotency key, and creator are required");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM content_questions WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.id("question");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO content_questions(
           id, question, source_type, intake_id, opportunity_id, content_asset_id,
           evidence_span, market, locale, priority, status, idempotency_key, created_by,
           metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        question,
        input.sourceType,
        input.intakeId ?? null,
        input.opportunityId ?? null,
        input.contentAssetId ?? null,
        input.evidenceSpan?.trim() || null,
        input.market?.trim() || null,
        input.locale?.trim().toLowerCase() || null,
        Math.max(0, Math.min(100, Math.trunc(input.priority ?? 50))),
        idempotencyKey,
        createdBy,
        canonicalJson(input.metadata ?? {}),
        now,
        now,
      );
      this.recordEvent("content_question", id, "CONTENT_QUESTION_CREATED", createdBy, {
        sourceType: input.sourceType,
        intakeId: input.intakeId ?? null,
        opportunityId: input.opportunityId ?? null,
      });
      return { id, created: true };
    });
  }

  listContentQuestions(statuses: readonly string[] = ["OPEN", "PROPOSED"]): Array<Record<string, unknown>> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM content_questions WHERE status IN (${placeholders})
       ORDER BY priority DESC, created_at, id`,
    ).all(...statuses) as Array<Record<string, unknown>>;
  }

  upsertInquiryIntake(input: InquiryIntakeInput): {
    id: string;
    inserted: boolean;
    status: string;
  } {
    const bodyText = input.bodyText.slice(0, 32_768);
    const normalizedSender = input.source === "WHATSAPP"
      ? input.sender.replace(/\D/g, "")
      : input.sender.trim().toLowerCase();
    if (!normalizedSender) throw new Error("Inbound sender is required");
    const providerEventId = input.providerEventId?.trim() || null;
    const messageId = input.messageId?.trim() || null;
    const suppliedHash = input.contentHash?.trim().toLowerCase() || null;
    if (suppliedHash && suppliedHash.length < 16) throw new Error("Inbound content hash is too short");
    const contentHash = suppliedHash ?? crypto.createHash("sha256").update(canonicalJson({
      source: input.source,
      sender: normalizedSender,
      recipient: input.recipient?.trim().toLowerCase() || null,
      subject: input.subject?.trim() || null,
      bodyText,
      receivedAt: input.receivedAt,
    })).digest("hex");
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, intake_status FROM inquiry_intakes
         WHERE source=? AND (
           (? IS NOT NULL AND provider_event_id=?) OR
           (? IS NOT NULL AND message_id=?) OR content_hash=?
         ) ORDER BY created_at LIMIT 1`,
      ).get(
        input.source,
        providerEventId,
        providerEventId,
        messageId,
        messageId,
        contentHash,
      ) as { id: string; intake_status: string } | undefined;
      if (existing) return { id: existing.id, inserted: false, status: existing.intake_status };

      const id = this.id("intake");
      const now = this.now();
      const matched = Boolean(input.accountId || input.personId || input.contactPointId || input.leadId);
      const status = matched ? "MATCHED" : "QUARANTINED";
      const idempotencyKey = providerEventId
        ? `provider:${input.source}:${providerEventId}`
        : messageId
          ? `message:${input.source}:${messageId}`
          : `content:${input.source}:${contentHash}`;
      this.db.prepare(
        `INSERT INTO inquiry_intakes(
           id, source, provider_event_id, message_id, content_hash, idempotency_key,
           normalized_sender, recipient, subject, body_text, received_at, classification,
           account_id, person_id, contact_point_id, legacy_lead_id, outbound_message_id,
           correlation_method, correlation_confidence, intake_status, quarantine_reason,
           raw_headers_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.source,
        providerEventId,
        messageId,
        contentHash,
        idempotencyKey,
        normalizedSender,
        input.recipient?.trim().toLowerCase() || null,
        input.subject?.slice(0, 1000) ?? null,
        bodyText,
        input.receivedAt,
        input.classification ?? null,
        input.accountId ?? null,
        input.personId ?? null,
        input.contactPointId ?? null,
        input.leadId ?? null,
        input.outboundMessageId ?? null,
        input.correlationMethod ?? null,
        input.correlationConfidence ?? null,
        status,
        matched ? null : "unmatched inbound intake",
        canonicalJson(input.rawHeaders ?? {}),
        now,
        now,
      );
      this.recordEvent("inquiry_intake", id, "INQUIRY_INTAKE_RECEIVED", "system", {
        source: input.source,
        matched,
        classification: input.classification ?? null,
      });
      return { id, inserted: true, status };
    });
  }

  quarantineInquiryIntake(intakeId: string, reason: string, classification?: string | null): void {
    this.transaction(() => {
      const current = this.db.prepare(
        `SELECT intake_status, quarantine_reason, classification, quarantine_decision
         FROM inquiry_intakes WHERE id=?`,
      ).get(intakeId) as {
        intake_status: string;
        quarantine_reason: string | null;
        classification: string | null;
        quarantine_decision: string | null;
      } | undefined;
      if (!current) throw new Error(`Inquiry intake not found: ${intakeId}`);
      if (current.quarantine_decision) {
        throw new Error(`Reviewed inquiry intake cannot return to quarantine: ${intakeId}`);
      }
      const boundedReason = reason.slice(0, 1000);
      const nextClassification = classification ?? current.classification;
      if (current.intake_status === "QUARANTINED" && current.quarantine_reason === boundedReason &&
        current.classification === nextClassification) return;
      const result = this.db.prepare(
        `UPDATE inquiry_intakes SET intake_status='QUARANTINED', quarantine_reason=?,
           classification=coalesce(?, classification), updated_at=? WHERE id=?`,
      ).run(boundedReason, classification ?? null, this.now(), intakeId);
      if (Number(result.changes) !== 1) throw new Error(`Inquiry intake not found: ${intakeId}`);
      this.recordEvent("inquiry_intake", intakeId, "INQUIRY_INTAKE_QUARANTINED", "system", {
        reason: boundedReason,
        classification: classification ?? null,
      });
    });
  }

  updateInquiryIntakeClassification(
    intakeId: string,
    classification: string,
    status: "MATCHED" | "QUALIFIED" | "REJECTED" | "PROCESSED",
  ): void {
    this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE inquiry_intakes SET classification=?, intake_status=?,
           quarantine_reason=NULL, updated_at=? WHERE id=?`,
      ).run(classification, status, this.now(), intakeId);
      if (Number(result.changes) !== 1) throw new Error(`Inquiry intake not found: ${intakeId}`);
      this.recordEvent("inquiry_intake", intakeId, `INQUIRY_INTAKE_${status}`, "system", {
        classification,
      });
    });
  }

  recordInquiryFacts(intakeId: string, facts: readonly InquiryFactInput[]): number {
    return this.transaction(() => {
      let inserted = 0;
      const statement = this.db.prepare(
        `INSERT OR IGNORE INTO inquiry_facts(
           id, intake_id, field_name, normalized_value, unit, exact_evidence_span,
           confidence, extraction_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const fact of facts) {
        if (!fact.fieldName.trim() || !fact.exactEvidenceSpan.trim()) continue;
        const result = statement.run(
          this.id("ifact"),
          intakeId,
          fact.fieldName.trim(),
          fact.normalizedValue.slice(0, 1000),
          fact.unit?.slice(0, 50) ?? null,
          fact.exactEvidenceSpan.slice(0, 1000),
          Math.max(0, Math.min(1, fact.confidence)),
          fact.extractionVersion,
          this.now(),
        );
        inserted += Number(result.changes);
      }
      if (inserted > 0) {
        this.recordEvent("inquiry_intake", intakeId, "INQUIRY_FACTS_RECORDED", "system", {
          inserted,
        });
      }
      return inserted;
    });
  }

  getInquiryIntake(intakeId: string): Record<string, unknown> | null {
    return (this.db.prepare("SELECT * FROM inquiry_intakes WHERE id=?").get(intakeId) as
      | Record<string, unknown>
      | undefined) ?? null;
  }

  listQuarantinedInquiryReviews(): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT intake.*, prospect.id AS inbound_prospect_id, prospect.prospect_status
       FROM inquiry_intakes intake
       LEFT JOIN inbound_prospects prospect ON prospect.intake_id=intake.id
       WHERE intake.intake_status IN ('UNMATCHED','QUARANTINED')
         AND intake.quarantine_decision IS NULL
       ORDER BY intake.received_at, intake.id`,
    ).all() as Array<Record<string, unknown>>;
  }

  acceptQuarantinedInquiry(
    intakeId: string,
    prospect: InboundProspectReviewInput,
    authorization: WorkflowAuthorization,
    reason: string,
  ): { prospectId: string; changed: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Inbound quarantine acceptance", {
      human: true,
      roles: ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
    });
    return this.transaction(() => {
      const intake = this.db.prepare(
        `SELECT id, intake_status, quarantine_decision, normalized_sender, account_id, person_id,
           classification, source, received_at
         FROM inquiry_intakes WHERE id=?`,
      ).get(intakeId) as {
        id: string;
        intake_status: string;
        quarantine_decision: "ACCEPTED" | "REJECTED" | null;
        normalized_sender: string;
        account_id: string | null;
        person_id: string | null;
        classification: string | null;
        source: string;
        received_at: string;
      } | undefined;
      if (!intake) throw new Error(`Inquiry intake not found: ${intakeId}`);
      if (intake.quarantine_decision === "REJECTED") {
        throw new Error("A rejected quarantine review cannot be accepted without a new intake");
      }
      const existing = this.db.prepare("SELECT id FROM inbound_prospects WHERE intake_id=?")
        .get(intakeId) as { id: string } | undefined;
      if (intake.quarantine_decision === "ACCEPTED") {
        if (!existing) throw new Error("Accepted quarantine review is missing its inbound prospect");
        return { prospectId: existing.id, changed: false };
      }
      if (!new Set(["UNMATCHED", "QUARANTINED"]).has(intake.intake_status)) {
        throw new Error(`Inquiry intake is not awaiting quarantine review: ${intake.intake_status}`);
      }
      if (prospect.contentAssetId &&
        !this.db.prepare("SELECT 1 FROM content_assets WHERE id=?").get(prospect.contentAssetId)) {
        throw new Error(`Content asset not found: ${prospect.contentAssetId}`);
      }
      const prospectId = this.id("inboundp");
      const now = this.now();
      const inferredEmail = intake.normalized_sender.includes("@") ? intake.normalized_sender : null;
      this.db.prepare(
        `INSERT INTO inbound_prospects(
           id, intake_id, account_id, person_id, content_asset_id, full_name, company_name,
           work_email, phone, country_code, product_interest, application, landing, referrer,
           utm_source, utm_medium, utm_campaign, consent_status, prospect_status, send_eligible,
           accepted_by, accepted_at, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'PENDING_VERIFICATION', 0, ?, ?, ?, ?, ?)`,
      ).run(
        prospectId,
        intakeId,
        intake.account_id,
        intake.person_id,
        prospect.contentAssetId ?? null,
        prospect.fullName?.trim() || null,
        prospect.companyName?.trim() || null,
        prospect.workEmail?.trim().toLowerCase() || inferredEmail,
        prospect.phone?.trim() || null,
        prospect.countryCode?.trim().toUpperCase() || null,
        prospect.productInterest?.trim() || null,
        prospect.application?.trim() || null,
        prospect.landing?.trim() || null,
        prospect.referrer?.trim() || null,
        prospect.utmSource?.trim() || null,
        prospect.utmMedium?.trim() || null,
        prospect.utmCampaign?.trim() || null,
        prospect.consentStatus ?? "UNKNOWN",
        actor,
        now,
        canonicalJson(prospect.metadata ?? {}),
        now,
        now,
      );
      const update = this.db.prepare(
        `UPDATE inquiry_intakes SET intake_status='PROCESSED', quarantine_decision='ACCEPTED',
           quarantine_reviewed_by=?, quarantine_reviewed_at=?, quarantine_review_reason=?,
           quarantine_reason=NULL, updated_at=?
         WHERE id=? AND quarantine_decision IS NULL`,
      ).run(actor, now, reason.trim().slice(0, 2000), now, intakeId);
      if (Number(update.changes) !== 1) throw new Error("Concurrent quarantine review conflict");
      this.recordEvent("inquiry_intake", intakeId, "INQUIRY_QUARANTINE_ACCEPTED", actor, {
        prospectId,
        reason: reason.trim().slice(0, 2000),
      });
      this.recordEvent("inbound_prospect", prospectId, "INBOUND_PROSPECT_CREATED", actor, {
        intakeId,
        sendEligible: false,
      });
      if (["P1_INQUIRY", "P2_INTEREST", "REFERRAL"].includes(intake.classification ?? "")) {
        const opportunity = this.createOrGetOpportunity({
          idempotencyKey: `accepted-inquiry-intake:${intakeId}`,
          source: intake.source,
          accountId: intake.account_id,
          personId: intake.person_id,
          intakeId,
          stage: "INQUIRY_QUALIFIED",
          owner: actor,
          firstResponseDueAt: new Date(Date.parse(intake.received_at) + 15 * 60_000).toISOString(),
        });
        this.createOrGetSalesTask({
          idempotencyKey: `accepted-inquiry-intake:${intakeId}:followup`,
          taskType: "INQUIRY_FOLLOWUP",
          owner: actor,
          dueAt: new Date(Date.parse(intake.received_at) + 15 * 60_000).toISOString(),
          accountId: intake.account_id,
          personId: intake.person_id,
          opportunityId: opportunity.id,
          sourceSignal: intake.classification,
          payload: { intakeId, prospectId, acceptedBy: actor },
        });
      }
      return { prospectId, changed: true };
    });
  }

  rejectQuarantinedInquiry(
    intakeId: string,
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Inbound quarantine rejection", {
      human: true,
      roles: ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
    });
    const boundedReason = reason.trim().slice(0, 2000);
    if (!boundedReason) throw new Error("Inbound quarantine rejection reason is required");
    return this.transaction(() => {
      const intake = this.db.prepare(
        "SELECT intake_status, quarantine_decision FROM inquiry_intakes WHERE id=?",
      ).get(intakeId) as {
        intake_status: string;
        quarantine_decision: "ACCEPTED" | "REJECTED" | null;
      } | undefined;
      if (!intake) throw new Error(`Inquiry intake not found: ${intakeId}`);
      if (intake.quarantine_decision === "ACCEPTED") {
        throw new Error("An accepted quarantine review cannot be rejected without a new intake");
      }
      if (intake.quarantine_decision === "REJECTED") return { changed: false };
      if (!new Set(["UNMATCHED", "QUARANTINED"]).has(intake.intake_status)) {
        throw new Error(`Inquiry intake is not awaiting quarantine review: ${intake.intake_status}`);
      }
      const now = this.now();
      this.db.prepare(
        `UPDATE inquiry_intakes SET intake_status='REJECTED', quarantine_decision='REJECTED',
           quarantine_reviewed_by=?, quarantine_reviewed_at=?, quarantine_review_reason=?,
           updated_at=? WHERE id=? AND quarantine_decision IS NULL`,
      ).run(actor, now, boundedReason, now, intakeId);
      this.recordEvent("inquiry_intake", intakeId, "INQUIRY_QUARANTINE_REJECTED", actor, {
        reason: boundedReason,
      });
      return { changed: true };
    });
  }

  linkInboundMessage(input: InboundMessageLinkInput): { id: string; created: boolean } {
    const idempotencyKey = input.idempotencyKey.trim();
    const correlationMethod = input.correlationMethod.trim();
    if (!idempotencyKey || !correlationMethod) {
      throw new Error("Inbound link idempotency key and correlation method are required");
    }
    if (!input.inboundMessageId && !input.outboundMessageId) {
      throw new Error("Inbound link requires an inbound or outbound message id");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM inbound_message_links WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      if (!this.db.prepare("SELECT 1 FROM inquiry_intakes WHERE id=?").get(input.intakeId)) {
        throw new Error(`Inquiry intake not found: ${input.intakeId}`);
      }
      const id = this.id("inboundlink");
      const confidence = Math.max(0, Math.min(1, input.correlationConfidence));
      const now = this.now();
      this.db.prepare(
        `INSERT INTO inbound_message_links(
           id, intake_id, inbound_message_id, outbound_message_id, correlation_method,
           correlation_confidence, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.intakeId,
        input.inboundMessageId ?? null,
        input.outboundMessageId ?? null,
        correlationMethod,
        confidence,
        idempotencyKey,
        now,
      );
      if (input.outboundMessageId) {
        this.db.prepare(
          `UPDATE inquiry_intakes SET outbound_message_id=?, correlation_method=?,
             correlation_confidence=?, updated_at=? WHERE id=?`,
        ).run(input.outboundMessageId, correlationMethod, confidence, now, input.intakeId);
      }
      this.recordEvent("inquiry_intake", input.intakeId, "INBOUND_MESSAGE_LINKED", "system", {
        inboundMessageId: input.inboundMessageId ?? null,
        outboundMessageId: input.outboundMessageId ?? null,
        correlationMethod,
        correlationConfidence: confidence,
      });
      return { id, created: true };
    });
  }

  createOrGetOpportunity(input: OpportunityInput): { id: string; created: boolean } {
    if (input.stage === "WON") {
      throw new Error("WON opportunities require an accepted quote and an authorized human transition");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM opportunities WHERE idempotency_key=?")
        .get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.id("opp");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO opportunities(
           id, account_id, person_id, intake_id, enrollment_id, source, stage, owner,
           first_response_due_at, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId ?? null,
        input.personId ?? null,
        input.intakeId ?? null,
        input.enrollmentId ?? null,
        input.source,
        input.stage ?? "NEW",
        input.owner ?? null,
        input.firstResponseDueAt ?? null,
        input.idempotencyKey,
        now,
        now,
      );
      this.recordEvent("opportunity", id, "OPPORTUNITY_CREATED", "system", {
        source: input.source,
        stage: input.stage ?? "NEW",
        intakeId: input.intakeId ?? null,
      });
      return { id, created: true };
    });
  }

  getOpportunity(opportunityId: string): Record<string, unknown> | null {
    return (this.db.prepare("SELECT * FROM opportunities WHERE id=?").get(opportunityId) as
      | Record<string, unknown>
      | undefined) ?? null;
  }

  transitionOpportunityStage(
    opportunityId: string,
    to: OpportunityStage,
    authorization: WorkflowAuthorization,
    reason: string,
    options: { wonQuoteId?: string | null; lostReason?: string | null } = {},
  ): { changed: boolean; stage: OpportunityStage } {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT stage FROM opportunities WHERE id=?")
        .get(opportunityId) as { stage: OpportunityStage } | undefined;
      if (!row) throw new Error(`Opportunity not found: ${opportunityId}`);
      if (row.stage === to) return { changed: false, stage: to };
      const allowed: Record<OpportunityStage, readonly OpportunityStage[]> = {
        NEW: ["INQUIRY_QUALIFIED", "QUALIFIED", "NEEDS_INFO", "LOST"],
        INQUIRY_QUALIFIED: ["TECHNICAL_DISCOVERY", "TECHNICAL_REVIEW", "NEEDS_INFO", "LOST"],
        QUALIFIED: ["TECHNICAL_DISCOVERY", "TECHNICAL_REVIEW", "NEEDS_INFO", "LOST"],
        NEEDS_INFO: ["INQUIRY_QUALIFIED", "TECHNICAL_DISCOVERY", "LOST"],
        TECHNICAL_REVIEW: ["TECHNICAL_DISCOVERY", "NEEDS_INFO", "LOST"],
        TECHNICAL_DISCOVERY: ["QUOTE_PENDING", "QUOTED", "LOST"],
        QUOTE_PENDING: ["TECHNICAL_DISCOVERY", "QUOTED", "LOST"],
        QUOTED: ["NEGOTIATION", "WON", "LOST"],
        NEGOTIATION: ["QUOTED", "WON", "LOST"],
        WON: [],
        LOST: [],
      };
      if (!allowed[row.stage].includes(to)) {
        throw new Error(`Invalid opportunity transition: ${row.stage} -> ${to}`);
      }
      const needsSalesHuman = new Set<OpportunityStage>(["QUOTED", "NEGOTIATION", "WON", "LOST"])
        .has(to);
      const actor = needsSalesHuman
        ? this.assertWorkflowAuthorization(authorization, `Opportunity transition to ${to}`, {
          human: true,
          roles: to === "WON" ? ["SALES_MANAGER"] : ["SALES", "SALES_MANAGER"],
        })
        : this.assertWorkflowAuthorization(authorization, `Opportunity transition to ${to}`);
      const now = this.now();
      let wonQuote: {
        id: string;
        amount_minor: number;
        currency: string;
        gross_margin_bps: number | null;
      } | null = null;
      if (to === "WON") {
        if (!options.wonQuoteId) throw new Error("WON transition requires an accepted quote");
        const selectedQuote = this.db.prepare(
          `SELECT id, amount_minor, currency, gross_margin_bps FROM quotes
           WHERE id=? AND opportunity_id=? AND status='ACCEPTED'`,
        ).get(options.wonQuoteId, opportunityId) as {
          id: string;
          amount_minor: number;
          currency: string;
          gross_margin_bps: number | null;
        } | undefined;
        wonQuote = selectedQuote ?? null;
        if (!wonQuote) throw new Error("WON transition requires an accepted quote for this opportunity");
      }
      if (to === "QUOTED" || to === "NEGOTIATION") {
        const quote = this.db.prepare(
          `SELECT 1 FROM quotes WHERE opportunity_id=?
           AND status IN ('SUBMITTED','ACCEPTED') LIMIT 1`,
        ).get(opportunityId);
        if (!quote) throw new Error(`${to} requires a submitted or accepted quote`);
      }
      const lostReason = to === "LOST" ? (options.lostReason?.trim() || reason.trim()) : null;
      if (to === "LOST" && !lostReason) throw new Error("LOST transition requires a reason");
      this.db.prepare(
        `UPDATE opportunities SET stage=?,
           quoted_at=CASE WHEN ?='QUOTED' THEN coalesce(quoted_at, ?) ELSE quoted_at END,
           closed_at=CASE WHEN ? IN ('WON','LOST') THEN ? ELSE closed_at END,
           lost_reason=CASE WHEN ?='LOST' THEN ? ELSE lost_reason END,
           won_quote_id=CASE WHEN ?='WON' THEN ? ELSE won_quote_id END,
           won_amount_minor=CASE WHEN ?='WON' THEN ? ELSE won_amount_minor END,
           won_currency=CASE WHEN ?='WON' THEN ? ELSE won_currency END,
           won_gross_margin_bps=CASE WHEN ?='WON' THEN ? ELSE won_gross_margin_bps END,
           won_by=CASE WHEN ?='WON' THEN ? ELSE won_by END,
           updated_at=? WHERE id=?`,
      ).run(
        to,
        to,
        now,
        to,
        now,
        to,
        lostReason,
        to,
        wonQuote?.id ?? null,
        to,
        wonQuote?.amount_minor ?? null,
        to,
        wonQuote?.currency ?? null,
        to,
        wonQuote?.gross_margin_bps ?? null,
        to,
        actor,
        now,
        opportunityId,
      );
      this.recordEvent("opportunity", opportunityId, "OPPORTUNITY_STAGE_CHANGED", actor, {
        from: row.stage,
        to,
        reason: reason.trim().slice(0, 2000),
        wonQuoteId: wonQuote?.id ?? null,
      });
      return { changed: true, stage: to };
    });
  }

  createQuote(
    input: QuoteInput,
    authorization: WorkflowAuthorization,
  ): { id: string; versionNumber: number; created: boolean } {
    const actor = this.assertWorkflowAuthorization(authorization, "Quote creation", {
      human: true,
      roles: ["SALES", "SALES_MANAGER"],
    });
    const idempotencyKey = input.idempotencyKey.trim();
    const currency = input.currency.trim().toUpperCase();
    if (!idempotencyKey) throw new Error("Quote idempotency key is required");
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new Error("Quote amount must be a non-negative integer in minor currency units");
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Quote currency must be a three-letter ISO code");
    if (input.grossMarginBps !== null && input.grossMarginBps !== undefined &&
      (!Number.isInteger(input.grossMarginBps) || input.grossMarginBps < -10_000 ||
        input.grossMarginBps > 10_000)) {
      throw new Error("Quote gross margin must be an integer between -10000 and 10000 basis points");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id, version_number FROM quotes WHERE idempotency_key=?")
        .get(idempotencyKey) as { id: string; version_number: number } | undefined;
      if (existing) {
        return { id: existing.id, versionNumber: existing.version_number, created: false };
      }
      const opportunity = this.db.prepare("SELECT stage FROM opportunities WHERE id=?")
        .get(input.opportunityId) as { stage: OpportunityStage } | undefined;
      if (!opportunity) throw new Error(`Opportunity not found: ${input.opportunityId}`);
      if (opportunity.stage === "WON" || opportunity.stage === "LOST") {
        throw new Error("A closed opportunity cannot receive a new quote");
      }
      if (input.sourceTouchpointId &&
        !this.db.prepare("SELECT 1 FROM touchpoints WHERE id=?").get(input.sourceTouchpointId)) {
        throw new Error(`Touchpoint not found: ${input.sourceTouchpointId}`);
      }
      const latest = this.db.prepare(
        "SELECT coalesce(max(version_number), 0) AS version FROM quotes WHERE opportunity_id=?",
      ).get(input.opportunityId) as { version: number };
      const versionNumber = Number(latest.version) + 1;
      const id = this.id("quote");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO quotes(
           id, opportunity_id, version_number, amount_minor, currency, gross_margin_bps,
           status, created_by, terms_json, created_at, updated_at, idempotency_key,
           expires_at, source_touchpoint_id, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.opportunityId,
        versionNumber,
        input.amountMinor,
        currency,
        input.grossMarginBps ?? null,
        actor,
        canonicalJson(input.terms ?? {}),
        now,
        now,
        idempotencyKey,
        input.expiresAt ?? null,
        input.sourceTouchpointId ?? null,
        actor,
      );
      this.recordEvent("quote", id, "QUOTE_CREATED", actor, {
        opportunityId: input.opportunityId,
        versionNumber,
      });
      return { id, versionNumber, created: true };
    });
  }

  transitionQuoteStatus(
    quoteId: string,
    to: "APPROVED" | "SUBMITTED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "WITHDRAWN",
    authorization: WorkflowAuthorization,
    reason: string,
  ): { changed: boolean; status: string } {
    const actor = this.assertWorkflowAuthorization(authorization, `Quote transition to ${to}`, {
      human: true,
      roles: ["SALES", "SALES_MANAGER"],
    });
    return this.transaction(() => {
      const quote = this.db.prepare("SELECT status, opportunity_id, expires_at FROM quotes WHERE id=?")
        .get(quoteId) as { status: string; opportunity_id: string; expires_at: string | null } | undefined;
      if (!quote) throw new Error(`Quote not found: ${quoteId}`);
      if (quote.status === to) return { changed: false, status: to };
      const allowed: Record<string, readonly string[]> = {
        DRAFT: ["APPROVED", "WITHDRAWN"],
        APPROVED: ["SUBMITTED", "WITHDRAWN", "EXPIRED"],
        SUBMITTED: ["ACCEPTED", "REJECTED", "WITHDRAWN", "EXPIRED"],
        ACCEPTED: [],
        REJECTED: [],
        EXPIRED: [],
        WITHDRAWN: [],
      };
      if (!(allowed[quote.status] ?? []).includes(to)) {
        throw new Error(`Invalid quote transition: ${quote.status} -> ${to}`);
      }
      const now = this.now();
      if (to === "SUBMITTED" && quote.expires_at && quote.expires_at <= now) {
        throw new Error("An expired quote cannot be submitted");
      }
      this.db.prepare(
        `UPDATE quotes SET status=?,
           approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END,
           approved_at=CASE WHEN ?='APPROVED' THEN ? ELSE approved_at END,
           quoted_at=CASE WHEN ?='SUBMITTED' THEN ? ELSE quoted_at END,
           submitted_at=CASE WHEN ?='SUBMITTED' THEN ? ELSE submitted_at END,
           accepted_at=CASE WHEN ?='ACCEPTED' THEN ? ELSE accepted_at END,
           rejected_at=CASE WHEN ?='REJECTED' THEN ? ELSE rejected_at END,
           updated_by=?, updated_at=? WHERE id=?`,
      ).run(
        to,
        to,
        actor,
        to,
        now,
        to,
        now,
        to,
        now,
        to,
        now,
        to,
        now,
        actor,
        now,
        quoteId,
      );
      this.recordEvent("quote", quoteId, "QUOTE_STATUS_CHANGED", actor, {
        from: quote.status,
        to,
        reason: reason.trim().slice(0, 2000),
      });
      if (to === "SUBMITTED") {
        const opportunity = this.db.prepare("SELECT stage FROM opportunities WHERE id=?")
          .get(quote.opportunity_id) as { stage: OpportunityStage } | undefined;
        if (opportunity && new Set<OpportunityStage>(["TECHNICAL_DISCOVERY", "QUOTE_PENDING"])
          .has(opportunity.stage)) {
          this.db.prepare(
            "UPDATE opportunities SET stage='QUOTED', quoted_at=coalesce(quoted_at, ?), updated_at=? WHERE id=?",
          ).run(now, now, quote.opportunity_id);
          this.recordEvent("opportunity", quote.opportunity_id, "OPPORTUNITY_STAGE_CHANGED", actor, {
            from: opportunity.stage,
            to: "QUOTED",
            reason: `quote submitted: ${quoteId}`,
          });
        }
      }
      return { changed: true, status: to };
    });
  }

  createOrGetSalesTask(input: SalesTaskInput): { id: string; created: boolean } {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM sales_tasks WHERE idempotency_key=?")
        .get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.id("stask");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO sales_tasks(
           id, account_id, person_id, play_id, enrollment_id, opportunity_id,
           task_type, status, owner, due_at, source_signal, idempotency_key,
           payload_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.accountId ?? null,
        input.personId ?? null,
        input.playId ?? null,
        input.enrollmentId ?? null,
        input.opportunityId ?? null,
        input.taskType,
        input.owner,
        input.dueAt,
        input.sourceSignal ?? null,
        input.idempotencyKey,
        canonicalJson(input.payload ?? {}),
        now,
        now,
      );
      this.recordEvent("sales_task", id, "SALES_TASK_CREATED", "system", {
        taskType: input.taskType,
        sourceSignal: input.sourceSignal ?? null,
        opportunityId: input.opportunityId ?? null,
      });
      return { id, created: true };
    });
  }

  getSalesTask(taskId: string): Record<string, unknown> | null {
    return (this.db.prepare("SELECT * FROM sales_tasks WHERE id=?").get(taskId) as
      | Record<string, unknown>
      | undefined) ?? null;
  }

  getAcquisitionFoundationSummary(): AcquisitionFoundationSummary {
    const scalar = (sql: string, ...parameters: string[]): number =>
      Number((this.db.prepare(sql).get(...parameters) as { count: number }).count);
    const now = this.now();
    return {
      schemaVersion: this.getSchemaVersion(),
      accounts: scalar("SELECT count(*) AS count FROM accounts"),
      accountDomains: scalar("SELECT count(*) AS count FROM account_domains"),
      facilities: scalar("SELECT count(*) AS count FROM facilities"),
      people: scalar("SELECT count(*) AS count FROM people"),
      employments: scalar("SELECT count(*) AS count FROM employments"),
      contactPoints: scalar("SELECT count(*) AS count FROM contact_points"),
      plays: scalar("SELECT count(*) AS count FROM plays"),
      playVersions: scalar("SELECT count(*) AS count FROM play_versions"),
      playEnrollments: scalar("SELECT count(*) AS count FROM play_enrollments"),
      activeExclusions: scalar(
        `SELECT count(*) AS count FROM exclusions
         WHERE status='ACTIVE' AND starts_at<=? AND (expires_at IS NULL OR expires_at>?)`,
        now,
        now,
      ),
      providerRuns: scalar("SELECT count(*) AS count FROM provider_runs"),
      inquiryIntakes: scalar("SELECT count(*) AS count FROM inquiry_intakes"),
      quarantinedIntakes: scalar(
        "SELECT count(*) AS count FROM inquiry_intakes WHERE intake_status='QUARANTINED'",
      ),
      inboundProspects: scalar("SELECT count(*) AS count FROM inbound_prospects"),
      opportunities: scalar("SELECT count(*) AS count FROM opportunities"),
      openSalesTasks: scalar(
        "SELECT count(*) AS count FROM sales_tasks WHERE status IN ('OPEN','IN_PROGRESS','SNOOZED')",
      ),
      approvedClaims: scalar(
        "SELECT count(*) AS count FROM approved_claims WHERE status='APPROVED'",
      ),
      contentAssets: scalar("SELECT count(*) AS count FROM content_assets"),
      contentVersions: scalar("SELECT count(*) AS count FROM content_versions"),
      openContentQuestions: scalar(
        "SELECT count(*) AS count FROM content_questions WHERE status IN ('OPEN','PROPOSED')",
      ),
    };
  }

  createCampaign(input: CampaignInput): string {
    const id = this.id("cmp");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO campaigns(
          id, name, market, product, buyer_type, target_count, created_by,
          daily_limit, hourly_limit, followup_days_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.market,
        input.product,
        input.buyerType,
        input.targetCount,
        input.createdBy,
        input.dailyLimit,
        input.hourlyLimit,
        JSON.stringify(input.followupDays),
        now,
        now,
      );
    this.recordEvent("campaign", id, "CAMPAIGN_CREATED", input.createdBy, input as unknown as Record<string, unknown>);
    return id;
  }

  private dailyPlayPerformance(
    playId: string,
    asOf: string,
  ): DailyPlaySelectionCandidate["performance"] {
    const accountStats = this.db.prepare(
      `WITH versions AS (
         SELECT id FROM play_versions WHERE play_id=?
       ), selected_campaigns AS (
         SELECT DISTINCT cpl.campaign_id
         FROM campaign_play_links cpl
         JOIN versions version ON version.id=cpl.play_version_id
         WHERE cpl.is_primary=1
       ), researched AS (
         SELECT dc.campaign_id || ':' || lower(trim(dc.domain)) AS research_key
         FROM discovery_candidates dc
         JOIN selected_campaigns selected ON selected.campaign_id=dc.campaign_id
         WHERE dc.created_at<=?
         GROUP BY research_key
       ), qualified_accounts AS (
         SELECT DISTINCT lal.account_id
         FROM leads lead
         JOIN selected_campaigns selected ON selected.campaign_id=lead.campaign_id
         JOIN lead_account_links lal ON lal.lead_id=lead.id
         WHERE lead.created_at<=?
         UNION
         SELECT DISTINCT enrollment.account_id
         FROM play_enrollments enrollment
         JOIN versions version ON version.id=enrollment.play_version_id
         WHERE enrollment.enrolled_at<=?
           AND enrollment.status IN ('QUALIFIED','READY_FOR_REVIEW','APPROVED','ACTIVE','HUMAN_TAKEOVER')
       ), relevant_accounts AS (
         SELECT account_id FROM qualified_accounts
         UNION
         SELECT DISTINCT enrollment.account_id
         FROM play_enrollments enrollment
         JOIN versions version ON version.id=enrollment.play_version_id
         WHERE enrollment.enrolled_at<=?
       ), valid_contacts AS (
         SELECT 'legacy:' || contact.id AS contact_key
         FROM contacts contact
         JOIN lead_account_links lal ON lal.lead_id=contact.lead_id
         JOIN relevant_accounts account ON account.account_id=lal.account_id
         WHERE contact.email_status='VALID'
         UNION
         SELECT 'canonical:' || point.id AS contact_key
         FROM contact_points point
         JOIN employments employment ON employment.person_id=point.person_id
         JOIN relevant_accounts account ON account.account_id=employment.account_id
         WHERE point.kind='EMAIL' AND point.verification_status='VALID'
       )
       SELECT (SELECT count(*) FROM researched) AS researched_accounts,
              (SELECT count(*) FROM qualified_accounts) AS qualified_accounts,
              (SELECT count(*) FROM valid_contacts) AS valid_contacts`,
    ).get(playId, asOf, asOf, asOf, asOf) as {
      researched_accounts: number;
      qualified_accounts: number;
      valid_contacts: number;
    };

    const engagement = this.db.prepare(
      `WITH versions AS (
         SELECT id FROM play_versions WHERE play_id=?
       ), selected_campaigns AS (
         SELECT DISTINCT cpl.campaign_id
         FROM campaign_play_links cpl
         JOIN versions version ON version.id=cpl.play_version_id
         WHERE cpl.is_primary=1
       ), delivered_messages AS (
         SELECT DISTINCT message.id
         FROM outbound_messages message
         JOIN selected_campaigns selected ON selected.campaign_id=message.campaign_id
         WHERE coalesce(message.sent_at, message.updated_at)<=?
           AND (message.status IN ('DELIVERED','REPLIED') OR EXISTS (
             SELECT 1 FROM events event
             WHERE event.entity_type='outbound_message' AND event.entity_id=message.id
               AND event.event_type='MESSAGE_DELIVERED' AND event.created_at<=?
           ))
       ), inbound_replies AS (
         SELECT DISTINCT inbound.id
         FROM inbound_messages inbound
         JOIN leads lead ON lead.id=inbound.lead_id
         JOIN selected_campaigns selected ON selected.campaign_id=lead.campaign_id
         WHERE inbound.received_at<=?
           AND inbound.classification IN ('P1_INQUIRY','P2_INTEREST','OTHER_REPLY','REFERRAL')
       ), inbound_inquiries AS (
         SELECT DISTINCT inbound.id
         FROM inbound_messages inbound
         JOIN leads lead ON lead.id=inbound.lead_id
         JOIN selected_campaigns selected ON selected.campaign_id=lead.campaign_id
         WHERE inbound.received_at<=? AND inbound.classification='P1_INQUIRY'
       ), manual_delivery AS (
         SELECT DISTINCT event.id
         FROM manual_engagement_events event
         WHERE event.play_id=? AND event.occurred_at<=? AND event.channel='EMAIL'
           AND event.direction='OUTBOUND'
           AND (upper(event.event_type) LIKE '%DELIVER%' OR upper(coalesce(event.outcome,'')) LIKE '%DELIVER%'
             OR upper(event.event_type) LIKE '%SENT%')
       ), manual_reply AS (
         SELECT DISTINCT event.id
         FROM manual_engagement_events event
         WHERE event.play_id=? AND event.occurred_at<=? AND event.channel='EMAIL'
           AND event.direction='INBOUND'
           AND (upper(coalesce(event.outcome,'')) LIKE '%INTEREST%'
             OR upper(coalesce(event.outcome,'')) LIKE '%INQUIRY%'
             OR upper(coalesce(event.outcome,'')) LIKE '%REPLY%'
             OR upper(coalesce(event.outcome,'')) LIKE '%REFERRAL%')
       ), manual_inquiry AS (
         SELECT DISTINCT event.id
         FROM manual_engagement_events event
         WHERE event.play_id=? AND event.occurred_at<=? AND event.direction='INBOUND'
           AND (upper(coalesce(event.outcome,'')) LIKE '%INQUIRY%'
             OR upper(coalesce(event.outcome,'')) LIKE '%OPPORTUNITY%')
       )
       SELECT (SELECT count(*) FROM delivered_messages) + (SELECT count(*) FROM manual_delivery) AS delivered,
              (SELECT count(*) FROM inbound_replies) + (SELECT count(*) FROM manual_reply) AS positive_replies,
              (SELECT count(*) FROM inbound_inquiries) + (SELECT count(*) FROM manual_inquiry) AS inbound_inquiries`,
    ).get(playId, asOf, asOf, asOf, asOf, playId, asOf, playId, asOf, playId, asOf) as {
      delivered: number;
      positive_replies: number;
      inbound_inquiries: number;
    };

    const commercial = this.db.prepare(
      `WITH versions AS (
         SELECT id FROM play_versions WHERE play_id=?
       ), scoped_opportunities AS (
         SELECT opportunity.id, opportunity.stage
         FROM opportunities opportunity
         JOIN play_enrollments enrollment ON enrollment.id=opportunity.enrollment_id
         JOIN versions version ON version.id=enrollment.play_version_id
         WHERE opportunity.created_at<=?
       ), scoped_quotes AS (
         SELECT quote.*
         FROM quotes quote
         JOIN scoped_opportunities opportunity ON opportunity.id=quote.opportunity_id
         WHERE quote.created_at<=?
           AND quote.version_number=(
             SELECT max(latest.version_number) FROM quotes latest
             WHERE latest.opportunity_id=quote.opportunity_id AND latest.created_at<=?
           )
           AND quote.status IN ('APPROVED','SUBMITTED','ACCEPTED')
       )
       SELECT (SELECT count(*) FROM scoped_opportunities) AS inquiries,
              (SELECT count(*) FROM scoped_quotes) AS quotes,
              (SELECT count(*) FROM scoped_opportunities WHERE stage='WON') AS wins,
              coalesce((SELECT round(sum(
                CASE WHEN opportunity.stage='WON' AND quote.gross_margin_bps IS NOT NULL
                  THEN quote.amount_minor * quote.gross_margin_bps / 10000.0 ELSE 0 END
              )) FROM scoped_quotes quote
              JOIN scoped_opportunities opportunity ON opportunity.id=quote.opportunity_id), 0) AS gross_margin_minor`,
    ).get(playId, asOf, asOf, asOf) as {
      inquiries: number;
      quotes: number;
      wins: number;
      gross_margin_minor: number;
    };

    const usage = this.db.prepare(
      `WITH versions AS (SELECT id FROM play_versions WHERE play_id=?)
       SELECT coalesce(sum(CASE
                WHEN lower(resource.resource_type) IN ('research_hour','research_hours')
                  OR lower(resource.operation) IN ('research','account_research')
                THEN resource.units ELSE 0 END), 0) AS research_hours,
              coalesce(round(sum(resource.cost_micros) / 10000.0), 0) AS cost_minor,
              min(resource.occurred_at) AS first_usage_at
       FROM resource_usage resource
       JOIN versions version ON version.id=resource.play_version_id
       WHERE resource.occurred_at<=?`,
    ).get(playId, asOf) as {
      research_hours: number;
      cost_minor: number;
      first_usage_at: string | null;
    };
    const manualResearch = this.db.prepare(
      `SELECT coalesce(sum(duration_seconds), 0) / 3600.0 AS research_hours,
              min(occurred_at) AS first_manual_at
       FROM manual_engagement_events
       WHERE play_id=? AND occurred_at<=? AND upper(event_type) LIKE '%RESEARCH%'`,
    ).get(playId, asOf) as { research_hours: number; first_manual_at: string | null };
    const selectionHistory = this.db.prepare(
      `SELECT count(*) AS count FROM events
       WHERE entity_type='system' AND entity_id='daily_research'
         AND event_type='DAILY_RESEARCH_RESERVED' AND created_at<=?
         AND json_extract(payload_json, '$.playId')=?`,
    ).get(asOf, playId) as { count: number };
    const firstEnrollment = this.db.prepare(
      `SELECT min(value) AS first_at FROM (
         SELECT enrollment.enrolled_at AS value
         FROM play_enrollments enrollment
         JOIN play_versions version ON version.id=enrollment.play_version_id
         WHERE version.play_id=? AND enrollment.enrolled_at<=?
         UNION ALL
         SELECT campaign.created_at AS value
         FROM campaigns campaign
         JOIN campaign_play_links link ON link.campaign_id=campaign.id AND link.is_primary=1
         JOIN play_versions version ON version.id=link.play_version_id
         WHERE version.play_id=? AND campaign.created_at<=?
       )`,
    ).get(playId, asOf, playId, asOf) as { first_at: string | null };

    const qualifiedAccounts = Math.max(0, Number(accountStats.qualified_accounts));
    const researchedAccounts = Math.max(
      qualifiedAccounts,
      Math.max(0, Number(accountStats.researched_accounts)),
    );
    const delivered = Math.max(0, Number(engagement.delivered));
    const positiveReplies = Math.min(delivered, Math.max(0, Number(engagement.positive_replies)));
    const rawInquiries = Math.max(
      Number(engagement.inbound_inquiries),
      Number(commercial.inquiries),
      0,
    );
    const inquiries = Math.min(delivered, rawInquiries);
    const quotes = Math.min(inquiries, Math.max(0, Number(commercial.quotes)));
    const wins = Math.min(quotes, Math.max(0, Number(commercial.wins)));
    const firstAt = [firstEnrollment.first_at, usage.first_usage_at, manualResearch.first_manual_at]
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    const measurementDays = firstAt
      ? Math.max(0, Math.ceil((Date.parse(asOf) - Date.parse(firstAt)) / 86_400_000))
      : 0;

    return {
      priorDailySelections: Math.max(0, Number(selectionHistory.count)),
      researchedAccounts,
      researchHours: Math.max(0, Number(usage.research_hours) + Number(manualResearch.research_hours)),
      qualifiedAccounts,
      validContacts: Math.max(0, Number(accountStats.valid_contacts)),
      delivered,
      positiveReplies,
      inquiries,
      quotes,
      wins,
      grossMarginMinor: Math.trunc(Number(commercial.gross_margin_minor)),
      costMinor: Math.max(0, Math.trunc(Number(usage.cost_minor))),
      measurementDays,
    };
  }

  listDailyResearchPlayCandidates(
    asOf: string,
    filter: DailyResearchPlayFilter = {},
  ): DailyPlaySelectionCandidate[] {
    if (!Number.isFinite(Date.parse(asOf))) throw new Error("Daily research selection requires a valid asOf timestamp");
    const rows = this.db.prepare(
      `SELECT play.id AS play_id, play.country, play.product_family, play.buyer_archetype,
              play.application, play.offer, play.role_family, play.qualification_track,
              play.channel, play.status AS play_status,
              version.id AS play_version_id, version.version_number,
              allocation.id AS allocation_id, allocation.created_at AS allocation_created_at,
              allocation.policy_version AS allocation_policy_version,
              allocation.recommended_units, allocation.recommended_share,
              allocation.recommendation, allocation.applied, allocation.requires_human_approval,
              CASE WHEN snapshot.id IS NOT NULL AND snapshot.created_at<=? AND EXISTS (
                SELECT 1 FROM json_each(snapshot.evidence_ids_json) evidence_id
                JOIN market_evidence evidence ON evidence.id=evidence_id.value
                WHERE evidence.human_review='APPROVED' AND evidence.retrieved_at<=?
                  AND evidence.expires_at>=?
              ) THEN 1 ELSE 0 END AS evidence_eligible
       FROM plays play
       JOIN play_versions version ON version.play_id=play.id
         AND version.version_number=(
           SELECT max(latest.version_number) FROM play_versions latest WHERE latest.play_id=play.id
         )
       JOIN play_allocations allocation ON allocation.play_id=play.id
       LEFT JOIN market_opportunity_snapshots snapshot ON snapshot.id=allocation.snapshot_id
       ORDER BY play.id, allocation.created_at DESC, allocation.id`,
    ).all(asOf, asOf, asOf) as Array<Record<string, unknown>>;
    const normalize = (value: unknown): string => String(value ?? "").trim().toLowerCase();
    const marketAliases = new Map([
      ["malaysia", "my"], ["my", "my"],
      ["vietnam", "vn"], ["viet nam", "vn"], ["vn", "vn"],
      ["philippines", "ph"], ["ph", "ph"],
      ["indonesia", "id"], ["id", "id"],
      ["mexico", "mx"], ["mx", "mx"],
    ]);
    const matches = (actual: unknown, expected: string | undefined, market = false): boolean => {
      if (!expected?.trim()) return true;
      const actualValue = normalize(actual);
      const expectedValue = normalize(expected);
      if (market) {
        const actualAlias = marketAliases.get(actualValue) ?? actualValue;
        const expectedAlias = marketAliases.get(expectedValue) ?? expectedValue;
        return actualAlias === expectedAlias;
      }
      return actualValue === expectedValue || actualValue.includes(expectedValue) || expectedValue.includes(actualValue);
    };
    const filtered = rows.filter((row) =>
      matches(row.country, filter.market, true) &&
      matches(row.product_family, filter.product) &&
      matches(row.buyer_archetype, filter.buyerType)
    );
    const performanceByPlay = new Map<string, DailyPlaySelectionCandidate["performance"]>();
    return filtered.map((row): DailyPlaySelectionCandidate => {
      const playId = String(row.play_id);
      let performance = performanceByPlay.get(playId);
      if (!performance) {
        performance = this.dailyPlayPerformance(playId, asOf);
        performanceByPlay.set(playId, performance);
      }
      return {
        playId,
        playVersionId: String(row.play_version_id),
        playVersionNumber: Number(row.version_number),
        isLatestPlayVersion: true,
        playStatus: String(row.play_status) as DailyPlaySelectionCandidate["playStatus"],
        template: {
          market: String(row.country),
          product: String(row.product_family),
          buyerType: String(row.buyer_archetype),
          application: String(row.application),
          offer: String(row.offer),
          roleFamily: String(row.role_family),
          qualificationTrack: String(row.qualification_track) as DailyPlaySelectionCandidate["template"]["qualificationTrack"],
          channel: String(row.channel) as DailyPlaySelectionCandidate["template"]["channel"],
        },
        hasApprovedCurrentMarketEvidence: Number(row.evidence_eligible) === 1,
        allocation: {
          id: String(row.allocation_id),
          createdAt: String(row.allocation_created_at),
          policyVersion: String(row.allocation_policy_version),
          recommendedUnits: Number(row.recommended_units),
          recommendedShare: Number(row.recommended_share),
          recommendation: String(row.recommendation) as DailyPlaySelectionCandidate["allocation"]["recommendation"],
          applied: Number(row.applied) === 1,
          requiresHumanApproval: Number(row.requires_human_approval) === 1,
        },
        performance,
      };
    });
  }

  selectDailyResearchPlay(input: DailyResearchPlaySelectionInput): DailyPlaySelectionDecision {
    return chooseDailyResearchPlay({
      asOf: input.asOf,
      explorationShare: input.explorationShare,
      acceptedAllocationPolicyVersions: input.acceptedAllocationPolicyVersions,
      candidates: this.listDailyResearchPlayCandidates(input.asOf, input.filter),
    });
  }

  setCampaignStatus(campaignId: string, status: string, reason = ""): void {
    this.db
      .prepare("UPDATE campaigns SET status=?, paused_reason=?, updated_at=? WHERE id=?")
      .run(status, reason || null, this.now(), campaignId);
    this.recordEvent("campaign", campaignId, "CAMPAIGN_STATUS_CHANGED", "system", {
      status,
      reason,
    });
  }

  upsertDiscoveryCandidate(input: DiscoveryCandidateInput): string {
    const existing = this.db
      .prepare("SELECT * FROM discovery_candidates WHERE campaign_id=? AND domain=?")
      .get(input.campaignId, input.domain) as ({ id: string } & Record<string, unknown>) | undefined;
    const now = this.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE discovery_candidates SET company=?, website=?, round=?, stage=?, outcome=?,
           reason=?, source_count=?, fit_score=?, intent_score=?, activity_score=?,
           buying_likelihood=?, recommended_offer=?, evidence_json=?, updated_at=? WHERE id=?`,
        )
        .run(
          input.company,
          input.website,
          input.round,
          input.stage,
          input.outcome,
          input.reason,
          input.sourceCount,
          input.fitScore ?? Number(existing.fit_score ?? 0),
          input.intentScore ?? Number(existing.intent_score ?? 0),
          input.activityScore ?? Number(existing.activity_score ?? 0),
          input.buyingLikelihood ?? String(existing.buying_likelihood ?? "UNKNOWN"),
          input.recommendedOffer ?? String(existing.recommended_offer ?? ""),
          JSON.stringify(mergeDiscoveryEvidence(String(existing.evidence_json ?? "[]"), input.evidence)),
          now,
          existing.id,
        );
      return existing.id;
    }
    const id = this.id("cand");
    this.db
      .prepare(
        `INSERT INTO discovery_candidates(
          id, campaign_id, domain, company, website, round, stage, outcome, reason,
          source_count, fit_score, intent_score, activity_score, buying_likelihood,
          recommended_offer, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.campaignId,
        input.domain,
        input.company,
        input.website,
        input.round,
        input.stage,
        input.outcome,
        input.reason,
        input.sourceCount,
        input.fitScore ?? 0,
        input.intentScore ?? 0,
        input.activityScore ?? 0,
        input.buyingLikelihood ?? "UNKNOWN",
        input.recommendedOffer ?? "",
        JSON.stringify(input.evidence ?? []),
        now,
        now,
      );
    return id;
  }

  getCampaignDiscoveryStats(campaignId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM discovery_candidates
         WHERE campaign_id=? GROUP BY outcome ORDER BY count DESC`,
      )
      .all(campaignId) as Array<Record<string, unknown>>;
  }

  listCampaignCandidates(campaignId: string, limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM discovery_candidates WHERE campaign_id=?
         ORDER BY fit_score + intent_score + activity_score DESC, updated_at DESC LIMIT ?`,
      )
      .all(campaignId, limit) as Array<Record<string, unknown>>;
  }

  upsertLead(input: LeadInput): string {
    return this.transaction(() => this.upsertLeadInTransaction(input));
  }

  private upsertLeadInTransaction(input: LeadInput): string {
    const campaignId = input.campaignId ?? null;
    const existing = this.db
      .prepare("SELECT id FROM leads WHERE domain = ? COLLATE NOCASE AND campaign_id IS ?")
      .get(input.domain, campaignId) as { id: string } | undefined;
    const now = this.now();
    const demandPolicyVersion = input.demandPolicyVersion ?? "";
    const demandEvidenceQualified = input.demandEvidenceQualified === true;
    const demandStage = input.demandStage || "INDUSTRY_FIT";
    const demandEvidence = input.demandEvidence ?? [];
    const demandPolicyCurrent = demandPolicyVersion === DEMAND_POLICY_VERSION;
    const demandGatePassed = demandEvidenceQualified && demandPolicyCurrent;
    const sendEligible = input.sendEligible && demandGatePassed;
    const eligibilityReasons = [...new Set([
      ...input.eligibilityReasons,
      ...(!demandPolicyCurrent ? ["demand evidence policy is missing or stale"] : []),
      ...(!demandEvidenceQualified ? ["no qualifying direct demand evidence"] : []),
    ])];
    if (existing) {
      this.db
        .prepare(
          `UPDATE leads SET company=?, website=?, country=?, buyer_type=?, product=?,
           fit_score=?, intent_score=?, activity_score=?, contact_score=?, channel_score=?,
           total_score=?, grade=?, last_activity_at=?, last_verified_at=?,
           demand_evidence_qualified=?, demand_policy_version=?, demand_stage=?, demand_evidence_json=?,
           send_eligible=?, eligibility_reasons_json=?, updated_at=? WHERE id=?`,
        )
        .run(
          input.company,
          input.website,
          input.country,
          input.buyerType,
          input.product,
          input.fitScore,
          input.intentScore,
          input.activityScore,
          input.contactScore,
          input.channelScore,
          input.totalScore,
          input.grade,
          input.lastActivityAt ?? null,
          now,
          demandEvidenceQualified ? 1 : 0,
          demandPolicyVersion,
          demandStage,
          JSON.stringify(demandEvidence),
          sendEligible ? 1 : 0,
          JSON.stringify(eligibilityReasons),
          now,
          existing.id,
        );
      this.recordEvent("lead", existing.id, "LEAD_REVERIFIED", "system", {
        score: input.totalScore,
        eligible: sendEligible,
        demandPolicyVersion,
        demandEvidenceQualified,
      });
      return existing.id;
    }

    const id = this.id("lead");
    this.db
      .prepare(
        `INSERT INTO leads(
          id, campaign_id, company, domain, website, country, buyer_type, product,
          fit_score, intent_score, activity_score, contact_score, channel_score,
          total_score, grade, status, last_activity_at, last_verified_at,
          demand_evidence_qualified, demand_policy_version, demand_stage, demand_evidence_json,
          send_eligible, eligibility_reasons_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        campaignId,
        input.company,
        input.domain,
        input.website,
        input.country,
        input.buyerType,
        input.product,
        input.fitScore,
        input.intentScore,
        input.activityScore,
        input.contactScore,
        input.channelScore,
        input.totalScore,
        input.grade,
        input.lastActivityAt ?? null,
        now,
        demandEvidenceQualified ? 1 : 0,
        demandPolicyVersion,
        demandStage,
        JSON.stringify(demandEvidence),
        sendEligible ? 1 : 0,
        JSON.stringify(eligibilityReasons),
        now,
        now,
      );
    this.recordEvent("lead", id, "LEAD_CREATED", "system", {
      domain: input.domain,
      demandPolicyVersion,
      demandEvidenceQualified,
    });
    return id;
  }

  addLeadSource(
    leadId: string,
    sourceUrl: string,
    sourceType: string,
    sourceDate: string | null,
    evidence: string,
  ): void {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO lead_sources(
          id, lead_id, source_url, source_type, source_date, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id("src"), leadId, sourceUrl, sourceType, sourceDate, evidence, this.now());
    if (result.changes === 1) {
      const sameTypeCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM lead_sources WHERE lead_id=? AND source_type=?")
        .get(leadId, sourceType) as { count: number };
      if (sameTypeCount.count === 1) {
        this.db
          .prepare(
            `INSERT INTO source_metrics(source_type, leads, updated_at) VALUES (?, 1, ?)
             ON CONFLICT(source_type) DO UPDATE SET leads=leads+1, updated_at=excluded.updated_at`,
          )
          .run(sourceType, this.now());
      }
    }
  }

  persistOfficialMailboxEvidence(
    leadId: string,
    evidence: OfficialMailboxEvidence,
  ): OfficialMailboxEvidence {
    const sourceUrl = evidence.sourceUrl.trim();
    const exactText = evidence.exactText.trim();
    const observedAtMs = Date.parse(evidence.observedAt);
    if (!sourceUrl || !exactText || !Number.isFinite(observedAtMs)) {
      throw new Error("Official mailbox evidence requires a source URL, exact text, and valid observedAt");
    }
    const observedAt = new Date(observedAtMs).toISOString();

    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id, source_url, source_type, evidence
         FROM lead_sources WHERE lead_id=? AND source_url=?`,
      ).get(leadId, sourceUrl) as
        | { id: string; source_url: string; source_type: string; evidence: string | null }
        | undefined;

      let sourceId: string;
      let persistedText: string;
      if (existing) {
        const priorText = String(existing.evidence ?? "").trim();
        persistedText = priorText && !priorText.includes(exactText)
          ? `${priorText}\n\n${exactText}`
          : priorText || exactText;
        this.db.prepare(
          `UPDATE lead_sources
           SET source_type='official_website', evidence=?, created_at=?
           WHERE id=?`,
        ).run(persistedText, observedAt, existing.id);
        sourceId = existing.id;

        if (existing.source_type.toLocaleLowerCase("en-US") !== "official_website") {
          const officialCount = this.db.prepare(
            `SELECT COUNT(*) AS count FROM lead_sources
             WHERE lead_id=? AND source_type='official_website'`,
          ).get(leadId) as { count: number };
          if (officialCount.count === 1) {
            this.db.prepare(
              `INSERT INTO source_metrics(source_type, leads, updated_at) VALUES ('official_website', 1, ?)
               ON CONFLICT(source_type) DO UPDATE SET leads=leads+1, updated_at=excluded.updated_at`,
            ).run(observedAt);
          }
        }
      } else {
        sourceId = this.id("src");
        persistedText = exactText;
        this.db.prepare(
          `INSERT INTO lead_sources(
            id, lead_id, source_url, source_type, source_date, evidence, created_at
          ) VALUES (?, ?, ?, 'official_website', NULL, ?, ?)`,
        ).run(sourceId, leadId, sourceUrl, persistedText, observedAt);
        const officialCount = this.db.prepare(
          `SELECT COUNT(*) AS count FROM lead_sources
           WHERE lead_id=? AND source_type='official_website'`,
        ).get(leadId) as { count: number };
        if (officialCount.count === 1) {
          this.db.prepare(
            `INSERT INTO source_metrics(source_type, leads, updated_at) VALUES ('official_website', 1, ?)
             ON CONFLICT(source_type) DO UPDATE SET leads=leads+1, updated_at=excluded.updated_at`,
          ).run(observedAt);
        }
      }

      const sourceDocumentId = `source_document_legacy:${sourceId}`;
      this.db.prepare(
        `UPDATE source_documents
         SET authority_class='ACCOUNT_OFFICIAL',
             metadata_json=json_set(metadata_json, '$.sourceType', 'official_website',
               '$.officialMailboxEvidence', 1),
             updated_at=?
         WHERE id=?`,
      ).run(observedAt, sourceDocumentId);
      this.db.prepare(
        `INSERT OR IGNORE INTO account_sources(
          id, account_id, source_document_id, source_url, source_type,
          publisher_domain, independence_key, observed_at, created_at
        )
        SELECT ?, lal.account_id, sd.id, ?, 'official_website', NULL,
          lower(trim(?)), ?, ?
        FROM lead_account_links lal
        JOIN source_documents sd ON sd.id=?
        WHERE lal.lead_id=?`,
      ).run(
        `account_source_official_mailbox:${sourceId}`,
        sourceUrl,
        sourceUrl,
        observedAt,
        observedAt,
        sourceDocumentId,
        leadId,
      );

      return { sourceUrl, exactText: persistedText, observedAt };
    });
  }

  countLeadSources(leadId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM lead_sources WHERE lead_id = ?")
      .get(leadId) as { count: number };
    return row.count;
  }

  countIndependentLeadSources(leadId: string): number {
    return this.independentSourceCounts([leadId]).get(leadId) ?? 0;
  }

  getLead(leadId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT l.* FROM leads l WHERE l.id=?").get(leadId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.attachIndependentSourceCounts([row], "id")[0] ?? null : null;
  }

  withLeadAutomationGuard<T>(
    target: LeadAutomationGuardTarget,
    options: LeadAutomationGuardOptions,
    operation: (leadId: string | null) => T,
    ...asyncOperationRejected: T extends PromiseLike<unknown> ? [never] : []
  ): LeadAutomationGuardResult<T> {
    void asyncOperationRejected;
    if ((operation as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
      throw new Error("Lead automation guard operations must be synchronous");
    }
    return this.transaction(() => {
      const identityTarget = typeof target === "string" ? null : target;
      const row = (identityTarget
        ? this.db.prepare(
            `SELECT id, status, human_takeover, enrichment_attempts, domain, company, campaign_id
             FROM leads WHERE campaign_id=? AND domain=?`,
          ).get(identityTarget.campaignId, identityTarget.domain)
        : this.db.prepare(
            `SELECT id, status, human_takeover, enrichment_attempts, domain, company, campaign_id
             FROM leads WHERE id=?`,
          ).get(target as string)) as
        | {
            id: string;
            status: LeadStatus;
            human_takeover: number;
            enrichment_attempts: number;
            domain: string;
            company: string;
            campaign_id: string | null;
          }
        | undefined;
      if (!row) {
        if (!identityTarget?.allowMissing) return { applied: false, reason: "missing" };
        if (this.hasDncMatch([
          { type: "domain", value: identityTarget.domain },
          ...(options.additionalDncValues ?? []),
        ])) {
          return { applied: false, reason: "dnc" };
        }
        const value = this.runSynchronousLeadAutomationOperation(() => operation(null));
        return { applied: true, value };
      }
      if (options.campaignId !== undefined && row.campaign_id !== options.campaignId) {
        return { applied: false, reason: "campaign" };
      }
      if (row.human_takeover !== 0 || !options.allowedStatuses.includes(row.status)) {
        return { applied: false, reason: "state" };
      }
      if (options.expectedEnrichmentAttempts !== undefined &&
        Number(row.enrichment_attempts) !== options.expectedEnrichmentAttempts) {
        return { applied: false, reason: "attempt" };
      }
      const contacts = this.db.prepare(
        "SELECT email, whatsapp FROM contacts WHERE lead_id=?",
      ).all(row.id) as Array<{ email: string | null; whatsapp: string | null }>;
      const dncValues = [
        { type: "domain", value: row.domain },
        { type: "company", value: row.company },
        ...contacts.flatMap((contact) => [
          { type: "email", value: contact.email },
          { type: "whatsapp", value: contact.whatsapp },
        ]),
        ...(options.additionalDncValues ?? []),
      ];
      if (this.hasDncMatch(dncValues)) {
        this.markLeadDoNotContact(row.id, "system", "matched DNC during guarded automation");
        return { applied: false, reason: "dnc" };
      }
      const value = this.runSynchronousLeadAutomationOperation(() => operation(row.id));
      return { applied: true, value };
    });
  }

  getCampaign(campaignId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM campaigns WHERE id=?").get(campaignId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  listCampaigns(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
  }

  findLeadByDomain(domain: string, campaignId?: string | null): Record<string, unknown> | null {
    const statement = campaignId === undefined
      ? "SELECT * FROM leads WHERE domain=? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1"
      : "SELECT * FROM leads WHERE domain=? COLLATE NOCASE AND campaign_id IS ? ORDER BY updated_at DESC LIMIT 1";
    return (
      (this.db
        .prepare(statement)
        .get(...(campaignId === undefined ? [domain] : [domain, campaignId])) as
          Record<string, unknown> | undefined) ?? null
    );
  }

  listEnrichingLeads(
    campaignId: string,
    limit = 50,
    dueAt = this.now(),
    maxAttempts = 3,
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM leads
         WHERE campaign_id=? AND status='ENRICHING' AND human_takeover=0
           AND enrichment_attempts < ?
           AND enrichment_attempts = (
             SELECT MIN(pending.enrichment_attempts)
             FROM leads pending
             WHERE pending.campaign_id=leads.campaign_id
               AND pending.status='ENRICHING'
               AND pending.human_takeover=0
               AND pending.enrichment_attempts < ?
           )
           AND (enrichment_next_at IS NULL OR enrichment_next_at<=?)
         ORDER BY enrichment_attempts ASC,
           COALESCE(enrichment_next_at, created_at) ASC,
           fit_score + intent_score + activity_score DESC,
           id ASC
         LIMIT ?`,
      )
      .all(campaignId, maxAttempts, maxAttempts, dueAt, limit) as Array<Record<string, unknown>>;
  }

  completeEnrichmentAttempt(
    leadId: string,
    expectedAttempts: number,
    nextRunAt: string,
    maxAttempts = 3,
    continueEnrichment = true,
  ): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE leads
         SET enrichment_attempts=enrichment_attempts+1,
             status=CASE
               WHEN ?=1 AND status='ENRICHING' AND enrichment_attempts+1 >= ? THEN 'ENRICHMENT_EXHAUSTED'
               ELSE status
             END,
             enrichment_next_at=CASE
               WHEN ?=1 AND status='ENRICHING' AND enrichment_attempts+1 < ? THEN ?
               ELSE NULL
             END,
             updated_at=?
         WHERE id=? AND status='ENRICHING' AND human_takeover=0
           AND enrichment_attempts=? AND enrichment_attempts < ?`,
      )
      .run(
        continueEnrichment ? 1 : 0,
        maxAttempts,
        continueEnrichment ? 1 : 0,
        maxAttempts,
        nextRunAt,
        now,
        leadId,
        expectedAttempts,
        maxAttempts,
      );
    if (result.changes !== 1) return false;
    if (continueEnrichment && expectedAttempts + 1 >= maxAttempts) {
      const row = this.db.prepare("SELECT status FROM leads WHERE id=?").get(leadId) as
        | { status: string }
        | undefined;
      if (row?.status === "ENRICHMENT_EXHAUSTED") {
        this.recordEvent("lead", leadId, "CONTACT_ENRICHMENT_EXHAUSTED", "contact_enrichment", {
          attempts: maxAttempts,
        });
      }
    }
    return true;
  }

  getEnrichmentQueueState(
    campaignId: string,
    dueAt = this.now(),
    maxAttempts = 3,
  ): EnrichmentQueueState {
    const row = this.db
      .prepare(
        `WITH pending AS (
           SELECT enrichment_attempts, enrichment_next_at
           FROM leads
           WHERE campaign_id=? AND status='ENRICHING' AND human_takeover=0
             AND enrichment_attempts < ?
         ), current_pass AS (
           SELECT MIN(enrichment_attempts) AS attempts FROM pending
         )
         SELECT
           (SELECT attempts + 1 FROM current_pass) AS current_pass,
           COUNT(*) AS remaining_in_pass,
           (SELECT COUNT(*) FROM pending) AS remaining_eligible,
           MIN(COALESCE(pending.enrichment_next_at, ?)) AS next_run_at
         FROM pending, current_pass
         WHERE pending.enrichment_attempts=current_pass.attempts`,
      )
      .get(campaignId, maxAttempts, dueAt) as {
        current_pass: number | null;
        remaining_in_pass: number;
        remaining_eligible: number;
        next_run_at: string | null;
      };
    return {
      currentPass: row.current_pass === null ? null : Number(row.current_pass),
      remainingInPass: Number(row.remaining_in_pass),
      remainingEligible: Number(row.remaining_eligible),
      nextRunAt: row.next_run_at,
    };
  }

  listReviewLeads(limit = 20): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT l.*,
          (SELECT COUNT(*) FROM contacts c WHERE c.lead_id=l.id) AS contact_count
         FROM leads l WHERE l.status='READY_FOR_REVIEW'
           AND l.send_eligible=1
           AND l.demand_evidence_qualified=1
           AND l.demand_policy_version=?
         ORDER BY l.total_score DESC, l.updated_at DESC LIMIT ?`,
      )
      .all(DEMAND_POLICY_VERSION, limit) as Array<Record<string, unknown>>;
    return this.attachIndependentSourceCounts(rows, "id");
  }

  listContactsForLead(leadId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM contacts WHERE lead_id=? ORDER BY email_status, updated_at DESC")
      .all(leadId) as Array<Record<string, unknown>>;
  }

  getContact(contactId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM contacts WHERE id=?").get(contactId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  listLeadSources(leadId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM lead_sources WHERE lead_id=? ORDER BY created_at")
      .all(leadId) as Array<Record<string, unknown>>;
  }

  hasOutboundSequence(leadId: string, contactId: string, channel: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM outbound_messages WHERE lead_id=? AND contact_id=? AND channel=? LIMIT 1",
        )
        .get(leadId, contactId, channel),
    );
  }

  listOutboundMessagesForLead(leadId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM outbound_messages WHERE lead_id=?
         ORDER BY channel, sequence_index, created_at`,
      )
      .all(leadId) as Array<Record<string, unknown>>;
  }

  getSequenceReviewHash(leadId: string): string {
    const messages = this.listOutboundMessagesForLead(leadId);
    if (messages.length === 0) throw new Error(`No outbound sequence exists for lead: ${leadId}`);
    const canonical = messages.map((message) => ({
      id: String(message.id),
      channel: String(message.channel),
      destination: String(message.destination),
      subject: String(message.subject),
      body: String(message.body),
      sequenceIndex: Number(message.sequence_index),
      scheduledAt: message.scheduled_at ? String(message.scheduled_at) : null,
      status: String(message.status),
    }));
    return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  listLeadsForSync(limit = 500): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT l.*,
          c.id AS contact_id, c.name AS contact_name, c.title AS contact_title,
          c.email, c.whatsapp, c.linkedin, c.email_status,
          c.source_url AS contact_source_url
         FROM leads l
         LEFT JOIN contacts c ON c.id=(
           SELECT c2.id FROM contacts c2 WHERE c2.lead_id=l.id
           ORDER BY c2.email_status='VALID' DESC, c2.updated_at DESC LIMIT 1
         )
         ORDER BY l.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return this.attachIndependentSourceCounts(rows, "id");
  }

  upsertContact(input: ContactInput): string {
    const columns = `id, email, whatsapp, employment_verified_at, email_status, email_risk,
      role_address, disposable_address, catch_all, whatsapp_opt_in_at, verification_notes,
      recipient_tier, recipient_evidence_url, recipient_evidence_observed_at,
      recipient_evidence_expires_at, recipient_evidence_hash, recipient_policy_version`;
    let existing = input.email
      ? (this.db
          .prepare(`SELECT ${columns} FROM contacts WHERE lead_id = ? AND email = ?`)
          .get(input.leadId, input.email) as ExistingContactVerification | undefined)
      : input.whatsapp
        ? (this.db
            .prepare(`SELECT ${columns} FROM contacts WHERE lead_id = ? AND whatsapp = ?`)
            .get(input.leadId, input.whatsapp) as ExistingContactVerification | undefined)
        : undefined;
    if (!existing) {
      existing = this.db
        .prepare(
          `SELECT ${columns} FROM contacts
           WHERE lead_id=? AND email IS NULL AND whatsapp IS NULL
             AND lower(trim(name))=lower(trim(?))
             AND lower(trim(title))=lower(trim(?))
           LIMIT 1`,
        )
        .get(input.leadId, input.name, input.title) as ExistingContactVerification | undefined;
    }
    const now = this.now();
    const lead = this.db.prepare("SELECT domain FROM leads WHERE id=?").get(input.leadId) as
      | { domain: string }
      | undefined;
    if (!lead) throw new Error(`Lead not found: ${input.leadId}`);
    const officialEvidence = (existing && !input.officialMailboxEvidence && existing.recipient_evidence_url)
      ? this.db.prepare(
          `SELECT source_url, evidence, created_at FROM lead_sources
           WHERE lead_id=? AND lower(source_url)=lower(?)
             AND lower(source_type)='official_website'
             AND instr(lower(evidence), lower(?))>0
           ORDER BY created_at DESC LIMIT 1`,
        ).get(input.leadId, existing.recipient_evidence_url, existing.email ?? input.email ?? "") as
          | { source_url: string; evidence: string; created_at: string }
          | undefined
      : undefined;
    const resolvedOfficialEvidence = input.officialMailboxEvidence ?? (officialEvidence ? {
      sourceUrl: officialEvidence.source_url,
      exactText: officialEvidence.evidence,
      observedAt: officialEvidence.created_at,
    } : input.employmentVerifiedAt ? {
      sourceUrl: input.sourceUrl,
      exactText: "",
      observedAt: input.employmentVerifiedAt,
    } : null);
    if (existing) {
      const roleAddress = Boolean(existing.role_address) || input.roleAddress;
      const disposableAddress = Boolean(existing.disposable_address) || input.disposableAddress;
      const catchAll = Boolean(existing.catch_all) || input.catchAll;
      const explicitIncomingRisk = input.emailStatus === "RISKY" &&
        /Reacher verdict:\s*risky|(?:Hunter|Bouncer|independent official) (?:email )?verifier (?:risky|webmail)/i
          .test(input.emailRisk);
      let emailStatus = existing.email_status !== "INVALID" && explicitIncomingRisk
        ? "RISKY"
        : mergeEmailStatus(existing.email_status, input.emailStatus);
      if (disposableAddress) emailStatus = "INVALID";
      else if (catchAll && emailStatus === "VALID") emailStatus = "RISKY";
      const emailRisk = existing.email_status === "INVALID"
        ? appendVerificationNotes(existing.email_risk, input.emailStatus === "INVALID" ? input.emailRisk : null) ?? existing.email_risk
        : explicitIncomingRisk
          ? input.emailRisk
        : catchAll
          ? appendVerificationNotes(existing.email_risk, input.emailRisk, "known catch-all mailbox") ?? "known catch-all mailbox"
        : input.emailStatus === "INVALID" || input.emailStatus === "VALID"
          ? input.emailRisk
          : existing.email_status === "VALID"
            ? existing.email_risk
            : input.emailRisk || existing.email_risk;
      const recipient = classifyRecipientTier({
        accountDomain: lead.domain,
        email: existing.email ?? input.email ?? null,
        name: input.name,
        title: input.title,
        employmentVerifiedAt: existing.employment_verified_at ?? input.employmentVerifiedAt ?? null,
        emailStatus,
        roleAddress,
        disposableAddress,
        catchAll,
        officialMailboxEvidence: resolvedOfficialEvidence,
        asOf: new Date(now),
      });
      this.db
        .prepare(
          `UPDATE contacts SET name=?, title=?, email=?, whatsapp=?, linkedin=?, source_url=?,
           employment_verified_at=?, email_status=?, email_risk=?, role_address=?,
           disposable_address=?, catch_all=?, whatsapp_opt_in_at=?, verification_notes=?,
           recipient_tier=?, recipient_evidence_url=?, recipient_evidence_observed_at=?,
           recipient_evidence_expires_at=?, recipient_evidence_hash=?, recipient_policy_version=?,
           updated_at=? WHERE id=?`,
        )
        .run(
          input.name,
          input.title,
          existing.email ?? input.email ?? null,
          existing.whatsapp ?? input.whatsapp ?? null,
          input.linkedin ?? null,
          input.sourceUrl,
          existing.employment_verified_at ?? input.employmentVerifiedAt ?? null,
          emailStatus,
          emailRisk,
          roleAddress || recipient.tier === "B" ? 1 : 0,
          disposableAddress ? 1 : 0,
          catchAll ? 1 : 0,
          existing.whatsapp_opt_in_at ?? input.whatsappOptInAt ?? null,
          appendVerificationNotes(existing.verification_notes, input.verificationNotes),
          recipient.tier,
          recipient.evidenceUrl,
          recipient.evidenceObservedAt,
          recipient.evidenceExpiresAt,
          recipient.evidenceHash,
          recipient.policyVersion,
          now,
          existing.id,
        );
      return existing.id;
    }

    const id = this.id("ctc");
    const recipient = classifyRecipientTier({
      accountDomain: lead.domain,
      email: input.email ?? null,
      name: input.name,
      title: input.title,
      employmentVerifiedAt: input.employmentVerifiedAt ?? null,
      emailStatus: input.emailStatus,
      roleAddress: input.roleAddress,
      disposableAddress: input.disposableAddress,
      catchAll: input.catchAll,
      officialMailboxEvidence: resolvedOfficialEvidence,
      asOf: new Date(now),
    });
    this.db
      .prepare(
        `INSERT INTO contacts(
          id, lead_id, name, title, email, whatsapp, linkedin, source_url,
          employment_verified_at, email_status, email_risk, role_address,
          disposable_address, catch_all, whatsapp_opt_in_at, verification_notes,
          recipient_tier, recipient_evidence_url, recipient_evidence_observed_at,
          recipient_evidence_expires_at, recipient_evidence_hash, recipient_policy_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.leadId,
        input.name,
        input.title,
        input.email ?? null,
        input.whatsapp ?? null,
        input.linkedin ?? null,
        input.sourceUrl,
        input.employmentVerifiedAt ?? null,
        input.emailStatus,
        input.emailRisk,
        input.roleAddress || recipient.tier === "B" ? 1 : 0,
        input.disposableAddress ? 1 : 0,
        input.catchAll ? 1 : 0,
        input.whatsappOptInAt ?? null,
        input.verificationNotes ?? null,
        recipient.tier,
        recipient.evidenceUrl,
        recipient.evidenceObservedAt,
        recipient.evidenceExpiresAt,
        recipient.evidenceHash,
        recipient.policyVersion,
        now,
        now,
      );
    this.recordEvent("contact", id, "CONTACT_CREATED", "system", { leadId: input.leadId });
    return id;
  }

  createOutboundMessage(input: OutboundMessageInput): string {
    const owner = this.db
      .prepare(
        `SELECT c.lead_id AS contact_lead_id, c.email, c.whatsapp, l.campaign_id
         FROM contacts c JOIN leads l ON l.id=? WHERE c.id=?`,
      )
      .get(input.leadId, input.contactId) as
      | {
          contact_lead_id: string;
          email: string | null;
          whatsapp: string | null;
          campaign_id: string | null;
        }
      | undefined;
    if (!owner || owner.contact_lead_id !== input.leadId) {
      throw new Error("Outbound contact does not belong to the lead");
    }
    const campaignId = input.campaignId ?? owner.campaign_id;
    if (campaignId !== owner.campaign_id) {
      throw new Error("Outbound campaign does not belong to the lead");
    }
    const expectedDestination = input.channel === "email" ? owner.email : owner.whatsapp;
    if (
      !expectedDestination ||
      normalizedMessageDestination(input.channel, input.destination) !==
        normalizedMessageDestination(input.channel, expectedDestination)
    ) {
      throw new Error("Outbound destination does not match the selected contact");
    }
    const id = this.id("msg");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO outbound_messages(
          id, campaign_id, lead_id, contact_id, channel, destination, subject,
          body, sequence_index, status, scheduled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        campaignId,
        input.leadId,
        input.contactId,
        input.channel,
        input.destination,
        input.subject,
        input.body,
        input.sequenceIndex,
        input.status ?? "DRAFT",
        input.scheduledAt ?? null,
        now,
        now,
      );
    this.recordEvent("outbound_message", id, "MESSAGE_CREATED", "system", {
      leadId: input.leadId,
      sequenceIndex: input.sequenceIndex,
    });
    return id;
  }

  transitionLead(leadId: string, to: LeadStatus, actor: string, reason: string): void {
    const row = this.db.prepare(
      `SELECT status, send_eligible, demand_evidence_qualified, demand_policy_version,
              outreach_qualification_track, outreach_qualification_policy_version
       FROM leads WHERE id = ?`,
    ).get(leadId) as
      | {
          status: LeadStatus;
          send_eligible: number;
          demand_evidence_qualified: number;
          demand_policy_version: string;
          outreach_qualification_track: string;
          outreach_qualification_policy_version: string;
        }
      | undefined;
    if (!row) throw new Error(`Lead not found: ${leadId}`);
    assertLeadTransition(row.status, to);
    if (
      to === "READY_FOR_REVIEW" &&
      (!row.send_eligible || !outreachQualificationSatisfied(row as unknown as Record<string, unknown>))
    ) {
      throw new Error("Lead does not satisfy the current deterministic demand evidence gate or a current ICP_FIT qualification");
    }
    const restartEnrichment = row.status === "ENRICHMENT_EXHAUSTED" &&
      (to === "VERIFYING" || to === "ENRICHING");
    this.db.prepare(
      `UPDATE leads
       SET status=?,
           enrichment_attempts=CASE WHEN ? THEN 0 ELSE enrichment_attempts END,
           enrichment_next_at=CASE WHEN ? THEN NULL ELSE enrichment_next_at END,
           updated_at=?
       WHERE id=?`,
    ).run(to, restartEnrichment ? 1 : 0, restartEnrichment ? 1 : 0, this.now(), leadId);
    this.recordEvent("lead", leadId, "LEAD_STATUS_CHANGED", actor, {
      from: row.status,
      to,
      reason,
    });
  }

  promoteLeadFromGroundedQualification(input: {
    leadId: string;
    qualificationRunId: string;
    personalizationPlanId: string;
    qualificationTrack: "ACTIVE_INTENT" | "ICP_FIT";
    policyVersion: string;
  }): void {
    if (input.policyVersion !== QUALIFICATION_POLICY_VERSION || input.qualificationTrack !== "ICP_FIT") {
      throw new Error("Only a current grounded ICP_FIT decision can replace the direct-demand gate");
    }
    this.transaction(() => {
      const row = this.db.prepare(
        `SELECT l.status, l.human_takeover, l.outreach_qualification_track,
                l.outreach_qualification_policy_version,
                q.decision, q.status AS qualification_status,
                q.qualification_track, q.policy_version, pp.status AS plan_status
         FROM leads l
         JOIN qualification_runs q ON q.id=?
         JOIN personalization_plans pp ON pp.id=? AND pp.account_id=q.account_id
           AND pp.legacy_lead_id=l.id
         WHERE l.id=?`,
      ).get(input.qualificationRunId, input.personalizationPlanId, input.leadId) as Record<string, unknown> | undefined;
      if (!row || row.qualification_status !== "COMPLETE" || row.decision !== "QUALIFIED" ||
        row.plan_status !== "VALID" || row.qualification_track !== input.qualificationTrack ||
        row.policy_version !== input.policyVersion) {
        throw new Error("Grounded qualification run is missing, stale, or not qualified");
      }
      if (Number(row.human_takeover) !== 0) throw new Error("Lead is under human takeover");
      if (["APPROVED", "CONTACTED"].includes(String(row.status)) &&
        row.outreach_qualification_track === input.qualificationTrack &&
        row.outreach_qualification_policy_version === input.policyVersion) {
        return;
      }
      if (!["VERIFYING", "ENRICHING", "READY_FOR_REVIEW"].includes(String(row.status))) {
        throw new Error(`Lead cannot enter ICP_FIT outreach from ${String(row.status)}`);
      }
      const now = this.now();
      this.db.prepare(
        `UPDATE leads SET send_eligible=1, status='READY_FOR_REVIEW',
           outreach_qualification_track='ICP_FIT', outreach_qualification_policy_version=?,
           eligibility_reasons_json='[]', updated_at=? WHERE id=?`,
      ).run(input.policyVersion, now, input.leadId);
      this.recordEvent("lead", input.leadId, "LEAD_QUALIFIED_FOR_OUTREACH", "qualification-policy", {
        qualificationRunId: input.qualificationRunId,
        qualificationTrack: input.qualificationTrack,
        policyVersion: input.policyVersion,
      });
    });
  }

  transitionMessage(messageId: string, to: MessageStatus, actor: string, reason: string): void {
    const row = this.db.prepare("SELECT status FROM outbound_messages WHERE id = ?").get(messageId) as
      | { status: MessageStatus }
      | undefined;
    if (!row) throw new Error(`Message not found: ${messageId}`);
    assertMessageTransition(row.status, to);
    this.db
      .prepare("UPDATE outbound_messages SET status=?, updated_at=? WHERE id=?")
      .run(to, this.now(), messageId);
    this.recordEvent("outbound_message", messageId, "MESSAGE_STATUS_CHANGED", actor, {
      from: row.status,
      to,
      reason,
    });
  }

  approveLeadSequence(leadId: string, approvedBy: string, expectedReviewHash: string): void {
    const now = this.now();
    this.transaction(() => {
      const lead = this.db.prepare(
        `SELECT status, send_eligible, demand_evidence_qualified, demand_policy_version,
                outreach_qualification_track, outreach_qualification_policy_version
         FROM leads WHERE id = ?`,
      ).get(leadId) as
        | {
            status: LeadStatus;
            send_eligible: number;
            demand_evidence_qualified: number;
            demand_policy_version: string;
            outreach_qualification_track: string;
            outreach_qualification_policy_version: string;
          }
        | undefined;
      if (!lead) throw new Error(`Lead not found: ${leadId}`);
      if (!lead.send_eligible) throw new Error("Lead does not satisfy the send quality gate");
      if (!outreachQualificationSatisfied(lead as unknown as Record<string, unknown>)) {
        throw new Error("Lead does not satisfy the current deterministic demand evidence gate or a current ICP_FIT qualification");
      }
      if (lead.status !== "READY_FOR_REVIEW") {
        throw new Error(`Lead must be READY_FOR_REVIEW, got ${lead.status}`);
      }
      const ownershipRows = this.db.prepare(
        `SELECT m.channel, m.destination, m.campaign_id AS message_campaign_id,
                l.campaign_id AS lead_campaign_id, c.lead_id AS contact_lead_id,
                c.email, c.whatsapp
         FROM outbound_messages m
         JOIN leads l ON l.id=m.lead_id
         LEFT JOIN contacts c ON c.id=m.contact_id
         WHERE m.lead_id=?`,
      ).all(leadId) as Array<{
        channel: string;
        destination: string;
        message_campaign_id: string | null;
        lead_campaign_id: string | null;
        contact_lead_id: string | null;
        email: string | null;
        whatsapp: string | null;
      }>;
      const ownershipInvalid = ownershipRows.some((message) => {
        const expected = message.channel === "email" ? message.email : message.whatsapp;
        return message.contact_lead_id !== leadId ||
          message.message_campaign_id !== message.lead_campaign_id ||
          !expected ||
          normalizedMessageDestination(message.channel, message.destination) !==
            normalizedMessageDestination(message.channel, expected);
      });
      if (ownershipInvalid) throw new Error("Outbound sequence recipient ownership is invalid");
      if (!/^[a-f0-9]{64}$/i.test(expectedReviewHash)) {
        throw new Error("Approval requires the review hash from the complete sequence card");
      }
      const currentReviewHash = this.getSequenceReviewHash(leadId);
      const supplied = Buffer.from(expectedReviewHash.toLowerCase());
      const current = Buffer.from(currentReviewHash);
      if (supplied.length !== current.length || !crypto.timingSafeEqual(supplied, current)) {
        throw new Error("Outbound sequence changed after review; generate a new approval card");
      }
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM outbound_messages
           WHERE lead_id=? AND status='PENDING_APPROVAL'`,
        )
        .get(leadId) as { count: number };
      const total = this.db
        .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE lead_id=?")
        .get(leadId) as { count: number };
      if (pending.count === 0 || pending.count !== total.count) {
        throw new Error("Every message in the reviewed sequence must be pending approval");
      }
      this.db.prepare("UPDATE leads SET status='APPROVED', updated_at=? WHERE id=?").run(now, leadId);
      this.db
        .prepare(
          `UPDATE outbound_messages SET status='APPROVED', approved_by=?, approved_at=?, updated_at=?
           WHERE lead_id=? AND status='PENDING_APPROVAL'`,
        )
        .run(approvedBy, now, now, leadId);
      this.recordEvent("lead", leadId, "OUTREACH_SEQUENCE_APPROVED", approvedBy, {
        reviewHash: currentReviewHash,
        messageCount: total.count,
      });
    });
  }

  setHumanTakeover(leadId: string, actor: string, reason: string): void {
    this.transaction(() => {
      const lead = this.db.prepare("SELECT status FROM leads WHERE id = ?").get(leadId) as
        | { status: LeadStatus }
        | undefined;
      if (!lead) throw new Error(`Lead not found: ${leadId}`);
      this.db
        .prepare(
          "UPDATE leads SET status='HUMAN_TAKEOVER', human_takeover=1, updated_at=? WHERE id=?",
        )
        .run(this.now(), leadId);
      this.db
        .prepare(
          `UPDATE outbound_messages SET status='CANCELLED', failure_reason=?, updated_at=?
           WHERE lead_id=? AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','FAILED')`,
        )
        .run(`human takeover: ${reason}`, this.now(), leadId);
      this.recordEvent("lead", leadId, "HUMAN_TAKEOVER", actor, {
        from: lead.status,
        reason,
      });
    });
  }

  addDnc(valueType: string, value: string, reason: string, source: string): void {
    const normalized = normalizedDncValue(valueType, value);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dnc(id, value_type, value, reason, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id("dnc"), valueType, normalized, reason, source, this.now());
  }

  hasDncMatch(values: Array<{ type: string; value: string | null | undefined }>): boolean {
    const statement = this.db.prepare("SELECT 1 FROM dnc WHERE value_type=? AND value=? LIMIT 1");
    const whatsappStatement = this.db.prepare(
      `SELECT 1 FROM dnc WHERE value_type='whatsapp'
       AND replace(replace(replace(replace(replace(value, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')=?
       LIMIT 1`,
    );
    return values.some(({ type, value }) => {
      if (!value) return false;
      const normalized = normalizedDncValue(type, value);
      return type === "whatsapp"
        ? Boolean(whatsappStatement.get(normalized))
        : Boolean(statement.get(type, normalized));
    });
  }

  insertInbound(input: InboundMessageInput): { id: string; inserted: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM inbound_messages WHERE provider_id = ?")
      .get(input.providerId) as { id: string } | undefined;
    if (existing) return { id: existing.id, inserted: false };
    const id = this.id("inb");
    this.db
      .prepare(
        `INSERT INTO inbound_messages(
          id, channel, provider_id, thread_id, lead_id, contact_id, from_address,
          to_address, subject, body_text, received_at, classification, confidence,
          reason, raw_headers_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channel,
        input.providerId,
        input.threadId ?? null,
        input.leadId ?? null,
        input.contactId ?? null,
        input.fromAddress,
        input.toAddress ?? null,
        input.subject ?? null,
        input.bodyText,
        input.receivedAt,
        input.classification,
        input.confidence,
        input.reason,
        input.rawHeaders ? JSON.stringify(input.rawHeaders) : null,
        this.now(),
      );
    this.recordEvent("inbound_message", id, "INBOUND_RECEIVED", "system", {
      classification: input.classification,
      leadId: input.leadId ?? null,
    });
    return { id, inserted: true };
  }

  processInboundAtomically<T>(
    input: InboundMessageInput,
    operation: (inboundId: string) => T,
  ): { id: string; inserted: boolean; processed: boolean; result: T | null } {
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT id, processed_at AS processedAt FROM inbound_messages WHERE provider_id=?")
        .get(input.providerId) as { id: string; processedAt: string | null } | undefined;
      if (existing?.processedAt) {
        return { id: existing.id, inserted: false, processed: false, result: null };
      }

      const inbound = existing
        ? { id: existing.id, inserted: false }
        : this.insertInbound(input);
      const result = operation(inbound.id);
      const processedAt = this.now();
      this.db
        .prepare("UPDATE inbound_messages SET processed_at=? WHERE id=? AND processed_at IS NULL")
        .run(processedAt, inbound.id);
      this.recordEvent("inbound_message", inbound.id, "INBOUND_PROCESSED", "system", {
        classification: input.classification,
        leadId: input.leadId ?? null,
      });
      return { id: inbound.id, inserted: inbound.inserted, processed: true, result };
    });
  }

  resolveLegacyInboundContext(leadId: string, contactId?: string | null): CanonicalInboundContext | null {
    const row = this.db.prepare(
      `SELECT lal.account_id AS accountId,
         p.id AS personId,
         cp.id AS contactPointId
       FROM lead_account_links lal
       LEFT JOIN people p ON p.legacy_contact_id=?
       LEFT JOIN contact_points cp ON cp.legacy_contact_id=?
       WHERE lal.lead_id=?
       ORDER BY cp.kind='EMAIL' DESC, cp.created_at, cp.id
       LIMIT 1`,
    ).get(contactId ?? null, contactId ?? null, leadId) as CanonicalInboundContext | undefined;
    return row ?? null;
  }

  findContactByAddress(address: string): InboundCorrelation | null {
    const normalized = address.trim().toLowerCase();
    if (!normalized) return null;
    const rows = normalized.includes("@")
      ? this.db.prepare(
          `SELECT lead_id AS leadId, id AS contactId FROM contacts
           WHERE lower(trim(email))=? ORDER BY lead_id, id LIMIT 2`,
        ).all(normalized) as Array<{ leadId: string; contactId: string }>
      : this.db.prepare(
          `SELECT lead_id AS leadId, id AS contactId FROM contacts
           WHERE replace(replace(replace(replace(replace(whatsapp, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')=?
           ORDER BY lead_id, id LIMIT 2`,
        ).all(normalized.replace(/\D/g, "")) as Array<{ leadId: string; contactId: string }>;
    if (rows.length !== 1) return null;
    return {
      leadId: rows[0]!.leadId,
      contactId: rows[0]!.contactId,
      outboundMessageId: null,
      correlationMethod: "sender_address",
    };
  }

  findInboundMatch(
    threadId: string | null | undefined,
    fromAddress: string | null | undefined,
    options: { allowAddressFallback?: boolean } = {},
  ): InboundCorrelation | null {
    if (threadId) {
      const referenceMatch = this.findLeadByProviderReference(threadId);
      if (referenceMatch) return referenceMatch;
      if (!options.allowAddressFallback) return null;
    }
    return fromAddress ? this.findContactByAddress(fromAddress) : null;
  }

  private recipientTierPolicyBlockers(message: Record<string, unknown>, nowDate: Date): string[] {
    const tier = String(message.recipient_tier ?? "C");
    const blockers: string[] = [];
    if (tier === "A") {
      if (String(message.email_status) !== "VALID") blockers.push(`email status is ${String(message.email_status)}`);
      if (message.role_address) blockers.push("tier A role mailbox is blocked");
      if (message.disposable_address) blockers.push("disposable mailbox is blocked");
      if (message.catch_all) blockers.push("tier A catch-all mailbox is blocked");
      if (!String(message.contact_name ?? message.name ?? "").trim()) blockers.push("tier A named contact is missing");
      if (!String(message.contact_title ?? message.title ?? "").trim()) blockers.push("tier A current title is missing");
      const employmentAt = Date.parse(String(message.employment_verified_at ?? ""));
      const employmentAgeDays = (nowDate.getTime() - employmentAt) / 86_400_000;
      if (!Number.isFinite(employmentAt)) blockers.push("tier A employment verification is missing");
      else if (employmentAgeDays < 0 || employmentAgeDays > 90) {
        blockers.push("tier A employment verification is outside the 90-day policy TTL");
      }
      if (!String(message.contact_source_url ?? message.source_url ?? "").trim()) {
        blockers.push("tier A contact evidence URL is missing");
      }
      return blockers;
    }
    if (tier !== "B") return ["recipient tier C is never sendable"];
    if (String(message.email_status ?? "UNKNOWN") === "INVALID") blockers.push("tier B email is explicitly INVALID");
    if (!message.role_address) blockers.push("tier B recipient is not a company role mailbox");
    if (message.disposable_address) blockers.push("disposable mailbox is blocked");
    if (String(message.recipient_policy_version) !== RECIPIENT_TIER_POLICY_VERSION) {
      blockers.push("tier B recipient policy is stale");
    }
    const evidenceUrl = String(message.recipient_evidence_url ?? "").trim();
    const evidenceObservedAt = String(message.recipient_evidence_observed_at ?? "");
    const evidenceExpiresAt = String(message.recipient_evidence_expires_at ?? "");
    if (!evidenceUrl || String(message.recipient_evidence_hash ?? "").length !== 64 ||
      !evidenceObservedAt || evidenceObservedAt > nowDate.toISOString() ||
      !evidenceExpiresAt || evidenceExpiresAt <= nowDate.toISOString()) {
      blockers.push("tier B official publication evidence is missing, stale, or malformed");
    }
    const leadId = message.lead_id ?? message.legacy_lead_id;
    if (evidenceUrl && leadId && message.email) {
      const exactOfficialEvidence = this.db.prepare(
        `SELECT 1 FROM lead_sources
         WHERE lead_id=? AND lower(source_type)='official_website'
           AND lower(source_url)=lower(?) AND instr(lower(evidence), lower(?))>0
         LIMIT 1`,
      ).get(String(leadId), evidenceUrl, String(message.email));
      if (!exactOfficialEvidence) blockers.push("tier B exact official-site email evidence is missing");
    } else {
      blockers.push("tier B recipient binding is incomplete");
    }
    return blockers;
  }

  private campaignPolicyAuthorizationBlockers(
    message: Record<string, unknown>,
    nowDate: Date,
  ): string[] {
    if (String(message.authorization_mode ?? "LEAD_REVIEW") !== "CAMPAIGN_POLICY") return [];
    const blockers: string[] = [];
    const authorizationId = String(message.campaign_send_authorization_id ?? "");
    const messageAuthorizationId = String(message.campaign_message_authorization_id ?? "");
    const currentVersionId = String(message.current_version_id ?? "");
    if (!authorizationId || !messageAuthorizationId || !currentVersionId) {
      return ["campaign policy authorization lineage is incomplete"];
    }
    const material = this.db.prepare(
      `SELECT csa.brief_id, csa.version_id, csa.brief_hash, csa.campaign_id,
              csa.market, csa.transport, csa.total_limit, csa.daily_limit,
              csa.hourly_limit, csa.maximum_sequence_index, csa.valid_from,
              csa.expires_at, csa.policy_hash, csa.external_send_authorized,
              cma.id AS message_authorization_id,
              cma.outbound_message_id AS authorized_outbound_message_id,
              cma.message_version_id, cma.review_hash AS authorized_review_hash,
              cma.content_hash AS authorized_content_hash,
              cma.policy_hash AS authorized_policy_hash, cma.decision,
              cma.send_authorized AS message_send_authorized,
              mv.message_key, mv.version_number, mv.subject AS version_subject,
              mv.body AS version_body, mv.destination AS version_destination,
              mv.sequence_index AS version_sequence_index, mv.review_hash AS current_review_hash,
              mv.content_hash AS current_content_hash, mv.status AS version_status,
              mv.send_authorized AS version_send_authorized,
              mv.generation_mode, mv.lint_result_json,
              pp.status AS plan_status, pp.qualification_track,
              cb.current_version_id AS current_brief_version_id,
              cb.external_send_authorized AS brief_send_authorized,
              ca.scope AS approval_scope, ca.approved_actor_type,
              cmp.market AS campaign_market,
              CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS revoked,
              CASE WHEN EXISTS (
                SELECT 1 FROM message_versions newer
                WHERE newer.message_key=mv.message_key AND newer.version_number>mv.version_number
              ) THEN 0 ELSE 1 END AS is_latest
       FROM campaign_message_authorizations cma
       JOIN campaign_send_authorizations csa ON csa.id=cma.campaign_send_authorization_id
       JOIN message_versions mv ON mv.id=cma.message_version_id
       JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
       JOIN campaign_briefs cb ON cb.id=csa.brief_id
       JOIN campaign_approvals ca ON ca.id=csa.campaign_approval_id
       JOIN campaigns cmp ON cmp.id=csa.campaign_id
       LEFT JOIN campaign_send_authorization_revocations r
         ON r.campaign_send_authorization_id=csa.id
       WHERE cma.id=? AND cma.campaign_send_authorization_id=?`,
    ).get(messageAuthorizationId, authorizationId) as Record<string, unknown> | undefined;
    if (!material) return ["campaign policy authorization ledger entry is missing"];

    const now = nowDate.toISOString();
    blockers.push(...this.recipientTierPolicyBlockers(message, nowDate));
    if (String(message.recipient_tier) === "A" &&
      !this.getIndependentValidEmailVerification({
      contactId: String(message.contact_id ?? ""),
      email: String(message.email ?? ""),
      campaignId: String(material.campaign_id ?? ""),
      versionId: String(material.version_id ?? ""),
      at: now,
    })) {
      blockers.push("current public-web discovery plus an independent official verifier is missing");
    }
    if (Number(material.external_send_authorized) !== 1 ||
      Number(material.message_send_authorized) !== 1 || material.decision !== "AUTO_SEND_ELIGIBLE") {
      blockers.push("campaign policy does not authorize this message");
    }
    if (Number(material.revoked) !== 0) blockers.push("campaign send authorization is revoked");
    if (String(material.valid_from) > now) blockers.push("campaign send authorization is not active yet");
    if (String(material.expires_at) <= now) blockers.push("campaign send authorization is expired");
    if (material.current_brief_version_id !== material.version_id ||
      Number(material.brief_send_authorized) !== 1) {
      blockers.push("campaign brief authorization is stale or disabled");
    }
    if (material.approval_scope !== "EXTERNAL_SEND" || material.approved_actor_type !== "HUMAN") {
      blockers.push("campaign external-send approval is invalid");
    }
    if (material.campaign_id !== message.campaign_id ||
      String(material.market).trim().toLowerCase() !== String(message.country ?? "").trim().toLowerCase() ||
      String(material.market).trim().toLowerCase() !== String(material.campaign_market).trim().toLowerCase()) {
      blockers.push("message is outside the authorized campaign or market");
    }
    if (material.transport !== "SMTP" || String(message.channel) !== "email") {
      blockers.push("message channel is outside the SMTP authorization scope");
    }
    if (Number(message.sequence_index) > Number(material.maximum_sequence_index)) {
      blockers.push("message sequence index is outside the campaign authorization");
    }
    if (material.authorized_outbound_message_id !== message.id ||
      material.message_version_id !== currentVersionId || Number(material.is_latest) !== 1) {
      blockers.push("message is not bound to the latest authorized grounded version");
    }
    const computedContentHash = canonicalHash({
      subject: material.version_subject,
      body: material.version_body,
    });
    if (computedContentHash !== material.current_content_hash ||
      material.authorized_content_hash !== material.current_content_hash ||
      material.authorized_review_hash !== material.current_review_hash ||
      material.authorized_policy_hash !== material.policy_hash ||
      message.subject !== material.version_subject || message.body !== material.version_body ||
      String(message.destination).trim().toLowerCase() !==
        String(material.version_destination).trim().toLowerCase() ||
      Number(message.sequence_index) !== Number(material.version_sequence_index)) {
      blockers.push("message content, recipient, review hash, or policy hash changed after authorization");
    }
    const lint = parseJsonRecord(String(material.lint_result_json));
    if (material.version_status !== "PENDING_APPROVAL" || Number(material.version_send_authorized) !== 0 ||
      material.plan_status !== "VALID" ||
      !new Set(["ACTIVE_INTENT", "ICP_FIT"]).has(String(material.qualification_track)) ||
      lint.passed !== true || /(?:generic|fallback|diagnostic)/i.test(String(material.generation_mode))) {
      blockers.push("grounded message or personalization plan is no longer policy-eligible");
    }

    const reservationCount = (since: string | null): number => {
      const parameters: Array<string> = [authorizationId];
      const sinceClause = since
        ? " AND ((sent_at>=? AND status IN ('SENT','DELIVERED','REPLIED','BOUNCED')) OR (status IN ('SENDING','UNKNOWN_RECONCILIATION_REQUIRED') AND updated_at>=?))"
        : " AND status IN ('SENDING','UNKNOWN_RECONCILIATION_REQUIRED','SENT','DELIVERED','REPLIED','BOUNCED')";
      if (since) parameters.push(since, since);
      const row = this.db.prepare(
        `SELECT count(*) AS count FROM outbound_messages
         WHERE campaign_send_authorization_id=?${sinceClause}`,
      ).get(...parameters) as { count: number };
      return Number(row.count);
    };
    const startOfHour = new Date(nowDate);
    startOfHour.setUTCMinutes(0, 0, 0);
    const startOfDay = new Date(nowDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    if (reservationCount(null) >= Number(material.total_limit)) {
      blockers.push("campaign total send limit reached");
    }
    if (reservationCount(startOfDay.toISOString()) >= Number(material.daily_limit)) {
      blockers.push("campaign authorized daily send limit reached");
    }
    if (reservationCount(startOfHour.toISOString()) >= Number(material.hourly_limit)) {
      blockers.push("campaign authorized hourly send limit reached");
    }
    return [...new Set(blockers)];
  }

  getCampaignPolicyAuthorizationBlockers(
    message: Record<string, unknown>,
    now = new Date(),
  ): string[] {
    return this.campaignPolicyAuthorizationBlockers(message, now);
  }

  getDueMessagesPage(
    limit: number,
    now = this.now(),
    cursor: DueMessageCursor | null = null,
  ): Array<Record<string, unknown>> {
    const boundedLimit = Math.max(0, Math.min(1_000, Math.trunc(limit)));
    if (boundedLimit === 0) return [];
    if (cursor && (
      !Number.isFinite(Date.parse(cursor.dueAt)) ||
      !Number.isInteger(cursor.sequenceIndex) ||
      cursor.sequenceIndex < 0 ||
      !cursor.messageId.trim()
    )) {
      throw new Error("Due-message cursor is invalid");
    }
    const cursorClause = cursor
      ? `AND (
           COALESCE(m.scheduled_at, m.created_at)>?
           OR (COALESCE(m.scheduled_at, m.created_at)=? AND m.sequence_index>?)
           OR (COALESCE(m.scheduled_at, m.created_at)=? AND m.sequence_index=? AND m.id>?)
         )`
      : "";
    const parameters: Array<string | number> = [now];
    if (cursor) {
      parameters.push(
        cursor.dueAt,
        cursor.dueAt,
        cursor.sequenceIndex,
        cursor.dueAt,
        cursor.sequenceIndex,
        cursor.messageId,
      );
    }
    parameters.push(boundedLimit);
    const rows = this.db
      .prepare(
        `SELECT m.*, COALESCE(m.scheduled_at, m.created_at) AS dispatch_due_at,
                 l.status AS lead_status, l.human_takeover, l.send_eligible,
                 l.demand_evidence_qualified, l.demand_policy_version,
                 l.outreach_qualification_track, l.outreach_qualification_policy_version,
                 l.total_score, l.last_activity_at, l.country,
                 c.email, c.whatsapp, c.email_status, c.email_risk,
                 c.role_address, c.disposable_address, c.catch_all,
                c.recipient_tier, c.recipient_evidence_url, c.recipient_evidence_observed_at,
                c.recipient_evidence_expires_at, c.recipient_evidence_hash, c.recipient_policy_version,
                c.employment_verified_at, c.source_url AS contact_source_url,
                c.whatsapp_opt_in_at, c.name AS contact_name, c.title AS contact_title, l.company,
                 COALESCE(cmp.daily_limit, 2147483647) AS campaign_daily_limit,
                 COALESCE(cmp.hourly_limit, 2147483647) AS campaign_hourly_limit,
                 cmp.market AS campaign_market
         FROM outbound_messages m
         JOIN leads l ON l.id=m.lead_id
         JOIN contacts c ON c.id=m.contact_id AND c.lead_id=m.lead_id
         LEFT JOIN campaigns cmp ON cmp.id=m.campaign_id
         WHERE m.status IN ('APPROVED','SCHEDULED','FAILED')
           AND (m.scheduled_at IS NULL OR m.scheduled_at <= ?)
           AND l.human_takeover=0
           AND l.status IN ('APPROVED','CONTACTED')
           AND m.campaign_id IS l.campaign_id
           AND (
             (m.channel='email' AND lower(trim(m.destination))=lower(trim(c.email)))
             OR
             (m.channel='whatsapp'
               AND replace(replace(replace(replace(replace(lower(trim(m.destination)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                 =replace(replace(replace(replace(replace(lower(trim(c.whatsapp)), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''))
           )
           ${cursorClause}
         ORDER BY COALESCE(m.scheduled_at, m.created_at), m.sequence_index, m.id
         LIMIT ?`,
      )
      .all(...parameters) as Array<Record<string, unknown>>;
    return this.attachIndependentSourceCounts(rows, "lead_id");
  }

  getDueMessages(limit: number, now = this.now()): Array<Record<string, unknown>> {
    return this.getDueMessagesPage(limit, now);
  }

  recordOutboundPolicyBlock(
    messageId: string,
    blockers: readonly string[],
    blockedAt = this.now(),
  ): boolean {
    const reasons = [...new Set(blockers
      .map(sanitizeOutboundPolicyReason)
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 8);
    if (reasons.length === 0) throw new Error("Outbound policy block requires at least one reason");
    if (!Number.isFinite(Date.parse(blockedAt))) throw new Error("Outbound policy block time is invalid");
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT status, failure_reason FROM outbound_messages WHERE id=?",
      ).get(messageId) as { status: MessageStatus; failure_reason: string | null } | undefined;
      if (!row || !["APPROVED", "SCHEDULED", "FAILED"].includes(row.status)) return false;
      const previous = parseStoredOutboundPolicyBlock(row.failure_reason);
      if (previous && canonicalJson(previous.reasons) === canonicalJson(reasons)) return false;
      const stored: StoredOutboundPolicyBlock = {
        version: 1,
        blockedAt: previous?.blockedAt ?? blockedAt,
        reasons,
        ...(previous?.previousFailure
          ? { previousFailure: previous.previousFailure }
          : row.failure_reason
            ? { previousFailure: sanitizeOutboundPolicyReason(row.failure_reason) }
            : {}),
      };
      const encoded = `${OUTBOUND_POLICY_BLOCK_PREFIX}${canonicalJson(stored)}`;
      const changed = this.db.prepare(
        `UPDATE outbound_messages SET failure_reason=?
         WHERE id=? AND status IN ('APPROVED','SCHEDULED','FAILED')`,
      ).run(encoded, messageId);
      if (Number(changed.changes) !== 1) return false;
      this.recordEvent("outbound_message", messageId, "MESSAGE_POLICY_BLOCKED", "dispatcher", {
        blockedAt: stored.blockedAt,
        reasons,
      });
      return true;
    });
  }

  getOutboundPolicyBlockSummary(now = new Date()): OutboundPolicyBlockSummary {
    if (!Number.isFinite(now.getTime())) throw new Error("Outbound policy block summary time is invalid");
    const rows = this.db.prepare(
      `SELECT failure_reason FROM outbound_messages
       WHERE status IN ('APPROVED','SCHEDULED','FAILED') AND failure_reason LIKE ?`,
    ).all(`${OUTBOUND_POLICY_BLOCK_PREFIX}%`) as Array<{ failure_reason: string }>;
    const stored = rows
      .map((row) => parseStoredOutboundPolicyBlock(row.failure_reason))
      .filter((row): row is StoredOutboundPolicyBlock => row !== null);
    const reasonCounts = new Map<string, number>();
    let oldestBlockedAt = Number.POSITIVE_INFINITY;
    for (const block of stored) {
      oldestBlockedAt = Math.min(oldestBlockedAt, Date.parse(block.blockedAt));
      for (const reason of block.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    return {
      blockedMessages: stored.length,
      oldestBlockedAgeSeconds: Number.isFinite(oldestBlockedAt)
        ? Math.max(0, Math.floor((now.getTime() - oldestBlockedAt) / 1_000))
        : null,
      topReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
        .slice(0, 5),
    };
  }

  claimMessageForSending(
    messageId: string,
    policy: MessageClaimPolicy = {},
  ): Record<string, unknown> {
    return this.transaction(() => {
      const nowDate = policy.now ?? new Date();
      const now = nowDate.toISOString();
      let recoveryAuthorizationId: string | null = null;
      const reject = (reason: string): never => {
        throw new Error(`Message is not claimable: ${messageId} (${reason})`);
      };
      const messageRow = this.db.prepare(
        `SELECT m.*, l.campaign_id AS lead_campaign_id, l.status AS lead_status,
                l.human_takeover, l.send_eligible, l.demand_evidence_qualified,
                l.demand_policy_version, l.outreach_qualification_track,
                l.outreach_qualification_policy_version, l.total_score, l.domain, l.company, l.country,
                c.lead_id AS contact_lead_id, c.name AS contact_name, c.title AS contact_title,
                c.email, c.whatsapp, c.source_url AS contact_source_url,
                c.employment_verified_at, c.email_status, c.email_risk,
                c.role_address, c.disposable_address, c.catch_all, c.whatsapp_opt_in_at,
                c.recipient_tier, c.recipient_evidence_url, c.recipient_evidence_observed_at,
                c.recipient_evidence_expires_at, c.recipient_evidence_hash, c.recipient_policy_version,
                 COALESCE(cmp.daily_limit, 2147483647) AS campaign_daily_limit,
                 COALESCE(cmp.hourly_limit, 2147483647) AS campaign_hourly_limit,
                 cmp.market AS campaign_market
         FROM outbound_messages m
         JOIN leads l ON l.id=m.lead_id
         LEFT JOIN contacts c ON c.id=m.contact_id
         LEFT JOIN campaigns cmp ON cmp.id=m.campaign_id
         WHERE m.id=?`,
      ).get(messageId) as Record<string, unknown> | undefined;
      if (!messageRow) {
        throw new Error(`Message is not claimable: ${messageId} (message or owner record is missing)`);
      }
      const message = this.attachIndependentSourceCounts([messageRow], "lead_id")[0] as Record<string, unknown>;
      if (!["APPROVED", "SCHEDULED", "FAILED"].includes(String(message.status))) {
        reject(`status is ${String(message.status)}`);
      }
      if (Number(message.attempts) >= Number(message.max_attempts)) reject("attempt limit reached");
      if (message.scheduled_at && String(message.scheduled_at) > now) reject("message is not due");
      if (!message.approved_by || !message.approved_at) reject("sequence approval is missing");
      if (this.getSetting("outbound_paused") === "true") reject("global outbound pause is active");
      if (this.db.prepare(
        `SELECT 1 FROM outbound_messages
         WHERE lead_id=? AND id<>? AND status='UNKNOWN_RECONCILIATION_REQUIRED' LIMIT 1`,
      ).get(String(message.lead_id), String(messageId))) {
        reject("lead has an unresolved delivery reconciliation");
      }
      const campaignPolicyBlockers = this.campaignPolicyAuthorizationBlockers(message, nowDate);
      if (campaignPolicyBlockers.length > 0) reject(campaignPolicyBlockers.join("; "));
      if (
        message.lead_status !== "APPROVED" &&
        message.lead_status !== "CONTACTED"
      ) reject(`lead status is ${String(message.lead_status)}`);
      if (message.human_takeover) reject("lead is under human takeover");
      if (!message.send_eligible) reject("lead quality gate is not satisfied");
      if (!outreachQualificationSatisfied(message)) reject("deterministic demand evidence gate is not satisfied");
      if (message.contact_lead_id !== message.lead_id) reject("contact belongs to another lead");
      if (message.campaign_id !== message.lead_campaign_id) reject("campaign belongs to another lead");

      const channel = String(message.channel);
      const expectedDestination = channel === "email" ? message.email : message.whatsapp;
      if (
        !expectedDestination ||
        normalizedMessageDestination(channel, String(message.destination)) !==
          normalizedMessageDestination(channel, String(expectedDestination))
      ) reject("destination does not match the selected contact");
      if (channel === "email") {
        if (policy.requireFreshImapMonitoring) {
          const monitorStartedAt = this.getSetting("imap_monitor_started_at");
          const lastSuccessAt = this.getSetting("imap_last_poll_success_at");
          const consecutiveFailures = Math.max(
            0,
            Number.parseInt(this.getSetting("imap_consecutive_failures") ?? "0", 10) || 0,
          );
          const maxAgeSeconds = Math.max(1, Math.floor(policy.imapHealthMaxAgeSeconds ?? 300));
          const failureThreshold = Math.max(1, Math.floor(policy.imapFailureThreshold ?? 3));
          const startedMs = monitorStartedAt ? new Date(monitorStartedAt).getTime() : Number.NaN;
          const successMs = lastSuccessAt ? new Date(lastSuccessAt).getTime() : Number.NaN;
          if (
            !Number.isFinite(startedMs) ||
            !Number.isFinite(successMs) ||
            successMs < startedMs ||
            nowDate.getTime() - successMs > maxAgeSeconds * 1000 ||
            consecutiveFailures >= failureThreshold
          ) {
            reject("IMAP runtime reply monitoring is not healthy");
          }
        }
        const recipientBlockers = this.recipientTierPolicyBlockers(message, nowDate);
        if (recipientBlockers.length > 0) reject(recipientBlockers.join("; "));
      }
      if (this.hasDncMatch([
        { type: channel, value: String(message.destination) },
        { type: "email", value: message.email ? String(message.email) : null },
        { type: "whatsapp", value: message.whatsapp ? String(message.whatsapp) : null },
        { type: "domain", value: message.domain ? String(message.domain) : null },
        { type: "company", value: message.company ? String(message.company) : null },
      ])) reject("do-not-contact match");

      if (channel === "email") {
        const emailStatus = String(message.email_status ?? "UNKNOWN");
        const riskyHasMxEvidence = emailStatus === "RISKY" &&
          /\bMX\b|Reacher verdict/i.test(String(message.email_risk ?? ""));
        const tierB = String(message.recipient_tier) === "B";
        const campaignPolicy = String(message.authorization_mode ?? "LEAD_REVIEW") === "CAMPAIGN_POLICY";
        if (!tierB && emailStatus !== "VALID" && (campaignPolicy || !(policy.allowRiskyEmail && riskyHasMxEvidence))) {
          reject(`email status is ${emailStatus}`);
        }
      } else if (channel === "whatsapp") {
        if (!message.whatsapp_opt_in_at) reject("WhatsApp opt-in is missing");
      } else {
        reject(`unsupported channel ${channel}`);
      }

      if (policy.requireGmailPilotActivation && this.getSetting("gmail_pilot_activated") !== "true") {
        reject("Gmail pilot is not activated");
      }
      const maximumSequenceIndex = Number.isFinite(policy.maximumSequenceIndex)
        ? Math.max(0, Math.trunc(policy.maximumSequenceIndex as number))
        : Number.MAX_SAFE_INTEGER;
      if (Number(message.sequence_index) > maximumSequenceIndex) reject("sequence index is not permitted");
      if (Number(message.total_score) < Math.max(0, policy.minimumLeadScore ?? 0)) {
        reject("lead score is below the active sending policy");
      }
      if (Number(message.source_count) < Math.max(0, policy.minimumSourceCount ?? 0)) {
        reject("independent source count is below the active sending policy");
      }

      const startOfHour = new Date(nowDate);
      startOfHour.setUTCMinutes(0, 0, 0);
      const startOfDay = new Date(nowDate);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const reservationCount = (since: string, campaignOnly: boolean): number => {
        const campaignClause = campaignOnly ? " AND campaign_id IS ?" : "";
        const parameters: Array<string | null> = [channel, since, since];
        if (campaignOnly) parameters.push(message.campaign_id ? String(message.campaign_id) : null);
        const row = this.db.prepare(
          `SELECT COUNT(*) AS count FROM outbound_messages
           WHERE channel=?
             AND ((sent_at>=? AND status IN ('SENT','DELIVERED','REPLIED','BOUNCED'))
               OR (status IN ('SENDING','UNKNOWN_RECONCILIATION_REQUIRED') AND updated_at>=?))${campaignClause}`,
        ).get(...parameters) as { count: number };
        return Number(row.count);
      };
      const globalHourlyLimit = Number.isFinite(policy.globalHourlyLimit)
        ? Math.max(0, Math.trunc(policy.globalHourlyLimit as number))
        : Number.MAX_SAFE_INTEGER;
      const globalDailyLimit = Number.isFinite(policy.globalDailyLimit)
        ? Math.max(0, Math.trunc(policy.globalDailyLimit as number))
        : Number.MAX_SAFE_INTEGER;
      if (reservationCount(startOfHour.toISOString(), false) >= globalHourlyLimit) {
        reject("global hourly limit reached");
      }
      if (reservationCount(startOfDay.toISOString(), false) >= globalDailyLimit) {
        reject("global daily limit reached");
      }
      if (reservationCount(startOfHour.toISOString(), true) >= Number(message.campaign_hourly_limit)) {
        reject("campaign hourly limit reached");
      }
      if (reservationCount(startOfDay.toISOString(), true) >= Number(message.campaign_daily_limit)) {
        reject("campaign daily limit reached");
      }

      const minimumIntervalSeconds = Math.max(0, policy.minimumIntervalSeconds ?? 0);
      if (minimumIntervalSeconds > 0) {
        const latest = this.db.prepare(
          `SELECT MAX(CASE WHEN status IN ('SENDING','UNKNOWN_RECONCILIATION_REQUIRED') THEN updated_at ELSE sent_at END) AS latest
           FROM outbound_messages
           WHERE channel=? AND (sent_at IS NOT NULL OR status IN ('SENDING','UNKNOWN_RECONCILIATION_REQUIRED'))`,
        ).get(channel) as { latest: string | null };
        if (latest.latest) {
          const elapsedSeconds = (nowDate.getTime() - new Date(latest.latest).getTime()) / 1000;
          if (elapsedSeconds < minimumIntervalSeconds) reject("minimum sending interval is active");
        }
      }

      const hardBounceWindowSize = Math.max(1, Math.trunc(policy.hardBounceWindowSize ?? 50));
      const maxHardBounceRate = policy.maxHardBounceRate ?? 1;
      if (channel === "email" && Number.isFinite(maxHardBounceRate)) {
        const rows = this.db.prepare(
          `SELECT status FROM outbound_messages WHERE channel='email' AND sent_at IS NOT NULL
           ORDER BY sent_at DESC LIMIT ?`,
        ).all(hardBounceWindowSize) as Array<{ status: string }>;
        const minimumSample = Math.max(0, Math.trunc(policy.hardBounceMinimumSample ?? 20));
        const bounced = rows.filter((row) => row.status === "BOUNCED").length;
        if (rows.length >= minimumSample && rows.length > 0 && bounced / rows.length > maxHardBounceRate) {
          const recovery = this.getDeliverabilityRecoveryState({
            maxHardBounceRate,
            hardBounceWindowSize,
            hardBounceMinimumSample: minimumSample,
            now: nowDate,
          });
          if (!policy.allowAuditedDeliverabilityRecovery || !recovery.authorizationId) {
            reject("hard bounce rate exceeds the active sending policy");
          }
          recoveryAuthorizationId = recovery.authorizationId;
        }
      }

      const result = this.db.prepare(
        `UPDATE outbound_messages SET status='SENDING', attempts=attempts+1,
           failure_reason=NULL, updated_at=?
         WHERE id=? AND status IN ('APPROVED','SCHEDULED','FAILED') AND attempts < max_attempts`,
      ).run(now, messageId);
      if (result.changes !== 1) reject("message changed during claim");
      if (recoveryAuthorizationId) {
        this.db.prepare(
          `INSERT INTO deliverability_recovery_claims(
             id, authorization_id, outbound_message_id, claimed_at
           ) VALUES (?, ?, ?, ?)`,
        ).run(this.id("recoveryclaim"), recoveryAuthorizationId, messageId, now);
        this.recordEvent("outbound_message", messageId, "DELIVERABILITY_RECOVERY_SAMPLE_CLAIMED", "system", {
          authorizationId: recoveryAuthorizationId,
        });
      }
      this.recordEvent("outbound_message", messageId, "MESSAGE_SENDING", "system", {});
      return { ...message, status: "SENDING", attempts: Number(message.attempts) + 1, updated_at: now };
    });
  }

  markMessageSending(messageId: string): void {
    this.claimMessageForSending(messageId);
  }

  prepareMessageSubmissionReference(messageId: string, reference: string): string {
    const normalized = reference.trim();
    if (!/^<[^<>\s]+@[^<>\s]+>$/.test(normalized)) {
      throw new Error("SMTP submission reference must be a valid RFC Message-ID");
    }
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT status, provider_message_id FROM outbound_messages WHERE id=?",
      ).get(messageId) as { status: MessageStatus; provider_message_id: string | null } | undefined;
      if (!row || row.status !== "SENDING") {
        throw new Error(`Message submission reference requires SENDING status: ${messageId}`);
      }
      if (row.provider_message_id && row.provider_message_id !== normalized) {
        throw new Error(`Message submission reference already differs: ${messageId}`);
      }
      if (!row.provider_message_id) {
        this.db.prepare(
          `UPDATE outbound_messages SET provider_message_id=?, thread_id=?, updated_at=?
           WHERE id=? AND status='SENDING' AND provider_message_id IS NULL`,
        ).run(normalized, normalized, this.now(), messageId);
        this.recordEvent(
          "outbound_message",
          messageId,
          "MESSAGE_SUBMISSION_REFERENCE_PREPARED",
          "system",
          { reference: normalized },
        );
      }
      return normalized;
    });
  }

  quarantineStaleSendingMessages(staleBefore: string, actor = "system"): Array<Record<string, unknown>> {
    if (!Number.isFinite(Date.parse(staleBefore))) throw new Error("staleBefore must be an ISO timestamp");
    return this.transaction(() => {
      const rows = this.db.prepare(
        `SELECT m.id, m.lead_id, m.contact_id, m.destination, m.provider_message_id, m.attempts,
                m.updated_at AS sending_started_at, l.company
         FROM outbound_messages m JOIN leads l ON l.id=m.lead_id
         WHERE m.status='SENDING' AND m.updated_at<=?
         ORDER BY m.updated_at, m.id`,
      ).all(staleBefore) as Array<Record<string, unknown>>;
      const quarantined: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const now = this.now();
        const result = this.db.prepare(
          `UPDATE outbound_messages
           SET status='UNKNOWN_RECONCILIATION_REQUIRED',
               failure_reason='SMTP submission outcome is unknown after process interruption', updated_at=?
           WHERE id=? AND status='SENDING' AND updated_at<=?`,
        ).run(now, String(row.id), staleBefore);
        if (Number(result.changes) !== 1) continue;
        this.recordEvent(
          "outbound_message",
          String(row.id),
          "MESSAGE_DELIVERY_UNKNOWN_REQUIRES_RECONCILIATION",
          actor,
          {
            sendingStartedAt: row.sending_started_at,
            submissionReference: row.provider_message_id,
          },
        );
        quarantined.push({ ...row, status: "UNKNOWN_RECONCILIATION_REQUIRED", quarantined_at: now });
      }
      if (quarantined.length > 0) {
        this.setSetting("outbound_paused", "true");
        this.recordEvent("system", "outbound", "OUTBOUND_PAUSED_FOR_DELIVERY_RECONCILIATION", actor, {
          messageIds: quarantined.map((row) => row.id),
        });
      }
      return quarantined;
    });
  }

  markMessageDeliveryUnknown(messageId: string, reason: string, actor = "system"): boolean {
    return this.transaction(() => {
      const now = this.now();
      const result = this.db.prepare(
        `UPDATE outbound_messages
         SET status='UNKNOWN_RECONCILIATION_REQUIRED', failure_reason=?, updated_at=?
         WHERE id=? AND status='SENDING'`,
      ).run(reason.slice(0, 1000), now, messageId);
      if (Number(result.changes) !== 1) return false;
      this.recordEvent(
        "outbound_message",
        messageId,
        "MESSAGE_DELIVERY_UNKNOWN_REQUIRES_RECONCILIATION",
        actor,
        { reason: reason.slice(0, 1000) },
      );
      this.setSetting("outbound_paused", "true");
      this.recordEvent("system", "outbound", "OUTBOUND_PAUSED_FOR_DELIVERY_RECONCILIATION", actor, {
        messageIds: [messageId],
      });
      return true;
    });
  }

  listUnknownDeliveryReconciliations(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT m.id, m.lead_id, m.contact_id, m.destination, m.provider_message_id, m.attempts,
              m.failure_reason, m.updated_at, l.company
       FROM outbound_messages m JOIN leads l ON l.id=m.lead_id
       WHERE m.status='UNKNOWN_RECONCILIATION_REQUIRED'
       ORDER BY m.updated_at, m.id LIMIT ?`,
    ).all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
  }

  resolveUnknownDelivery(
    messageId: string,
    resolution: "CONFIRMED_SENT" | "CONFIRMED_NOT_SENT_REQUEUE",
    actor: string,
  ): { changed: boolean; status: MessageStatus } {
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT status, lead_id, provider_message_id FROM outbound_messages WHERE id=?`,
      ).get(messageId) as {
        status: MessageStatus;
        lead_id: string;
        provider_message_id: string | null;
      } | undefined;
      if (!row) throw new Error(`Outbound message not found: ${messageId}`);
      if (row.status !== "UNKNOWN_RECONCILIATION_REQUIRED") {
        return { changed: false, status: row.status };
      }
      const now = this.now();
      const status: MessageStatus = resolution === "CONFIRMED_SENT" ? "SENT" : "APPROVED";
      if (resolution === "CONFIRMED_SENT") {
        this.db.prepare(
          `UPDATE outbound_messages
           SET status='SENT', sent_at=COALESCE(sent_at, ?),
               thread_id=COALESCE(thread_id, provider_message_id), failure_reason=NULL, updated_at=?
           WHERE id=? AND status='UNKNOWN_RECONCILIATION_REQUIRED'`,
        ).run(now, now, messageId);
        this.db.prepare(
          "UPDATE leads SET status='CONTACTED', updated_at=? WHERE id=? AND status='APPROVED'",
        ).run(now, row.lead_id);
      } else {
        this.db.prepare(
          `UPDATE outbound_messages
           SET status='APPROVED', scheduled_at=?, sent_at=NULL, provider_message_id=NULL,
               thread_id=NULL, failure_reason=NULL, updated_at=?
           WHERE id=? AND status='UNKNOWN_RECONCILIATION_REQUIRED'`,
        ).run(now, now, messageId);
      }
      this.recordEvent("outbound_message", messageId, `MESSAGE_RECONCILED_${resolution}`, actor, {
        previousSubmissionReference: row.provider_message_id,
        globalPauseRemainsActive: true,
      });
      return { changed: true, status };
    });
  }

  hasUnknownDeliveryForLead(leadId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM outbound_messages WHERE lead_id=? AND status='UNKNOWN_RECONCILIATION_REQUIRED' LIMIT 1",
    ).get(leadId));
  }

  markMessageSent(messageId: string, providerMessageId: string, threadId?: string | null): void {
    const now = this.now();
    const message = this.db
      .prepare(
        `SELECT lead_id AS leadId, contact_id AS contactId, channel, sequence_index AS sequenceIndex
         FROM outbound_messages WHERE id=?`,
      )
      .get(messageId) as
      | { leadId: string; contactId: string; channel: string; sequenceIndex: number }
      | undefined;
    this.db
      .prepare(
        `UPDATE outbound_messages
         SET status=CASE WHEN status IN ('REPLIED','BOUNCED') THEN status ELSE 'SENT' END,
             sent_at=?, provider_message_id=?, thread_id=?, failure_reason=NULL, updated_at=?
         WHERE id=?`,
      )
      .run(now, providerMessageId, threadId ?? providerMessageId, now, messageId);
    if (!message) throw new Error(`Message not found after send: ${messageId}`);
    if (message.sequenceIndex === 0) {
      this.db
        .prepare(
          `UPDATE outbound_messages SET parent_message_id=?, thread_id=?, updated_at=?
           WHERE lead_id=? AND contact_id=? AND channel=? AND sequence_index>0
             AND status IN ('APPROVED','SCHEDULED','PENDING_APPROVAL')`,
        )
        .run(
          providerMessageId,
          threadId ?? providerMessageId,
          now,
          message.leadId,
          message.contactId,
          message.channel,
        );
    }
    this.db
      .prepare("UPDATE leads SET status='CONTACTED', updated_at=? WHERE id=? AND status='APPROVED'")
      .run(now, message.leadId);
    this.recordEvent("outbound_message", messageId, "MESSAGE_SENT", "system", {
      providerMessageId,
    });
  }

  markMessageFailed(messageId: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbound_messages SET status='FAILED', failure_reason=?, updated_at=?
         WHERE id=? AND status='SENDING'`,
      )
      .run(reason.slice(0, 1000), this.now(), messageId);
    if (result.changes === 1) {
      this.recordEvent("outbound_message", messageId, "MESSAGE_FAILED", "system", { reason });
      return true;
    }
    return false;
  }

  findLeadByOutboundMessageId(messageId: string): InboundCorrelation | null {
    const cleaned = messageId.trim();
    if (!cleaned) return null;
    const row = this.db.prepare(
      `SELECT lead_id AS leadId, contact_id AS contactId, id AS outboundMessageId
       FROM outbound_messages WHERE id=?`,
    ).get(cleaned) as { leadId: string; contactId: string; outboundMessageId: string } | undefined;
    return row ? { ...row, correlationMethod: "exact_provider_reference" } : null;
  }

  findLeadByProviderReference(reference: string): InboundCorrelation | null {
    const cleaned = reference.trim();
    if (!cleaned) return null;
    const exact = this.db.prepare(
      `SELECT lead_id AS leadId, contact_id AS contactId, id AS outboundMessageId
       FROM outbound_messages WHERE provider_message_id=? ORDER BY id LIMIT 2`,
    ).all(cleaned) as Array<{ leadId: string; contactId: string; outboundMessageId: string }>;
    if (exact.length > 1) return null;
    if (exact.length === 1) {
      return { ...exact[0]!, correlationMethod: "exact_provider_reference" };
    }

    const thread = this.db.prepare(
      `SELECT lead_id AS leadId, contact_id AS contactId
       FROM outbound_messages WHERE thread_id=? ORDER BY lead_id, contact_id, id`,
    ).all(cleaned) as Array<{ leadId: string; contactId: string }>;
    if (thread.length === 0) return null;
    const owners = new Set(thread.map((row) => `${row.leadId}\u0000${row.contactId}`));
    if (owners.size !== 1) return null;
    return {
      leadId: thread[0]!.leadId,
      contactId: thread[0]!.contactId,
      outboundMessageId: null,
      correlationMethod: "thread_reference",
    };
  }

  markOutboundFromInbound(
    messageId: string | null | undefined,
    status: "REPLIED" | "BOUNCED",
  ): boolean {
    if (!messageId) return false;
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE outbound_messages SET status=?, sent_at=COALESCE(sent_at, ?), updated_at=?
         WHERE id=? AND status IN ('SENDING','SENT','DELIVERED','UNKNOWN_RECONCILIATION_REQUIRED')`,
      ).run(status, this.now(), this.now(), messageId);
      if (Number(result.changes) !== 1) return false;
      this.recordEvent("outbound_message", messageId, `MESSAGE_${status}`, "inbound", {
        correlation: "exact_provider_reference",
      });
      return true;
    });
  }

  stopAutomationForReply(leadId: string, actor: string, reason: string): void {
    this.transaction(() => {
      const lead = this.db.prepare("SELECT status, human_takeover FROM leads WHERE id=?").get(leadId) as
        | { status: LeadStatus; human_takeover: number }
        | undefined;
      if (!lead || lead.human_takeover) return;
      this.db
        .prepare(
          `UPDATE outbound_messages SET status='CANCELLED', failure_reason=?, updated_at=?
           WHERE lead_id=? AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','FAILED')`,
        )
        .run(`reply received: ${reason}`, this.now(), leadId);
      if (["CONTACTED", "APPROVED"].includes(lead.status)) {
        this.db.prepare("UPDATE leads SET status='REPLIED', updated_at=? WHERE id=?").run(this.now(), leadId);
      }
      this.recordEvent("lead", leadId, "AUTOMATION_STOPPED_ON_REPLY", actor, { reason });
    });
  }

  markLeadDoNotContact(leadId: string, actor: string, reason: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE leads SET status='DO_NOT_CONTACT', human_takeover=1, updated_at=? WHERE id=?",
        )
        .run(this.now(), leadId);
      this.db
        .prepare(
          `UPDATE outbound_messages SET status='CANCELLED', failure_reason=?, updated_at=?
           WHERE lead_id=? AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','FAILED')`,
        )
        .run(`do not contact: ${reason}`, this.now(), leadId);
      this.recordEvent("lead", leadId, "DO_NOT_CONTACT", actor, { reason });
    });
  }

  markContactEmailInvalid(contactId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE contacts SET email_status='INVALID', email_risk=?, updated_at=? WHERE id=?`,
      )
      .run(reason.slice(0, 1000), this.now(), contactId);
    this.recordEvent("contact", contactId, "EMAIL_INVALIDATED", "inbound", { reason });
  }

  getLeadDetails(leadId: string): Record<string, unknown> | null {
    const row = this.db
        .prepare(
          `SELECT l.*,
                  c.id AS contact_id, c.name AS contact_name, c.title AS contact_title,
                  c.email, c.whatsapp, c.linkedin, c.source_url AS contact_source_url,
                  c.employment_verified_at, c.email_status, c.email_risk,
                  c.role_address, c.disposable_address, c.catch_all
                  ,dc.buying_likelihood AS buying_likelihood
                  ,dc.evidence_json AS candidate_evidence_json
           FROM leads l LEFT JOIN contacts c ON c.lead_id=l.id
           LEFT JOIN discovery_candidates dc ON dc.campaign_id=l.campaign_id AND dc.domain=l.domain
           WHERE l.id=? ORDER BY c.email_status='VALID' DESC LIMIT 1`,
        )
        .get(leadId) as Record<string, unknown> | undefined;
    return row ? this.attachIndependentSourceCounts([row], "id")[0] ?? null : null;
  }

  enqueueJob(
    jobType: string,
    payload: Record<string, unknown>,
    runAfter?: string,
    options: JobEnqueueOptions = {},
  ): string {
    return this.transaction(() => {
      let dedupeKey = String(options.dedupeKey ?? "").trim().slice(0, 500) || null;
      if (jobType === "ENRICH_CONTACTS") {
        const campaignId = String(payload.campaignId ?? "").trim();
        if (!campaignId) throw new Error("ENRICH_CONTACTS requires a campaign id");
        dedupeKey = `contact-enrichment:${campaignId}`.slice(0, 500);
      }
      if (dedupeKey) {
        const existing = this.db
          .prepare(
            `SELECT id FROM jobs
             WHERE dedupe_key=? AND status IN ('QUEUED','RUNNING') LIMIT 1`,
          )
          .get(dedupeKey) as { id: string } | undefined;
        if (existing) return existing.id;
      }
      const id = this.id("job");
      const now = this.now();
      const defaults = defaultJobRoute(jobType);
      const lane = options.lane ?? defaults.lane;
      const priority = Number.isFinite(options.priority)
        ? Math.trunc(options.priority as number)
        : defaults.priority;
      this.db
        .prepare(
          `INSERT INTO jobs(
             id, job_type, payload_json, run_after, lane, priority, dedupe_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, jobType, JSON.stringify(payload), runAfter ?? now, lane, priority, dedupeKey, now, now);
      this.recordEvent("job", id, "JOB_QUEUED", "system", { jobType, lane, priority, dedupeKey });
      return id;
    });
  }

  supersedeDuplicateQueuedJobs(jobType: string, dedupeKey: string): number {
    const normalizedType = jobType.trim();
    const normalizedKey = dedupeKey.trim().slice(0, 500);
    if (!normalizedType || !normalizedKey) throw new Error("Job compaction requires a type and dedupe key");
    return this.transaction(() => {
      const rows = this.db.prepare(
        `SELECT id, status FROM jobs
         WHERE job_type=? AND status IN ('QUEUED','RUNNING')
         ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END, run_after, created_at, id`,
      ).all(normalizedType) as Array<{ id: string; status: string }>;
      if (rows.length === 0) return 0;
      const keeper = rows[0]!;
      this.db.prepare("UPDATE jobs SET dedupe_key=? WHERE id=?").run(normalizedKey, keeper.id);
      let superseded = 0;
      for (const row of rows.slice(1)) {
        const now = this.now();
        const result = this.db.prepare(
          `UPDATE jobs SET status='SUPERSEDED', result_json=?, locked_at=NULL,
             worker_id=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=?
           WHERE id=? AND status='QUEUED'`,
        ).run(JSON.stringify({ supersededBy: keeper.id, dedupeKey: normalizedKey }), now, row.id);
        if (Number(result.changes) !== 1) continue;
        superseded += 1;
        this.recordEvent("job", row.id, "JOB_SUPERSEDED", "system", {
          supersededBy: keeper.id,
          jobType: normalizedType,
          dedupeKey: normalizedKey,
        });
      }
      return superseded;
    });
  }

  getJob(jobId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  deleteJob(jobId: string): boolean {
    const result = this.db.prepare("DELETE FROM jobs WHERE id=?").run(jobId);
    return Number(result.changes) === 1;
  }

  claimDueJob(options: JobClaimOptions): ClaimedJob | null {
    return this.transaction(() => {
      const now = this.now();
      const leaseDurationMs = Math.max(1, options.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS);
      const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
      const leaseToken = crypto.randomUUID();
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status='QUEUED' AND attempts < max_attempts AND lane=? AND run_after<=?
           ORDER BY priority DESC, run_after, created_at LIMIT 1`,
        )
        .get(options.lane, now) as Record<string, unknown> | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status='RUNNING', attempts=attempts+1, locked_at=?, worker_id=?,
               lease_token=?, lease_expires_at=?, updated_at=?
           WHERE id=? AND status='QUEUED'`,
        )
        .run(
          now,
          options.workerId,
          leaseToken,
          leaseExpiresAt,
          now,
          row.id as string,
        );
      if (result.changes !== 1) return null;
      return {
        ...row,
        id: String(row.id),
        job_type: String(row.job_type),
        lane: options.lane,
        priority: Number(row.priority),
        status: "RUNNING",
        attempts: Number(row.attempts) + 1,
        locked_at: now,
        worker_id: options.workerId,
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
      };
    });
  }

  renewJobLease(
    jobId: string,
    workerId: string,
    leaseToken: string,
    leaseDurationMs = DEFAULT_JOB_LEASE_MS,
  ): boolean {
    const now = this.now();
    const leaseExpiresAt = new Date(Date.now() + Math.max(1, leaseDurationMs)).toISOString();
    const result = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at=?, updated_at=?
         WHERE id=? AND status='RUNNING' AND worker_id=? AND lease_token=?
           AND lease_expires_at>?`,
      )
      .run(leaseExpiresAt, now, jobId, workerId, leaseToken, now);
    return Number(result.changes) === 1;
  }

  ownsJobLease(jobId: string, workerId: string, leaseToken: string): boolean {
    const now = this.now();
    return Boolean(this.db.prepare(
      `SELECT 1 FROM jobs
       WHERE id=? AND status='RUNNING' AND worker_id=? AND lease_token=?
         AND lease_expires_at>?`,
    ).get(jobId, workerId, leaseToken, now));
  }

  completeJob(jobId: string, workerId: string, leaseToken: string, result: unknown): boolean {
    return this.completeJobWithFollowup(jobId, workerId, leaseToken, result).completed;
  }

  completeJobWithFollowup(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: unknown,
    followup?: JobFollowup | null,
    notification?: JobNotificationOutbox | null,
  ): { completed: boolean; followupJobId: string | null } {
    return this.transaction(() => {
      const now = this.now();
      const update = this.db
        .prepare(
          `UPDATE jobs
           SET status='COMPLETED', result_json=?, locked_at=NULL, worker_id=NULL,
               lease_token=NULL, lease_expires_at=NULL, updated_at=?
           WHERE id=? AND status='RUNNING' AND worker_id=? AND lease_token=?
             AND lease_expires_at>?`,
        )
        .run(JSON.stringify(result ?? null), now, jobId, workerId, leaseToken, now);
      if (Number(update.changes) !== 1) return { completed: false, followupJobId: null };
      this.recordEvent("job", jobId, "JOB_COMPLETED", workerId, {});
      const followupJobId = followup
        ? this.enqueueJob(followup.jobType, followup.payload, followup.runAfter, followup.options)
        : null;
      if (followupJobId && result && typeof result === "object" && !Array.isArray(result)) {
        this.db.prepare("UPDATE jobs SET result_json=? WHERE id=?").run(
          JSON.stringify({ ...(result as Record<string, unknown>), followupJobId }),
          jobId,
        );
      }
      if (notification) {
        const eventType = notification.eventType.trim();
        const destination = notification.destination.trim();
        if (!eventType || !destination) {
          throw new Error("Durable job notification requires an event type and trusted destination");
        }
        const eventId = this.recordEvent(
          "notification",
          jobId,
          eventType,
          workerId,
          notification.payload,
        );
        this.queueNotification(eventId, notification.channel, destination);
      }
      return { completed: true, followupJobId };
    });
  }

  failJob(jobId: string, workerId: string, leaseToken: string, error: string): {
    retry: boolean;
    attempts: number;
    maxAttempts: number;
    runAfter: string;
  } | null {
    return this.transaction(() => {
      const now = this.now();
      const row = this.db
        .prepare(
          `SELECT attempts, max_attempts FROM jobs
           WHERE id=? AND status='RUNNING' AND worker_id=? AND lease_token=?
             AND lease_expires_at>?`,
        )
        .get(jobId, workerId, leaseToken, now) as
          | { attempts: number; max_attempts: number }
          | undefined;
      if (!row) return null;
      const retry = row.attempts < row.max_attempts;
      const delayMinutes = Math.min(60, 2 ** Math.max(row.attempts, 1));
      const runAfter = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      const update = this.db
        .prepare(
          `UPDATE jobs
           SET status=?, run_after=?, locked_at=NULL, worker_id=NULL, lease_token=NULL,
               lease_expires_at=NULL, last_error=?, updated_at=?
           WHERE id=? AND status='RUNNING' AND worker_id=? AND lease_token=?
             AND lease_expires_at>?`,
        )
        .run(
          retry ? "QUEUED" : "FAILED",
          runAfter,
          error.slice(0, 2000),
          now,
          jobId,
          workerId,
          leaseToken,
          now,
        );
      if (Number(update.changes) !== 1) return null;
      this.recordEvent(
        "job",
        jobId,
        retry ? "JOB_RETRY_SCHEDULED" : "JOB_FAILED",
        workerId,
        { error },
      );
      return {
        retry,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        runAfter,
      };
    });
  }

  recoverExpiredJobs(): number {
    return this.transaction(() => {
      const now = this.now();
      const expired = this.db
        .prepare(
          `SELECT id, worker_id, attempts, max_attempts FROM jobs
           WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`,
        )
        .all(now) as Array<{
          id: string;
          worker_id: string | null;
          attempts: number;
          max_attempts: number;
        }>;
      let recovered = 0;
      const update = this.db.prepare(
        `UPDATE jobs
         SET status=?, locked_at=NULL, worker_id=NULL, lease_token=NULL,
             lease_expires_at=NULL, run_after=?, last_error=?, updated_at=?
         WHERE id=? AND status='RUNNING' AND lease_expires_at IS NOT NULL
           AND lease_expires_at<=?`,
      );
      for (const job of expired) {
        const retry = Number(job.attempts) < Number(job.max_attempts);
        const result = update.run(
          retry ? "QUEUED" : "FAILED",
          now,
          retry ? "job lease expired; retry scheduled" : "job lease expired at maximum attempts",
          now,
          job.id,
          now,
        );
        if (Number(result.changes) !== 1) continue;
        recovered += 1;
        this.recordEvent("job", job.id, retry ? "JOB_LEASE_EXPIRED" : "JOB_FAILED", "system", {
          previousWorkerId: job.worker_id,
          attempts: job.attempts,
          maxAttempts: job.max_attempts,
          retry,
        });
      }
      return recovered;
    });
  }

  recoverStaleJobs(): number {
    return this.recoverExpiredJobs();
  }

  queueNotification(eventId: string, channel: string, destination: string): string {
    const id = this.id("ntf");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO notifications(
           id, event_id, channel, destination, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, eventId, channel, destination, now, now, now);
    return id;
  }

  stageNotificationOnce(input: {
    idempotencyKey: string;
    eventType: string;
    payload: Record<string, unknown>;
    channel: string;
    destinations: string[];
    entityType?: string;
    entityId?: string;
  }): boolean {
    const idempotencyKey = input.idempotencyKey.trim();
    const eventType = input.eventType.trim();
    const channel = input.channel.trim();
    const destinations = [...new Set(input.destinations.map((value) => value.trim()).filter(Boolean))];
    if (!idempotencyKey || !eventType || !channel || destinations.length === 0) {
      throw new Error("Durable notification requires an idempotency key, event type, channel, and destination");
    }
    return this.transaction(() => {
      const marker = `notification_once:${idempotencyKey}`;
      if (!this.setSettingIfAbsent(marker, this.now())) return false;
      const eventId = this.recordEvent(
        input.entityType?.trim() || "notification",
        input.entityId?.trim() || channel,
        eventType,
        "system",
        input.payload,
      );
      for (const destination of destinations) this.queueNotification(eventId, channel, destination);
      return true;
    });
  }

  listPendingNotifications(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT n.*, e.entity_type, e.entity_id, e.event_type, e.payload_json
         FROM notifications n LEFT JOIN events e ON e.id=n.event_id
         WHERE n.status='PENDING'
         ORDER BY COALESCE(n.next_attempt_at, n.created_at), n.created_at, n.id LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  listDueNotifications(limit = 20, now = new Date()): Array<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const dueAt = now.toISOString();
    return this.db.prepare(
      `SELECT n.*, e.entity_type, e.entity_id, e.event_type, e.payload_json
       FROM notifications n LEFT JOIN events e ON e.id=n.event_id
       WHERE n.status='PENDING' AND COALESCE(n.next_attempt_at, n.created_at)<=?
       ORDER BY
         CASE WHEN n.attempts=0 THEN 0 ELSE 1 END,
         CASE
           WHEN e.event_type IN (
             'INQUIRY_ALERT',
             'EMAIL_HARD_BOUNCE_ALERT',
             'GMAIL_PILOT_SAFETY_PAUSE',
             'EMAIL_DELIVERY_RECONCILIATION_REQUIRED',
             'IMAP_RUNTIME_HEALTH_PAUSE',
             'IMAP_RUNTIME_RECOVERED',
             'IMAP_MESSAGE_QUARANTINED',
             'QUARANTINED_INBOUND_ALERT'
           ) THEN 0
           WHEN e.event_type='REPLY_ALERT' THEN 1
           ELSE 2
         END,
         COALESCE(n.next_attempt_at, n.created_at), n.created_at, n.id
       LIMIT ?`,
    ).all(dueAt, safeLimit) as Array<Record<string, unknown>>;
  }

  markNotificationSent(notificationId: string, now = new Date()): void {
    const timestamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE notifications
         SET status='SENT', attempts=attempts+1, sent_at=?, next_attempt_at=NULL, updated_at=?
         WHERE id=? AND status='PENDING'`,
      )
      .run(timestamp, timestamp, notificationId);
  }

  deferNotification(
    notificationId: string,
    reason: string,
    now = new Date(),
    delayMs = 5 * 60 * 1_000,
  ): string | null {
    const timestamp = now.toISOString();
    const boundedDelayMs = Math.max(30_000, Math.min(NOTIFICATION_BACKOFF_MAX_MS, Math.trunc(delayMs)));
    const nextAttemptAt = new Date(now.getTime() + boundedDelayMs).toISOString();
    const result = this.db.prepare(
      `UPDATE notifications
       SET last_error=?, next_attempt_at=?, updated_at=?
       WHERE id=? AND status='PENDING'`,
    ).run(reason.slice(0, 1_000), nextAttemptAt, timestamp, notificationId);
    return Number(result.changes) === 1 ? nextAttemptAt : null;
  }

  markNotificationFailed(
    notificationId: string,
    error: string,
    now = new Date(),
  ): NotificationFailureResult | null {
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT attempts FROM notifications WHERE id=? AND status='PENDING'",
      ).get(notificationId) as { attempts: number } | undefined;
      if (!row) return null;
      const attempts = Math.max(0, Number(row.attempts)) + 1;
      const timestamp = now.toISOString();
      const safeError = error
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;&}\]\r\n]+/gi, "[authorization]")
        .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, "[token]")
        .slice(0, 1_000);
      if (attempts >= NOTIFICATION_MAX_ATTEMPTS) {
        this.db.prepare(
          `UPDATE notifications
           SET status='DEAD_LETTER', attempts=?, last_error=?, next_attempt_at=NULL,
               dead_lettered_at=?, updated_at=?
           WHERE id=? AND status='PENDING'`,
        ).run(attempts, safeError, timestamp, timestamp, notificationId);
        this.recordEvent("notification", notificationId, "NOTIFICATION_DEAD_LETTERED", "system", {
          attempts,
          maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
        });
        return {
          status: "DEAD_LETTER",
          attempts,
          nextAttemptAt: null,
          deadLetteredAt: timestamp,
        };
      }
      const backoffMs = Math.min(
        NOTIFICATION_BACKOFF_MAX_MS,
        NOTIFICATION_BACKOFF_BASE_MS * (2 ** (attempts - 1)),
      );
      const nextAttemptAt = new Date(now.getTime() + backoffMs).toISOString();
      this.db.prepare(
        `UPDATE notifications
         SET attempts=?, last_error=?, next_attempt_at=?, dead_lettered_at=NULL, updated_at=?
         WHERE id=? AND status='PENDING'`,
      ).run(attempts, safeError, nextAttemptAt, timestamp, notificationId);
      return { status: "PENDING", attempts, nextAttemptAt, deadLetteredAt: null };
    });
  }

  getNotificationOutboxSummary(now = new Date()): NotificationOutboxSummary {
    const timestamp = now.toISOString();
    const row = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status='PENDING' AND COALESCE(next_attempt_at, created_at)<=? THEN 1 ELSE 0 END) AS due_count,
         SUM(CASE WHEN status='DEAD_LETTER' THEN 1 ELSE 0 END) AS dead_letter_count,
         MIN(CASE WHEN status='PENDING' THEN created_at END) AS oldest_pending_at
       FROM notifications`,
    ).get(timestamp) as {
      pending_count: number | null;
      due_count: number | null;
      dead_letter_count: number | null;
      oldest_pending_at: string | null;
    };
    const oldestPendingAt = row.oldest_pending_at ?? null;
    const oldestMs = oldestPendingAt ? Date.parse(oldestPendingAt) : Number.NaN;
    return {
      pendingCount: Number(row.pending_count ?? 0),
      dueCount: Number(row.due_count ?? 0),
      deadLetterCount: Number(row.dead_letter_count ?? 0),
      oldestPendingAt,
      oldestPendingAgeSeconds: Number.isFinite(oldestMs)
        ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 1_000))
        : null,
    };
  }

  countSentSince(since: string, channel = "email"): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM outbound_messages WHERE channel=? AND sent_at>=? AND status IN ('SENT','DELIVERED','REPLIED','BOUNCED')",
      )
      .get(channel, since) as { count: number };
    return row.count;
  }

  getLatestSentAt(channel = "email"): string | null {
    const row = this.db
      .prepare(
        `SELECT sent_at AS sentAt FROM outbound_messages
         WHERE channel=? AND sent_at IS NOT NULL
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(channel) as { sentAt: string } | undefined;
    return row?.sentAt ?? null;
  }

  recordEmailBounceIncident(input: {
    inboundMessageId: string;
    outboundMessageId: string;
    leadId: string;
    contactId: string;
    diagnosticSource: string;
    createdAt?: string;
  }): BounceIncidentRecord {
    const diagnostic = analyzeBounceDiagnostic(input.diagnosticSource);
    this.db.prepare(
      `INSERT OR IGNORE INTO email_bounce_incidents(
         id, inbound_message_id, outbound_message_id, lead_id, contact_id,
         diagnostic_category, enhanced_status_code, diagnostic_code,
         evidence_sha256, evidence_excerpt, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.id("bounce"),
      input.inboundMessageId,
      input.outboundMessageId,
      input.leadId,
      input.contactId,
      diagnostic.category,
      diagnostic.enhancedStatusCode,
      diagnostic.diagnosticCode,
      diagnostic.evidenceSha256,
      diagnostic.evidenceExcerpt,
      input.createdAt ?? this.now(),
    );
    const incident = this.db.prepare(
      `SELECT incident.*, review.id AS review_id, review.disposition AS review_disposition,
              review.reviewed_by, review.review_reason, review.created_at AS reviewed_at
       FROM email_bounce_incidents incident
       LEFT JOIN email_bounce_incident_reviews review ON review.incident_id=incident.id
       WHERE incident.outbound_message_id=?`,
    ).get(input.outboundMessageId) as BounceIncidentRecord | undefined;
    if (!incident) throw new Error("Email bounce incident could not be persisted");
    return incident;
  }

  listEmailBounceIncidents(limit = 100): BounceIncidentRecord[] {
    return this.db.prepare(
      `SELECT incident.*, review.id AS review_id, review.disposition AS review_disposition,
              review.reviewed_by, review.review_reason, review.created_at AS reviewed_at
       FROM email_bounce_incidents incident
       LEFT JOIN email_bounce_incident_reviews review ON review.incident_id=incident.id
       ORDER BY incident.created_at DESC, incident.id DESC LIMIT ?`,
    ).all(Math.max(1, Math.trunc(limit))) as unknown as BounceIncidentRecord[];
  }

  reviewEmailBounceIncident(input: {
    incidentId: string;
    disposition: BounceReviewDisposition;
    reviewedBy: string;
    reason: string;
  }): BounceIncidentRecord {
    const allowed = new Set<BounceReviewDisposition>([
      "CONFIRMED_RECIPIENT_FAILURE",
      "REMOTE_INFRASTRUCTURE_FAILURE",
      "SENDER_INFRASTRUCTURE_FAILURE",
      "MISCLASSIFIED",
    ]);
    const reviewedBy = input.reviewedBy.trim();
    const reason = input.reason.trim();
    if (!allowed.has(input.disposition)) throw new Error("Invalid bounce review disposition");
    if (!reviewedBy || !reason) throw new Error("Bounce review requires an actor and reason");
    return this.transaction(() => {
      const incident = this.db.prepare(
        "SELECT id FROM email_bounce_incidents WHERE id=?",
      ).get(input.incidentId) as { id: string } | undefined;
      if (!incident) throw new Error(`Bounce incident not found: ${input.incidentId}`);
      if (this.db.prepare(
        "SELECT 1 FROM email_bounce_incident_reviews WHERE incident_id=?",
      ).get(input.incidentId)) {
        throw new Error(`Bounce incident has already been reviewed: ${input.incidentId}`);
      }
      const reviewId = this.id("bouncereview");
      const createdAt = this.now();
      this.db.prepare(
        `INSERT INTO email_bounce_incident_reviews(
           id, incident_id, disposition, reviewed_by, review_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(reviewId, input.incidentId, input.disposition, reviewedBy, reason, createdAt);
      this.recordEvent("email_bounce_incident", input.incidentId, "EMAIL_BOUNCE_INCIDENT_REVIEWED", reviewedBy, {
        reviewId,
        disposition: input.disposition,
        reason,
      });
      return this.listEmailBounceIncidents(10_000).find((row) => row.id === input.incidentId)!;
    });
  }

  authorizeDeliverabilityRecovery(input: {
    incidentReviewId: string;
    authorizedBy: string;
    reason: string;
    maxMessages: number;
    expiresAt: string;
    maxHardBounceRate: number;
    hardBounceWindowSize?: number;
    hardBounceMinimumSample?: number;
  }): DeliverabilityRecoveryState {
    const authorizedBy = input.authorizedBy.trim();
    const reason = input.reason.trim();
    const maxMessages = Math.trunc(input.maxMessages);
    const now = this.now();
    const expiresAt = new Date(input.expiresAt).toISOString();
    if (!authorizedBy || !reason) throw new Error("Recovery authorization requires an actor and reason");
    if (!Number.isFinite(maxMessages) || maxMessages < 1 || maxMessages > 50) {
      throw new Error("Recovery authorization maxMessages must be between 1 and 50");
    }
    if (expiresAt <= now || Date.parse(expiresAt) - Date.parse(now) > 7 * 86_400_000) {
      throw new Error("Recovery authorization must expire within seven days");
    }
    const windowSize = Math.max(1, Math.trunc(input.hardBounceWindowSize ?? 50));
    const minimumSample = Math.max(0, Math.trunc(input.hardBounceMinimumSample ?? 20));
    const bounce = this.getBounceStats(windowSize);
    if (bounce.sent < minimumSample || bounce.rate <= input.maxHardBounceRate) {
      throw new Error("Deliverability recovery is not currently required");
    }
    const requiredSuccessfulSends = this.requiredDeliverabilityRecoverySuccesses(
      windowSize,
      minimumSample,
      input.maxHardBounceRate,
    );
    if (maxMessages > requiredSuccessfulSends) {
      throw new Error(`Recovery authorization exceeds the ${requiredSuccessfulSends}-message sample required by policy`);
    }
    return this.transaction(() => {
      const review = this.db.prepare(
        `SELECT review.id, review.incident_id, incident.created_at
         FROM email_bounce_incident_reviews review
         JOIN email_bounce_incidents incident ON incident.id=review.incident_id
         WHERE review.id=?`,
      ).get(input.incidentReviewId) as Record<string, unknown> | undefined;
      if (!review) throw new Error(`Bounce incident review not found: ${input.incidentReviewId}`);
      const unresolved = this.db.prepare(
        `SELECT count(*) AS count FROM email_bounce_incidents incident
         LEFT JOIN email_bounce_incident_reviews review ON review.incident_id=incident.id
         WHERE review.id IS NULL`,
      ).get() as { count: number };
      if (Number(unresolved.count) > 0) {
        throw new Error("All bounce incidents must be reviewed before recovery can be authorized");
      }
      const newest = this.db.prepare(
        "SELECT id FROM email_bounce_incidents ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get() as { id: string } | undefined;
      if (newest?.id !== review.incident_id) {
        throw new Error("Recovery authorization must reference the latest reviewed bounce incident");
      }
      if (this.db.prepare(
        `SELECT 1 FROM deliverability_recovery_authorizations authorization
         WHERE authorization.valid_from<=? AND authorization.expires_at>?
           AND NOT EXISTS (
             SELECT 1 FROM email_bounce_incidents newer
             WHERE newer.created_at>authorization.created_at
           )
           AND (SELECT count(*) FROM deliverability_recovery_claims claim
                WHERE claim.authorization_id=authorization.id)<authorization.max_messages
         LIMIT 1`,
      ).get(now, now)) {
        throw new Error("An active deliverability recovery authorization already exists");
      }
      const authorizationId = this.id("recoveryauth");
      this.db.prepare(
        `INSERT INTO deliverability_recovery_authorizations(
           id, incident_review_id, authorized_by, authorization_reason,
           max_messages, valid_from, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        authorizationId,
        input.incidentReviewId,
        authorizedBy,
        reason,
        maxMessages,
        now,
        expiresAt,
        now,
      );
      this.recordEvent("system", "deliverability_recovery", "DELIVERABILITY_RECOVERY_AUTHORIZED", authorizedBy, {
        authorizationId,
        incidentReviewId: input.incidentReviewId,
        maxMessages,
        expiresAt,
        reason,
      });
      return this.getDeliverabilityRecoveryState({
        maxHardBounceRate: input.maxHardBounceRate,
        hardBounceWindowSize: windowSize,
        hardBounceMinimumSample: minimumSample,
        now: new Date(now),
      });
    });
  }

  getDeliverabilityRecoveryState(input: {
    maxHardBounceRate: number;
    hardBounceWindowSize?: number;
    hardBounceMinimumSample?: number;
    now?: Date;
  }): DeliverabilityRecoveryState {
    const windowSize = Math.max(1, Math.trunc(input.hardBounceWindowSize ?? 50));
    const minimumSample = Math.max(0, Math.trunc(input.hardBounceMinimumSample ?? 20));
    const now = (input.now ?? new Date()).toISOString();
    const bounceStats = this.getBounceStats(windowSize);
    const required = bounceStats.sent >= minimumSample && bounceStats.rate > input.maxHardBounceRate;
    const requiredSuccessfulMessages = required
      ? this.requiredDeliverabilityRecoverySuccesses(windowSize, minimumSample, input.maxHardBounceRate)
      : 0;
    const unresolved = this.db.prepare(
      `SELECT count(*) AS count FROM email_bounce_incidents incident
       LEFT JOIN email_bounce_incident_reviews review ON review.incident_id=incident.id
       WHERE review.id IS NULL`,
    ).get() as { count: number };
    const candidate = this.db.prepare(
      `SELECT authorization.id, authorization.max_messages, authorization.expires_at,
              authorization.created_at,
              (SELECT count(*) FROM deliverability_recovery_claims claim
               WHERE claim.authorization_id=authorization.id) AS claimed_messages,
              CASE WHEN EXISTS (
                SELECT 1 FROM email_bounce_incidents newer
                WHERE newer.created_at>authorization.created_at
              ) THEN 1 ELSE 0 END AS invalidated_by_new_bounce
       FROM deliverability_recovery_authorizations authorization
       WHERE authorization.valid_from<=? AND authorization.expires_at>?
       ORDER BY authorization.created_at DESC LIMIT 1`,
    ).get(now, now) as Record<string, unknown> | undefined;
    const invalidatedByNewBounce = Number(candidate?.invalidated_by_new_bounce ?? 0) === 1;
    const authorizedMessages = Number(candidate?.max_messages ?? 0);
    const claimedMessages = Number(candidate?.claimed_messages ?? 0);
    const active = Boolean(
      required && candidate && Number(unresolved.count) === 0 && !invalidatedByNewBounce &&
      claimedMessages < authorizedMessages,
    );
    return {
      required,
      bounceStats,
      requiredSuccessfulMessages,
      unresolvedIncidents: Number(unresolved.count),
      authorizationId: active ? String(candidate!.id) : null,
      authorizationExpiresAt: active ? String(candidate!.expires_at) : null,
      authorizedMessages,
      claimedMessages,
      remainingMessages: active ? authorizedMessages - claimedMessages : 0,
      invalidatedByNewBounce,
    };
  }

  getBounceStats(windowSize = 50): { sent: number; bounced: number; rate: number } {
    const rows = this.recentEmailDeliveryStatuses(windowSize);
    const bounced = rows.filter((status) => status === "BOUNCED").length;
    return { sent: rows.length, bounced, rate: rows.length ? bounced / rows.length : 0 };
  }

  private recentEmailDeliveryStatuses(windowSize: number): MessageStatus[] {
    return this.db
      .prepare(
        `SELECT status FROM outbound_messages WHERE channel='email' AND sent_at IS NOT NULL
         ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.trunc(windowSize)))
      .map((row) => (row as { status: MessageStatus }).status);
  }

  private requiredDeliverabilityRecoverySuccesses(
    windowSize: number,
    minimumSample: number,
    maxHardBounceRate: number,
  ): number {
    const boundedWindow = Math.max(1, Math.trunc(windowSize));
    const statuses = this.recentEmailDeliveryStatuses(boundedWindow);
    for (let successes = 1; successes <= boundedWindow; successes += 1) {
      const simulated = [
        ...Array<MessageStatus>(successes).fill("SENT"),
        ...statuses,
      ].slice(0, boundedWindow);
      if (simulated.length < minimumSample) continue;
      const bounced = simulated.filter((status) => status === "BOUNCED").length;
      if (bounced / simulated.length <= maxHardBounceRate) return successes;
    }
    return boundedWindow;
  }

  recordLlmUsage(purpose: string, model: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage(id, purpose, model, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id("llm"), purpose, model, inputTokens, outputTokens, this.now());
  }

  getLlmTokensSince(since: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
         FROM llm_usage WHERE created_at >= ?`,
      )
      .get(since) as { total: number };
    return row.total;
  }

  getMetrics(): Record<string, number> {
    const scalar = (sql: string): number =>
      (this.db.prepare(sql).get() as { count: number }).count;
    return {
      campaigns: scalar("SELECT COUNT(*) AS count FROM campaigns"),
      leads: scalar("SELECT COUNT(*) AS count FROM leads"),
      eligibleLeads: scalar("SELECT COUNT(*) AS count FROM leads WHERE send_eligible=1"),
      humanTakeovers: scalar("SELECT COUNT(*) AS count FROM leads WHERE human_takeover=1"),
      pendingReview: scalar("SELECT COUNT(*) AS count FROM leads WHERE status='READY_FOR_REVIEW'"),
      messagesSent: scalar("SELECT COUNT(*) AS count FROM outbound_messages WHERE sent_at IS NOT NULL"),
      replies: scalar(
        `SELECT COUNT(DISTINCT lead_id) AS count FROM inbound_messages
         WHERE lead_id IS NOT NULL
           AND classification IN ('P1_INQUIRY','P2_INTEREST','OTHER_REPLY','NEGATIVE','UNSUBSCRIBE')`,
      ),
      inquiries: scalar(
        `SELECT COUNT(DISTINCT lead_id) AS count FROM inbound_messages
         WHERE lead_id IS NOT NULL AND classification IN ('P1_INQUIRY','P2_INTEREST')`,
      ),
      bounces: scalar(
        `SELECT COUNT(DISTINCT lead_id) AS count FROM inbound_messages
         WHERE lead_id IS NOT NULL AND channel='email' AND classification='BOUNCE'`,
      ),
      softBounces: scalar(
        `SELECT COUNT(DISTINCT lead_id) AS count FROM inbound_messages
         WHERE lead_id IS NOT NULL AND channel='email' AND classification='SOFT_BOUNCE'`,
      ),
      whatsappDeliveryFailures: scalar(
        `SELECT COUNT(DISTINCT lead_id) AS count FROM inbound_messages
         WHERE lead_id IS NOT NULL AND channel='whatsapp' AND classification='BOUNCE'`,
      ),
      matchedInbound: scalar("SELECT COUNT(*) AS count FROM inbound_messages WHERE lead_id IS NOT NULL"),
      unmatchedInbound: scalar("SELECT COUNT(*) AS count FROM inbound_messages WHERE lead_id IS NULL"),
      pendingJobs: scalar("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('QUEUED','RUNNING')"),
      deliveryReconciliations: scalar(
        "SELECT COUNT(*) AS count FROM outbound_messages WHERE status='UNKNOWN_RECONCILIATION_REQUIRED'",
      ),
    };
  }

  recordSourceOutcome(leadId: string, outcome: "reply" | "inquiry" | "bounce"): void {
    const sources = this.db
      .prepare("SELECT DISTINCT source_type FROM lead_sources WHERE lead_id=?")
      .all(leadId) as Array<{ source_type: string }>;
    const column = outcome === "reply" ? "replies" : outcome === "inquiry" ? "inquiries" : "bounces";
    for (const source of sources) {
      const attribution = this.db
        .prepare(
          `INSERT OR IGNORE INTO source_outcomes(source_type, lead_id, outcome, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(source.source_type, leadId, outcome, this.now());
      if (attribution.changes !== 1) continue;
      this.db
        .prepare(
          `INSERT INTO source_metrics(source_type, ${column}, updated_at) VALUES (?, 1, ?)
           ON CONFLICT(source_type) DO UPDATE SET ${column}=${column}+1, updated_at=excluded.updated_at`,
        )
        .run(source.source_type, this.now());
    }
  }

  listSourceMetrics(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT *,
          CASE WHEN leads=0 THEN 0.0 ELSE CAST(inquiries AS REAL)/leads END AS inquiry_yield,
          CASE WHEN leads=0 THEN 0.0 ELSE CAST(bounces AS REAL)/leads END AS bounce_yield
         FROM source_metrics ORDER BY inquiry_yield DESC, leads DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  listEventsForSync(excludedEventTypes: readonly string[] = []): Array<Record<string, unknown>> {
    const excluded = [...new Set(excludedEventTypes
      .map((eventType) => eventType.trim().toUpperCase())
      .filter(Boolean))];
    const where = excluded.length > 0
      ? `WHERE upper(trim(event_type)) NOT IN (${excluded.map(() => "?").join(",")})`
      : "";
    return this.db
      .prepare(
        `SELECT id, entity_type, entity_id, event_type, actor, payload_json, created_at
         FROM events ${where} ORDER BY created_at, id`,
      )
      .all(...excluded) as Array<Record<string, unknown>>;
  }
}
