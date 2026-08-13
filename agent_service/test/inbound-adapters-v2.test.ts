import { describe, expect, it } from "vitest";
import { EmailInboundIntakeAdapter } from "../src/inbound/adapters/email-intake.js";
import { FormInboundIntakeAdapter } from "../src/inbound/adapters/form-intake.js";
import { DeterministicProductInquiryExtractor } from "../src/inbound/product-extractor.js";
import { DeterministicInquiryQualificationPolicy } from "../src/inbound/qualification.js";

const base = {
  providerId: "fixture-001",
  sender: " Buyer@Example.COM ",
  recipient: "sales@supplier.example",
  subject: "RFQ for sample products",
  body: "Please quote 2 units for 12 units. What are your MOQ and lead time?",
  receivedAt: "2026-07-20T02:00:00.000Z",
  locale: "en-MY",
  consent: "TRANSACTIONAL" as const,
  sourceAssetId: null,
  referrer: null,
  attachments: [],
};

describe("WO-09 inbound adapter contracts", () => {
  it("normalizes email before extraction and routes a commercial request to P1", async () => {
    const intake = await new EmailInboundIntakeAdapter().normalize(base);
    const extraction = await new DeterministicProductInquiryExtractor().extract({
      subject: intake.subject,
      body: intake.body,
      locale: intake.locale ?? undefined,
    });
    const decision = new DeterministicInquiryQualificationPolicy().evaluate(intake, extraction);

    expect(intake).toMatchObject({ source: "EMAIL", sender: "buyer@example.com" });
    expect(intake.idempotencyKey).toMatch(/^email:[a-f0-9]{32}$/);
    expect(extraction.commercialQuestionFields).toEqual(expect.arrayContaining([
      "PRICE_OR_QUOTE",
      "QUANTITY",
      "MOQ",
      "LEAD_TIME",
    ]));
    expect(decision).toMatchObject({ classification: "P1_INQUIRY", shouldTakeover: true });
  });

  it("keeps form and email provider namespaces distinct", async () => {
    const email = await new EmailInboundIntakeAdapter().normalize(base);
    const form = await new FormInboundIntakeAdapter().normalize(base);
    expect(form.source).toBe("FORM");
    expect(form.idempotencyKey).not.toBe(email.idempotencyKey);
  });

  it("rejects unknown or oversized input fields", async () => {
    await expect(new FormInboundIntakeAdapter().normalize({ ...base, hidden: "value" }))
      .rejects.toThrow();
    await expect(new FormInboundIntakeAdapter().normalize({ ...base, body: "x".repeat(100_001) }))
      .rejects.toThrow();
  });
});
