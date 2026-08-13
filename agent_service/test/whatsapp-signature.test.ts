import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWhatsAppSignature } from "../src/inbound/whatsapp.js";

describe("WhatsApp webhook signature", () => {
  it("accepts the exact Meta HMAC signature", () => {
    const raw = Buffer.from('{"entry":[]}');
    const secret = "test-app-secret";
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(raw, signature, secret)).toBe(true);
  });

  it("rejects missing, malformed, or tampered signatures", () => {
    const raw = Buffer.from('{"entry":[]}');
    expect(verifyWhatsAppSignature(raw, "", "secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, "sha1=deadbeef", "secret")).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from("tampered"), "sha256=deadbeef", "secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, "sha256=deadbeef", "")).toBe(false);
  });
});
