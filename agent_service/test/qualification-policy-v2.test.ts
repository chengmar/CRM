import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_POLICY_VERSION,
  type EvidenceFact,
  type QualificationInput,
} from "../src/acquisition/models.js";
import {
  evaluateQualification,
  lintIcpFitLanguage,
} from "../src/acquisition/qualification.js";

const asOf = "2026-07-20T00:00:00.000Z";

function fact(overrides: Partial<EvidenceFact> & Pick<EvidenceFact, "id" | "claimType">): EvidenceFact {
  return {
    id: overrides.id,
    subjectEntityId: "account-1",
    claimType: overrides.claimType,
    signalType: null,
    publisherDomain: "buyer.example.com",
    independenceKey: `document-${overrides.id}`,
    originalDocumentKey: null,
    authorityClass: "T1_COMPANY_OFFICIAL",
    authorityAllowlisted: false,
    sourceKind: "OFFICIAL_WEBSITE",
    subjectRole: "BUYER",
    exactQuote: "Buyer Engineering operates sample product application systems.",
    entityBound: true,
    effectiveAt: null,
    observedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    status: "CURRENT",
    confidence: 0.95,
    humanReview: "UNREVIEWED",
    allowedQualificationUses: [],
    allowedForOutreach: true,
    ...overrides,
  };
}

function baseInput(): QualificationInput {
  const identity = fact({
    id: "fact-identity",
    claimType: "ACCOUNT_IDENTITY",
    allowedQualificationUses: ["ICP_IDENTITY"],
  });
  const scenario = fact({
    id: "fact-scenario",
    claimType: "BUSINESS_SCENARIO",
    allowedQualificationUses: ["ICP_BUSINESS_SCENARIO"],
  });
  const buyerType = fact({
    id: "fact-buyer-type",
    claimType: "BUYER_TYPE",
    publisherDomain: "industry-association.example.org",
    independenceKey: "association-member-record",
    authorityClass: "OTHER",
    sourceKind: "PUBLIC_WEB",
    allowedQualificationUses: ["ICP_BUYER_TYPE"],
  });

  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    asOf,
    rankScore: 12,
    account: {
      id: "account-1",
      buyerType: "END_USER_FACTORY",
      officialDomains: ["buyer.example.com"],
      identityVerified: true,
      identityFactIds: [identity.id],
      businessScenarioVerified: true,
      businessScenarioFactIds: [scenario.id],
      buyerTypeMatchesPlay: true,
      buyerTypeFactIds: [buyerType.id],
      dncMatch: false,
      excluded: false,
      ownershipConflict: false,
    },
    contact: {
      id: "contact-1",
      accountId: "account-1",
      name: "Jane Tan",
      named: true,
      title: "Plant Engineering Manager",
      roleFamily: "TECHNICAL_ENGINEERING",
      seniority: "MANAGER",
      employment: {
        accountId: "account-1",
        status: "CURRENT",
        observedAt: "2026-07-10T00:00:00.000Z",
        expiresAt: "2026-09-30T00:00:00.000Z",
        confidence: 0.95,
        assertionIds: ["employment-1"],
        conflict: false,
      },
      email: {
        address: "jane@buyer.example.com",
        status: "VALID",
        workEmail: true,
        roleAddress: false,
        disposable: false,
        catchAll: false,
        domainMatchesAccount: true,
        discoverySourceKey: "public-contact-page",
        verifierSourceKey: "independent-verifier",
        independentlyVerified: true,
        observedAt: "2026-07-15T00:00:00.000Z",
        expiresAt: "2026-08-10T00:00:00.000Z",
        confidence: 0.98,
        assertionIds: ["email-verification-1"],
        conflict: false,
      },
      evidenceConfidence: 0.94,
      lastEvidenceAt: "2026-07-15T00:00:00.000Z",
      dncMatch: false,
      excluded: false,
      ownershipConflict: false,
      conflicts: [],
    },
    evidenceFacts: [identity, scenario, buyerType],
    seller: {
      sellerContextId: "seller-context-v1",
      sellerContextApproved: true,
      offerId: "offer-assessment-v1",
      offerApproved: true,
    },
    message: {
      draftText: "Your published process profile appears relevant to sample application. Would you be the right person to assess product specification fit?",
      grounded: true,
      citedFactIds: [scenario.id],
      unsupportedFactIds: [],
    },
  };
}

function activeFact(overrides: Partial<EvidenceFact> = {}): EvidenceFact {
  return fact({
    id: "fact-active",
    claimType: "ACTIVE_INTENT",
    signalType: "TENDER",
    exactQuote: "Buyer Engineering invites bids for a new sample product systems.",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    allowedQualificationUses: ["ACTIVE_INTENT"],
    ...overrides,
  });
}

describe("qualification-policy-v2", () => {
  it("admits a fully evidenced account without public purchase intent only to ICP_FIT", () => {
    const decision = evaluateQualification(baseInput());

    expect(decision).toMatchObject({
      track: "ICP_FIT",
      policyVersion: QUALIFICATION_POLICY_VERSION,
      eligible: true,
      blockers: [],
      rankScore: 12,
      requiredReviewPolicy: "REVIEW_ALL",
      whyNowFactIds: [],
      whyContactAssertionIds: ["employment-1"],
    });
    expect(decision.independentPublisherKeys).toHaveLength(2);
    expect(decision.laneBlockers.activeIntent.map((item) => item.code)).toContain("ACTIVE_INTENT_MISSING");
  });

  it("uses rank score only for ordering and never as an eligibility override", () => {
    const lowScore = baseInput();
    lowScore.rankScore = 0;
    expect(evaluateQualification(lowScore)).toMatchObject({ track: "ICP_FIT", eligible: true, rankScore: 0 });

    const highScore = baseInput();
    highScore.rankScore = 100;
    highScore.contact.email.status = "UNKNOWN";
    const decision = evaluateQualification(highScore);
    expect(decision).toMatchObject({ track: "WATCHLIST", eligible: false, rankScore: 100 });
    expect(decision.blockers.map((item) => item.code)).toContain("EMAIL_NOT_VALID");
  });

  it("admits an official tier B ICP mailbox without third-party buyer-type evidence", () => {
    const input = baseInput();
    input.account.buyerTypeFactIds = [];
    input.evidenceFacts = input.evidenceFacts.filter((item) => item.claimType !== "BUYER_TYPE");
    input.contact.recipientTier = "B";
    input.contact.name = "Buyer Engineering team";
    input.contact.named = false;
    input.contact.title = "Company mailbox";
    input.contact.roleFamily = "OTHER";
    input.contact.seniority = "OTHER";
    input.contact.email.address = "sales@buyer.example.com";
    input.contact.email.status = "RISKY";
    input.contact.email.roleAddress = true;
    input.contact.email.independentlyVerified = false;
    input.contact.email.discoverySourceKey = "official-mailbox-page";
    input.contact.email.verifierSourceKey = "official-mailbox-page";
    input.contact.email.officiallyPublished = true;
    input.contact.email.officialSourceUrl = "https://buyer.example.com/contact";
    input.contact.email.officialObservedAt = "2026-07-15T00:00:00.000Z";
    input.contact.email.officialEvidenceHash = "a".repeat(64);

    const decision = evaluateQualification(input);
    expect(decision).toMatchObject({ track: "ICP_FIT", eligible: true, blockers: [] });
    expect(decision.independentPublisherKeys).toHaveLength(1);
    expect(decision.laneBlockers.activeIntent.map((item) => item.code))
      .toContain("BUYER_TYPE_EVIDENCE_MISSING");
  });

  it("does not apply the tier B exception when the business scenario is not first-party", () => {
    const input = baseInput();
    input.account.buyerTypeFactIds = [];
    input.evidenceFacts = input.evidenceFacts.filter((item) => item.claimType !== "BUYER_TYPE");
    input.contact.recipientTier = "B";
    input.contact.named = false;
    input.contact.roleFamily = "OTHER";
    input.contact.seniority = "OTHER";
    input.contact.email.status = "RISKY";
    input.contact.email.roleAddress = true;
    input.contact.email.independentlyVerified = false;
    input.contact.email.discoverySourceKey = "official-mailbox-page";
    input.contact.email.verifierSourceKey = "official-mailbox-page";
    input.contact.email.officiallyPublished = true;
    input.contact.email.officialSourceUrl = "https://buyer.example.com/contact";
    input.contact.email.officialObservedAt = "2026-07-15T00:00:00.000Z";
    input.contact.email.officialEvidenceHash = "b".repeat(64);
    const scenario = input.evidenceFacts.find((item) => item.claimType === "BUSINESS_SCENARIO")!;
    scenario.publisherDomain = "industry-directory.example.org";
    scenario.authorityClass = "OTHER";
    scenario.sourceKind = "PUBLIC_WEB";

    const decision = evaluateQualification(input);
    expect(decision).toMatchObject({ track: "WATCHLIST", eligible: false });
    expect(decision.blockers.map((item) => item.code)).toContain("BUYER_TYPE_EVIDENCE_MISSING");
  });

  it("accepts fresh entity-bound buyer-official T1 evidence as ACTIVE_INTENT", () => {
    const input = baseInput();
    const active = activeFact();
    input.evidenceFacts.push(active);
    input.message.citedFactIds = ["fact-scenario", active.id];
    input.message.draftText = "Your July tender describes a sample product systems; may I confirm whether product specification is in scope?";

    const decision = evaluateQualification(input);
    expect(decision).toMatchObject({
      track: "ACTIVE_INTENT",
      eligible: true,
      blockers: [],
      whyNowFactIds: [active.id],
      requiredReviewPolicy: "REVIEW_ALL",
    });
  });

  it.each([
    ["missing date", { effectiveAt: null }, "ACTIVE_INTENT_STALE"],
    ["expired", { expiresAt: "2026-07-19T23:59:59.000Z" }, "ACTIVE_INTENT_STALE"],
    ["cancelled", { status: "CANCELLED" }, "ACTIVE_INTENT_STALE"],
    ["wrong entity", { subjectEntityId: "account-2", entityBound: false }, "ACTIVE_INTENT_ENTITY_MISMATCH"],
    ["supplier-side", { subjectRole: "SUPPLIER" }, "ACTIVE_INTENT_ENTITY_MISMATCH"],
    ["human-rejected", { humanReview: "REJECTED" }, "ACTIVE_INTENT_SOURCE_NOT_ALLOWED"],
  ] as const)("does not classify %s T1 evidence as ACTIVE_INTENT", (_name, overrides, expectedCode) => {
    const input = baseInput();
    const active = activeFact(overrides);
    input.evidenceFacts.push(active);
    input.message.citedFactIds = ["fact-scenario"];
    const decision = evaluateQualification(input);
    expect(decision.track).toBe("ICP_FIT");
    expect(decision.laneBlockers.activeIntent.map((item) => item.code)).toContain(expectedCode);
  });

  it("requires an allowlisted authority document and approved review for T2", () => {
    const input = baseInput();
    const unreviewed = activeFact({
      authorityClass: "T2_GOVERNMENT",
      publisherDomain: "procurement.gov.example",
      sourceKind: "AUTHORITY_DOCUMENT",
      authorityAllowlisted: true,
      humanReview: "UNREVIEWED",
    });
    input.evidenceFacts.push(unreviewed);
    input.message.citedFactIds = ["fact-scenario", unreviewed.id];
    const blocked = evaluateQualification(input);
    expect(blocked.track).toBe("ICP_FIT");
    expect(blocked.laneBlockers.activeIntent.map((item) => item.code)).toContain("ACTIVE_INTENT_T2_REVIEW_REQUIRED");

    unreviewed.humanReview = "APPROVED";
    expect(evaluateQualification(input)).toMatchObject({ track: "ACTIVE_INTENT", eligible: true });

    unreviewed.authorityAllowlisted = false;
    expect(evaluateQualification(input).track).toBe("ICP_FIT");
  });

  it.each([
    ["T3_SEARCH", "SEARCH_SNIPPET"],
    ["T3_DIRECTORY", "DIRECTORY"],
    ["T3_SOCIAL", "SOCIAL"],
    ["T3_MEDIA", "MEDIA"],
  ] as const)("never lets %s qualify ACTIVE_INTENT", (authorityClass, sourceKind) => {
    const input = baseInput();
    const active = activeFact({ authorityClass, sourceKind, humanReview: "APPROVED", authorityAllowlisted: true });
    input.evidenceFacts.push(active);
    input.message.citedFactIds = ["fact-scenario", active.id];
    const decision = evaluateQualification(input);
    expect(decision.track).toBe("ICP_FIT");
    expect(decision.laneBlockers.activeIntent.map((item) => item.code)).toContain("ACTIVE_INTENT_SOURCE_NOT_ALLOWED");
  });

  it("fails closed to WATCHLIST with structured blockers and no review path", () => {
    const input = baseInput();
    input.account.businessScenarioVerified = false;
    input.account.businessScenarioFactIds = [];
    input.contact.employment.expiresAt = "2026-07-19T00:00:00.000Z";
    input.seller.offerApproved = false;
    input.message.grounded = false;

    const decision = evaluateQualification(input);
    expect(decision).toMatchObject({
      track: "WATCHLIST",
      eligible: false,
      requiredReviewPolicy: "NOT_REVIEWABLE",
    });
    expect(decision.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "BUSINESS_SCENARIO_UNVERIFIED",
      "BUSINESS_SCENARIO_EVIDENCE_MISSING",
      "EMPLOYMENT_EXPIRED",
      "OFFER_UNAPPROVED",
      "MESSAGE_NOT_GROUNDED",
    ]));
  });

  it.each([
    ["DNC", (input: QualificationInput) => { input.account.dncMatch = true; }, "DNC_MATCH"],
    ["exclusion", (input: QualificationInput) => { input.contact.excluded = true; }, "EXCLUSION_MATCH"],
    ["ownership", (input: QualificationInput) => { input.account.ownershipConflict = true; }, "OWNERSHIP_CONFLICT"],
    ["role mailbox", (input: QualificationInput) => { input.contact.email.roleAddress = true; }, "EMAIL_ROLE_ADDRESS"],
    ["disposable", (input: QualificationInput) => { input.contact.email.disposable = true; }, "EMAIL_DISPOSABLE"],
    ["catch-all", (input: QualificationInput) => { input.contact.email.catchAll = true; }, "EMAIL_CATCH_ALL"],
    ["same-source verifier", (input: QualificationInput) => {
      input.contact.email.verifierSourceKey = input.contact.email.discoverySourceKey;
    }, "EMAIL_NOT_INDEPENDENT"],
    ["unapproved seller context", (input: QualificationInput) => {
      input.seller.sellerContextApproved = false;
    }, "SELLER_CONTEXT_UNAPPROVED"],
  ] as const)("keeps the %s hard gate in both sendable lanes", (_name, mutate, blockerCode) => {
    const input = baseInput();
    mutate(input);
    const decision = evaluateQualification(input);
    expect(decision.track).toBe("WATCHLIST");
    expect(decision.laneBlockers.activeIntent.map((item) => item.code)).toContain(blockerCode);
    expect(decision.laneBlockers.icpFit.map((item) => item.code)).toContain(blockerCode);
  });

  it("rejects stale policy records until they are recomputed", () => {
    const input = baseInput();
    input.policyVersion = "qualification-policy-v1";
    const decision = evaluateQualification(input);
    expect(decision).toMatchObject({ track: "WATCHLIST", eligible: false });
    expect(decision.blockers.map((item) => item.code)).toContain("POLICY_VERSION_STALE");
  });

  it("hard-blocks unsupported procurement assertions in ICP_FIT but allows an honest exploratory question", () => {
    const unsupported = [
      "I saw you are sourcing replacement sample components.",
      "Your current tender for a Sample Product A looks relevant.",
      "We understand you currently need a Sample Product C.",
      "了解到贵司正在采购产品设备，想提供报价。",
    ];
    for (const text of unsupported) {
      expect(lintIcpFitLanguage(text)).toMatchObject({ valid: false });
      const input = baseInput();
      input.message.draftText = text;
      const decision = evaluateQualification(input);
      expect(decision.track).toBe("WATCHLIST");
      expect(decision.blockers.map((item) => item.code)).toContain("ICP_FIT_LANGUAGE_UNSUPPORTED");
    }

    expect(lintIcpFitLanguage(
      "Your published process profile appears relevant. Are you the right person to assess whether this could fit?",
    )).toEqual({ valid: true, issues: [] });
  });

  it("strictly rejects unknown fields at the external qualification boundary", () => {
    const input = { ...baseInput(), silentlyTrustProvider: true };
    expect(() => evaluateQualification(input)).toThrow();
  });
});
