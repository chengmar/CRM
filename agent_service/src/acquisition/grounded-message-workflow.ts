import { z } from "zod";
import type { AgentDatabase } from "../db.js";
import {
  EvidenceFactSchema,
  PageSnapshotSchema,
  type EvidenceFact,
  type PageSnapshot,
} from "./evidence.js";
import {
  parseQualificationInput,
  type QualificationDecision,
  type QualificationInput,
} from "./models.js";
import {
  MESSAGE_GROUNDING_LINT_VERSION,
  PersonalizationPlanSchema,
  compileGroundedMessage,
  lintGroundedMessage,
  type MessageLintResult,
  type PersonalizationPlan,
} from "./message-grounding.js";
import { evaluateQualification } from "./qualification.js";
import {
  SellerKnowledgeDocumentSchema,
  SellerKnowledgeStore,
} from "./seller-knowledge.js";

export const GROUNDED_COMPILER_VERSION = "grounded-message-compiler-v1" as const;

const EmailSchema = z.string().trim().email().max(320);
const IdSchema = z.string().trim().min(1).max(200);

export const GroundedMessageJobPayloadSchema = z.object({
  plan: PersonalizationPlanSchema,
  evidenceFacts: z.array(EvidenceFactSchema).min(1).max(500),
  snapshots: z.array(PageSnapshotSchema).min(1).max(500),
  sellerKnowledge: SellerKnowledgeDocumentSchema,
  qualificationInput: z.unknown(),
  destination: EmailSchema,
  messageKey: IdSchema.optional(),
  planKey: IdSchema.optional(),
  sequenceIndex: z.number().int().min(0).max(100).optional(),
  personId: IdSchema.nullable().optional(),
  enrollmentId: IdSchema.nullable().optional(),
  dossierVersionId: IdSchema.nullable().optional(),
  experiment: z.object({
    experimentId: IdSchema,
    subjectType: z.enum(["ACCOUNT", "PERSON", "PLAY_ENROLLMENT"]),
    subjectId: IdSchema,
  }).strict().nullable().optional(),
  campaignSendAuthorizationId: IdSchema.optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  evaluatorVersion: IdSchema.optional(),
  createdBy: IdSchema,
  replyChatId: z.string().trim().max(300).optional(),
}).strict();

export interface GroundedMessageJobReview {
  accountId: string;
  leadId: string;
  contactId: string;
  qualificationTrack: PersonalizationPlan["qualificationTrack"];
  locale: string;
  destination: string;
  subject: string;
  body: string;
  referencedFactIds: string[];
}

export interface GroundedMessageJobResult extends StageGroundedMessageResult {
  review: GroundedMessageJobReview | null;
}

export interface StageGroundedMessageInput {
  db: AgentDatabase;
  plan: unknown;
  evidenceFacts: readonly EvidenceFact[];
  snapshots: readonly PageSnapshot[];
  sellerStore: SellerKnowledgeStore;
  qualificationInput: unknown;
  destination: string;
  messageKey?: string;
  planKey?: string;
  sequenceIndex?: number;
  personId?: string | null;
  enrollmentId?: string | null;
  dossierVersionId?: string | null;
  experiment?: {
    experimentId: string;
    subjectType: "ACCOUNT" | "PERSON" | "PLAY_ENROLLMENT";
    subjectId: string;
  } | null;
  createdBy: string;
  now?: Date;
}

export interface StageGroundedMessageResult {
  status: "PENDING_APPROVAL" | "NEEDS_REWRITE" | "LINT_FAILED";
  qualificationRunId: string | null;
  experimentAssignmentId: string | null;
  experimentArm: string | null;
  planId: string | null;
  messageVersionId: string | null;
  planVersion: number | null;
  messageVersion: number | null;
  reviewHash: string | null;
  reviewCardId: string | null;
  reviewExpiresAt: string | null;
  campaignSendAuthorizationId: string | null;
  campaignMessageAuthorizationId: string | null;
  outboundMessageId: string | null;
  outboundStatus: "APPROVED" | null;
  lint: MessageLintResult;
  qualification: QualificationDecision | null;
  externalSendAuthorized: boolean;
}

function blockedResult(
  status: "NEEDS_REWRITE" | "LINT_FAILED",
  blockers: string[],
): StageGroundedMessageResult {
  return {
    status,
    qualificationRunId: null,
    experimentAssignmentId: null,
    experimentArm: null,
    planId: null,
    messageVersionId: null,
    planVersion: null,
    messageVersion: null,
    reviewHash: null,
    reviewCardId: null,
    reviewExpiresAt: null,
    campaignSendAuthorizationId: null,
    campaignMessageAuthorizationId: null,
    outboundMessageId: null,
    outboundStatus: null,
    lint: {
      passed: false,
      status,
      blockers: [...new Set(blockers)].sort(),
      warnings: [],
      referencedFactIds: [],
    },
    qualification: null,
    externalSendAuthorized: false,
  };
}

export function stageGroundedMessageForApproval(
  input: StageGroundedMessageInput,
): StageGroundedMessageResult {
  const planResult = PersonalizationPlanSchema.safeParse(input.plan);
  if (!planResult.success) {
    return blockedResult("NEEDS_REWRITE", planResult.error.issues.map((issue) =>
      `PERSONALIZATION_PLAN_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
  }
  const plan: PersonalizationPlan = planResult.data;
  const createdByResult = IdSchema.safeParse(input.createdBy);
  const destinationResult = EmailSchema.safeParse(input.destination);
  const blockers: string[] = [];
  if (!createdByResult.success) blockers.push("GROUNDED_WORKFLOW_CREATOR_INVALID");
  if (!destinationResult.success) blockers.push("GROUNDED_WORKFLOW_DESTINATION_INVALID");
  if (plan.channel !== "EMAIL") blockers.push("GROUNDED_WORKFLOW_EMAIL_CHANNEL_REQUIRED");
  if (blockers.length > 0 || !createdByResult.success || !destinationResult.success) {
    return blockedResult("NEEDS_REWRITE", blockers);
  }

  const draft = compileGroundedMessage(plan);
  const lint = lintGroundedMessage({
    plan,
    draft,
    evidenceFacts: input.evidenceFacts,
    snapshots: input.snapshots,
    sellerStore: input.sellerStore,
    now: input.now,
  });
  if (!lint.passed || lint.status !== "PENDING_APPROVAL") {
    return {
      status: lint.status,
      qualificationRunId: null,
      experimentAssignmentId: null,
      experimentArm: null,
      planId: null,
      messageVersionId: null,
      planVersion: null,
      messageVersion: null,
      reviewHash: null,
      reviewCardId: null,
      reviewExpiresAt: null,
      campaignSendAuthorizationId: null,
      campaignMessageAuthorizationId: null,
      outboundMessageId: null,
      outboundStatus: null,
      lint,
      qualification: null,
      externalSendAuthorized: false,
    };
  }

  let qualification: QualificationDecision;
  let qualificationInput: QualificationInput;
  try {
    qualificationInput = parseQualificationInput(input.qualificationInput);
    const qualificationBlockers: string[] = [];
    if (qualificationInput.account.id !== plan.accountId) {
      qualificationBlockers.push("QUALIFICATION_ACCOUNT_MISMATCH");
    }
    if (qualificationInput.contact.id !== plan.contactId ||
      qualificationInput.contact.accountId !== plan.accountId) {
      qualificationBlockers.push("QUALIFICATION_CONTACT_MISMATCH");
    }
    if (qualificationInput.contact.email.address.toLowerCase() !== destinationResult.data.toLowerCase()) {
      qualificationBlockers.push("QUALIFICATION_DESTINATION_MISMATCH");
    }
    if (qualificationInput.policyVersion !== plan.versions.qualificationPolicyVersion) {
      qualificationBlockers.push("QUALIFICATION_POLICY_VERSION_MISMATCH");
    }
    if (qualificationBlockers.length > 0) return blockedResult("NEEDS_REWRITE", qualificationBlockers);
    qualification = evaluateQualification({
      ...qualificationInput,
      message: {
        draftText: draft.body,
        grounded: true,
        citedFactIds: draft.referencedFactIds,
        unsupportedFactIds: [],
      },
    });
  } catch (error) {
    return blockedResult("NEEDS_REWRITE", [
      `QUALIFICATION_INPUT_INVALID:${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (!qualification.eligible || qualification.track !== plan.qualificationTrack ||
    qualification.policyVersion !== plan.versions.qualificationPolicyVersion) {
    return {
      ...blockedResult("LINT_FAILED", [
        ...(qualification.blockers.map((blocker) => `QUALIFICATION_BLOCKED:${blocker.code}`)),
        ...(!qualification.eligible ? ["QUALIFICATION_NOT_ELIGIBLE"] : []),
        ...(qualification.track !== plan.qualificationTrack ? ["QUALIFICATION_TRACK_MISMATCH"] : []),
        ...(qualification.policyVersion !== plan.versions.qualificationPolicyVersion
          ? ["QUALIFICATION_POLICY_VERSION_MISMATCH"]
          : []),
      ]),
      qualification,
    };
  }

  if (input.experiment) {
    const expectedSubjectId = input.experiment.subjectType === "ACCOUNT"
      ? plan.accountId
      : input.experiment.subjectType === "PERSON"
        ? input.personId ?? null
        : input.enrollmentId ?? null;
    if (!expectedSubjectId || input.experiment.subjectId !== expectedSubjectId) {
      return blockedResult("NEEDS_REWRITE", ["EXPERIMENT_SUBJECT_MISMATCH"]);
    }
  }

  const persistence = input.db.runInTransaction(() => {
    const experimentAssignment = input.experiment
      ? input.db.assignExperimentArm(input.experiment)
      : null;
    const qualificationRun = input.db.saveQualificationRun({
      idempotencyKey: `grounded-qualification:${plan.id}:${qualificationInput.asOf}`,
      accountId: plan.accountId,
      enrollmentId: input.enrollmentId ?? null,
      qualificationTrack: qualification.track,
      policyVersion: qualification.policyVersion,
      decision: "QUALIFIED",
      evidenceFactIds: qualificationInput.evidenceFacts.map((fact) => fact.id),
      result: qualification as unknown as Record<string, unknown>,
      startedAt: qualificationInput.asOf,
      // Keep the persisted qualification record stable across a post-commit job retry.
      completedAt: qualificationInput.asOf,
    });
    const planPersistence = input.db.savePersonalizationPlan({
      planKey: input.planKey ?? `grounded:${plan.accountId}:${plan.contactId}`,
      accountId: plan.accountId,
      personId: input.personId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      leadId: plan.leadId,
      contactId: plan.contactId,
      qualificationTrack: plan.qualificationTrack,
      qualificationPolicyVersion: plan.versions.qualificationPolicyVersion,
      dossierVersionId: input.dossierVersionId ?? null,
      sellerFactSetVersion: String(plan.versions.sellerFactSetVersion),
      locale: plan.locale,
      plan,
      factIds: draft.referencedFactIds,
      createdBy: createdByResult.data,
      status: "VALID",
    });
    const messagePersistence = input.db.saveMessageVersion({
      messageKey: input.messageKey ?? `grounded:${plan.accountId}:${plan.contactId}:${input.sequenceIndex ?? 0}`,
      personalizationPlanId: planPersistence.id,
      subject: draft.subject,
      body: draft.body,
      destination: destinationResult.data,
      sequenceIndex: input.sequenceIndex ?? 0,
      generationMode: draft.generationMode,
      promptVersion: "deterministic-no-prompt",
      model: "deterministic-no-model",
      templateVersion: GROUNDED_COMPILER_VERSION,
      lintVersion: MESSAGE_GROUNDING_LINT_VERSION,
      lintResult: lint as unknown as Record<string, unknown>,
      angle: plan.angle,
      locale: plan.locale,
      experimentVariant: experimentAssignment?.arm ?? null,
      dossierVersionId: input.dossierVersionId ?? null,
      sellerFactSetVersion: String(plan.versions.sellerFactSetVersion),
      factIds: draft.referencedFactIds,
      createdBy: createdByResult.data,
      status: "PENDING_APPROVAL",
    });
    const reviewCard = input.db.issueGroundedMessageReviewCard({
      messageVersionId: messagePersistence.id,
      reviewHash: messagePersistence.reviewHash,
    });
    return { qualificationRun, experimentAssignment, planPersistence, messagePersistence, reviewCard };
  });
  return {
    status: "PENDING_APPROVAL",
    qualificationRunId: persistence.qualificationRun.id,
    experimentAssignmentId: persistence.experimentAssignment?.id ?? null,
    experimentArm: persistence.experimentAssignment?.arm ?? null,
    planId: persistence.planPersistence.id,
    messageVersionId: persistence.messagePersistence.id,
    planVersion: persistence.planPersistence.versionNumber,
    messageVersion: persistence.messagePersistence.versionNumber,
    reviewHash: persistence.messagePersistence.reviewHash,
    reviewCardId: persistence.reviewCard.id,
    reviewExpiresAt: persistence.reviewCard.expiresAt,
    campaignSendAuthorizationId: null,
    campaignMessageAuthorizationId: null,
    outboundMessageId: null,
    outboundStatus: null,
    lint,
    qualification,
    externalSendAuthorized: false,
  };
}

export function stageGroundedMessageJobForApproval(input: {
  db: AgentDatabase;
  payload: unknown;
  now?: Date;
}): GroundedMessageJobResult {
  const payload = GroundedMessageJobPayloadSchema.parse(input.payload);
  const now = input.now ?? new Date();
  const sellerStore = new SellerKnowledgeStore(payload.sellerKnowledge, now);
  const staged = input.db.runInTransaction(() => {
    const grounded = stageGroundedMessageForApproval({
      db: input.db,
      plan: payload.plan,
      evidenceFacts: payload.evidenceFacts,
      snapshots: payload.snapshots,
      sellerStore,
      qualificationInput: payload.qualificationInput,
      destination: payload.destination,
      messageKey: payload.messageKey,
      planKey: payload.planKey,
      sequenceIndex: payload.sequenceIndex,
      personId: payload.personId,
      enrollmentId: payload.enrollmentId,
      dossierVersionId: payload.dossierVersionId,
      experiment: payload.experiment,
      createdBy: payload.createdBy,
      now,
    });
    if (grounded.status !== "PENDING_APPROVAL" || !payload.campaignSendAuthorizationId) {
      return grounded;
    }
    if (!grounded.messageVersionId) {
      throw new Error("A grounded message version is required before campaign authorization");
    }
    if (grounded.qualification?.track === "ICP_FIT" && grounded.qualificationRunId && grounded.planId) {
      input.db.promoteLeadFromGroundedQualification({
        leadId: payload.plan.leadId,
        qualificationRunId: grounded.qualificationRunId,
        personalizationPlanId: grounded.planId,
        qualificationTrack: "ICP_FIT",
        policyVersion: grounded.qualification.policyVersion,
      });
    }
    const authorized = input.db.authorizeGroundedMessageForCampaign({
      campaignSendAuthorizationId: payload.campaignSendAuthorizationId,
      messageVersionId: grounded.messageVersionId,
      scheduledAt: payload.scheduledAt ?? now.toISOString(),
      evaluatorVersion: payload.evaluatorVersion ?? "campaign-message-gate-v1",
    });
    return {
      ...grounded,
      campaignSendAuthorizationId: payload.campaignSendAuthorizationId,
      campaignMessageAuthorizationId: authorized.id,
      outboundMessageId: authorized.outboundMessageId,
      outboundStatus: "APPROVED" as const,
      externalSendAuthorized: true,
    };
  });
  if (staged.status !== "PENDING_APPROVAL") return { ...staged, review: null };

  const draft = compileGroundedMessage(payload.plan);
  return {
    ...staged,
    review: {
      accountId: payload.plan.accountId,
      leadId: payload.plan.leadId,
      contactId: payload.plan.contactId,
      qualificationTrack: payload.plan.qualificationTrack,
      locale: payload.plan.locale,
      destination: payload.destination,
      subject: draft.subject,
      body: draft.body,
      referencedFactIds: [...draft.referencedFactIds],
    },
  };
}
