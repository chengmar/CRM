import { z } from "zod";
import { getDomain } from "tldts";
import {
  EMAIL_VERIFICATION_TTL_DAYS,
  EMPLOYMENT_TTL_DAYS,
  buyerTypeSchema,
  contactCandidateSchema,
  parseContactCandidates,
  type BuyerType,
  type ContactCandidate,
  type RoleFamily,
} from "./models.js";

export const buyerTypeRolePriorities: Readonly<Record<BuyerType, Readonly<Record<RoleFamily, number>>>> = {
  SYSTEM_INTEGRATOR_EPC: {
    OWNER_EXECUTIVE: 100,
    TECHNICAL_ENGINEERING: 95,
    PROJECT: 90,
    PROCUREMENT_SOURCING: 80,
    PRODUCT: 0,
    PLANT_OPERATIONS: 0,
    EHS: 0,
    MAINTENANCE: 0,
    OTHER: 0,
  },
  DISTRIBUTOR: {
    OWNER_EXECUTIVE: 100,
    PRODUCT: 95,
    PROCUREMENT_SOURCING: 90,
    TECHNICAL_ENGINEERING: 0,
    PROJECT: 0,
    PLANT_OPERATIONS: 0,
    EHS: 0,
    MAINTENANCE: 0,
    OTHER: 0,
  },
  END_USER_FACTORY: {
    PLANT_OPERATIONS: 100,
    TECHNICAL_ENGINEERING: 95,
    EHS: 90,
    MAINTENANCE: 85,
    PROJECT: 80,
    PROCUREMENT_SOURCING: 70,
    OWNER_EXECUTIVE: 0,
    PRODUCT: 0,
    OTHER: 0,
  },
};

export const contactRankingBlockerCodes = [
  "CONTACT_NOT_NAMED",
  "CONTACT_ACCOUNT_MISMATCH",
  "CONTACT_ROLE_IRRELEVANT",
  "EMPLOYMENT_NOT_CURRENT",
  "EMPLOYMENT_EXPIRED",
  "EMPLOYMENT_CONFLICT",
  "EMAIL_NOT_VALID",
  "EMAIL_NOT_WORK",
  "EMAIL_VERIFICATION_EXPIRED",
  "EMAIL_NOT_INDEPENDENT",
  "EMAIL_DOMAIN_MISMATCH",
  "EMAIL_ROLE_ADDRESS",
  "EMAIL_DISPOSABLE",
  "EMAIL_CATCH_ALL",
  "EMAIL_CONFLICT",
  "RECIPIENT_TIER_C",
  "EMAIL_OFFICIAL_PUBLICATION_MISSING",
  "DNC_MATCH",
  "EXCLUSION_MATCH",
  "OWNERSHIP_CONFLICT",
] as const;
export type ContactRankingBlockerCode = (typeof contactRankingBlockerCodes)[number];

export interface ContactRankingBlocker {
  code: ContactRankingBlockerCode;
  message: string;
  assertionIds: string[];
}

export interface RankedContact {
  contact: ContactCandidate;
  sendable: boolean;
  blockers: ContactRankingBlocker[];
  dimensions: {
    emailStatusRank: number;
    currentFreshEmploymentRank: number;
    roleRelevance: number;
    seniorityRank: number;
    confidence: number;
    recencyEpochMs: number;
  };
}

export const contactRankingContextSchema = z
  .object({
    accountId: z.string().trim().min(1).max(200),
    buyerType: buyerTypeSchema,
    asOf: z.string().datetime({ offset: true }),
  })
  .strict();
export type ContactRankingContext = z.infer<typeof contactRankingContextSchema>;

const emailStatusRanks = {
  VALID: 4,
  RISKY: 3,
  UNKNOWN: 2,
  INVALID: 1,
} as const;

const seniorityRanks = {
  OWNER_C_SUITE: 5,
  VP_DIRECTOR_HEAD: 4,
  MANAGER: 3,
  SPECIALIST: 2,
  OTHER: 1,
} as const;

const millisecondsPerDay = 86_400_000;

function ageInDays(isoDate: string, asOfMs: number): number {
  return (asOfMs - Date.parse(isoDate)) / millisecondsPerDay;
}

function isFresh(
  observedAt: string,
  expiresAt: string,
  asOfMs: number,
  maximumAgeDays: number,
): boolean {
  const observedMs = Date.parse(observedAt);
  const expiresMs = Date.parse(expiresAt);
  const age = ageInDays(observedAt, asOfMs);
  return observedMs <= asOfMs && expiresMs >= asOfMs && expiresMs >= observedMs && age >= 0 && age <= maximumAgeDays;
}

function blocker(
  code: ContactRankingBlockerCode,
  message: string,
  assertionIds: string[] = [],
): ContactRankingBlocker {
  return { code, message, assertionIds: [...new Set(assertionIds)].sort() };
}

export function getRolePriority(buyerType: BuyerType, roleFamily: RoleFamily): number {
  return buyerTypeRolePriorities[buyerType][roleFamily];
}

export function inferRoleFamily(title: string): RoleFamily {
  const normalized = title.toLowerCase();
  if (/\b(?:owner|founder|chief executive|ceo|general manager|managing director|president)\b/.test(normalized)) {
    return "OWNER_EXECUTIVE";
  }
  if (/\b(?:procurement|purchasing|buyer|sourcing|supply chain)\b/.test(normalized)) {
    return "PROCUREMENT_SOURCING";
  }
  if (/\b(?:ehs|hse|environment(?:al)?|safety|compliance)\b/.test(normalized)) {
    return "EHS";
  }
  if (/\b(?:maintenance|reliability)\b/.test(normalized)) return "MAINTENANCE";
  if (/\b(?:plant|factory|operations?|production)\b/.test(normalized)) return "PLANT_OPERATIONS";
  if (/\b(?:project|commissioning)\b/.test(normalized)) return "PROJECT";
  if (/\b(?:product|category|portfolio|merchandis)\w*\b/.test(normalized)) return "PRODUCT";
  if (/\b(?:technical|engineer(?:ing)?|technology|design|process)\b/.test(normalized)) {
    return "TECHNICAL_ENGINEERING";
  }
  return "OTHER";
}

export function assessContactCandidate(
  candidateInput: ContactCandidate,
  contextInput: ContactRankingContext,
): RankedContact {
  const candidate = contactCandidateSchema.parse(candidateInput);
  const context = contactRankingContextSchema.parse(contextInput);
  const asOfMs = Date.parse(context.asOf);
  const employmentFresh = isFresh(
    candidate.employment.observedAt,
    candidate.employment.expiresAt,
    asOfMs,
    EMPLOYMENT_TTL_DAYS,
  );
  const emailFresh = isFresh(
    candidate.email.observedAt,
    candidate.email.expiresAt,
    asOfMs,
    EMAIL_VERIFICATION_TTL_DAYS,
  );
  const roleRelevance = getRolePriority(context.buyerType, candidate.roleFamily);
  const blockers: ContactRankingBlocker[] = [];
  const tierA = candidate.recipientTier === "A";
  const tierB = candidate.recipientTier === "B";

  if (candidate.recipientTier === "C") {
    blockers.push(blocker("RECIPIENT_TIER_C", "recipient tier C is never sendable"));
  }
  if (tierA && !candidate.named) blockers.push(blocker("CONTACT_NOT_NAMED", "contact is not a named person"));
  if (candidate.accountId !== context.accountId || candidate.employment.accountId !== context.accountId) {
    blockers.push(blocker(
      "CONTACT_ACCOUNT_MISMATCH",
      "contact or employment assertion belongs to a different account",
      candidate.employment.assertionIds,
    ));
  }
  if (tierA && roleRelevance === 0) {
    blockers.push(blocker("CONTACT_ROLE_IRRELEVANT", "contact role is not routed for this buyer type"));
  }
  if (tierA && candidate.employment.status !== "CURRENT") {
    blockers.push(blocker(
      "EMPLOYMENT_NOT_CURRENT",
      `employment status is ${candidate.employment.status}`,
      candidate.employment.assertionIds,
    ));
  }
  if (tierA && !employmentFresh) {
    blockers.push(blocker(
      "EMPLOYMENT_EXPIRED",
      `employment evidence is outside the ${EMPLOYMENT_TTL_DAYS}-day policy TTL`,
      candidate.employment.assertionIds,
    ));
  }
  if (tierA && (candidate.employment.conflict || candidate.employment.status === "CONFLICT" || candidate.conflicts.length > 0)) {
    blockers.push(blocker(
      "EMPLOYMENT_CONFLICT",
      "contact has unresolved employment or identity conflicts",
      candidate.employment.assertionIds,
    ));
  }
  if ((tierA && candidate.email.status !== "VALID") || (tierB && candidate.email.status === "INVALID")) {
    blockers.push(blocker(
      "EMAIL_NOT_VALID",
      `email verification status is ${candidate.email.status}`,
      candidate.email.assertionIds,
    ));
  }
  if (!candidate.email.workEmail) {
    blockers.push(blocker("EMAIL_NOT_WORK", "email is not verified as a work address", candidate.email.assertionIds));
  }
  if (!emailFresh) {
    blockers.push(blocker(
      "EMAIL_VERIFICATION_EXPIRED",
      `email verification is outside the ${EMAIL_VERIFICATION_TTL_DAYS}-day policy TTL`,
      candidate.email.assertionIds,
    ));
  }
  if (tierA && (
    !candidate.email.independentlyVerified ||
    candidate.email.discoverySourceKey.trim().toLowerCase() === candidate.email.verifierSourceKey.trim().toLowerCase()
  )) {
    blockers.push(blocker(
      "EMAIL_NOT_INDEPENDENT",
      "mailbox verdict is not independent from email discovery",
      candidate.email.assertionIds,
    ));
  }
  if (!candidate.email.domainMatchesAccount) {
    blockers.push(blocker("EMAIL_DOMAIN_MISMATCH", "email domain does not match the account", candidate.email.assertionIds));
  }
  if (tierA && candidate.email.roleAddress) {
    blockers.push(blocker("EMAIL_ROLE_ADDRESS", "role-based mailboxes are not sendable", candidate.email.assertionIds));
  }
  if (tierB) {
    const emailDomain = candidate.email.address.split("@").at(-1) ?? "";
    let sourceDomain = "";
    try {
      const sourceHost = new URL(candidate.email.officialSourceUrl ?? "").hostname;
      sourceDomain = getDomain(sourceHost, { allowPrivateDomains: true }) ?? sourceHost.replace(/^www\./, "");
    } catch {
      sourceDomain = "";
    }
    const registeredEmailDomain = getDomain(emailDomain, { allowPrivateDomains: true }) ?? emailDomain;
    if (!candidate.email.roleAddress || !candidate.email.officiallyPublished ||
      !candidate.email.officialSourceUrl || !candidate.email.officialObservedAt ||
      !candidate.email.officialEvidenceHash || sourceDomain.toLowerCase() !== registeredEmailDomain.toLowerCase()) {
      blockers.push(blocker(
        "EMAIL_OFFICIAL_PUBLICATION_MISSING",
        "tier B requires an exact, current official-site mailbox publication",
        candidate.email.assertionIds,
      ));
    }
  }
  if (candidate.email.disposable) {
    blockers.push(blocker("EMAIL_DISPOSABLE", "disposable mailboxes are not sendable", candidate.email.assertionIds));
  }
  if (tierA && candidate.email.catchAll) {
    blockers.push(blocker("EMAIL_CATCH_ALL", "catch-all mailboxes are not sendable", candidate.email.assertionIds));
  }
  if (candidate.email.conflict) {
    blockers.push(blocker("EMAIL_CONFLICT", "email assertions conflict", candidate.email.assertionIds));
  }
  if (candidate.dncMatch) blockers.push(blocker("DNC_MATCH", "contact matches do-not-contact policy"));
  if (candidate.excluded) blockers.push(blocker("EXCLUSION_MATCH", "contact matches an exclusion policy"));
  if (candidate.ownershipConflict) blockers.push(blocker("OWNERSHIP_CONFLICT", "contact ownership is unresolved"));

  const recencyEpochMs = Math.min(
    Date.parse(candidate.employment.observedAt),
    Date.parse(candidate.email.observedAt),
    Date.parse(candidate.lastEvidenceAt),
  );

  return {
    contact: candidate,
    sendable: blockers.length === 0,
    blockers,
    dimensions: {
      emailStatusRank: emailStatusRanks[candidate.email.status],
      currentFreshEmploymentRank: candidate.employment.status === "CURRENT" ? (employmentFresh ? 2 : 1) : 0,
      roleRelevance,
      seniorityRank: seniorityRanks[candidate.seniority],
      confidence: Math.min(
        candidate.evidenceConfidence,
        candidate.employment.confidence,
        candidate.email.confidence,
      ),
      recencyEpochMs,
    },
  };
}

function compareRankedContacts(left: RankedContact, right: RankedContact): number {
  if (left.sendable !== right.sendable) return left.sendable ? -1 : 1;
  const dimensions: Array<keyof RankedContact["dimensions"]> = [
    "emailStatusRank",
    "currentFreshEmploymentRank",
    "roleRelevance",
    "seniorityRank",
    "confidence",
    "recencyEpochMs",
  ];
  for (const dimension of dimensions) {
    const difference = right.dimensions[dimension] - left.dimensions[dimension];
    if (difference !== 0) return difference;
  }
  return left.contact.id.localeCompare(right.contact.id);
}

export function rankSendableContacts(
  candidatesInput: readonly ContactCandidate[],
  contextInput: ContactRankingContext,
): RankedContact[] {
  const candidates = parseContactCandidates(candidatesInput);
  const context = contactRankingContextSchema.parse(contextInput);
  return candidates
    .map((candidate) => assessContactCandidate(candidate, context))
    .sort(compareRankedContacts);
}
