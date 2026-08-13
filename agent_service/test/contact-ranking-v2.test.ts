import { describe, expect, it } from "vitest";
import type { ContactCandidate } from "../src/acquisition/models.js";
import {
  inferRoleFamily,
  rankSendableContacts,
} from "../src/acquisition/contact-ranking.js";

const context = {
  accountId: "account-1",
  buyerType: "END_USER_FACTORY" as const,
  asOf: "2026-07-20T00:00:00.000Z",
};

function candidate(id: string, overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  const base: ContactCandidate = {
    id,
    accountId: "account-1",
    name: `Named Person ${id}`,
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
      assertionIds: [`employment-${id}`],
      conflict: false,
    },
    email: {
      address: `${id}@buyer.example.com`,
      status: "VALID",
      workEmail: true,
      roleAddress: false,
      disposable: false,
      catchAll: false,
      domainMatchesAccount: true,
      discoverySourceKey: `discovery-${id}`,
      verifierSourceKey: `verifier-${id}`,
      independentlyVerified: true,
      observedAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      confidence: 0.98,
      assertionIds: [`email-${id}`],
      conflict: false,
    },
    evidenceConfidence: 0.94,
    lastEvidenceAt: "2026-07-15T00:00:00.000Z",
    dncMatch: false,
    excluded: false,
    ownershipConflict: false,
    conflicts: [],
  };
  return {
    ...base,
    ...overrides,
    employment: { ...base.employment, ...overrides.employment },
    email: { ...base.email, ...overrides.email },
  };
}

describe("contact ranking v2", () => {
  it("orders email verdicts explicitly as VALID > RISKY > UNKNOWN > INVALID", () => {
    const contacts = [
      candidate("invalid", { email: { ...candidate("x").email, status: "INVALID" } }),
      candidate("unknown", { email: { ...candidate("x").email, status: "UNKNOWN" } }),
      candidate("valid"),
      candidate("risky", { email: { ...candidate("x").email, status: "RISKY" } }),
    ];

    const ranked = rankSendableContacts(contacts, context);
    expect(ranked.map((item) => item.contact.id)).toEqual(["valid", "risky", "unknown", "invalid"]);
    expect(ranked.map((item) => item.dimensions.emailStatusRank)).toEqual([4, 3, 2, 1]);
    expect(ranked[0]?.sendable).toBe(true);
    expect(ranked.slice(1).every((item) => !item.sendable)).toBe(true);
  });

  it("routes roles by buyer type rather than using one global title order", () => {
    const people = [
      candidate("owner", { roleFamily: "OWNER_EXECUTIVE", seniority: "OWNER_C_SUITE" }),
      candidate("product", { roleFamily: "PRODUCT", seniority: "MANAGER" }),
      candidate("plant", { roleFamily: "PLANT_OPERATIONS", seniority: "MANAGER" }),
      candidate("ehs", { roleFamily: "EHS", seniority: "MANAGER" }),
    ];

    const factory = rankSendableContacts(people, context);
    expect(factory.map((item) => item.contact.id)).toEqual(["plant", "ehs", "owner", "product"]);

    const distributor = rankSendableContacts(people, { ...context, buyerType: "DISTRIBUTOR" });
    expect(distributor.map((item) => item.contact.id)).toEqual(["owner", "product", "ehs", "plant"]);
    expect(distributor.map((item) => item.sendable)).toEqual([true, true, false, false]);
  });

  it("applies role relevance before seniority, confidence, and recency", () => {
    const moreRelevant = candidate("relevant-specialist", {
      roleFamily: "PLANT_OPERATIONS",
      seniority: "SPECIALIST",
      evidenceConfidence: 0.7,
      lastEvidenceAt: "2026-07-01T00:00:00.000Z",
    });
    const seniorButLessRelevant = candidate("senior-less-relevant", {
      roleFamily: "PROJECT",
      seniority: "OWNER_C_SUITE",
      evidenceConfidence: 1,
      lastEvidenceAt: "2026-07-19T00:00:00.000Z",
    });

    const ranked = rankSendableContacts([seniorButLessRelevant, moreRelevant], context);
    expect(ranked.map((item) => item.contact.id)).toEqual(["relevant-specialist", "senior-less-relevant"]);
  });

  it("uses seniority, weakest-link confidence, then evidence recency as deterministic tie breakers", () => {
    const manager = candidate("manager", { seniority: "MANAGER" });
    const specialist = candidate("specialist", { seniority: "SPECIALIST" });
    expect(rankSendableContacts([specialist, manager], context)[0]?.contact.id).toBe("manager");

    const confident = candidate("confident", { evidenceConfidence: 0.99 });
    const uncertain = candidate("uncertain", { evidenceConfidence: 0.6 });
    expect(rankSendableContacts([uncertain, confident], context)[0]?.contact.id).toBe("confident");

    const recent = candidate("recent");
    const old = candidate("old", {
      employment: {
        ...candidate("x").employment,
        observedAt: "2026-06-01T00:00:00.000Z",
      },
      email: {
        ...candidate("x").email,
        observedAt: "2026-06-25T00:00:00.000Z",
      },
      lastEvidenceAt: "2026-06-25T00:00:00.000Z",
    });
    expect(rankSendableContacts([old, recent], context)[0]?.contact.id).toBe("recent");
  });

  it("blocks expired employment and email evidence even when the status is VALID", () => {
    const staleEmployment = candidate("stale-employment", {
      employment: {
        ...candidate("x").employment,
        observedAt: "2026-04-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
    const staleEmail = candidate("stale-email", {
      email: {
        ...candidate("x").email,
        observedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });

    const ranked = rankSendableContacts([staleEmployment, staleEmail], context);
    expect(ranked.find((item) => item.contact.id === "stale-employment")?.blockers.map((item) => item.code))
      .toContain("EMPLOYMENT_EXPIRED");
    expect(ranked.find((item) => item.contact.id === "stale-email")?.blockers.map((item) => item.code))
      .toContain("EMAIL_VERIFICATION_EXPIRED");
    expect(ranked.every((item) => !item.sendable)).toBe(true);
  });

  it("blocks current-employment, mailbox, domain, DNC, exclusion, ownership, and conflict failures", () => {
    const unsafe = candidate("unsafe", {
      accountId: "other-account",
      named: false,
      roleFamily: "OTHER",
      employment: {
        ...candidate("x").employment,
        accountId: "other-account",
        status: "CONFLICT",
        conflict: true,
      },
      email: {
        ...candidate("x").email,
        workEmail: false,
        roleAddress: true,
        disposable: true,
        catchAll: true,
        domainMatchesAccount: false,
        discoverySourceKey: "same-source",
        verifierSourceKey: "same-source",
        independentlyVerified: false,
        conflict: true,
      },
      dncMatch: true,
      excluded: true,
      ownershipConflict: true,
      conflicts: ["providers disagree on employer"],
    });

    const result = rankSendableContacts([unsafe], context)[0];
    expect(result?.sendable).toBe(false);
    expect(result?.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "CONTACT_NOT_NAMED",
      "CONTACT_ACCOUNT_MISMATCH",
      "CONTACT_ROLE_IRRELEVANT",
      "EMPLOYMENT_NOT_CURRENT",
      "EMPLOYMENT_CONFLICT",
      "EMAIL_NOT_WORK",
      "EMAIL_NOT_INDEPENDENT",
      "EMAIL_DOMAIN_MISMATCH",
      "EMAIL_ROLE_ADDRESS",
      "EMAIL_DISPOSABLE",
      "EMAIL_CATCH_ALL",
      "EMAIL_CONFLICT",
      "DNC_MATCH",
      "EXCLUSION_MATCH",
      "OWNERSHIP_CONFLICT",
    ]));
  });

  it("infers the role families used by the buyer routing policy", () => {
    expect(inferRoleFamily("General Manager")).toBe("OWNER_EXECUTIVE");
    expect(inferRoleFamily("Strategic Sourcing Director")).toBe("PROCUREMENT_SOURCING");
    expect(inferRoleFamily("Environmental Health and Safety Manager")).toBe("EHS");
    expect(inferRoleFamily("Plant Maintenance Manager")).toBe("MAINTENANCE");
    expect(inferRoleFamily("Project Engineering Lead")).toBe("PROJECT");
    expect(inferRoleFamily("Regional Product Manager")).toBe("PRODUCT");
    expect(inferRoleFamily("Finance Analyst")).toBe("OTHER");
  });

  it("uses a stable contact id tie-break and strictly rejects unknown external fields", () => {
    const first = candidate("a");
    const second = candidate("b");
    expect(rankSendableContacts([second, first], context).map((item) => item.contact.id)).toEqual(["a", "b"]);

    const unsafe = { ...candidate("unsafe"), providerVerdictIsEnough: true };
    expect(() => rankSendableContacts([unsafe], context)).toThrow();
    expect(() => rankSendableContacts([first], { ...context, hiddenOverride: true })).toThrow();
  });
});
