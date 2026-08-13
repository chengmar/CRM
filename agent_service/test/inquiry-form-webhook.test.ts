import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { InquiryFormWebhook } from "../src/inbound/form-webhook.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import type { AgentLlm } from "../src/llm.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const secret = "fixture-inquiry-secret";

function sign(raw: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "form-fixture-001",
    sender: "buyer@example.com",
    recipient: "sales@supplier.example",
    subject: "RFQ for sample products",
    body: "Please quote 2 units for 12 units and confirm MOQ.",
    receivedAt: new Date().toISOString(),
    consent: "TRANSACTIONAL",
    ...overrides,
  };
}

async function fixture(rateLimit = 30): Promise<{
  app: FastifyInstance;
  db: AgentDatabase;
  notifyQuarantinedIntake: ReturnType<typeof vi.fn>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inquiry-form-webhook-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  const notifyQuarantinedIntake = vi.fn(async () => undefined);
  const notifier: InquiryNotifier = {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
    notifyQuarantinedIntake,
  };
  const config = loadConfig({
    INQUIRY_FORM_WEBHOOK_ENABLED: "true",
    INQUIRY_FORM_HMAC_SECRET: secret,
    INQUIRY_WEBHOOK_RATE_LIMIT_PER_MINUTE: String(rateLimit),
  });
  const llm = { isConfigured: () => false } as unknown as AgentLlm;
  const processor = new InboundProcessor(config, db, notifier);
  const app = Fastify({ logger: false });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  await new InquiryFormWebhook(config, db, llm, processor).register(app);
  await app.ready();
  return { app, db, notifyQuarantinedIntake };
}

async function injectSigned(app: FastifyInstance, value: Record<string, unknown>, timestamp?: string) {
  const raw = JSON.stringify(value);
  const at = timestamp ?? String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/webhooks/inquiry/form",
    headers: {
      "content-type": "application/json",
      "x-inquiry-timestamp": at,
      "x-inquiry-signature": sign(raw, at),
    },
    payload: raw,
  });
}

describe("signed inquiry form webhook", () => {
  it("persists a valid unmatched RFQ once and never sends an automatic response", async () => {
    const { app, db, notifyQuarantinedIntake } = await fixture();
    const first = await injectSigned(app, payload());
    const replay = await injectSigned(app, payload());

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      ok: true,
      status: "QUARANTINED",
      duplicate: false,
      automaticResponseSent: false,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({
      inquiryIntakes: 1,
      quarantinedIntakes: 1,
      opportunities: 0,
    });
    expect(notifyQuarantinedIntake).toHaveBeenCalledOnce();
    await app.close();
    db.close();
  });

  it("rejects invalid and stale signatures before persistence", async () => {
    const { app, db } = await fixture();
    const raw = JSON.stringify(payload());
    const now = String(Math.floor(Date.now() / 1000));
    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/inquiry/form",
      headers: {
        "content-type": "application/json",
        "x-inquiry-timestamp": now,
        "x-inquiry-signature": `sha256=${"0".repeat(64)}`,
      },
      payload: raw,
    });
    const stale = await injectSigned(app, payload(), String(Math.floor(Date.now() / 1000) - 301));

    expect(invalid.statusCode).toBe(401);
    expect(stale.statusCode).toBe(401);
    expect(db.getAcquisitionFoundationSummary().inquiryIntakes).toBe(0);
    await app.close();
    db.close();
  });

  it("rejects strict-schema extras and request bodies over 100KB", async () => {
    const { app, db } = await fixture();
    const extra = await injectSigned(app, payload({ hidden: "not allowed" }));
    const oversized = await injectSigned(app, payload({ body: "x".repeat(100_001) }));

    expect(extra.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);
    expect(db.getAcquisitionFoundationSummary().inquiryIntakes).toBe(0);
    await app.close();
    db.close();
  });

  it("applies an in-memory per-source/IP rate limit before persistence", async () => {
    const { app, db } = await fixture(1);
    const first = await injectSigned(app, payload({ providerId: "rate-1" }));
    const second = await injectSigned(app, payload({ providerId: "rate-2" }));

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
    expect(db.getAcquisitionFoundationSummary().inquiryIntakes).toBe(1);
    await app.close();
    db.close();
  });
});
