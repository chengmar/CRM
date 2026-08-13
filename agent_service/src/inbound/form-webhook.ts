import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";
import { FormInboundIntakeAdapter } from "./adapters/form-intake.js";
import { verifyInquiryWebhook } from "./intake.js";
import { classifyInbound } from "./classifier.js";
import type { InboundProcessor } from "./processor.js";

interface RateWindow {
  startedAt: number;
  count: number;
}

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  allow(key: string, now: number, limit: number): boolean {
    const windowMs = 60_000;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    if (this.windows.size > 10_000) {
      for (const [candidate, value] of this.windows) {
        if (now - value.startedAt >= windowMs) this.windows.delete(candidate);
      }
    }
    return current.count <= Math.max(1, limit);
  }
}

export class InquiryFormWebhook {
  private readonly adapter = new FormInboundIntakeAdapter();
  private readonly limiter = new FixedWindowRateLimiter();

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    private readonly processor: InboundProcessor,
  ) {}

  async register(app: FastifyInstance): Promise<void> {
    app.post(
      "/webhooks/inquiry/:source",
      { bodyLimit: 100_000, config: { rawBody: true } },
      async (request: FastifyRequest, reply) => {
        const source = String((request.params as { source?: string }).source ?? "").toLowerCase();
        if (source !== "form") return reply.code(404).send({ error: "unsupported source" });
        if (!this.config.INQUIRY_FORM_WEBHOOK_ENABLED) {
          return reply.code(404).send({ error: "inquiry webhook is disabled" });
        }
        if (!this.config.INQUIRY_FORM_HMAC_SECRET) {
          return reply.code(503).send({ error: "inquiry webhook signing is not configured" });
        }
        if (!this.limiter.allow(
          `${source}:${request.ip}`,
          Date.now(),
          this.config.INQUIRY_WEBHOOK_RATE_LIMIT_PER_MINUTE,
        )) {
          return reply.header("retry-after", "60").code(429).send({ error: "rate limit exceeded" });
        }

        const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
        if (!raw) return reply.code(400).send({ error: "raw request body is required" });
        const signature = String(request.headers["x-inquiry-signature"] ?? "");
        const timestamp = String(request.headers["x-inquiry-timestamp"] ?? "");
        if (!verifyInquiryWebhook({
          rawBody: raw,
          signature,
          timestamp,
          secret: this.config.INQUIRY_FORM_HMAC_SECRET,
          replayWindowSeconds: this.config.INQUIRY_WEBHOOK_REPLAY_WINDOW_SECONDS,
        })) {
          return reply.code(401).send({ error: "invalid or expired signature" });
        }

        try {
          const normalized = await this.adapter.normalize(request.body);
          const rawInput = {
            channel: "form" as const,
            providerId: normalized.providerId,
            fromAddress: normalized.sender,
            toAddress: normalized.recipient,
            subject: normalized.subject,
            bodyText: normalized.body,
            receivedAt: normalized.receivedAt,
            rawHeaders: {
              locale: normalized.locale,
              consent: normalized.consent,
              sourceAssetId: normalized.sourceAssetId,
              referrer: normalized.referrer,
              attachments: normalized.attachments,
            },
          };
          const prepared = this.processor.prepare(rawInput);
          const decision = await classifyInbound(
            {
              from: normalized.sender,
              subject: normalized.subject,
              body: normalized.body,
              headers: { matchedInbound: Boolean(prepared.match), source: "WEB_FORM" },
            },
            this.llm,
            this.config,
          );
          const result = await this.processor.process({
            ...rawInput,
            classification: decision.classification,
            confidence: decision.confidence,
            reason: decision.reason,
          }, decision, prepared);
          return reply.code(202).send({
            ok: true,
            intakeId: result.intakeId,
            status: result.quarantined ? "QUARANTINED" : "PROCESSED",
            duplicate: !prepared.intakeInserted,
            automaticResponseSent: false,
          });
        } catch {
          return reply.code(400).send({ error: "invalid inquiry payload" });
        }
      },
    );
  }
}
