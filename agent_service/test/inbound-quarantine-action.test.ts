import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-quarantine-action-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  const service = new CommandService(
    loadConfig({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({
        "owner-fixture": ["INBOUND_REVIEW"],
        "reviewer-fixture": ["CONTENT_REVIEW", "ENGINEERING", "LOCALIZATION"],
        "sales-manager-fixture": ["SALES_MANAGER"],
      }),
    }),
    db,
    { isConfigured: () => false } as unknown as AgentLlm,
    {} as OutboundDispatcher,
  );
  return { db, service };
}

describe("Feishu inbound quarantine actions", () => {
  it("accepts P1 idempotently into a non-sendable prospect plus opportunity/task", async () => {
    const { db, service } = fixture();
    const intake = db.upsertInquiryIntake({
      source: "WEB_FORM",
      providerEventId: "action-p1-1",
      sender: "buyer@example.com",
      subject: "RFQ",
      bodyText: "Please quote two units.",
      receivedAt: "2026-07-20T00:00:00.000Z",
      classification: "P1_INQUIRY",
    });
    const action = {
      action: { intent: "accept_inbound_quarantine", intakeId: intake.id },
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "card-fixture",
    };

    expect(await service.handleAction(action)).toContain("创建待核验 prospect");
    expect(await service.handleAction(action)).toContain("未重复创建 prospect");
    expect(db.db.prepare("SELECT count(*) AS count FROM inbound_prospects").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT send_eligible FROM inbound_prospects").get()).toEqual({ send_eligible: 0 });
    expect(db.getAcquisitionFoundationSummary()).toMatchObject({ opportunities: 1, openSalesTasks: 1 });
    expect(db.db.prepare("SELECT count(*) AS count FROM leads").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rejects quarantine idempotently while preserving the intake", async () => {
    const { db, service } = fixture();
    const intake = db.upsertInquiryIntake({
      source: "EMAIL",
      providerEventId: "action-reject-1",
      sender: "ambiguous@example.com",
      bodyText: "Ambiguous fixture",
      receivedAt: "2026-07-20T00:00:00.000Z",
      classification: "AMBIGUOUS",
    });
    const action = {
      action: { intent: "reject_inbound_quarantine", intakeId: intake.id },
      senderId: "owner-fixture",
      chatId: "chat-fixture",
      messageId: "card-fixture",
    };

    expect(await service.handleAction(action)).toContain("原始审计记录保留");
    expect(await service.handleAction(action)).toContain("未重复处理");
    expect(db.getInquiryIntake(intake.id)).toMatchObject({
      intake_status: "REJECTED",
      quarantine_decision: "REJECTED",
      body_text: "Ambiguous fixture",
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM inbound_prospects").get()).toEqual({ count: 0 });
    db.close();
  });

  it("moves content through review without exposing a publish action", async () => {
    const { db, service } = fixture();
    const asset = db.upsertContentAsset({
      assetKey: "fixture-rfq-checklist",
      assetType: "RFQ_CHECKLIST",
      title: "Fixture RFQ checklist",
      defaultLocale: "en",
      visibility: "PRIVATE",
      createdBy: "agent-fixture",
    });
    const version = db.upsertContentVersion({
      assetId: asset.id,
      locale: "en",
      body: "Draft fixture content.",
      createdBy: "agent-fixture",
    });
    const action = (to: string) => service.handleAction({
      action: { intent: "transition_content_version", contentVersionId: version.id, to },
      senderId: "reviewer-fixture",
      chatId: "chat-fixture",
      messageId: `card-${to}`,
    });

    await expect(action("TECHNICAL_REVIEW")).resolves.toContain("TECHNICAL_REVIEW");
    await expect(action("LOCALIZATION_REVIEW")).resolves.toContain("LOCALIZATION_REVIEW");
    await expect(action("APPROVED")).resolves.toContain("不代表网站已发布");
    await expect(action("PUBLISHED")).resolves.toContain("不允许发布");
    expect(db.db.prepare("SELECT status FROM content_versions WHERE id=?").get(version.id))
      .toEqual({ status: "APPROVED" });
    db.close();
  });

  it("requires a human-created submitted quote before QUOTED and an accepted quote before WON", async () => {
    const { db, service } = fixture();
    const intake = db.upsertInquiryIntake({
      source: "WEB_FORM",
      providerEventId: "opportunity-action-1",
      sender: "buyer@example.com",
      bodyText: "Please quote.",
      receivedAt: "2026-07-20T00:00:00.000Z",
      classification: "P1_INQUIRY",
    });
    const opportunity = db.createOrGetOpportunity({
      idempotencyKey: "opportunity-action-1",
      source: "WEB_FORM",
      intakeId: intake.id,
      stage: "INQUIRY_QUALIFIED",
      owner: "sales-fixture",
    });
    const action = (to: string, wonQuoteId?: string) => service.handleAction({
      action: { intent: "update_opportunity_stage", opportunityId: opportunity.id, to, wonQuoteId },
      senderId: "sales-manager-fixture",
      chatId: "chat-fixture",
      messageId: `opportunity-${to}`,
    });

    await expect(action("TECHNICAL_DISCOVERY")).resolves.toContain("TECHNICAL_DISCOVERY");
    await expect(action("QUOTED")).resolves.toContain("requires a submitted or accepted quote");
    const authorization = {
      actor: "sales-manager-fixture",
      actorType: "HUMAN" as const,
      roles: ["SALES_MANAGER" as const],
    };
    const quote = db.createQuote({
      opportunityId: opportunity.id,
      idempotencyKey: "quote-action-1",
      amountMinor: 100_000,
      currency: "USD",
      grossMarginBps: 2_000,
    }, authorization);
    db.transitionQuoteStatus(quote.id, "APPROVED", authorization, "fixture approval");
    db.transitionQuoteStatus(quote.id, "SUBMITTED", authorization, "fixture submission");
    await expect(action("QUOTED")).resolves.toContain("QUOTED");
    await expect(action("WON", quote.id)).resolves.toContain("requires an accepted quote");
    db.transitionQuoteStatus(quote.id, "ACCEPTED", authorization, "fixture acceptance");
    await expect(action("WON", quote.id)).resolves.toContain("WON");
    expect(db.getOpportunity(opportunity.id)).toMatchObject({
      stage: "WON",
      won_quote_id: quote.id,
      won_amount_minor: 100_000,
      won_currency: "USD",
    });
    db.close();
  });
});
