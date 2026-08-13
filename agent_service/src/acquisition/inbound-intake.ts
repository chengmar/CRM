import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const inboundSourceSchema = z.enum([
  "EMAIL",
  "WHATSAPP",
  "FORM",
  "FORWARDED",
  "REFERRAL",
]);

const boundedText = (maximum: number) => z.string().trim().max(maximum);

export const normalizedInboundIntakeSchema = z.object({
  source: inboundSourceSchema,
  providerId: boundedText(500).min(1),
  sender: boundedText(500).min(1),
  recipient: boundedText(500).min(1),
  subject: boundedText(500).default(""),
  body: z.string().max(100_000),
  receivedAt: z.string().datetime({ offset: true }),
  locale: boundedText(32).nullable().default(null),
  consent: z.enum(["OPT_IN", "TRANSACTIONAL", "UNKNOWN", "WITHDRAWN"]).default("UNKNOWN"),
  sourceAssetId: boundedText(500).nullable().default(null),
  referrer: boundedText(2_000).nullable().default(null),
  attachments: z.array(z.object({
    filename: boundedText(255),
    contentType: boundedText(255),
    sizeBytes: z.number().int().nonnegative().max(25_000_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable().default(null),
  }).strict()).max(20).default([]),
}).strict();

export type NormalizedInboundIntake = z.infer<typeof normalizedInboundIntakeSchema> & {
  idempotencyKey: string;
  contentHash: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeInboundIntake(input: unknown): NormalizedInboundIntake {
  const parsed = normalizedInboundIntakeSchema.parse(input);
  const normalized = {
    ...parsed,
    sender: parsed.sender.toLowerCase(),
    recipient: parsed.recipient.toLowerCase(),
    body: parsed.body.replace(/\r\n?/g, "\n"),
  };
  const contentHash = sha256(JSON.stringify({
    source: normalized.source,
    sender: normalized.sender,
    recipient: normalized.recipient,
    subject: normalized.subject,
    body: normalized.body,
  }));
  return {
    ...normalized,
    idempotencyKey: `${normalized.source.toLowerCase()}:${sha256(normalized.providerId).slice(0, 32)}`,
    contentHash,
  };
}

export interface InquiryWebhookVerificationInput {
  rawBody: Buffer;
  signature: string;
  timestamp: string;
  secret: string;
  now?: Date;
  replayWindowSeconds?: number;
}

export function verifyInquiryWebhook(input: InquiryWebhookVerificationInput): boolean {
  if (!input.secret || !/^\d{10,13}$/.test(input.timestamp)) return false;
  const timestampNumber = Number(input.timestamp);
  const timestampMs = input.timestamp.length === 10 ? timestampNumber * 1_000 : timestampNumber;
  if (!Number.isFinite(timestampMs)) return false;
  const nowMs = (input.now ?? new Date()).getTime();
  const replayWindowMs = Math.max(1, input.replayWindowSeconds ?? 300) * 1_000;
  if (Math.abs(nowMs - timestampMs) > replayWindowMs) return false;

  const suppliedHex = input.signature.trim().replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.`)
    .update(input.rawBody)
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
