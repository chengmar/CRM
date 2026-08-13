import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchMessageObject } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { EmailInboundListener } from "../src/inbound/email-listener.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import type { AgentLlm } from "../src/llm.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function createDatabase(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-inbound-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function message(uid: number, from: string, body: string, inReplyTo?: string): FetchMessageObject {
  const source = [
    `From: ${from}`,
    "To: pilot.sender@gmail.com",
    `Subject: ${body}`,
    `Message-ID: <inbound-${uid}@example.invalid>`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].filter(Boolean).join("\r\n");
  return { uid, source: Buffer.from(source) } as unknown as FetchMessageObject;
}

function listener(db: AgentDatabase, isConfigured = vi.fn(() => false)): {
  value: EmailInboundListener;
  notifier: InquiryNotifier;
  isConfigured: ReturnType<typeof vi.fn>;
} {
  const config = loadConfig({ EMAIL_FROM_ADDRESS: "pilot.sender@gmail.com" });
  const llm = { isConfigured } as unknown as AgentLlm;
  const notifier: InquiryNotifier = {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
  };
  const processor = new InboundProcessor(config, db, notifier);
  return { value: new EmailInboundListener(config, db, llm, processor), notifier, isConfigured };
}

async function processMessage(value: EmailInboundListener, input: FetchMessageObject): Promise<void> {
  await (value as unknown as { processMessage(message: FetchMessageObject): Promise<void> })
    .processMessage(input);
}

describe("email inbound correlation", () => {
  it("ignores an unmatched inbox message before LLM classification or persistence", async () => {
    const db = createDatabase();
    const fixture = listener(db, vi.fn(() => true));

    await processMessage(
      fixture.value,
      message(1, "unrelated.sender@example.com", "Please send a quote"),
    );

    expect(fixture.isConfigured).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get()).toEqual({ count: 0 });
    db.close();
  });

  it("classifies and processes a message from a known contact", async () => {
    const db = createDatabase();
    const campaignId = db.createCampaign({
      name: "inbound-correlation",
      market: "Malaysia",
      product: "Sample Product A",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const leadId = db.upsertLead({
      campaignId,
      company: "Known Buyer",
      domain: "known.example",
      website: "https://known.example",
      country: "Malaysia",
      buyerType: "integrator",
      product: "Sample Product A",
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
      demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
      sendEligible: true,
      eligibilityReasons: [],
    });
    db.upsertContact({
      leadId,
      name: "Jane Buyer",
      title: "Procurement Manager",
      email: "jane@known.example",
      sourceUrl: "https://known.example/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "fixture",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    const fixture = listener(db);

    await processMessage(
      fixture.value,
      message(2, "jane@known.example", "Please quote 2 Sample Product A units"),
    );

    expect(db.getMetrics()).toMatchObject({ replies: 1, inquiries: 1, unmatchedInbound: 0 });
    expect(db.getLead(leadId)).toMatchObject({ status: "HUMAN_TAKEOVER", human_takeover: 1 });
    expect(fixture.notifier.notifyInquiry).toHaveBeenCalledOnce();
    db.close();
  });

  it("correlates a standard DSN without outer reply headers", async () => {
    const db = createDatabase();
    const campaignId = db.createCampaign({
      name: "dsn-correlation",
      market: "Malaysia",
      product: "Sample Product A",
      buyerType: "integrator",
      targetCount: 1,
      createdBy: "test",
      dailyLimit: 5,
      hourlyLimit: 2,
      followupDays: [3, 7, 14],
    });
    const leadId = db.upsertLead({
      campaignId,
      company: "Bounced Buyer",
      domain: "bounced.example",
      website: "https://bounced.example",
      country: "Malaysia",
      buyerType: "integrator",
      product: "Sample Product A",
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
      demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: "https://fixture.invalid/rfq" }],
      sendEligible: true,
      eligibilityReasons: [],
    });
    const contactId = db.upsertContact({
      leadId,
      name: "Jane Bounced",
      title: "Procurement Manager",
      email: "jane@bounced.example",
      sourceUrl: "https://bounced.example/team",
      employmentVerifiedAt: new Date().toISOString(),
      emailStatus: "VALID",
      emailRisk: "fixture",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
    });
    const outboundId = db.createOutboundMessage({
      campaignId,
      leadId,
      contactId,
      channel: "email",
      destination: "jane@bounced.example",
      subject: "sample application project",
      body: "Hello",
      sequenceIndex: 0,
      status: "SCHEDULED",
    });
    db.db.prepare("UPDATE leads SET status='APPROVED' WHERE id=?").run(leadId);
    db.db.prepare(
      "UPDATE outbound_messages SET approved_by='fixture', approved_at=? WHERE id=?",
    ).run(new Date().toISOString(), outboundId);
    db.setSetting("outbound_paused", "false");
    db.markMessageSending(outboundId);
    db.markMessageSent(outboundId, "<sent-dsn@example.invalid>");
    const raw = [
      "From: Mailer-Daemon <mailer-daemon@gmail.com>",
      "To: pilot.sender@gmail.com",
      "Subject: Delivery Status Notification (Failure)",
      "Message-ID: <outer-dsn@example.invalid>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Delivery failed permanently.",
      "Original-Message-ID: <sent-dsn@example.invalid>",
      "Final-Recipient: rfc822; jane@bounced.example",
      "Status: 5.1.1",
    ].join("\r\n");
    const fixture = listener(db);

    await processMessage(
      fixture.value,
      { uid: 3, source: Buffer.from(raw) } as unknown as FetchMessageObject,
    );

    expect(db.getContact(contactId)).toMatchObject({ email_status: "INVALID" });
    expect(db.listOutboundMessagesForLead(leadId)).toEqual([
      expect.objectContaining({ id: outboundId, status: "BOUNCED" }),
    ]);
    expect(db.getMetrics()).toMatchObject({ bounces: 1, unmatchedInbound: 0 });
    db.close();
  });
});
