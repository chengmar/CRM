import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import type { InboundClassification } from "../src/types.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-correlation-safety-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function notifier(): InquiryNotifier {
  return {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
    notifyQuarantinedIntake: vi.fn(async () => undefined),
  };
}

function decision(value: "P1_INQUIRY" | "NEGATIVE"): InboundClassification {
  const takeover = value === "P1_INQUIRY";
  return {
    classification: value,
    confidence: 0.99,
    reason: `fixture ${value}`,
    shouldNotify: takeover,
    shouldTakeover: takeover,
    shouldStopAutomation: true,
  };
}

function fixture(db: AgentDatabase, suffix: string, email = `buyer@${suffix}.example`): {
  campaignId: string;
  leadId: string;
  contactId: string;
  email: string;
} {
  const campaignId = db.createCampaign({
    name: `correlation-${suffix}`,
    market: "Malaysia",
    product: "sample products",
    buyerType: "integrator",
    targetCount: 2,
    createdBy: "test",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: `Buyer ${suffix}`,
    domain: `${suffix}.example`,
    website: `https://${suffix}.example`,
    country: "Malaysia",
    buyerType: "integrator",
    product: "sample products",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: "2026-07-22T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://${suffix}.example/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const contactId = db.upsertContact({
    leadId,
    name: `Buyer ${suffix}`,
    title: "Procurement Manager",
    email,
    sourceUrl: `https://${suffix}.example/team`,
    employmentVerifiedAt: "2026-07-22T00:00:00.000Z",
    emailStatus: "VALID",
    emailRisk: "fixture",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  db.db.prepare("UPDATE leads SET status='CONTACTED' WHERE id=?").run(leadId);
  return { campaignId, leadId, contactId, email };
}

function sentMessage(
  db: AgentDatabase,
  owner: ReturnType<typeof fixture>,
  sequenceIndex: number,
  providerMessageId: string,
  threadId = providerMessageId,
): string {
  const id = db.createOutboundMessage({
    campaignId: owner.campaignId,
    leadId: owner.leadId,
    contactId: owner.contactId,
    channel: "email",
    destination: owner.email,
    subject: `Message ${sequenceIndex}`,
    body: "Fixture body",
    sequenceIndex,
    status: "SCHEDULED",
  });
  db.db.prepare(
    `UPDATE outbound_messages
     SET status='SENT', sent_at=?, provider_message_id=?, thread_id=? WHERE id=?`,
  ).run("2026-07-22T01:00:00.000Z", providerMessageId, threadId, id);
  return id;
}

describe("inbound correlation safety", () => {
  it("quarantines an address shared by multiple leads", async () => {
    const db = database();
    const shared = "shared-buyer@example.test";
    const first = fixture(db, "shared-first", shared);
    const second = fixture(db, "shared-second", shared);
    const classification = decision("P1_INQUIRY");

    expect(db.findContactByAddress(shared)).toBeNull();
    const result = await new InboundProcessor(loadConfig({}), db, notifier()).process({
      channel: "email",
      providerId: "ambiguous-address-inbound",
      fromAddress: shared,
      toAddress: "sales@supplier.example",
      subject: "RFQ",
      bodyText: "Please send a quotation.",
      receivedAt: "2026-07-22T02:00:00.000Z",
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
    }, classification);

    expect(result).toMatchObject({ quarantined: true, leadId: null, opportunityId: null });
    expect(db.getLead(first.leadId)).toMatchObject({ status: "CONTACTED", human_takeover: 0 });
    expect(db.getLead(second.leadId)).toMatchObject({ status: "CONTACTED", human_takeover: 0 });
    db.close();
  });

  it("does not fall back to the sender when an email has an unknown reply reference", async () => {
    const db = database();
    const owner = fixture(db, "unknown-reference");
    const outboundId = sentMessage(db, owner, 0, "<known-message@example.test>");
    const classification = decision("P1_INQUIRY");

    const result = await new InboundProcessor(loadConfig({}), db, notifier()).process({
      channel: "email",
      providerId: "unknown-reference-inbound",
      threadId: "<unknown-message@example.test>",
      fromAddress: owner.email,
      subject: "RFQ",
      bodyText: "Please send a quotation.",
      receivedAt: "2026-07-22T02:00:00.000Z",
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
    }, classification);

    expect(result).toMatchObject({ quarantined: true, leadId: null });
    expect(db.getLead(owner.leadId)).toMatchObject({ status: "CONTACTED", human_takeover: 0 });
    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(outboundId))
      .toEqual({ status: "SENT" });
    db.close();
  });

  it("prioritizes an exact provider message id over another lead's thread id", async () => {
    const db = database();
    const exactOwner = fixture(db, "exact-owner");
    const threadOwner = fixture(db, "thread-owner");
    const reference = "<exact-wins@example.test>";
    const exactId = sentMessage(db, exactOwner, 0, reference);
    const threadId = sentMessage(db, threadOwner, 0, "<other-message@example.test>", reference);

    expect(db.findLeadByProviderReference(reference)).toMatchObject({
      leadId: exactOwner.leadId,
      contactId: exactOwner.contactId,
      outboundMessageId: exactId,
      correlationMethod: "exact_provider_reference",
    });

    const classification = decision("NEGATIVE");
    await new InboundProcessor(loadConfig({}), db, notifier()).process({
      channel: "email",
      providerId: "exact-priority-inbound",
      threadId: reference,
      fromAddress: exactOwner.email,
      subject: "Re: message",
      bodyText: "No thank you.",
      receivedAt: "2026-07-22T02:00:00.000Z",
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
    }, classification);

    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(exactId))
      .toEqual({ status: "REPLIED" });
    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(threadId))
      .toEqual({ status: "SENT" });
    db.close();
  });

  it("correlates an unambiguous thread without guessing which outbound message was answered", async () => {
    const db = database();
    const owner = fixture(db, "shared-thread");
    const threadReference = "thread:shared-thread";
    const firstId = sentMessage(db, owner, 0, "<thread-first@example.test>", threadReference);
    const secondId = sentMessage(db, owner, 1, "<thread-second@example.test>", threadReference);

    expect(db.findLeadByProviderReference(threadReference)).toMatchObject({
      leadId: owner.leadId,
      contactId: owner.contactId,
      outboundMessageId: null,
      correlationMethod: "thread_reference",
    });

    const classification = decision("NEGATIVE");
    const result = await new InboundProcessor(loadConfig({}), db, notifier()).process({
      channel: "email",
      providerId: "shared-thread-inbound",
      threadId: threadReference,
      fromAddress: owner.email,
      subject: "Re: thread",
      bodyText: "No thank you.",
      receivedAt: "2026-07-22T02:00:00.000Z",
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
    }, classification);

    expect(result).toMatchObject({ quarantined: false, leadId: owner.leadId });
    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(firstId))
      .toEqual({ status: "SENT" });
    expect(db.db.prepare("SELECT status FROM outbound_messages WHERE id=?").get(secondId))
      .toEqual({ status: "SENT" });
    const intake = db.db.prepare(
      "SELECT correlation_method, outbound_message_id FROM inquiry_intakes WHERE provider_event_id=?",
    ).get("shared-thread-inbound");
    expect(intake).toEqual({ correlation_method: "thread_reference", outbound_message_id: null });
    db.close();
  });
});
