import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  reconcileTransportEvents,
  stagePausedTransportCampaign,
  transportContentHash,
  verifyTransportWebhook,
} from "../src/outreach/transports/contracts.js";
import { runPausedTransportShadow } from "../src/outreach/transports/paused-shadow.js";

function recipient(overrides: Record<string, unknown> = {}) {
  const subject = "Fixture";
  const body = "Evidence-bound fixture body";
  const reviewHash = "a".repeat(64);
  return {
    recipientId: "recipient-1",
    accountId: "account-1",
    contactId: "contact-1",
    messageId: "message-1",
    email: "buyer@example.com",
    emailStatus: "VALID",
    dncMatch: false,
    ownershipConflict: false,
    humanTakeover: false,
    approved: true,
    approvedReviewHash: reviewHash,
    currentReviewHash: reviewHash,
    dossierVersion: 1,
    experimentArm: "fixture-a",
    sequenceIndex: 0,
    subject,
    body,
    contentHash: transportContentHash(subject, body),
    ...overrides,
  };
}

describe("WO-14 paused transport shadow", () => {
  it("stages only VALID, approved, hash-matching and non-DNC recipients", () => {
    const result = stagePausedTransportCampaign({
      campaignId: "campaign-1",
      transport: "INSTANTLY",
      requestedMode: "PAUSED",
      activationRequested: false,
      openTracking: false,
      clickTracking: false,
      replyStopEnabled: true,
      companyStopEnabled: true,
      recipients: [recipient(), recipient({ recipientId: "recipient-2", email: "risky@example.com", emailStatus: "RISKY" })],
    });
    expect(result).toMatchObject({ status: "STAGED_PAUSED", activationAllowed: false, adapterCalls: 0 });
    expect(result.recipients).toEqual([
      expect.objectContaining({ recipientId: "recipient-1", staged: true, blockers: [] }),
      expect.objectContaining({ recipientId: "recipient-2", staged: false, blockers: ["EMAIL_NOT_INDEPENDENT_VALID"] }),
    ]);
  });

  it("blocks active mode, tracking and duplicate recipients", () => {
    const result = stagePausedTransportCampaign({
      campaignId: "campaign-1",
      transport: "INSTANTLY",
      requestedMode: "ACTIVE",
      activationRequested: true,
      openTracking: true,
      clickTracking: true,
      replyStopEnabled: true,
      companyStopEnabled: true,
      recipients: [recipient(), recipient({ recipientId: "recipient-2", messageId: "message-2" })],
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.campaignBlockers).toEqual(expect.arrayContaining([
      "TRANSPORT_MUST_BE_PAUSED",
      "ACTIVATION_NOT_AUTHORIZED",
      "OPEN_CLICK_TRACKING_MUST_BE_DISABLED",
    ]));
    expect(result.recipients.every((item) => item.blockers.includes("DUPLICATE_RECIPIENT"))).toBe(true);
  });

  it("authenticates events, deduplicates replay and stops on reply", () => {
    const raw = Buffer.from('{"event":"reply"}');
    const timestamp = "1784505600";
    const secret = "fixture-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
    expect(verifyTransportWebhook({
      rawBody: raw,
      timestamp,
      signature,
      secret,
      now: new Date(Number(timestamp) * 1000),
    })).toBe(true);
    const event = { providerEventId: "event-1", recipientId: "recipient-1", eventType: "REPLY", occurredAt: "2026-07-20T00:00:00.000Z" };
    const result = reconcileTransportEvents(
      { seenEventIds: [], recipients: { "recipient-1": { status: "STAGED_PAUSED", stoppedAt: null } } },
      [event, event],
      "2026-07-20T00:00:30.000Z",
    );
    expect(result).toMatchObject({ acceptedEvents: 1, duplicateEvents: 1, unmatchedEvents: 0 });
    expect(result.state.recipients["recipient-1"]).toMatchObject({ status: "STOPPED" });
    expect(result.stopLatencyMs).toEqual([30_000]);
  });

  it("runs 20 synthetic rows with zero adapter/network/send activity", () => {
    const report = runPausedTransportShadow();
    expect(report.totals).toMatchObject({ recipients: 20 });
    expect(report.totals.blockedRecipients).toBeGreaterThan(0);
    expect(report.safety).toEqual({
      adapterCalls: 0,
      networkCalls: 0,
      externalWrites: 0,
      messagesSent: 0,
      campaignsActivated: 0,
    });
    expect(report.verdict).toBe("BLOCKED_EXTERNAL");
  });
});
