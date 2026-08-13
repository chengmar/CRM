import { describe, expect, it } from "vitest";
import {
  normalizeContactRankingBuyerType,
  rankStoredContactRows,
  type ContactRankingVerification,
  type StoredContactRow,
  type StoredLeadSourceRow,
} from "../src/acquisition/contact-ranking-adapter.js";
import { classifyRecipientTier } from "../src/acquisition/recipient-tier.js";

const asOf = new Date("2026-07-20T00:00:00.000Z");
const accountDomain = "buyer.example.com";
const sourceUrl = "https://buyer.example.com/team";

function contact(input: {
  id: string;
  name?: string;
  title?: string;
  email?: string;
  emailStatus?: "VALID" | "RISKY" | "UNKNOWN" | "INVALID";
  employmentAt?: string | null;
  roleAddress?: boolean;
  officialEvidence?: { sourceUrl: string; exactText: string; observedAt: string } | null;
}): StoredContactRow {
  const name = input.name ?? `Named Person ${input.id}`;
  const title = input.title ?? "Plant Operations Manager";
  const email = input.email ?? `${input.id}@buyer.example.com`;
  const emailStatus = input.emailStatus ?? "VALID";
  const employmentAt = input.employmentAt === undefined ? "2026-07-10T00:00:00.000Z" : input.employmentAt;
  const roleAddress = input.roleAddress ?? false;
  const recipient = classifyRecipientTier({
    accountDomain,
    email,
    name,
    title,
    employmentVerifiedAt: employmentAt,
    emailStatus,
    roleAddress,
    disposableAddress: false,
    catchAll: false,
    officialMailboxEvidence: input.officialEvidence ?? (employmentAt ? {
      sourceUrl,
      exactText: "",
      observedAt: employmentAt,
    } : null),
    asOf,
  });
  return {
    id: input.id,
    name,
    title,
    email,
    source_url: sourceUrl,
    employment_verified_at: employmentAt,
    email_status: emailStatus,
    role_address: roleAddress ? 1 : 0,
    disposable_address: 0,
    catch_all: 0,
    recipient_tier: recipient.tier,
    recipient_evidence_url: recipient.evidenceUrl,
    recipient_evidence_observed_at: recipient.evidenceObservedAt,
    recipient_evidence_expires_at: recipient.evidenceExpiresAt,
    recipient_evidence_hash: recipient.evidenceHash,
    recipient_policy_version: recipient.policyVersion,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
  };
}

function lineage(
  id: string,
  observedAt = "2026-07-15T00:00:00.000Z",
  confidence = 0.98,
): ContactRankingVerification {
  return {
    discoveryAssertionId: `discovery-${id}`,
    verificationAssertionId: `verification-${id}`,
    discoverySourceKey: "LOCAL_PUBLIC_WEB",
    verifierSourceKey: "HUNTER",
    independentlyVerified: true,
    confidence,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 30 * 86_400_000).toISOString(),
  };
}

function rank(
  contacts: StoredContactRow[],
  verifications: Map<string, ContactRankingVerification>,
  sources: StoredLeadSourceRow[] = [],
) {
  return rankStoredContactRows({
    contacts,
    sources,
    accountId: "account-buyer",
    accountDomain,
    buyerType: "END_USER_FACTORY",
    asOf,
    verificationFor: (row) => verifications.get(String(row.id)) ?? null,
  });
}

describe("stored contact ranking adapter", () => {
  it("selects the buyer-relevant role instead of the first DB row", () => {
    const projectDirector = contact({
      id: "first-project",
      title: "Project Director",
    });
    const plantManager = contact({
      id: "second-plant",
      title: "Plant Operations Manager",
    });
    const verifications = new Map([
      ["first-project", lineage("first-project")],
      ["second-plant", lineage("second-plant")],
    ]);

    const ranked = rank([projectDirector, plantManager], verifications);

    expect(ranked[0]?.candidate.id).toBe("second-plant");
    expect(ranked[0]?.ranking.sendable).toBe(true);
    expect(ranked[0]?.ranking.dimensions.roleRelevance).toBe(100);
  });

  it("uses the newest complete evidence when policy and role are otherwise equal", () => {
    const older = contact({
      id: "first-older",
      employmentAt: "2026-06-20T00:00:00.000Z",
    });
    const newer = contact({
      id: "second-newer",
      employmentAt: "2026-07-15T00:00:00.000Z",
    });
    const verifications = new Map([
      ["first-older", lineage("first-older", "2026-07-01T00:00:00.000Z")],
      ["second-newer", lineage("second-newer", "2026-07-18T00:00:00.000Z")],
    ]);

    const ranked = rank([older, newer], verifications);

    expect(ranked.map((value) => value.candidate.id)).toEqual(["second-newer", "first-older"]);
    expect(ranked[0]!.ranking.dimensions.recencyEpochMs)
      .toBeGreaterThan(ranked[1]!.ranking.dimensions.recencyEpochMs);
  });

  it("prioritizes a sendable tier B mailbox over a VALID tier A row without independent verification", () => {
    const unverifiedPersonal = contact({ id: "first-valid-unverified" });
    const officialEvidence = {
      sourceUrl: "https://buyer.example.com/contact",
      exactText: "Email sales@buyer.example.com for export enquiries.",
      observedAt: "2026-07-18T00:00:00.000Z",
    };
    const companyMailbox = contact({
      id: "second-risky-sendable",
      name: "Buyer Company team",
      title: "Company mailbox",
      email: "sales@buyer.example.com",
      emailStatus: "RISKY",
      employmentAt: null,
      roleAddress: true,
      officialEvidence,
    });
    const sources: StoredLeadSourceRow[] = [{
      source_url: officialEvidence.sourceUrl,
      source_type: "official_website",
      evidence: officialEvidence.exactText,
      created_at: officialEvidence.observedAt,
    }];

    const ranked = rank([unverifiedPersonal, companyMailbox], new Map(), sources);

    expect(ranked[0]?.candidate.id).toBe("second-risky-sendable");
    expect(ranked[0]?.candidate.recipientTier).toBe("B");
    expect(ranked[0]?.ranking.sendable).toBe(true);
    expect(ranked[1]?.candidate.email.status).toBe("VALID");
    expect(ranked[1]?.ranking.sendable).toBe(false);
    expect(ranked[1]?.ranking.blockers.map((blocker) => blocker.code)).toContain("EMAIL_NOT_INDEPENDENT");
  });

  it("normalizes both canonical enum values and legacy buyer labels", () => {
    expect(normalizeContactRankingBuyerType("END_USER_FACTORY")).toBe("END_USER_FACTORY");
    expect(normalizeContactRankingBuyerType("System Integrator / EPC")).toBe("SYSTEM_INTEGRATOR_EPC");
    expect(normalizeContactRankingBuyerType("Distributor / Dealer")).toBe("DISTRIBUTOR");
    expect(normalizeContactRankingBuyerType("engineering company")).toBe("SYSTEM_INTEGRATOR_EPC");
    expect(normalizeContactRankingBuyerType("sample product application supplier")).toBe("DISTRIBUTOR");
    expect(normalizeContactRankingBuyerType("manufacturing")).toBe("END_USER_FACTORY");
    expect(normalizeContactRankingBuyerType("B2B company")).toBeNull();
    expect(normalizeContactRankingBuyerType("sample fabrication")).toBeNull();
    expect(normalizeContactRankingBuyerType("sample application")).toBeNull();
  });
});
