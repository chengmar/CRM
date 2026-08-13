import { describe, expect, it } from "vitest";
import {
  EmailDiscoveryAssertionSchema,
  EmailVerificationAssertionSchema,
  EmploymentAssertionSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
} from "../src/acquisition/providers/contracts.js";

const hash = "a".repeat(64);
const observedAt = "2026-07-20T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";

function assertionBase(providerId: "HUNTER" | "WIZA", providerRunId = "run-1") {
  return {
    assertionId: "assertion-1",
    providerId,
    providerRunId,
    accountId: "account-1",
    sourceUri: "https://example.com/about",
    observedAt,
    expiresAt,
    confidence: 0.9,
    rawPayloadHash: hash,
    creditUnits: 1,
    estimatedUsd: 0.1,
  };
}

describe("strict provider request and assertion contracts", () => {
  it("rejects unknown request fields and unsafe account-discovery policy", () => {
    const valid = {
      operation: "ACCOUNT_DISCOVERY",
      country: "Malaysia",
      localities: ["Penang"],
      buyerTypes: ["SYSTEM_INTEGRATOR"],
      keywords: ["sample application"],
      limit: 30,
      budgetId: "budget-shadow-1",
      sourceMode: "OFFICIAL_API_ONLY",
      personalDataAllowed: false,
    };

    expect(ProviderRequestSchema.safeParse(valid).success).toBe(true);
    expect(ProviderRequestSchema.safeParse({ ...valid, apiKey: "must-not-be-accepted" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...valid, personalDataAllowed: true }).success).toBe(false);
  });

  it("blocks personal, role, and cross-domain mailbox requests", () => {
    const base = {
      operation: "EMAIL_VERIFICATION",
      accountId: "account-1",
      personRef: "person-1",
      expectedDomain: "example.com",
      discoveryAssertionId: "email-discovery-1",
      discoveryProviderId: "WIZA",
      independentVerificationRequired: true,
    };

    expect(ProviderRequestSchema.safeParse({ ...base, email: "jane.doe@example.com" }).success).toBe(true);
    expect(ProviderRequestSchema.safeParse({ ...base, email: "jane.doe@gmail.com" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...base, email: "sales@example.com" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...base, email: "jane.doe@other.example" }).success).toBe(false);
  });

  it("keeps employment, email discovery, and mailbox verification physically separate", () => {
    const employment = {
      ...assertionBase("WIZA"),
      kind: "EMPLOYMENT",
      personRef: "person-1",
      providerPersonId: "wiza-person-1",
      providerCompanyId: "wiza-company-1",
      employerName: "Example Industrial",
      employerDomainAssertion: "example.com",
      title: "Engineering Manager",
      providerVerdict: "CURRENT",
      localEmploymentState: "UNCHANGED",
    };
    const discovery = {
      ...assertionBase("WIZA"),
      kind: "EMAIL_DISCOVERY",
      personRef: "person-1",
      email: "jane.doe@example.com",
      emailDomain: "example.com",
      emailType: "WORK",
      providerStatus: "PROVIDER_VALID_ASSERTION",
      localMailboxVerdict: "NOT_VERIFIED",
    };
    const verification = {
      ...assertionBase("HUNTER"),
      kind: "EMAIL_VERIFICATION",
      personRef: "person-1",
      emailHash: hash,
      discoveryAssertionId: "email-discovery-1",
      discoveryProviderId: "WIZA",
      verificationProviderId: "HUNTER",
      providerMailboxVerdict: "VALID_ASSERTION",
      catchAll: false,
      disposable: false,
      roleMailbox: false,
      localMailboxVerdict: "UNCHANGED",
    };

    expect(EmploymentAssertionSchema.safeParse(employment).success).toBe(true);
    expect(EmploymentAssertionSchema.safeParse({ ...employment, email: "jane.doe@example.com" }).success).toBe(false);
    expect(EmailDiscoveryAssertionSchema.safeParse(discovery).success).toBe(true);
    expect(EmailDiscoveryAssertionSchema.safeParse({ ...discovery, localMailboxVerdict: "VALID" }).success).toBe(false);
    expect(EmailVerificationAssertionSchema.safeParse(verification).success).toBe(true);
    expect(EmailVerificationAssertionSchema.safeParse({
      ...verification,
      discoveryProviderId: "HUNTER",
    }).success).toBe(false);
  });

  it("rejects assertion kinds that do not match the provider operation", () => {
    const emailDiscovery = {
      ...assertionBase("WIZA"),
      kind: "EMAIL_DISCOVERY",
      personRef: "person-1",
      email: "jane.doe@example.com",
      emailDomain: "example.com",
      emailType: "WORK",
      providerStatus: "PROVIDER_VALID_ASSERTION",
      localMailboxVerdict: "NOT_VERIFIED",
    };
    const response = {
      providerId: "WIZA",
      providerRunId: "run-1",
      operation: "EMAIL_VERIFICATION",
      result: "ASSERTIONS_RETURNED",
      assertions: [emailDiscovery],
      rawPayloadHash: hash,
      retryAfterSeconds: null,
    };

    expect(ProviderResponseSchema.safeParse(response).success).toBe(false);
  });

  it("requires same-domain, public website crawl requests with safety gates enabled", () => {
    const base = {
      operation: "WEBSITE_CRAWL",
      accountId: "account-1",
      canonicalDomain: "example.com",
      url: "https://example.com/products",
      escalationReason: "JS_REQUIRED",
      maxPages: 5,
      obeyRobots: true,
      allowCrossDomain: false,
      allowPrivateNetworks: false,
    };

    expect(ProviderRequestSchema.safeParse(base).success).toBe(true);
    expect(ProviderRequestSchema.safeParse({ ...base, url: "https://other.example/products" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...base, url: "http://127.0.0.1/private" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...base, obeyRobots: false }).success).toBe(false);
  });

  it("only accepts paused, approved transport drafts with tracking disabled", () => {
    const request = {
      operation: "OUTREACH_DRAFT",
      accountId: "account-1",
      leadId: "lead-1",
      contactId: "contact-1",
      messageIds: ["message-1"],
      recipientWorkEmail: "jane.doe@example.com",
      subject: "sample product application question",
      body: "Fixture-only approved body.",
      reviewHash: hash,
      dossierVersion: 1,
      experimentArm: "arm-a",
      contentHash: hash,
      approvalState: "APPROVED",
      transportMode: "PAUSED_DRAFT",
      openTrackingEnabled: false,
      clickTrackingEnabled: false,
      replyStopEnabled: true,
      companyStopEnabled: true,
      dncCheckedAt: observedAt,
      riskyMailbox: false,
      humanTakeover: false,
      alreadyReplied: false,
    };

    expect(ProviderRequestSchema.safeParse(request).success).toBe(true);
    expect(ProviderRequestSchema.safeParse({ ...request, transportMode: "ACTIVE" }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...request, openTrackingEnabled: true }).success).toBe(false);
    expect(ProviderRequestSchema.safeParse({ ...request, alreadyReplied: true }).success).toBe(false);
  });
});
