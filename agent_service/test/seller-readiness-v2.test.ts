import { describe, expect, it } from "vitest";
import {
  SellerKnowledgeDocumentSchema,
  SellerKnowledgeStore,
  assessSellerReadiness,
  parseSellerKnowledgeDocument,
  type SellerKnowledgeDocument,
} from "../src/acquisition/seller-knowledge.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function sellerDocument(): SellerKnowledgeDocument {
  return SellerKnowledgeDocumentSchema.parse({
    schemaVersion: "seller-knowledge-v2",
    factSetId: "seller-facts-aurora",
    factSetVersion: 3,
    profile: {
      schemaVersion: "seller-profile-v2",
      id: "seller-aurora",
      version: 4,
      status: "APPROVED",
      legalNameEn: "Aurora manufacturing Ltd.",
      brandNameEn: "Aurora Example",
      website: "https://aurora-example.test",
      sender: {
        name: "Alex Chen",
        email: "alex@aurora-example.test",
        title: "Export Manager",
      },
      postalAddress: {
        line1: "18 Industry Road",
        city: "Nanjing",
        region: "Jiangsu",
        postalCode: "210000",
        country: "China",
      },
      unsubscribe: {
        method: "REPLY",
        instruction: "Reply unsubscribe to opt out of future messages.",
      },
      products: [{
        id: "product-sample-product",
        name: "Sample Product A",
        modelsOrSpecifications: ["Sample Model A with a documented capacity"],
        publicApproved: true,
      }],
      quoteBoundaries: {
        moq: "MOQ is confirmed manually for each configuration.",
        leadTime: "Lead time is confirmed after technical review.",
        pricing: "Pricing requires a human-issued written quotation.",
        payment: "Payment terms require commercial approval.",
        oem: "OEM scope requires engineering approval.",
        packaging: "Packaging is agreed in the written quotation.",
        installation: "Installation scope is not included unless quoted.",
        requiresHumanApproval: true,
      },
      prohibitedClaims: ["zero maintenance"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
    },
    facts: [{
      schemaVersion: "seller-fact-v2",
      id: "seller-fact-sample-product",
      profileId: "seller-aurora",
      factSetVersion: 3,
      subject: "Aurora Example",
      predicate: "product capability",
      value: "Sample Product A supports 12 units configurations.",
      unit: "kg",
      source: {
        type: "PRODUCT_SHEET",
        url: "https://aurora-example.test/products/sample-product",
        documentId: "datasheet-pj-120",
        contentHash: "a".repeat(64),
      },
      publicApproved: true,
      status: "ACTIVE",
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
      confidentiality: "PUBLIC",
      version: 2,
    }],
    offers: [{
      schemaVersion: "seller-offer-v2",
      id: "offer-checklist",
      profileId: "seller-aurora",
      profileVersion: 4,
      version: 2,
      productId: "product-sample-product",
      text: "We can share an approved application checklist for Sample Product A.",
      sellerFactIds: ["seller-fact-sample-product"],
      status: "ACTIVE",
      publicApproved: true,
      allowedMarkets: ["*"],
      allowedChannels: ["EMAIL"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
    }],
    privateCases: [{
      id: "private-case-delta",
      confidentiality: "INTERNAL_ONLY",
      customerName: "Confidential Delta sample requirement",
      location: "Secret Ridge",
      result: "Reduced sample requirement by 47 percent",
      metrics: ["47 percent reduction"],
      derivedApplicationTags: ["sample requirement", "sample requirement"],
    }],
  });
}

describe("seller readiness v2", () => {
  it("accepts a strict, versioned and fully approved seller profile", () => {
    const document = sellerDocument();
    expect(assessSellerReadiness(document, NOW)).toMatchObject({
      ready: true,
      profileId: "seller-aurora",
      profileVersion: 4,
      factSetVersion: 3,
      blockers: [],
    });
  });

  it.each([
    ["JSON" as const, "{bad-json", "SELLER_JSON_PARSE_FAILED"],
    ["YAML" as const, "profile: [unterminated", "SELLER_YAML_PARSE_FAILED"],
  ])("represents malformed %s explicitly and fails closed", (format, raw, code) => {
    const loaded = parseSellerKnowledgeDocument(raw, format, NOW);
    expect(loaded.parsed).toBe(false);
    expect(loaded.document).toBeNull();
    expect(loaded.readiness.ready).toBe(false);
    expect(loaded.readiness.blockers.join("\n")).toContain(code);
  });

  it("fails closed for missing fields and strict-schema extras", () => {
    const missing = structuredClone(sellerDocument()) as Record<string, unknown>;
    const profile = missing.profile as Record<string, unknown>;
    delete profile.sender;
    profile.unreviewedClaim = "fastest on earth";
    const result = assessSellerReadiness(missing, NOW);
    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toMatch(/sender|Unrecognized key/i);
  });

  it.each([
    ["placeholder", (document: SellerKnowledgeDocument) => { document.profile.brandNameEn = "Your Brand"; }, "SELLER_PLACEHOLDER"],
    ["stale fact", (document: SellerKnowledgeDocument) => { document.facts[0]!.validTo = "2026-07-19T00:00:00.000Z"; }, "SELLER_FACT_STALE"],
    ["unapproved public fact", (document: SellerKnowledgeDocument) => { document.facts[0]!.publicApproved = false; }, "SELLER_PUBLIC_FACT_NOT_APPROVED"],
    ["missing quote boundary", (document: SellerKnowledgeDocument) => { delete (document.profile.quoteBoundaries as Partial<typeof document.profile.quoteBoundaries>).pricing; }, "quoteBoundaries.pricing"],
    ["consumer sender", (document: SellerKnowledgeDocument) => { document.profile.sender.email = "sales@gmail.com"; }, "SELLER_SENDER_POLICY_INVALID"],
  ])("readiness=false for %s", (_label, mutate, expected) => {
    const document = sellerDocument();
    mutate(document);
    const result = assessSellerReadiness(document, NOW);
    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toContain(expected);
  });

  it("never exposes private cases through the planner-facing seller context", () => {
    const store = new SellerKnowledgeStore(sellerDocument(), NOW);
    const context = store.getPublicPlanningContext("Malaysia", "EMAIL", NOW);
    expect(context).not.toBeNull();
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("Confidential Delta sample requirement");
    expect(serialized).not.toContain("Secret Ridge");
    expect(serialized).not.toContain("47 percent");
    expect(store.privateLeakageCaseIds("Draft for Confidential Delta sample requirement")).toEqual([
      "private-case-delta",
    ]);
  });
});
