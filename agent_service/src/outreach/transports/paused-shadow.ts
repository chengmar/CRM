import { createHash } from "node:crypto";
import {
  reconcileTransportEvents,
  stagePausedTransportCampaign,
  transportContentHash,
  type PausedTransportStageResult,
  type TransportReconcileResult,
} from "./contracts.js";

export interface PausedTransportShadowReport {
  fixtureSet: "paused-transport-shadow-v1";
  staged: PausedTransportStageResult;
  reconcile: TransportReconcileResult;
  totals: { recipients: 20; stagedRecipients: number; blockedRecipients: number };
  safety: { adapterCalls: 0; networkCalls: 0; externalWrites: 0; messagesSent: 0; campaignsActivated: 0 };
  verdict: "BLOCKED_EXTERNAL";
  reason: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function runPausedTransportShadow(): PausedTransportShadowReport {
  const recipients = Array.from({ length: 20 }, (_, index) => {
    const subject = `Fixture subject ${index}`;
    const body = `Fixture evidence-bound body ${index}`;
    const reviewHash = hash(`review-${index}`);
    return {
      recipientId: `recipient-${index}`,
      accountId: `account-${index}`,
      contactId: `contact-${index}`,
      messageId: `message-${index}`,
      email: index === 19 ? "fixture-18@example.com" : `fixture-${index}@example.com`,
      emailStatus: index === 16 ? "RISKY" as const : "VALID" as const,
      dncMatch: index === 15,
      ownershipConflict: false,
      humanTakeover: index === 17,
      approved: true,
      approvedReviewHash: reviewHash,
      currentReviewHash: reviewHash,
      dossierVersion: 1,
      experimentArm: "fixture-a",
      sequenceIndex: 0,
      subject,
      body,
      contentHash: index === 18 ? "0".repeat(64) : transportContentHash(subject, body),
    };
  });
  const staged = stagePausedTransportCampaign({
    campaignId: "transport-shadow-campaign",
    transport: "INSTANTLY",
    requestedMode: "PAUSED",
    activationRequested: false,
    openTracking: false,
    clickTracking: false,
    replyStopEnabled: true,
    companyStopEnabled: true,
    recipients,
  });
  const states = Object.fromEntries(staged.recipients.filter((item) => item.staged).map((item) => [
    item.recipientId,
    { status: "STAGED_PAUSED" as const, stoppedAt: null },
  ]));
  const reconcile = reconcileTransportEvents(
    { seenEventIds: [], recipients: states },
    [
      { providerEventId: "event-reply-1", recipientId: "recipient-1", eventType: "REPLY", occurredAt: "2026-07-20T00:00:00.000Z" },
      { providerEventId: "event-reply-1", recipientId: "recipient-1", eventType: "REPLY", occurredAt: "2026-07-20T00:00:00.000Z" },
      { providerEventId: "event-unknown", recipientId: "recipient-2", eventType: "UNKNOWN", occurredAt: "2026-07-20T00:00:00.000Z" },
    ],
    "2026-07-20T00:00:30.000Z",
  );
  const stagedRecipients = staged.recipients.filter((item) => item.staged).length;
  return {
    fixtureSet: "paused-transport-shadow-v1",
    staged,
    reconcile,
    totals: { recipients: 20, stagedRecipients, blockedRecipients: 20 - stagedRecipients },
    safety: { adapterCalls: 0, networkCalls: 0, externalWrites: 0, messagesSent: 0, campaignsActivated: 0 },
    verdict: "BLOCKED_EXTERNAL",
    reason: "Only local paused staging is implemented; credentials, upload and activation require separate authorization.",
  };
}
