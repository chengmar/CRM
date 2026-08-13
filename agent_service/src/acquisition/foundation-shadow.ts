import { AgentDatabase, type AcquisitionFoundationSummary } from "../db.js";

export interface AcquisitionFoundationShadowResult {
  ok: boolean;
  checks: {
    canonicalAccountDeduplicated: boolean;
    multiPlayEnrollmentSupported: boolean;
    intakeIdempotent: boolean;
    opportunityIdempotent: boolean;
    salesTaskIdempotent: boolean;
    externalActionsAttempted: false;
  };
  summary: AcquisitionFoundationSummary;
}

export function runAcquisitionFoundationShadow(): AcquisitionFoundationShadowResult {
  const shadow = new AgentDatabase(":memory:");
  try {
    const accountId = shadow.upsertAccount({
      domain: "shadow-buyer.example",
      displayName: "Shadow Buyer One",
      website: "https://shadow-buyer.example",
      countryCode: "MY",
      accountType: "INTEGRATOR",
      source: "fixture",
    });
    const duplicateAccountId = shadow.upsertAccount({
      domain: "www.shadow-buyer.example",
      displayName: "Shadow Buyer One Updated",
      countryCode: "MY",
      accountType: "INTEGRATOR",
      source: "fixture-replay",
    });

    const firstPlay = shadow.upsertPlay({
      key: "my-integrator-sample-product",
      name: "Malaysia integrator sample product",
      country: "MY",
      buyerArchetype: "SYSTEM_INTEGRATOR_EPC",
      application: "sample use case",
      productFamily: "Sample Product A",
      roleFamily: "TECHNICAL_ENGINEERING",
      qualificationTrack: "ICP_FIT",
      offer: "approved application checklist",
      channel: "EMAIL",
      status: "SHADOW",
      approvalPolicy: "REVIEW_ALL",
      definition: { fixture: true },
      createdBy: "acquisition-shadow",
    });
    const secondPlay = shadow.upsertPlay({
      key: "my-distributor-sample-components",
      name: "Malaysia distributor sample components",
      country: "MY",
      buyerArchetype: "DISTRIBUTOR",
      application: "replacement requirement",
      productFamily: "sample component B",
      roleFamily: "PRODUCT",
      qualificationTrack: "WATCHLIST",
      offer: "approved RFQ checklist",
      channel: "EMAIL",
      status: "SHADOW",
      approvalPolicy: "REVIEW_ALL",
      definition: { fixture: true },
      createdBy: "acquisition-shadow",
    });
    shadow.enrollAccountInPlay({
      accountId,
      playVersionId: firstPlay.playVersionId,
      status: "RESEARCHING",
      qualificationTrack: "ICP_FIT",
      source: "fixture",
    });
    shadow.enrollAccountInPlay({
      accountId,
      playVersionId: secondPlay.playVersionId,
      status: "WATCHLIST",
      qualificationTrack: "WATCHLIST",
      source: "fixture",
    });

    const intakeInput = {
      source: "WEB_FORM" as const,
      providerEventId: "shadow-form-001",
      sender: "buyer@shadow-buyer.example",
      recipient: "sales@supplier.example",
      subject: "RFQ",
      bodyText: "Please quote two Sample Product C and confirm the delivery schedule.",
      receivedAt: "2026-07-20T00:00:00.000Z",
      classification: "P1_INQUIRY",
      accountId,
      correlationMethod: "verified_form_domain",
      correlationConfidence: 0.95,
      rawHeaders: { fixture: true },
    };
    const intake = shadow.upsertInquiryIntake(intakeInput);
    const duplicateIntake = shadow.upsertInquiryIntake(intakeInput);
    const opportunityInput = {
      idempotencyKey: `shadow-opportunity:${intake.id}`,
      source: "WEB_FORM",
      accountId,
      intakeId: intake.id,
      stage: "INQUIRY_QUALIFIED" as const,
      owner: "shadow-owner",
      firstResponseDueAt: "2026-07-20T00:15:00.000Z",
    };
    const opportunity = shadow.createOrGetOpportunity(opportunityInput);
    const duplicateOpportunity = shadow.createOrGetOpportunity(opportunityInput);
    const taskInput = {
      idempotencyKey: `shadow-task:${opportunity.id}:followup`,
      taskType: "INQUIRY_FOLLOWUP" as const,
      owner: "shadow-owner",
      dueAt: "2026-07-20T00:15:00.000Z",
      accountId,
      opportunityId: opportunity.id,
      sourceSignal: "P1_INQUIRY",
      payload: { fixture: true },
    };
    const task = shadow.createOrGetSalesTask(taskInput);
    const duplicateTask = shadow.createOrGetSalesTask(taskInput);
    const summary = shadow.getAcquisitionFoundationSummary();
    const checks = {
      canonicalAccountDeduplicated: accountId === duplicateAccountId && summary.accounts === 1,
      multiPlayEnrollmentSupported:
        shadow.listAccountPlayEnrollments(accountId).length === 2 && summary.playEnrollments === 2,
      intakeIdempotent: intake.inserted && !duplicateIntake.inserted && intake.id === duplicateIntake.id,
      opportunityIdempotent:
        opportunity.created && !duplicateOpportunity.created && opportunity.id === duplicateOpportunity.id,
      salesTaskIdempotent: task.created && !duplicateTask.created && task.id === duplicateTask.id,
      externalActionsAttempted: false as const,
    };
    const ok = checks.canonicalAccountDeduplicated &&
      checks.multiPlayEnrollmentSupported &&
      checks.intakeIdempotent &&
      checks.opportunityIdempotent &&
      checks.salesTaskIdempotent &&
      checks.externalActionsAttempted === false;
    return { ok, checks, summary };
  } finally {
    shadow.close();
  }
}
