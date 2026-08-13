import { createHash } from "node:crypto";
import { z } from "zod";

const DateTimeSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ManualChannelCandidateSchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  accountId: z.string().trim().min(1).max(200),
  personId: z.string().trim().min(1).max(200),
  accountName: z.string().trim().min(1).max(300),
  buyerType: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  roleRelevant: z.boolean(),
  profileUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !/[?&](?:session|cookie|token|auth)=/i.test(url.search);
  }, { message: "profile URL must be public HTTPS without login material" }),
  profileCompanyMatches: z.boolean(),
  employmentVerifiedAt: DateTimeSchema.nullable(),
  employmentExpiresAt: DateTimeSchema.nullable(),
  evidence: z.object({
    exactQuote: z.string().trim().min(1).max(1_000),
    sourceUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    contentHash: Sha256Schema,
    public: z.boolean(),
  }).strict(),
  suggestedConnectionText: z.string().trim().min(1).max(300),
  citedFactIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  dncMatch: z.boolean(),
  excluded: z.boolean(),
  ownershipConflict: z.boolean(),
  asOf: DateTimeSchema,
}).strict();

export interface ManualChannelTaskPlan {
  taskId: string;
  status: "READY_FOR_HUMAN_REVIEW" | "VERIFY_REQUIRED" | "BLOCKED";
  blockers: string[];
  suggestedConnectionText: string | null;
  idempotencyKey: string;
  externalAction: "NONE";
  requiresHumanAction: true;
  automatedLinkedInRequest: false;
  automatedMessage: false;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createManualChannelTaskPlan(rawInput: unknown): ManualChannelTaskPlan {
  const input = ManualChannelCandidateSchema.parse(rawInput);
  const blockers: string[] = [];
  const asOf = Date.parse(input.asOf);
  if (!input.profileCompanyMatches) blockers.push("PROFILE_COMPANY_MISMATCH");
  if (!input.roleRelevant) blockers.push("ROLE_NOT_RELEVANT");
  if (!input.employmentVerifiedAt || !input.employmentExpiresAt ||
    Date.parse(input.employmentVerifiedAt) > asOf || Date.parse(input.employmentExpiresAt) < asOf) {
    blockers.push("EMPLOYMENT_VERIFY_REQUIRED");
  }
  if (!input.evidence.public) blockers.push("EVIDENCE_NOT_PUBLIC");
  if (input.dncMatch) blockers.push("DNC_MATCH");
  if (input.excluded) blockers.push("EXCLUSION_MATCH");
  if (input.ownershipConflict) blockers.push("OWNERSHIP_CONFLICT");
  const verifyOnly = blockers.length > 0 && blockers.every((blocker) =>
    ["PROFILE_COMPANY_MISMATCH", "ROLE_NOT_RELEVANT", "EMPLOYMENT_VERIFY_REQUIRED"].includes(blocker),
  );
  const status = blockers.length === 0
    ? "READY_FOR_HUMAN_REVIEW"
    : verifyOnly
      ? "VERIFY_REQUIRED"
      : "BLOCKED";
  return {
    taskId: input.taskId,
    status,
    blockers,
    suggestedConnectionText: status === "READY_FOR_HUMAN_REVIEW"
      ? input.suggestedConnectionText
      : null,
    idempotencyKey: stableHash({
      accountId: input.accountId,
      personId: input.personId,
      taskType: "LINKEDIN_REVIEW",
      profileUrl: input.profileUrl,
    }),
    externalAction: "NONE",
    requiresHumanAction: true,
    automatedLinkedInRequest: false,
    automatedMessage: false,
  };
}

export interface ManualChannelShadowReport {
  fixtureSet: "manual-channel-shadow-v1";
  candidates: 100;
  readyForHumanReview: number;
  verifyRequired: number;
  blocked: number;
  duplicateTaskKeys: number;
  safety: { profileRequests: 0; connectionRequests: 0; messages: 0; browserAutomation: 0; externalWrites: 0 };
  verdict: "HOLD";
  reason: string;
}

export function runManualChannelShadow(): ManualChannelShadowReport {
  const plans = Array.from({ length: 100 }, (_, index) => createManualChannelTaskPlan({
    taskId: `manual-task-${index}`,
    accountId: `account-${index}`,
    personId: `person-${index}`,
    accountName: `Fixture Account ${index}`,
    buyerType: "SYSTEM_INTEGRATOR_EPC",
    contactName: `Fixture Contact ${index}`,
    title: index < 90 ? "Engineering Manager" : "Finance Analyst",
    roleRelevant: index < 90,
    profileUrl: `https://www.linkedin.com/in/fixture-${index}`,
    profileCompanyMatches: index < 95,
    employmentVerifiedAt: index < 95 ? "2026-07-01T00:00:00.000Z" : null,
    employmentExpiresAt: index < 95 ? "2026-09-01T00:00:00.000Z" : null,
    evidence: {
      exactQuote: "Public fixture role evidence.",
      sourceUrl: `https://fixture.invalid/contact/${index}`,
      contentHash: stableHash(`fixture-${index}`),
      public: true,
    },
    suggestedConnectionText: "I work with sample product use cases and would value connecting.",
    citedFactIds: [`fact-${index}`],
    dncMatch: false,
    excluded: false,
    ownershipConflict: false,
    asOf: "2026-07-20T00:00:00.000Z",
  }));
  const keys = plans.map((plan) => plan.idempotencyKey);
  return {
    fixtureSet: "manual-channel-shadow-v1",
    candidates: 100,
    readyForHumanReview: plans.filter((plan) => plan.status === "READY_FOR_HUMAN_REVIEW").length,
    verifyRequired: plans.filter((plan) => plan.status === "VERIFY_REQUIRED").length,
    blocked: plans.filter((plan) => plan.status === "BLOCKED").length,
    duplicateTaskKeys: keys.length - new Set(keys).size,
    safety: { profileRequests: 0, connectionRequests: 0, messages: 0, browserAutomation: 0, externalWrites: 0 },
    verdict: "HOLD",
    reason: "Public fixture task quality is measurable, but no real manual pilot or platform action is authorized.",
  };
}
