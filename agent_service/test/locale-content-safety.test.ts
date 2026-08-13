import { describe, expect, it } from "vitest";
import {
  ApprovedClaimSchema,
  HighIntentContentPackageDraftSchema,
  createHighIntentContentPackageDraft,
  evaluateApprovedClaimForExternalUse,
  type ApprovedClaim,
  type HighIntentContentCandidate,
} from "../src/acquisition/content-safety.js";
import {
  LocalePackSchema,
  TranslationSchema,
  createMachineTranslationDraft,
  evaluateLocalePackForUse,
  validateTranslationSafety,
  type LocalePack,
  type Translation,
} from "../src/acquisition/locale-safety.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function localePack(): LocalePack {
  return LocalePackSchema.parse({
    schemaVersion: "locale-pack-v1",
    id: "locale-de-sample-product",
    sourceLocale: "en",
    locale: "de-DE",
    market: "Germany",
    version: 3,
    status: "APPROVED",
    technicalTerms: [{
      conceptId: "performance",
      sourceTerm: "performance",
      localizedTerm: "Leistung",
      doNotTranslate: false,
    }],
    productNames: [{
      productId: "sample-product",
      approvedSourceName: "Sample Product A",
      approvedLocalizedName: "Beispielprodukt A",
    }],
    approvedVocabulary: {
      product: "Produkt",
      model: "Modell",
      specification: "Spezifikation",
      quantity: "Menge",
      delivery: "Lieferung",
    },
    metricUnits: [{ symbol: "kg", localizedDisplay: "kg" }],
    forbiddenLiteralTranslations: [{
      sourceText: "Sample Product A",
      forbiddenText: "Nicht genehmigtes Produkt",
      approvedAlternative: "Beispielprodukt A",
    }],
    sourceNegationMarkers: ["not", "no", "never", "without", "cannot"],
    targetNegationMarkers: ["nicht", "kein", "nie", "ohne"],
    style: {
      salutation: "Guten Tag",
      tone: "DIRECT_TECHNICAL",
      subjectGuidance: "Use a factual technical subject.",
      ctaGuidance: "Ask one specific technical question.",
    },
    businessCalendar: {
      timeZone: "Europe/Berlin",
      workingDays: [1, 2, 3, 4, 5],
      businessHours: { start: "09:00", end: "17:00" },
    },
    legal: {
      unsubscribeRequired: true,
      unsubscribeText: "Antworten Sie mit Abmelden, wenn Sie keine weiteren Nachrichten wünschen.",
      requirements: ["Impressum and sender identity require human review."],
    },
    reviewer: {
      id: "reviewer-lena",
      name: "Lena Fischer",
      role: "LOCALIZATION_REVIEWER",
      human: true,
    },
    reviewedAt: "2026-07-01T00:00:00.000Z",
    approvedAt: "2026-07-02T00:00:00.000Z",
    validFrom: "2026-07-02T00:00:00.000Z",
    validTo: "2027-07-02T00:00:00.000Z",
    revokedAt: null,
  });
}

function translation(): Translation {
  return createMachineTranslationDraft({
    id: "translation-performance-de",
    sourceLocale: "en",
    targetLocale: "de-DE",
    localePackId: "locale-de-sample-product",
    localePackVersion: 3,
    sourceText: "The product is not CE marked. ISO 9001:2015 applies at 12 kg.",
    translatedText: "Das Produkt ist nicht CE-markiert. ISO 9001:2015 gilt fuer 12 kg.",
    approvedClaimIds: ["claim-performance"],
    negationBindings: [{
      id: "negation-ce",
      sourceFragment: "The product is not CE marked",
      translatedFragment: "Das Produkt ist nicht CE-markiert",
      meaning: "NEGATED",
    }],
    createdAt: NOW,
  });
}

function claim(): ApprovedClaim {
  return ApprovedClaimSchema.parse({
    schemaVersion: "approved-claim-v1",
    id: "claim-performance",
    version: 4,
    claimType: "PRODUCT_PARAMETER",
    statement: "Dokumentiertes Gewicht: 12 kg.",
    locale: "de-DE",
    source: {
      documentId: "datasheet-pj-120",
      contentHash: "a".repeat(64),
      sourceUrl: "https://seller.example.test/sample-product",
      sourceType: "PRODUCT_SHEET",
    },
    visibility: "PUBLIC",
    casePermission: "NOT_APPLICABLE",
    allowedMarkets: ["Germany"],
    allowedChannels: ["WEBSITE", "EMAIL"],
    status: "APPROVED",
    approvedBy: {
      id: "engineer-1",
      name: "Engineering Reviewer",
      role: "ENGINEERING",
      human: true,
    },
    approvedAt: "2026-07-01T00:00:00.000Z",
    validFrom: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-07-01T00:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    createdAt: "2026-06-20T00:00:00.000Z",
  });
}

function candidate(): HighIntentContentCandidate {
  const claimBlock = {
    kind: "APPROVED_CLAIM" as const,
    claimId: "claim-performance",
    claimVersion: 4,
    statement: "Dokumentiertes Gewicht: 12 kg.",
  };
  return {
    id: "content-rfq-de",
    assetType: "RFQ_CHECKLIST",
    market: "Germany",
    locale: "de-DE",
    localePackId: "locale-de-sample-product",
    localePackVersion: 3,
    title: "RFQ-Checkliste fuer Beispielprodukte",
    slugSuggestion: "rfq-checkliste-beispielprodukte",
    searchIntent: "HIGH_INTENT",
    audience: "Technische Einkäufer und Projektingenieure",
    productFamily: "Beispielprodukt A",
    application: "Beispielanwendung",
    requiredBuyerInputs: [
      "PERFORMANCE_REQUIREMENT",
      "PRODUCT_REQUIREMENT",
      "OPERATING_TEMPERATURE",
      "OPERATING_HUMIDITY",
      "MATERIAL_COMPATIBILITY",
      "SAFETY_REQUIREMENT",
      "UTILITY_REQUIREMENT",
      "INSTALLATION_CONSTRAINT",
      "QUANTITY",
    ],
    sections: [{
      id: "selection-boundary",
      heading: "Technischer Ausgangspunkt",
      blocks: [
        { kind: "COPY", text: "Erfassen Sie zuerst Anwendung und Prozessbedingungen." },
        claimBlock,
      ],
    }],
    faqDraft: [{
      id: "faq-performance",
      question: "Welche Auslegungsangabe ist freigegeben?",
      answerBlocks: [claimBlock],
    }],
    seoDraft: {
      titleSuggestion: "RFQ-Checkliste fuer Beispielprodukte",
      descriptionSuggestion: "Strukturierter Entwurf für technische Anfragedaten.",
      canonicalPathSuggestion: "/de/rfq-checkliste-beispielprodukte",
      hreflangSuggestions: [{ locale: "de-DE", pathSuggestion: "/de/rfq-checkliste-beispielprodukte" }],
    },
    jsonLdDraft: {
      status: "DRAFT",
      context: "https://schema.org",
      organization: {
        type: "Organization",
        name: "Aurora manufacturing Ltd.",
        urlSuggestion: "https://seller.example.test",
      },
      product: {
        type: "Product",
        name: "Beispielprodukt A",
        descriptionBlocks: [claimBlock],
      },
      faqPage: { type: "FAQPage", faqIds: ["faq-performance"] },
    },
    generationMode: "MODEL",
  };
}

const PRIVATE_CASE = {
  id: "private-delta",
  confidentiality: "INTERNAL_ONLY" as const,
  customerName: "Confidential Delta sample requirement",
  location: "Secret Ridge",
  result: "Reduced sample requirement by 47 percent",
  metrics: ["47 percent reduction"],
  derivedApplicationTags: ["sample requirement"],
};

describe("locale pack and translation safety", () => {
  it("requires strict versioned, human-reviewed locale packs", () => {
    expect(evaluateLocalePackForUse({
      pack: localePack(),
      market: "Germany",
      locale: "de-DE",
      now: NOW,
    }).eligible).toBe(true);

    const missingReviewer = { ...localePack(), reviewer: null };
    expect(LocalePackSchema.safeParse(missingReviewer).success).toBe(false);
    expect(LocalePackSchema.safeParse({ ...localePack(), unexpected: true }).success).toBe(false);
  });

  it("keeps every machine-produced translation in DRAFT", () => {
    const draft = translation();
    expect(draft.status).toBe("DRAFT");
    expect(TranslationSchema.safeParse({
      ...draft,
      status: "APPROVED",
      reviewer: {
        id: "reviewer-lena",
        name: "Lena Fischer",
        role: "LOCALIZATION_REVIEWER",
        human: true,
      },
      reviewedAt: NOW.toISOString(),
      approvedAt: NOW.toISOString(),
    }).success).toBe(false);
  });

  it("accepts a draft only when protected meaning remains intact", () => {
    const result = validateTranslationSafety({
      translation: translation(),
      localePack: localePack(),
      market: "Germany",
      now: NOW,
    });
    expect(result).toMatchObject({ passed: true, status: "DRAFT", blockers: [] });
  });

  it.each([
    ["number", "15 kg", "TRANSLATION_NUMBER_CHANGED"],
    ["unit", "12 mm", "TRANSLATION_UNIT_CHANGED"],
    ["certification", "ISO 14001:2015 gilt fuer 12 kg", "TRANSLATION_CERTIFICATION_CHANGED"],
  ])("rejects a changed %s", (_label, replacement, blocker) => {
    const value = translation();
    if (_label === "certification") {
      value.translatedText = value.translatedText.replace("ISO 9001:2015 gilt fuer 12 kg", replacement);
    } else {
      value.translatedText = value.translatedText.replace("12 kg", replacement);
    }
    const result = validateTranslationSafety({
      translation: value,
      localePack: localePack(),
      market: "Germany",
      now: NOW,
    });
    expect(result.passed).toBe(false);
    expect(result.blockers.join("\n")).toContain(blocker);
  });

  it("rejects removed or unbound negation", () => {
    const value = translation();
    value.translatedText = value.translatedText.replace("nicht ", "");
    value.negationBindings[0]!.translatedFragment = "Das Produkt ist CE-markiert";
    const result = validateTranslationSafety({
      translation: value,
      localePack: localePack(),
      market: "Germany",
      now: NOW,
    });
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("TRANSLATION_NEGATION_CHANGED");
  });
});

describe("approved claim and content package safety", () => {
  it("allows only approved, public, in-scope and current claims", () => {
    expect(evaluateApprovedClaimForExternalUse({
      claim: claim(),
      market: "Germany",
      channel: "WEBSITE",
      locale: "de-DE",
      now: NOW,
    })).toMatchObject({ eligible: true, blockers: [] });
  });

  it.each([
    ["unapproved", (value: ApprovedClaim) => { value.status = "DRAFT"; }, "CLAIM_NOT_APPROVED"],
    ["private", (value: ApprovedClaim) => { value.visibility = "PRIVATE"; }, "CLAIM_NOT_PUBLIC"],
    ["expired", (value: ApprovedClaim) => { value.expiresAt = "2026-07-19T00:00:00.000Z"; }, "CLAIM_EXPIRED"],
    ["wrong market", (value: ApprovedClaim) => { value.allowedMarkets = ["France"]; }, "CLAIM_MARKET_NOT_ALLOWED"],
    ["wrong channel", (value: ApprovedClaim) => { value.allowedChannels = ["EMAIL"]; }, "CLAIM_CHANNEL_NOT_ALLOWED"],
  ])("rejects an %s claim", (_label, mutate, blocker) => {
    const value = claim();
    mutate(value);
    const result = evaluateApprovedClaimForExternalUse({
      claim: value,
      market: "Germany",
      channel: "WEBSITE",
      locale: "de-DE",
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it("rejects a revoked claim even when approval metadata is retained", () => {
    const value = claim();
    value.status = "REVOKED";
    value.revokedAt = "2026-07-19T00:00:00.000Z";
    value.revokedBy = {
      id: "compliance-1",
      name: "Compliance Reviewer",
      role: "COMPLIANCE",
      human: true,
    };
    const result = evaluateApprovedClaimForExternalUse({
      claim: value,
      market: "Germany",
      channel: "WEBSITE",
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("CLAIM_REVOKED");
  });

  it("creates a structured package that is always a non-published DRAFT", () => {
    const result = createHighIntentContentPackageDraft({
      candidate: candidate(),
      localePack: localePack(),
      claims: [claim()],
      privateCases: [PRIVATE_CASE],
      now: NOW,
    });
    expect(result).toMatchObject({ accepted: true, status: "DRAFT", blockers: [] });
    expect(result.draft).toMatchObject({
      status: "DRAFT",
      publicationState: "NOT_PUBLISHED",
      externalReady: false,
      publishedUrl: null,
      publishedAt: null,
      reviewChecklist: { humanPublishAuthorization: false },
    });
    expect(HighIntentContentPackageDraftSchema.safeParse({
      ...result.draft,
      publicationState: "PUBLISHED",
    }).success).toBe(false);
  });

  it.each([
    ["unapproved", (value: ApprovedClaim) => { value.status = "DRAFT"; }, "CONTENT_CLAIM_NOT_APPROVED"],
    ["private", (value: ApprovedClaim) => { value.visibility = "PRIVATE"; }, "CONTENT_CLAIM_NOT_PUBLIC"],
    ["expired", (value: ApprovedClaim) => { value.expiresAt = "2026-07-19T00:00:00.000Z"; }, "CONTENT_CLAIM_EXPIRED"],
  ])("keeps an %s claim out of external content", (_label, mutate, blocker) => {
    const value = claim();
    mutate(value);
    const result = createHighIntentContentPackageDraft({
      candidate: candidate(),
      localePack: localePack(),
      claims: [value],
      privateCases: [PRIVATE_CASE],
      now: NOW,
    });
    expect(result.accepted).toBe(false);
    expect(result.blockers.join("\n")).toContain(blocker);
  });

  it("blocks known private-case material even when placed in ordinary copy", () => {
    const value = candidate();
    value.sections[0]!.blocks.unshift({
      kind: "COPY",
      text: "Confidential Delta sample requirement is the reference for this application.",
    });
    const result = createHighIntentContentPackageDraft({
      candidate: value,
      localePack: localePack(),
      claims: [claim()],
      privateCases: [PRIVATE_CASE],
      now: NOW,
    });
    expect(result.accepted).toBe(false);
    expect(result.blockers).toContain("CONTENT_PRIVATE_CASE_LEAKAGE:private-delta");
  });

  it("requires protected numbers, units and certifications to be claim blocks", () => {
    const value = candidate();
    value.sections[0]!.blocks.unshift({ kind: "COPY", text: "Supports ISO 9001 at 15 kg." });
    const result = createHighIntentContentPackageDraft({
      candidate: value,
      localePack: localePack(),
      claims: [claim()],
      privateCases: [PRIVATE_CASE],
      now: NOW,
    });
    expect(result.accepted).toBe(false);
    expect(result.blockers).toContain("CONTENT_UNBOUND_NUMBER_UNIT_OR_CERTIFICATION");
  });
});
