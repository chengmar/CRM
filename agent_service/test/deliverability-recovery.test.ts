import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { analyzeBounceDiagnostic } from "../src/inbound/bounce-diagnostics.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-recovery-"));
  tempDirs.push(directory);
  const db = new AgentDatabase(path.join(directory, "agent.db"));
  db.setSetting("outbound_paused", "false");
  return db;
}

function approvedMessage(db: AgentDatabase, index: number): {
  leadId: string;
  contactId: string;
  messageId: string;
  destination: string;
} {
  const suffix = `recovery-${index}`;
  const campaignId = db.createCampaign({
    name: suffix,
    market: "Test",
    product: "sample components",
    buyerType: "integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 50,
    hourlyLimit: 50,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Buyer ${index}`,
    domain: `${suffix}.example.invalid`,
    website: `https://${suffix}.example.invalid`,
    country: "Test",
    buyerType: "integrator",
    product: "sample components",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: new Date().toISOString(),
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://${suffix}.example.invalid/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "test", "verified");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "ready");
  const destination = `buyer-${index}@example.invalid`;
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${index}`,
    title: "Procurement Manager",
    email: destination,
    sourceUrl: `https://${suffix}.example.invalid/team`,
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "VALID",
    emailRisk: "fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  const messageId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination,
    subject: "Fixture",
    body: "Fixture body",
    sequenceIndex: 0,
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "reviewer", db.getSequenceReviewHash(leadId));
  return { leadId, contactId, messageId, destination };
}

function recoveryFixture(): {
  db: AgentDatabase;
  messages: ReturnType<typeof approvedMessage>[];
  incidentId: string;
} {
  const db = database();
  const messages = Array.from({ length: 60 }, (_, index) => approvedMessage(db, index));
  const historyStart = Date.parse("2026-07-20T00:00:00.000Z");
  for (let index = 0; index < 25; index += 1) {
    const status = index === 24 ? "BOUNCED" : "SENT";
    const sentAt = new Date(historyStart + index * 60_000).toISOString();
    db.db.prepare(
      "UPDATE outbound_messages SET status=?, sent_at=?, provider_message_id=?, thread_id=?, updated_at=? WHERE id=?",
    ).run(status, sentAt, `<fixture-${index}@example.invalid>`, `<fixture-${index}@example.invalid>`, sentAt, messages[index]!.messageId);
    db.db.prepare("UPDATE leads SET status='CONTACTED', updated_at=? WHERE id=?")
      .run(sentAt, messages[index]!.leadId);
  }
  const bounced = messages[24]!;
  const dsn = [
    "Final-Recipient: rfc822; buyer@example.invalid",
    "Status: 5.7.25",
    "Diagnostic-Code: smtp; 550-5.7.25 The IP address sending this message does not have a PTR record,",
    "or the corresponding forward DNS entry does not match the sending IP.",
  ].join("\n");
  const inbound = db.insertInbound({
    channel: "email",
    providerId: "dsn-recovery-fixture",
    threadId: "<fixture-24@example.invalid>",
    fromAddress: "mailer-daemon@example.invalid",
    toAddress: "sender@example.invalid",
    subject: "Delivery Status Notification",
    bodyText: dsn,
    receivedAt: "2026-07-20T01:00:00.000Z",
    classification: "BOUNCE",
    confidence: 1,
    reason: "hard delivery failure",
    leadId: bounced.leadId,
    contactId: bounced.contactId,
    outboundMessageId: bounced.messageId,
  });
  const incident = db.recordEmailBounceIncident({
    inboundMessageId: inbound.id,
    outboundMessageId: bounced.messageId,
    leadId: bounced.leadId,
    contactId: bounced.contactId,
    diagnosticSource: dsn,
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  return { db, messages, incidentId: incident.id };
}

const policy = {
  hardBounceWindowSize: 50,
  hardBounceMinimumSample: 20,
  maxHardBounceRate: 0.03,
  allowAuditedDeliverabilityRecovery: true,
};

describe("audited deliverability recovery", () => {
  it("classifies Gmail 5.7.25 forwarding DNS rejection as remote infrastructure", () => {
    const diagnostic = analyzeBounceDiagnostic([
      "Status: 5.7.25",
      "Diagnostic-Code: smtp; 550-5.7.25 The IP address sending this message does not have a PTR record,",
      "or the corresponding forward DNS entry does not match the sending IP.",
    ].join("\n"));
    expect(diagnostic).toMatchObject({
      category: "REMOTE_FORWARDING_INFRASTRUCTURE",
      enhancedStatusCode: "5.7.25",
    });
    expect(diagnostic.evidenceExcerpt).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });

  it("preserves immutable bounce facts and blocks recovery before review", () => {
    const { db, messages, incidentId } = recoveryFixture();
    expect(db.getBounceStats()).toEqual({ sent: 25, bounced: 1, rate: 0.04 });
    expect(db.listEmailBounceIncidents()).toEqual([
      expect.objectContaining({
        id: incidentId,
        outbound_message_id: messages[24]!.messageId,
        diagnostic_category: "REMOTE_FORWARDING_INFRASTRUCTURE",
        review_id: null,
      }),
    ]);
    expect(() => db.db.prepare("UPDATE email_bounce_incidents SET evidence_excerpt='changed' WHERE id=?")
      .run(incidentId)).toThrow(/immutable/i);
    expect(() => db.db.prepare("DELETE FROM email_bounce_incidents WHERE id=?").run(incidentId))
      .toThrow(/immutable/i);
    expect(() => db.authorizeDeliverabilityRecovery({
      incidentReviewId: "missing",
      authorizedBy: "operator",
      reason: "review required",
      maxMessages: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      maxHardBounceRate: 0.03,
    })).toThrow(/review/i);
    expect(db.listOutboundMessagesForLead(messages[24]!.leadId)[0]).toMatchObject({ status: "BOUNCED" });
    db.close();
  });

  it("caps the 1-in-25 recovery sample at nine and consumes claims atomically", () => {
    const { db, messages, incidentId } = recoveryFixture();
    const review = db.reviewEmailBounceIncident({
      incidentId,
      disposition: "REMOTE_INFRASTRUCTURE_FAILURE",
      reviewedBy: "operator",
      reason: "The recipient gateway forwarded to Gmail and failed Gmail PTR/forward-DNS policy.",
    });
    expect(review.review_id).toBeTruthy();
    expect(() => db.authorizeDeliverabilityRecovery({
      incidentReviewId: review.review_id!,
      authorizedBy: "operator",
      reason: "bounded recovery",
      maxMessages: 10,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    })).toThrow(/9-message sample/i);

    const authorized = db.authorizeDeliverabilityRecovery({
      incidentReviewId: review.review_id!,
      authorizedBy: "operator",
      reason: "one-message canary",
      maxMessages: 1,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    });
    expect(authorized).toMatchObject({ authorizedMessages: 1, remainingMessages: 1 });
    expect(db.claimMessageForSending(messages[25]!.messageId, policy)).toMatchObject({ status: "SENDING" });
    expect(db.getDeliverabilityRecoveryState({ maxHardBounceRate: 0.03 })).toMatchObject({
      authorizationId: null,
      claimedMessages: 1,
      remainingMessages: 0,
    });
    expect(() => db.claimMessageForSending(messages[26]!.messageId, policy))
      .toThrow(/hard bounce rate exceeds/i);
    expect(db.db.prepare("SELECT count(*) AS count FROM deliverability_recovery_claims").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("invalidates an unused authorization when a newer bounce is recorded", () => {
    const { db, messages, incidentId } = recoveryFixture();
    const review = db.reviewEmailBounceIncident({
      incidentId,
      disposition: "REMOTE_INFRASTRUCTURE_FAILURE",
      reviewedBy: "operator",
      reason: "remote forwarding infrastructure",
    });
    db.authorizeDeliverabilityRecovery({
      incidentReviewId: review.review_id!,
      authorizedBy: "operator",
      reason: "bounded canary",
      maxMessages: 2,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    });

    const newer = messages[25]!;
    const future = new Date(Date.now() + 5_000).toISOString();
    db.db.prepare(
      "UPDATE outbound_messages SET status='BOUNCED', sent_at=?, provider_message_id=?, thread_id=?, updated_at=? WHERE id=?",
    ).run(future, "<new-bounce@example.invalid>", "<new-bounce@example.invalid>", future, newer.messageId);
    const inbound = db.insertInbound({
      channel: "email",
      providerId: "dsn-newer-fixture",
      threadId: "<new-bounce@example.invalid>",
      fromAddress: "mailer-daemon@example.invalid",
      bodyText: "Status: 5.1.1 no such user",
      receivedAt: future,
      classification: "BOUNCE",
      confidence: 1,
      reason: "recipient invalid",
      leadId: newer.leadId,
      contactId: newer.contactId,
      outboundMessageId: newer.messageId,
    });
    db.recordEmailBounceIncident({
      inboundMessageId: inbound.id,
      outboundMessageId: newer.messageId,
      leadId: newer.leadId,
      contactId: newer.contactId,
      diagnosticSource: "Status: 5.1.1 no such user",
      createdAt: future,
    });

    expect(db.getDeliverabilityRecoveryState({ maxHardBounceRate: 0.03 })).toMatchObject({
      authorizationId: null,
      invalidatedByNewBounce: true,
      unresolvedIncidents: 1,
    });
    expect(() => db.claimMessageForSending(messages[26]!.messageId, policy))
      .toThrow(/hard bounce rate exceeds/i);
    expect(db.listOutboundMessagesForLead(messages[24]!.leadId)[0]).toMatchObject({ status: "BOUNCED" });
    db.close();
  });

  it("calculates a full rolling-window recovery and replaces an invalidated authorization", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const { db, messages, incidentId } = recoveryFixture();
    const firstReview = db.reviewEmailBounceIncident({
      incidentId,
      disposition: "REMOTE_INFRASTRUCTURE_FAILURE",
      reviewedBy: "operator",
      reason: "remote forwarding infrastructure",
    });
    db.authorizeDeliverabilityRecovery({
      incidentReviewId: firstReview.review_id!,
      authorizedBy: "operator",
      reason: "initial bounded recovery",
      maxMessages: 2,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    });

    const historyStart = Date.parse("2026-07-20T00:00:00.000Z");
    for (let index = 25; index <= 56; index += 1) {
      const status = index === 56 ? "BOUNCED" : "SENT";
      const sentAt = new Date(historyStart + index * 60_000).toISOString();
      db.db.prepare(
        "UPDATE outbound_messages SET status=?, sent_at=?, provider_message_id=?, thread_id=?, updated_at=? WHERE id=?",
      ).run(status, sentAt, `<rolling-${index}@example.invalid>`, `<rolling-${index}@example.invalid>`, sentAt, messages[index]!.messageId);
    }
    const newer = messages[56]!;
    vi.setSystemTime(new Date("2026-07-21T01:00:00.000Z"));
    const receivedAt = new Date().toISOString();
    const inbound = db.insertInbound({
      channel: "email",
      providerId: "dsn-rolling-window-fixture",
      threadId: "<rolling-56@example.invalid>",
      fromAddress: "mailer-daemon@example.invalid",
      bodyText: "Status: 5.1.1 user does not exist",
      receivedAt,
      classification: "BOUNCE",
      confidence: 1,
      reason: "recipient invalid",
      leadId: newer.leadId,
      contactId: newer.contactId,
      outboundMessageId: newer.messageId,
    });
    const newerIncident = db.recordEmailBounceIncident({
      inboundMessageId: inbound.id,
      outboundMessageId: newer.messageId,
      leadId: newer.leadId,
      contactId: newer.contactId,
      diagnosticSource: "Status: 5.1.1 user does not exist",
      createdAt: receivedAt,
    });
    const secondReview = db.reviewEmailBounceIncident({
      incidentId: newerIncident.id,
      disposition: "CONFIRMED_RECIPIENT_FAILURE",
      reviewedBy: "operator",
      reason: "DSN confirms that the recipient does not exist",
    });

    expect(db.getDeliverabilityRecoveryState({ maxHardBounceRate: 0.03 })).toMatchObject({
      bounceStats: { sent: 50, bounced: 2, rate: 0.04 },
      requiredSuccessfulMessages: 18,
      invalidatedByNewBounce: true,
    });
    vi.setSystemTime(new Date("2026-07-21T02:00:00.000Z"));
    expect(() => db.authorizeDeliverabilityRecovery({
      incidentReviewId: secondReview.review_id!,
      authorizedBy: "operator",
      reason: "rolling-window recovery",
      maxMessages: 19,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    })).toThrow(/18-message sample/i);
    expect(db.authorizeDeliverabilityRecovery({
      incidentReviewId: secondReview.review_id!,
      authorizedBy: "operator",
      reason: "rolling-window recovery",
      maxMessages: 18,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      maxHardBounceRate: 0.03,
    })).toMatchObject({
      requiredSuccessfulMessages: 18,
      authorizedMessages: 18,
      remainingMessages: 18,
      invalidatedByNewBounce: false,
    });
    db.close();
  });
});
