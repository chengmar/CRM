import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { InboundProcessor, type InquiryNotifier } from "../src/inbound/processor.js";
import { WhatsAppInbound } from "../src/inbound/whatsapp.js";
import type { AgentLlm } from "../src/llm.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture(): {
  db: AgentDatabase;
  leadId: string;
  inbound: WhatsAppInbound;
  notifier: InquiryNotifier;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-whatsapp-inbound-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  const campaignId = db.createCampaign({
    name: "whatsapp-inbound",
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
    company: "WhatsApp Buyer",
    domain: "whatsapp.example",
    website: "https://whatsapp.example",
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
  db.db.prepare("UPDATE leads SET status='CONTACTED' WHERE id=?").run(leadId);
  db.upsertContact({
    leadId,
    name: "Jane Buyer",
    title: "Procurement Manager",
    whatsapp: "+60123456789",
    sourceUrl: "https://whatsapp.example/team",
    employmentVerifiedAt: new Date().toISOString(),
    emailStatus: "UNKNOWN",
    emailRisk: "no email",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
    whatsappOptInAt: new Date().toISOString(),
  });
  const config = loadConfig({});
  const notifier: InquiryNotifier = {
    notifyInquiry: vi.fn(async () => undefined),
    notifyReply: vi.fn(async () => undefined),
    notifySafetyPause: vi.fn(async () => undefined),
  };
  const processor = new InboundProcessor(config, db, notifier);
  const llm = { isConfigured: () => false } as unknown as AgentLlm;
  return { db, leadId, inbound: new WhatsAppInbound(config, db, llm, processor), notifier };
}

function webhook(message: Record<string, unknown>): never {
  return {
    entry: [{ changes: [{ value: { messages: [message] } }] }],
  } as never;
}

describe("WhatsApp inbound safety", () => {
  it("stops automation for a matched media-only reply", async () => {
    const { db, leadId, inbound, notifier } = fixture();

    const result = await inbound.processWebhook(webhook({
      id: "wamid.image-1",
      from: "60123456789",
      timestamp: "1784450000",
      type: "image",
      image: { id: "media-id" },
    }));

    expect(result.messages).toBe(1);
    expect(db.getLead(leadId)).toMatchObject({ status: "REPLIED" });
    expect(db.db.prepare("SELECT classification FROM inbound_messages").get()).toEqual({
      classification: "OTHER_REPLY",
    });
    expect(notifier.notifyReply).toHaveBeenCalledOnce();
    db.close();
  });

  it("writes a WhatsApp opt-out to number-level DNC", async () => {
    const { db, inbound } = fixture();

    await inbound.processWebhook(webhook({
      id: "wamid.unsubscribe-1",
      from: "60123456789",
      timestamp: "1784450000",
      type: "text",
      text: { body: "Please unsubscribe and stop messaging me" },
    }));

    expect(db.hasDncMatch([{ type: "whatsapp", value: "60123456789" }])).toBe(true);
    expect(db.hasDncMatch([{ type: "email", value: "60123456789" }])).toBe(false);
    db.close();
  });
});
