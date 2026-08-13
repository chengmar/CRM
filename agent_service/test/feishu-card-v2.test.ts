import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GroundedMessageJobResult } from "../src/acquisition/grounded-message-workflow.js";
import { loadConfig } from "../src/config.js";
import { cardV2Buttons } from "../src/integrations/feishu/card-v2.js";
import {
  contentReviewCard,
  deliveryReconciliationCard,
  groundedMessageReviewCard,
  hardBounceCard,
  inquiryCard,
  opportunityCard,
  quarantineCard,
} from "../src/integrations/feishu/cards.js";
import { reviewCard } from "../src/jobs/review-card.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function expectValidV2Buttons(card: object): void {
  const buttons: Record<string, unknown>[] = [];
  walk(card, (node) => {
    expect(node.tag).not.toBe("action");
    if (node.tag === "button") buttons.push(node);
  });
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button).not.toHaveProperty("value");
    expect(button.behaviors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "callback", value: expect.any(Object) }),
      ]),
    );
  }
}

describe("Feishu card JSON 2.0 buttons", () => {
  it("uses direct button elements with callback behaviors", () => {
    const elements = cardV2Buttons([
      { text: "Confirm", type: "primary_filled", value: { intent: "confirm" } },
    ]);
    expectValidV2Buttons({ schema: "2.0", body: { elements } });
  });

  it("keeps review and inquiry cards compatible with schema 2.0", () => {
    const config = loadConfig({});
    const review = reviewCard(
      config,
      {
        id: "lead_test",
        company: "Example Industrial",
        email: "buyer@example.com",
        total_score: 90,
        fit_score: 30,
        intent_score: 20,
        activity_score: 15,
        contact_score: 20,
        channel_score: 5,
        buying_likelihood: "HIGH",
        demand_evidence_qualified: 1,
        demand_policy_version: DEMAND_POLICY_VERSION,
        demand_stage: "RECENT_PROCUREMENT",
        demand_evidence_json: JSON.stringify([{
          stage: "RECENT_PROCUREMENT",
          sourceUrl: "https://procurement.example/tender/1",
          publisherDomain: "procurement.example",
          sourceDate: "2026-07-01T00:00:00.000Z",
          quote: "Request for quotation for sample application equipment.",
        }]),
        candidate_evidence_json: JSON.stringify({
          demandStage: "RECENT_PROCUREMENT",
          demandEvidence: [{
            stage: "RECENT_PROCUREMENT",
            sourceUrl: "https://procurement.example/tender/1",
            publisherDomain: "procurement.example",
            sourceDate: "2026-07-01T00:00:00.000Z",
            quote: "Request for quotation for sample application equipment.",
          }],
        }),
      },
      [{
        sequence_index: 0,
        scheduled_at: "2026-07-18",
        destination: "actual-recipient@example.com",
        subject: "Hello",
        body: "Body",
      }],
      "review_hash",
    );
    expect(JSON.stringify(review)).toContain("RECENT_PROCUREMENT");
    expect(JSON.stringify(review)).toContain("https://procurement.example/tender/1");
    expect(JSON.stringify(review)).toContain("actual-recipient@example.com");
    expect(JSON.stringify(review)).toContain("评分拆分");
    const inquiry = inquiryCard({
      lead: { id: "lead_test", company: "Example Industrial" },
      inbound: {
        channel: "email",
        providerId: "provider_test",
        fromAddress: "buyer@example.com",
        subject: "Request for quotation",
        bodyText: "Please quote.",
        receivedAt: "2026-07-18T00:00:00.000Z",
        classification: "P1_INQUIRY",
        confidence: 0.99,
        reason: "Explicit quotation request",
        leadId: "lead_test",
      },
      classification: {
        classification: "P1_INQUIRY",
        confidence: 0.99,
        reason: "Explicit quotation request",
        shouldNotify: true,
        shouldTakeover: true,
        shouldStopAutomation: true,
      },
    });
    expectValidV2Buttons(review);
    expectValidV2Buttons(inquiry);
  });

  it("renders quarantine accept/reject callbacks without creating a lead action", () => {
    const card = quarantineCard({
      intake: { id: "intake_fixture", source: "WEB_FORM" },
      inbound: {
        channel: "form",
        providerId: "form_fixture",
        fromAddress: "buyer@example.com",
        toAddress: "sales@example.test",
        subject: "RFQ",
        bodyText: "Please quote two units.",
        receivedAt: "2026-07-20T00:00:00.000Z",
        classification: "P1_INQUIRY",
        confidence: 0.99,
        reason: "fixture",
      },
      classification: {
        classification: "P1_INQUIRY",
        confidence: 0.99,
        reason: "fixture",
        shouldNotify: true,
        shouldTakeover: true,
        shouldStopAutomation: true,
      },
    });
    const serialized = JSON.stringify(card);
    expectValidV2Buttons(card);
    expect(serialized).toContain("accept_inbound_quarantine");
    expect(serialized).toContain("reject_inbound_quarantine");
    expect(serialized).not.toContain('"leadId"');
  });

  it("renders delivery reconciliation actions and an enterprise hard-bounce alert", () => {
    const reconciliation = deliveryReconciliationCard({
      message: {
        id: "msg_unknown",
        company: "Example Buyer",
        destination: "buyer@example.test",
        provider_message_id: "<crm-fixture@sender.example>",
        sending_started_at: "2026-07-22T00:00:00.000Z",
      },
    });
    const bounce = hardBounceCard({
      lead: { id: "lead_bounce", company: "Example Buyer" },
      inbound: {
        channel: "email",
        providerId: "bounce-fixture",
        fromAddress: "buyer@example.test",
        bodyText: "550 mailbox does not exist",
        receivedAt: "2026-07-22T00:00:00.000Z",
      },
      classification: {
        classification: "BOUNCE",
        confidence: 0.99,
        reason: "permanent delivery failure",
        shouldNotify: true,
        shouldTakeover: false,
        shouldStopAutomation: true,
      },
    });

    expectValidV2Buttons(reconciliation);
    expect(JSON.stringify(reconciliation)).toContain("reconcile_unknown_delivery");
    expect(JSON.stringify(reconciliation)).toContain("CONFIRMED_SENT");
    expect(JSON.stringify(reconciliation)).toContain("CONFIRMED_NOT_SENT_REQUEUE");
    expect(JSON.stringify(bounce)).toContain("企业邮箱发生硬退信");
  });

  it("keeps content publication and quote amounts out of review cards", () => {
    const content = contentReviewCard({
      asset: { title: "RFQ checklist", target_markets_json: '["MY"]' },
      version: { id: "contentv_fixture", version_number: 1, locale: "en-MY", status: "DRAFT" },
      claims: [{ statement: "Approved fixture claim", status: "APPROVED", source_hash: "a".repeat(64) }],
    });
    const opportunity = opportunityCard({
      opportunity: { id: "opp_fixture", stage: "INQUIRY_QUALIFIED", source: "WEB_FORM", owner: "sales" },
      intake: { subject: "RFQ", body_text: "Please quote." },
      facts: [{ field_name: "PERFORMANCE_REQUIREMENT", normalized_value: "12 units" }],
    });
    expectValidV2Buttons(content);
    expectValidV2Buttons(opportunity);
    expect(JSON.stringify(content)).not.toContain("PUBLISHED");
    expect(JSON.stringify(opportunity)).not.toContain("amountMinor");
    expect(JSON.stringify(opportunity)).not.toContain('"to":"WON"');
  });

  it("does not render an approve action when the persisted demand gate is stale", () => {
    const card = reviewCard(
      loadConfig({}),
      {
        id: "lead_stale",
        company: "Stale Buyer",
        demand_evidence_qualified: 1,
        demand_policy_version: "legacy-policy",
        demand_stage: "RECENT_PROCUREMENT",
        demand_evidence_json: "[]",
      },
      [],
      "review_hash",
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('"intent":"approve"');
    expect(serialized).toContain('"intent":"reject"');
  });

  it("does not render an approve action for an ungrounded DRAFT message", () => {
    const card = reviewCard(
      loadConfig({}),
      {
        id: "lead_draft",
        company: "Draft Buyer",
        demand_evidence_qualified: 1,
        demand_policy_version: DEMAND_POLICY_VERSION,
        demand_stage: "RECENT_PROCUREMENT",
        demand_evidence_json: "[]",
      },
      [{
        sequence_index: 0,
        scheduled_at: "2026-07-20",
        destination: "buyer@example.com",
        subject: "Draft",
        body: "Ungrounded draft",
        status: "DRAFT",
      }],
      "a".repeat(64),
    );
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("NEEDS_REWRITE");
    expect(serialized).not.toContain('"intent":"approve"');
  });

  it("renders campaign-authorized grounded messages as read-only audit cards", () => {
    const result: GroundedMessageJobResult = {
      status: "PENDING_APPROVAL",
      qualificationRunId: "qualification-fixture",
      experimentAssignmentId: null,
      experimentArm: null,
      planId: "plan-fixture",
      messageVersionId: "message-version-fixture",
      planVersion: 1,
      messageVersion: 1,
      reviewHash: "a".repeat(64),
      reviewCardId: "review-card-fixture",
      reviewExpiresAt: "2026-07-21T00:00:00.000Z",
      campaignSendAuthorizationId: "campaign-send-auth-fixture",
      campaignMessageAuthorizationId: "campaign-message-auth-fixture",
      outboundMessageId: "outbound-fixture",
      outboundStatus: "APPROVED",
      lint: {
        passed: true,
        status: "PENDING_APPROVAL",
        blockers: [],
        warnings: [],
        referencedFactIds: ["fact-fixture"],
      },
      qualification: null,
      externalSendAuthorized: true,
      review: {
        accountId: "account-fixture",
        leadId: "lead-fixture",
        contactId: "contact-fixture",
        qualificationTrack: "ICP_FIT",
        locale: "en-MY",
        destination: "buyer@example.test",
        subject: "Grounded subject",
        body: "Grounded body",
        referencedFactIds: ["fact-fixture"],
      },
    };

    const card = groundedMessageReviewCard(result);
    const serialized = JSON.stringify(card);
    const buttons: Record<string, unknown>[] = [];
    walk(card, (node) => {
      if (node.tag === "button") buttons.push(node);
    });

    expect(buttons).toEqual([]);
    expect(serialized).toContain("已获 Campaign 授权的邮件审计");
    expect(serialized).toContain("只读审计通知");
    expect(serialized).toContain("全局暂停和领取时门禁");
    expect(serialized).toContain("campaign-send-auth-fixture");
    expect(serialized).toContain("campaign-message-auth-fixture");
    expect(serialized).toContain("outbound-fixture / APPROVED");
    expect(serialized).not.toContain("批准邮件内容");
    expect(serialized).not.toContain("需要重写");
    expect(serialized).not.toContain("review_grounded_message");
  });

  it("does not reintroduce the removed action container", () => {
    const src = path.resolve("src");
    const files = fs
      .readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
    for (const entry of files) {
      const content = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
      expect(content).not.toMatch(/tag:\s*["']action["']/);
    }
  });
});
