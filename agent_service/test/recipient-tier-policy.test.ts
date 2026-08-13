import { describe, expect, it } from "vitest";
import {
  RECIPIENT_TIER_POLICY_VERSION,
  classifyRecipientTier,
  isCompanyRoleMailbox,
} from "../src/acquisition/recipient-tier.js";
import { assessContactCandidate } from "../src/acquisition/contact-ranking.js";

const now = new Date("2026-07-21T00:00:00.000Z");

describe("recipient tier policy", () => {
  it("keeps a current named independently-verifiable corporate contact in tier A", () => {
    const decision = classifyRecipientTier({
      accountDomain: "buyer.example",
      email: "person@buyer.example",
      name: "Jordan Lee",
      title: "Engineering Manager",
      employmentVerifiedAt: "2026-07-20T00:00:00.000Z",
      emailStatus: "VALID",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
      asOf: now,
    });
    expect(decision).toMatchObject({ tier: "A", sendable: true, policyVersion: RECIPIENT_TIER_POLICY_VERSION });
  });

  it("admits only an exact fresh official-site company mailbox to tier B", () => {
    expect(isCompanyRoleMailbox("export@buyer.example")).toBe(true);
    const decision = classifyRecipientTier({
      accountDomain: "buyer.example",
      email: "export@buyer.example",
      name: "Buyer Example team",
      title: "Company mailbox",
      employmentVerifiedAt: null,
      emailStatus: "UNKNOWN",
      roleAddress: true,
      disposableAddress: false,
      catchAll: true,
      officialMailboxEvidence: {
        sourceUrl: "https://buyer.example/contact",
        exactText: "Export enquiries: export@buyer.example",
        observedAt: "2026-07-20T00:00:00.000Z",
      },
      asOf: now,
    });
    expect(decision).toMatchObject({ tier: "B", sendable: true, blockers: [] });
    expect(decision.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    "ventas@buyer.example",
    "cotizaciones@buyer.example",
    "kinhdoanh@buyer.example",
    "xuatkhau@buyer.example",
    "penjualan@buyer.example",
    "pemasaran@buyer.example",
    "sales.vn@buyer.example",
    "export-asia@buyer.example",
    "commercial.mx@buyer.example",
  ])("recognizes controlled international sales mailbox %s", (email) => {
    expect(isCompanyRoleMailbox(email)).toBe(true);
  });

  it.each([
    "hr@buyer.example",
    "careers@buyer.example",
    "privacy@buyer.example",
    "abuse@buyer.example",
    "noreply@buyer.example",
    "security@buyer.example",
    "webmaster@buyer.example",
  ])("does not classify non-sales mailbox %s as a company outreach route", (email) => {
    expect(isCompanyRoleMailbox(email)).toBe(false);
  });

  it.each([
    { label: "guessed", emailStatus: "UNKNOWN" as const, disposableAddress: false, sourceUrl: null },
    { label: "invalid", emailStatus: "INVALID" as const, disposableAddress: false, sourceUrl: "https://buyer.example/contact" },
    { label: "disposable", emailStatus: "RISKY" as const, disposableAddress: true, sourceUrl: "https://buyer.example/contact" },
    { label: "third-party", emailStatus: "RISKY" as const, disposableAddress: false, sourceUrl: "https://directory.example/contact" },
  ])("keeps $label mailboxes in tier C", ({ emailStatus, disposableAddress, sourceUrl }) => {
    const decision = classifyRecipientTier({
      accountDomain: "buyer.example",
      email: "sales@buyer.example",
      name: "Buyer Example team",
      title: "Company mailbox",
      emailStatus,
      roleAddress: true,
      disposableAddress,
      catchAll: false,
      officialMailboxEvidence: sourceUrl ? {
        sourceUrl,
        exactText: "Contact sales@buyer.example",
        observedAt: "2026-07-20T00:00:00.000Z",
      } : null,
      asOf: now,
    });
    expect(decision).toMatchObject({ tier: "C", sendable: false });
  });

  it("lets a fully evidenced tier B mailbox pass contact ranking without invented employment", () => {
    const ranked = assessContactCandidate({
      id: "contact-role",
      accountId: "account-role",
      name: "Buyer Example team",
      named: false,
      title: "Company mailbox",
      roleFamily: "OTHER",
      seniority: "OTHER",
      employment: {
        accountId: "account-role",
        status: "UNKNOWN",
        observedAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:00:00.000Z",
        confidence: 0.8,
        assertionIds: ["official-mailbox-evidence"],
        conflict: false,
      },
      email: {
        address: "sales@buyer.example",
        status: "RISKY",
        workEmail: true,
        roleAddress: true,
        disposable: false,
        catchAll: true,
        domainMatchesAccount: true,
        discoverySourceKey: "OFFICIAL_SITE_PUBLICATION",
        verifierSourceKey: "OFFICIAL_SITE_PUBLICATION",
        independentlyVerified: false,
        observedAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:00:00.000Z",
        confidence: 0.8,
        assertionIds: ["official-mailbox-evidence"],
        conflict: false,
        officiallyPublished: true,
        officialSourceUrl: "https://buyer.example/contact",
        officialObservedAt: "2026-07-20T00:00:00.000Z",
        officialEvidenceHash: "a".repeat(64),
      },
      evidenceConfidence: 0.8,
      lastEvidenceAt: "2026-07-20T00:00:00.000Z",
      dncMatch: false,
      excluded: false,
      ownershipConflict: false,
      conflicts: [],
      recipientTier: "B",
    }, {
      accountId: "account-role",
      buyerType: "SYSTEM_INTEGRATOR_EPC",
      asOf: now.toISOString(),
    });
    expect(ranked.sendable).toBe(true);
    expect(ranked.blockers).toEqual([]);
  });
});
