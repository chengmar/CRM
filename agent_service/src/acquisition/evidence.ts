import { createHash } from "node:crypto";
import { z } from "zod";

export const EVIDENCE_FACT_SCHEMA_VERSION = "evidence-fact-v2" as const;
export const PAGE_SNAPSHOT_SCHEMA_VERSION = "page-snapshot-v2" as const;

const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "must be an HTTP(S) URL");

const IdSchema = z.string().trim().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const EvidencePublisherSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(300),
  domain: z.string().trim().min(1).max(253),
}).strict();

export const EvidenceIndependenceSchema = z.object({
  publisherKey: IdSchema,
  relationship: z.enum(["FIRST_PARTY", "INDEPENDENT", "SELLER", "UNKNOWN"]),
  independentFromSeller: z.boolean(),
  independentFromAccount: z.boolean(),
}).strict();

export const PageSnapshotSchema = z.object({
  schemaVersion: z.literal(PAGE_SNAPSHOT_SCHEMA_VERSION),
  id: IdSchema,
  accountId: IdSchema,
  leadId: IdSchema,
  subject: z.string().trim().min(1).max(300),
  sourceUrl: HttpUrlSchema,
  publisher: EvidencePublisherSchema,
  contentHash: HashSchema,
  text: z.string().min(1).max(2_000_000),
  publishedAt: IsoDateTimeSchema.nullable(),
  retrievedAt: IsoDateTimeSchema,
}).strict();

export const EvidenceFactSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_FACT_SCHEMA_VERSION),
  id: IdSchema,
  accountId: IdSchema,
  leadId: IdSchema,
  subject: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(2_000),
  exactQuote: z.string().min(1).max(20_000),
  sourceUrl: HttpUrlSchema,
  sourceSnapshotId: IdSchema,
  contentHash: HashSchema,
  observedAt: IsoDateTimeSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  retrievedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  publisher: EvidencePublisherSchema,
  independence: EvidenceIndependenceSchema,
  evidenceClass: z.enum([
    "IDENTITY",
    "FIT",
    "ACTIVE_INTENT",
    "DIRECT_DEMAND",
    "CONTACT",
    "PERSONALIZATION",
  ]),
  allowedUses: z.array(z.enum(["RESEARCH", "OUTREACH", "QUALIFICATION"])).min(1),
  visibility: z.enum(["PUBLIC", "INTERNAL_ONLY", "NOT_FOR_OUTREACH", "PROHIBITED"]),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
}).strict();

export type EvidencePublisher = z.infer<typeof EvidencePublisherSchema>;
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
export type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

export interface EvidenceValidationResult {
  passed: boolean;
  blockers: string[];
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const evidenceContentHash = contentHash;

export function createPageSnapshot(
  input: Omit<PageSnapshot, "schemaVersion" | "contentHash">,
): PageSnapshot {
  return PageSnapshotSchema.parse({
    ...input,
    schemaVersion: PAGE_SNAPSHOT_SCHEMA_VERSION,
    contentHash: contentHash(input.text),
  });
}

function samePublisher(left: EvidencePublisher, right: EvidencePublisher): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.domain.toLowerCase() === right.domain.toLowerCase();
}

export function validateEvidenceFactAgainstSnapshot(
  factInput: unknown,
  snapshotInput: unknown,
  now = new Date(),
): EvidenceValidationResult {
  const factResult = EvidenceFactSchema.safeParse(factInput);
  const snapshotResult = PageSnapshotSchema.safeParse(snapshotInput);
  const blockers: string[] = [];
  if (!factResult.success) {
    blockers.push(...factResult.error.issues.map((issue) =>
      `EVIDENCE_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  if (!snapshotResult.success) {
    blockers.push(...snapshotResult.error.issues.map((issue) =>
      `SNAPSHOT_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  if (!factResult.success || !snapshotResult.success) {
    return { passed: false, blockers: [...new Set(blockers)].sort() };
  }

  const fact = factResult.data;
  const snapshot = snapshotResult.data;
  if (snapshot.contentHash !== contentHash(snapshot.text)) blockers.push("SNAPSHOT_CONTENT_HASH_MISMATCH");
  if (fact.sourceSnapshotId !== snapshot.id) blockers.push("EVIDENCE_SNAPSHOT_ID_MISMATCH");
  if (fact.accountId !== snapshot.accountId) blockers.push("EVIDENCE_ACCOUNT_MISMATCH");
  if (fact.leadId !== snapshot.leadId) blockers.push("EVIDENCE_LEAD_MISMATCH");
  if (fact.subject !== snapshot.subject) blockers.push("EVIDENCE_SUBJECT_MISMATCH");
  if (fact.sourceUrl !== snapshot.sourceUrl) blockers.push("EVIDENCE_SOURCE_URL_MISMATCH");
  if (fact.contentHash !== snapshot.contentHash) blockers.push("EVIDENCE_CONTENT_HASH_MISMATCH");
  if (!samePublisher(fact.publisher, snapshot.publisher)) blockers.push("EVIDENCE_PUBLISHER_MISMATCH");
  if (fact.independence.publisherKey !== fact.publisher.id) {
    blockers.push("EVIDENCE_INDEPENDENCE_PUBLISHER_MISMATCH");
  }
  if (!snapshot.text.includes(fact.exactQuote)) blockers.push("EVIDENCE_QUOTE_NOT_IN_SNAPSHOT");
  if (Date.parse(fact.retrievedAt) !== Date.parse(snapshot.retrievedAt)) {
    blockers.push("EVIDENCE_RETRIEVED_AT_MISMATCH");
  }
  if (fact.publishedAt !== snapshot.publishedAt) blockers.push("EVIDENCE_PUBLISHED_AT_MISMATCH");
  if (fact.expiresAt !== null && Date.parse(fact.expiresAt) < now.getTime()) {
    blockers.push("EVIDENCE_FACT_EXPIRED");
  }
  if (fact.observedAt !== null && Date.parse(fact.observedAt) > now.getTime()) {
    blockers.push("EVIDENCE_OBSERVED_IN_FUTURE");
  }

  return { passed: blockers.length === 0, blockers: [...new Set(blockers)].sort() };
}

export function isOutreachEvidenceFact(
  fact: EvidenceFact,
  now = new Date(),
): boolean {
  return fact.visibility === "PUBLIC"
    && fact.allowedUses.includes("OUTREACH")
    && (fact.expiresAt === null || Date.parse(fact.expiresAt) >= now.getTime());
}

export interface EvidenceSelectionInput {
  factIds: readonly string[];
  accountId: string;
  leadId: string;
  facts: readonly EvidenceFact[];
  snapshots: readonly PageSnapshot[];
  now?: Date;
}

export interface EvidenceSelectionResult {
  selected: EvidenceFact[];
  blockers: string[];
}

export function selectOutreachEvidenceFacts(input: EvidenceSelectionInput): EvidenceSelectionResult {
  const now = input.now ?? new Date();
  const factMap = new Map(input.facts.map((fact) => [fact.id, fact]));
  const snapshotMap = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const blockers: string[] = [];
  const selected: EvidenceFact[] = [];

  for (const factId of [...new Set(input.factIds)]) {
    const fact = factMap.get(factId);
    if (!fact) {
      blockers.push(`EVIDENCE_FACT_UNKNOWN:${factId}`);
      continue;
    }
    if (fact.accountId !== input.accountId) blockers.push(`EVIDENCE_WRONG_ACCOUNT:${factId}`);
    if (fact.leadId !== input.leadId) blockers.push(`EVIDENCE_WRONG_LEAD:${factId}`);
    if (!isOutreachEvidenceFact(fact, now)) blockers.push(`EVIDENCE_NOT_ALLOWED_FOR_OUTREACH:${factId}`);
    const snapshot = snapshotMap.get(fact.sourceSnapshotId);
    if (!snapshot) {
      blockers.push(`EVIDENCE_SNAPSHOT_UNKNOWN:${factId}`);
      continue;
    }
    const validation = validateEvidenceFactAgainstSnapshot(fact, snapshot, now);
    blockers.push(...validation.blockers.map((blocker) => `${blocker}:${factId}`));
    if (
      fact.accountId === input.accountId
      && fact.leadId === input.leadId
      && isOutreachEvidenceFact(fact, now)
      && validation.passed
    ) {
      selected.push(fact);
    }
  }

  return {
    selected,
    blockers: [...new Set(blockers)].sort(),
  };
}
