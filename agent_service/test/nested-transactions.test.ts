import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
});

describe("nested database transactions", () => {
  it("rolls back a failed inner takeover while allowing the outer transaction to commit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-nested-tx-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));

    try {
      const campaignId = db.createCampaign({
        name: "nested transaction test",
        market: "Test",
        product: "sample components",
        buyerType: "integrator",
        targetCount: 1,
        createdBy: "test",
        dailyLimit: 3,
        hourlyLimit: 1,
        followupDays: [3, 7, 14],
      });
      const leadId = db.upsertLead({
        campaignId,
        company: "Nested Transaction Company",
        domain: "nested-transaction.invalid",
        website: "https://nested-transaction.invalid",
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
        demandEvidence: [{
          stage: "RECENT_PROCUREMENT",
          sourceUrl: "https://fixture.invalid/rfq",
        }],
        sendEligible: true,
        eligibilityReasons: [],
      });
      db.transitionLead(leadId, "VERIFYING", "test", "test setup");
      db.transitionLead(leadId, "READY_FOR_REVIEW", "test", "test setup");
      const contactId = db.upsertContact({
        leadId,
        name: "Buyer",
        title: "Procurement Manager",
        email: "buyer@nested-transaction.invalid",
        sourceUrl: "https://nested-transaction.invalid/contact",
        employmentVerifiedAt: new Date().toISOString(),
        emailStatus: "VALID",
        emailRisk: "test",
        roleAddress: false,
        disposableAddress: false,
        catchAll: false,
      });
      db.createOutboundMessage({
        campaignId,
        leadId,
        contactId,
        channel: "email",
        destination: "buyer@nested-transaction.invalid",
        subject: "Test",
        body: "Test",
        sequenceIndex: 0,
        status: "PENDING_APPROVAL",
      });

      const originalRecordEvent = db.recordEvent.bind(db);
      vi.spyOn(db, "recordEvent").mockImplementation(
        (entityType, entityId, eventType, actor, payload) => {
          if (eventType === "HUMAN_TAKEOVER") {
            throw new Error("injected event failure");
          }
          return originalRecordEvent(entityType, entityId, eventType, actor, payload);
        },
      );

      let caughtError: unknown;
      const outerResult = db.withLeadAutomationGuard(
        leadId,
        { allowedStatuses: ["READY_FOR_REVIEW"] },
        () => {
          try {
            db.setHumanTakeover(leadId, "test", "nested rollback test");
          } catch (error) {
            caughtError = error;
          }
          db.setSetting("nested_transaction_outer_write", "committed");
          return "outer-continued";
        },
      );

      expect(caughtError).toEqual(new Error("injected event failure"));
      expect(outerResult).toEqual({ applied: true, value: "outer-continued" });
      expect(db.getSetting("nested_transaction_outer_write")).toBe("committed");
      expect(db.getLead(leadId)?.status).toBe("READY_FOR_REVIEW");
      expect(db.getLead(leadId)?.human_takeover).toBe(0);
      expect(db.listOutboundMessagesForLead(leadId)).toEqual([
        expect.objectContaining({ status: "PENDING_APPROVAL", failure_reason: null }),
      ]);
    } finally {
      db.close();
    }
  });
});
