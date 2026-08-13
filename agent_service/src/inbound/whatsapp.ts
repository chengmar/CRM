import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";
import { logger } from "../logger.js";
import { classifyInbound } from "./classifier.js";
import type { InboundProcessor } from "./processor.js";

interface WhatsAppWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string; payload?: string };
          interactive?: {
            button_reply?: { title?: string; id?: string };
            list_reply?: { title?: string; id?: string };
          };
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          errors?: unknown[];
        }>;
      };
    }>;
  }>;
}

export function verifyWhatsAppSignature(raw: Buffer, signature: string, secret: string): boolean {
  if (!secret || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function messageText(message: NonNullable<NonNullable<WhatsAppWebhookBody["entry"]>[number]["changes"]>[number]["value"] extends infer V
  ? V extends { messages?: Array<infer M> }
    ? M
    : never
  : never): string {
  const item = message as {
    text?: { body?: string };
    button?: { text?: string };
    interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  };
  return (
    item.text?.body ??
    item.button?.text ??
    item.interactive?.button_reply?.title ??
    item.interactive?.list_reply?.title ??
    ""
  );
}

export class WhatsAppInbound {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    private readonly processor: InboundProcessor,
  ) {}

  async register(app: FastifyInstance): Promise<void> {
    app.get("/webhooks/whatsapp", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      if (
        this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
        query["hub.mode"] === "subscribe" &&
        query["hub.verify_token"] === this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN
      ) {
        return reply.type("text/plain").send(query["hub.challenge"] ?? "");
      }
      return reply.code(403).send({ error: "verification failed" });
    });

    app.post(
      "/webhooks/whatsapp",
      { config: { rawBody: true } },
      async (request: FastifyRequest, reply) => {
        const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
        if (!this.config.WHATSAPP_APP_SECRET) {
          return reply.code(503).send({ error: "webhook signing secret is not configured" });
        }
        const signature = String(request.headers["x-hub-signature-256"] ?? "");
        if (!verifyWhatsAppSignature(raw, signature, this.config.WHATSAPP_APP_SECRET)) {
          return reply.code(401).send({ error: "invalid signature" });
        }
        const body = request.body as WhatsAppWebhookBody;
        this.db.enqueueJob("PROCESS_WHATSAPP_WEBHOOK", { body });
        return reply.code(200).send({ ok: true });
      },
    );
  }

  async processWebhook(body: WhatsAppWebhookBody): Promise<{ messages: number; statuses: number }> {
    let messages = 0;
    let statuses = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        for (const message of value.messages ?? []) {
          if (!message.id || !message.from) continue;
          const text = messageText(message);
          const match = this.db.findInboundMatch(message.from, message.from, { allowAddressFallback: true });
          const rawInput = {
            channel: "whatsapp" as const,
            providerId: message.id,
            threadId: message.from,
            fromAddress: message.from,
            toAddress: value.metadata?.phone_number_id ?? null,
            subject: "WhatsApp message",
            bodyText: text,
            receivedAt: new Date(Number(message.timestamp ?? 0) * 1000 || Date.now()).toISOString(),
            rawHeaders: { type: message.type },
            leadId: match?.leadId ?? null,
            contactId: match?.contactId ?? null,
            outboundMessageId: match?.outboundMessageId ?? null,
          };
          const prepared = this.processor.prepare(rawInput);
          const classification = await classifyInbound(
            {
              from: message.from,
              subject: "WhatsApp message",
              body: text,
              headers: {
                matchedInbound: true,
                messageType: message.type,
                hasNonTextContent: !text && Boolean(message.type && message.type !== "text"),
              },
            },
            this.llm,
            this.config,
          );
          await this.processor.process(
            {
              ...rawInput,
              classification: classification.classification,
              confidence: classification.confidence,
              reason: classification.reason,
            },
            classification,
            prepared,
          );
          messages += 1;
        }
        for (const status of value.statuses ?? []) {
          if (status.status === "failed" && status.id) {
            const match = this.db.findLeadByProviderReference(status.id);
            const classification = {
              classification: "BOUNCE" as const,
              confidence: 0.99,
              reason: `WhatsApp delivery failed: ${JSON.stringify(status.errors ?? [])}`,
              shouldNotify: false,
              shouldTakeover: false,
              shouldStopAutomation: true,
            };
            await this.processor.process(
              {
                channel: "whatsapp",
                providerId: `status:${status.id}:failed`,
                threadId: status.id,
                fromAddress: status.recipient_id ?? "",
                subject: "WhatsApp delivery failure",
                bodyText: classification.reason,
                receivedAt: new Date(Number(status.timestamp ?? 0) * 1000 || Date.now()).toISOString(),
                classification: classification.classification,
                confidence: classification.confidence,
                reason: classification.reason,
                leadId: match?.leadId ?? null,
                contactId: match?.contactId ?? null,
              },
              classification,
            );
          }
          statuses += 1;
        }
      }
    }
    logger.info({ messages, statuses }, "WhatsApp webhook processed");
    return { messages, statuses };
  }
}
