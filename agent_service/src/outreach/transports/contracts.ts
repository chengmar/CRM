import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(200);
const DateTimeSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export function transportContentHash(subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ subject, body })).digest("hex");
}

export const TransportRecipientSchema = z.object({
  recipientId: IdentifierSchema,
  accountId: IdentifierSchema,
  contactId: IdentifierSchema,
  messageId: IdentifierSchema,
  email: z.string().trim().toLowerCase().email(),
  emailStatus: z.enum(["VALID", "RISKY", "UNKNOWN", "INVALID"]),
  dncMatch: z.boolean(),
  ownershipConflict: z.boolean(),
  humanTakeover: z.boolean(),
  approved: z.boolean(),
  approvedReviewHash: Sha256Schema.nullable(),
  currentReviewHash: Sha256Schema,
  dossierVersion: z.number().int().positive(),
  experimentArm: IdentifierSchema,
  sequenceIndex: z.number().int().min(0).max(3),
  subject: z.string().max(500),
  body: z.string().min(1).max(20_000),
  contentHash: Sha256Schema,
}).strict();

export type TransportRecipient = z.infer<typeof TransportRecipientSchema>;

export const PausedTransportCampaignSchema = z.object({
  campaignId: IdentifierSchema,
  transport: z.literal("INSTANTLY"),
  requestedMode: z.enum(["PAUSED", "ACTIVE"]),
  activationRequested: z.boolean(),
  openTracking: z.boolean(),
  clickTracking: z.boolean(),
  replyStopEnabled: z.boolean(),
  companyStopEnabled: z.boolean(),
  recipients: z.array(TransportRecipientSchema).min(1).max(100),
}).strict();

export interface TransportRecipientDecision {
  recipientId: string;
  staged: boolean;
  blockers: string[];
}

export interface PausedTransportStageResult {
  campaignId: string;
  status: "STAGED_PAUSED" | "BLOCKED";
  campaignBlockers: string[];
  recipients: TransportRecipientDecision[];
  adapterCalls: 0;
  networkCalls: 0;
  externalWrites: 0;
  activationAllowed: false;
}

export function stagePausedTransportCampaign(rawInput: unknown): PausedTransportStageResult {
  const input = PausedTransportCampaignSchema.parse(rawInput);
  const campaignBlockers: string[] = [];
  if (input.requestedMode !== "PAUSED") campaignBlockers.push("TRANSPORT_MUST_BE_PAUSED");
  if (input.activationRequested) campaignBlockers.push("ACTIVATION_NOT_AUTHORIZED");
  if (input.openTracking || input.clickTracking) campaignBlockers.push("OPEN_CLICK_TRACKING_MUST_BE_DISABLED");
  if (!input.replyStopEnabled || !input.companyStopEnabled) campaignBlockers.push("REPLY_AND_COMPANY_STOP_REQUIRED");
  const emailCounts = new Map<string, number>();
  for (const recipient of input.recipients) {
    emailCounts.set(recipient.email, (emailCounts.get(recipient.email) ?? 0) + 1);
  }
  const recipients = input.recipients.map((recipient): TransportRecipientDecision => {
    const blockers: string[] = [];
    if (recipient.emailStatus !== "VALID") blockers.push("EMAIL_NOT_INDEPENDENT_VALID");
    if (recipient.dncMatch) blockers.push("DNC_MATCH");
    if (recipient.ownershipConflict) blockers.push("OWNERSHIP_CONFLICT");
    if (recipient.humanTakeover) blockers.push("HUMAN_TAKEOVER");
    if (!recipient.approved || !recipient.approvedReviewHash) blockers.push("MESSAGE_NOT_APPROVED");
    if (recipient.approvedReviewHash !== recipient.currentReviewHash) blockers.push("REVIEW_HASH_STALE");
    if (recipient.contentHash !== transportContentHash(recipient.subject, recipient.body)) {
      blockers.push("CONTENT_HASH_MISMATCH");
    }
    if ((emailCounts.get(recipient.email) ?? 0) > 1) blockers.push("DUPLICATE_RECIPIENT");
    return { recipientId: recipient.recipientId, staged: blockers.length === 0, blockers };
  });
  const status = campaignBlockers.length === 0 && recipients.some((item) => item.staged)
    ? "STAGED_PAUSED"
    : "BLOCKED";
  return {
    campaignId: input.campaignId,
    status,
    campaignBlockers,
    recipients,
    adapterCalls: 0,
    networkCalls: 0,
    externalWrites: 0,
    activationAllowed: false,
  };
}

export const TransportEventSchema = z.object({
  providerEventId: IdentifierSchema,
  recipientId: IdentifierSchema,
  eventType: z.enum([
    "SENT",
    "DELIVERED",
    "REPLY",
    "AUTO_REPLY",
    "BOUNCE",
    "UNSUBSCRIBE",
    "INTERESTED",
    "WRONG_PERSON",
    "ACCOUNT_ERROR",
    "UNKNOWN",
  ]),
  occurredAt: DateTimeSchema,
}).strict();

export interface TransportRecipientState {
  status: "STAGED_PAUSED" | "SENT" | "DELIVERED" | "STOPPED" | "BOUNCED" | "UNKNOWN_RECONCILIATION_REQUIRED";
  stoppedAt: string | null;
}

export interface TransportReconcileState {
  seenEventIds: string[];
  recipients: Record<string, TransportRecipientState>;
}

export interface TransportReconcileResult {
  state: TransportReconcileState;
  acceptedEvents: number;
  duplicateEvents: number;
  unmatchedEvents: number;
  stopLatencyMs: number[];
}

export function reconcileTransportEvents(
  stateInput: TransportReconcileState,
  eventsInput: unknown,
  receivedAt: string,
): TransportReconcileResult {
  const events = z.array(TransportEventSchema).max(10_000).parse(eventsInput);
  const state = structuredClone(stateInput);
  const seen = new Set(state.seenEventIds);
  let acceptedEvents = 0;
  let duplicateEvents = 0;
  let unmatchedEvents = 0;
  const stopLatencyMs: number[] = [];
  for (const event of events) {
    if (seen.has(event.providerEventId)) {
      duplicateEvents += 1;
      continue;
    }
    seen.add(event.providerEventId);
    const recipient = state.recipients[event.recipientId];
    if (!recipient) {
      unmatchedEvents += 1;
      continue;
    }
    acceptedEvents += 1;
    if (["REPLY", "AUTO_REPLY", "UNSUBSCRIBE", "INTERESTED", "WRONG_PERSON"].includes(event.eventType)) {
      recipient.status = "STOPPED";
      recipient.stoppedAt = receivedAt;
      stopLatencyMs.push(Math.max(0, Date.parse(receivedAt) - Date.parse(event.occurredAt)));
    } else if (event.eventType === "BOUNCE") {
      recipient.status = "BOUNCED";
    } else if (event.eventType === "SENT") {
      recipient.status = "SENT";
    } else if (event.eventType === "DELIVERED") {
      recipient.status = "DELIVERED";
    } else {
      recipient.status = "UNKNOWN_RECONCILIATION_REQUIRED";
    }
  }
  state.seenEventIds = [...seen].sort();
  return { state, acceptedEvents, duplicateEvents, unmatchedEvents, stopLatencyMs };
}

export function verifyTransportWebhook(input: {
  rawBody: Buffer;
  timestamp: string;
  signature: string;
  secret: string;
  now?: Date;
  replayWindowSeconds?: number;
}): boolean {
  if (!input.secret || !/^\d{10,13}$/.test(input.timestamp)) return false;
  const numeric = Number(input.timestamp);
  const timestampMs = input.timestamp.length === 10 ? numeric * 1_000 : numeric;
  if (!Number.isFinite(timestampMs)) return false;
  const windowMs = Math.max(1, input.replayWindowSeconds ?? 300) * 1_000;
  if (Math.abs((input.now ?? new Date()).getTime() - timestampMs) > windowMs) return false;
  const suppliedHex = input.signature.replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.`)
    .update(input.rawBody)
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
