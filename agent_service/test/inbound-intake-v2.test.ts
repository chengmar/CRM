import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeInboundIntake,
  verifyInquiryWebhook,
} from "../src/acquisition/inbound-intake.js";

describe("WO-09/WO-18 normalized inbound intake", () => {
  it("normalizes a bounded intake and derives stable non-plaintext idempotency keys", () => {
    const input = {
      source: "FORM",
      providerId: "submission-sensitive-123",
      sender: " Buyer@Example.com ",
      recipient: "Sales@CRM.Example",
      subject: " RFQ ",
      body: "Please quote 10 sets.\r\nQuantity 10 units.",
      receivedAt: "2026-07-20T02:00:00.000Z",
    };
    const first = normalizeInboundIntake(input);
    const second = normalizeInboundIntake(input);

    expect(first).toMatchObject({
      sender: "buyer@example.com",
      recipient: "sales@crm.example",
      body: "Please quote 10 sets.\nQuantity 10 units.",
    });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).not.toContain(input.providerId);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown fields, oversized bodies, and executable attachment content", () => {
    const base = {
      source: "EMAIL",
      providerId: "message-1",
      sender: "buyer@example.com",
      recipient: "sales@example.com",
      subject: "RFQ",
      body: "Please quote",
      receivedAt: "2026-07-20T02:00:00.000Z",
    };
    expect(() => normalizeInboundIntake({ ...base, unexpected: "data" })).toThrow();
    expect(() => normalizeInboundIntake({ ...base, body: "x".repeat(100_001) })).toThrow();
    expect(() => normalizeInboundIntake({
      ...base,
      attachments: [{
        filename: "drawing.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        contentHash: null,
        content: "not allowed",
      }],
    })).toThrow();
  });

  it("validates HMAC, body integrity, and replay window without exposing the secret", () => {
    const rawBody = Buffer.from('{"providerId":"form-1"}');
    const secret = "fixture-secret-never-logged";
    const timestamp = "1784512800000";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex");
    const input = {
      rawBody,
      signature: `sha256=${signature}`,
      timestamp,
      secret,
      now: new Date("2026-07-20T02:00:00.000Z"),
    };

    expect(verifyInquiryWebhook(input)).toBe(true);
    expect(verifyInquiryWebhook({ ...input, rawBody: Buffer.from("tampered") })).toBe(false);
    expect(verifyInquiryWebhook({ ...input, now: new Date("2026-07-20T02:10:01.000Z") })).toBe(false);
  });
});
