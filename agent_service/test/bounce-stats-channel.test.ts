import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounce-stats-channel-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

describe("email bounce statistics", () => {
  it("excludes newer WhatsApp outcomes from the rolling email window", () => {
    const db = database();
    try {
      const domain = "mixed-channel.buyer.example";
      const email = `buyer@${domain}`;
      const whatsapp = "+60123456789";
      const campaignId = db.createCampaign({
        name: "mixed-channel-bounce-stats",
        market: "Malaysia",
        product: "sample product application",
        buyerType: "system integrator",
        targetCount: 1,
        createdBy: "test",
        dailyLimit: 10,
        hourlyLimit: 5,
        followupDays: [],
      });
      const leadId = db.upsertLead({
        campaignId,
        company: "Mixed Channel Buyer",
        domain,
        website: `https://${domain}`,
        country: "Malaysia",
        buyerType: "system integrator",
        product: "sample product application",
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
        demandEvidence: [{ stage: "RECENT_PROCUREMENT", sourceUrl: `https://${domain}/rfq` }],
        sendEligible: true,
        eligibilityReasons: [],
      });
      const contactId = db.upsertContact({
        leadId,
        name: "Morgan Lee",
        title: "Procurement Manager",
        email,
        whatsapp,
        sourceUrl: `https://${domain}/team`,
        employmentVerifiedAt: new Date().toISOString(),
        emailStatus: "VALID",
        emailRisk: "test fixture",
        roleAddress: false,
        disposableAddress: false,
        catchAll: false,
        whatsappOptInAt: new Date().toISOString(),
      });
      const createMessage = (
        channel: "email" | "whatsapp",
        destination: string,
        sequenceIndex: number,
      ): string =>
        db.createOutboundMessage({
          campaignId,
          leadId,
          contactId,
          channel,
          destination,
          subject: "Fixture",
          body: "Fixture",
          sequenceIndex,
          status: "PENDING_APPROVAL",
        });
      const emailBounce = createMessage("email", email, 0);
      const emailSent = createMessage("email", email, 1);
      const whatsappBounceOne = createMessage("whatsapp", whatsapp, 0);
      const whatsappBounceTwo = createMessage("whatsapp", whatsapp, 1);

      const setOutcome = (id: string, status: "SENT" | "BOUNCED", sentAt: string): void => {
        db.db.prepare(
          "UPDATE outbound_messages SET status=?, sent_at=?, updated_at=? WHERE id=?",
        ).run(status, sentAt, sentAt, id);
      };
      setOutcome(emailBounce, "BOUNCED", "2026-07-22T00:00:00.000Z");
      setOutcome(emailSent, "SENT", "2026-07-22T00:01:00.000Z");
      setOutcome(whatsappBounceOne, "BOUNCED", "2026-07-22T00:02:00.000Z");
      setOutcome(whatsappBounceTwo, "BOUNCED", "2026-07-22T00:03:00.000Z");

      expect(db.getBounceStats(2)).toEqual({ sent: 2, bounced: 1, rate: 0.5 });
      expect(db.getBounceStats(1)).toEqual({ sent: 1, bounced: 0, rate: 0 });
    } finally {
      db.close();
    }
  });
});
