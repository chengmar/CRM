import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroundedMessageJobResult } from "../src/acquisition/grounded-message-workflow.js";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase, LATEST_SCHEMA_VERSION } from "../src/db.js";
import { groundedMessageReviewCard } from "../src/integrations/feishu/cards.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDatabase(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return path.join(directory, "agent.db");
}

function seedV12ReviewSchema(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, name, applied_at) VALUES
      (1,'v1','2026-07-20T00:00:00.000Z'), (2,'v2','2026-07-20T00:00:00.000Z'),
      (3,'v3','2026-07-20T00:00:00.000Z'), (4,'v4','2026-07-20T00:00:00.000Z'),
      (5,'v5','2026-07-20T00:00:00.000Z'), (6,'v6','2026-07-20T00:00:00.000Z'),
      (7,'v7','2026-07-20T00:00:00.000Z'), (8,'v8','2026-07-20T00:00:00.000Z'),
      (9,'v9','2026-07-20T00:00:00.000Z'), (10,'v10','2026-07-20T00:00:00.000Z'),
      (11,'v11','2026-07-20T00:00:00.000Z'), (12,'v12','2026-07-20T00:00:00.000Z');
    CREATE TABLE personalization_plans(
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      qualification_track TEXT NOT NULL
    );
    CREATE TABLE message_versions(
      id TEXT PRIMARY KEY,
      message_key TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      personalization_plan_id TEXT NOT NULL REFERENCES personalization_plans(id),
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      lint_result_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      review_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      send_authorized INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version=12;
  `);
  db.close();
}

function createReviewableMessage(
  db: AgentDatabase,
  messageKey: string,
  body = "Grounded body tied to reviewed facts.",
  status: "GENERATED" | "PENDING_APPROVAL" = "PENDING_APPROVAL",
): {
  accountId: string;
  planId: string;
  messageVersionId: string;
  reviewHash: string;
} {
  const domain = `${messageKey.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.review.test`;
  const accountId = db.upsertAccount({ domain, displayName: `Account ${messageKey}` });
  const plan = db.savePersonalizationPlan({
    planKey: `plan:${messageKey}`,
    accountId,
    qualificationTrack: "ICP_FIT",
    qualificationPolicyVersion: "qualification-policy-v2",
    sellerFactSetVersion: "seller-facts-v1",
    locale: "en-MY",
    plan: { accountId, observedFact: "fixture fact", approvedOffer: "fixture offer" },
    factIds: ["fact-fixture"],
    createdBy: "fixture",
    status: "VALID",
  });
  const message = db.saveMessageVersion({
    messageKey,
    personalizationPlanId: plan.id,
    subject: `Grounded subject ${messageKey}`,
    body,
    destination: "buyer@example.test",
    sequenceIndex: 0,
    generationMode: "DETERMINISTIC_COMPILER",
    promptVersion: "deterministic-no-prompt",
    model: "deterministic-no-model",
    templateVersion: "grounded-message-compiler-v1",
    lintVersion: "message-grounding-lint-v2",
    lintResult: { passed: true, blockers: [], warnings: [] },
    angle: "fixture angle",
    locale: "en-MY",
    sellerFactSetVersion: "seller-facts-v1",
    factIds: ["fact-fixture"],
    createdBy: "fixture",
    status,
  });
  return { accountId, planId: plan.id, messageVersionId: message.id, reviewHash: message.reviewHash };
}

function callbackValues(card: object): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "callback" && record.value && typeof record.value === "object") {
      values.push(record.value as Record<string, unknown>);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return values;
}

describe("grounded message local review v13", () => {
  it("migrates an existing v12 message schema idempotently", () => {
    const file = tempDatabase("message-review-v13-migration-");
    seedV12ReviewSchema(file);
    let db = new AgentDatabase(file);
    expect(LATEST_SCHEMA_VERSION).toBe(19);
    expect(db.getSchemaVersion()).toBe(19);
    expect(db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='message_review_decisions'",
    ).get()).toMatchObject({ name: "message_review_decisions" });
    expect(db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='view' AND name='grounded_message_review_states'",
    ).get()).toMatchObject({ name: "grounded_message_review_states" });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();

    db = new AgentDatabase(file);
    expect(db.db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=13").get())
      .toMatchObject({ count: 1 });
    expect(db.checkIntegrity().ok).toBe(true);
    db.close();
  });

  it("records an exact human content approval while keeping every send gate at zero", () => {
    const db = new AgentDatabase(tempDatabase("message-review-v13-approve-"));
    const message = createReviewableMessage(db, "approve-fixture");
    const card = db.issueGroundedMessageReviewCard({
      messageVersionId: message.messageVersionId,
      reviewHash: message.reviewHash,
    });
    const input = {
      reviewCardId: card.id,
      messageVersionId: message.messageVersionId,
      reviewHash: message.reviewHash,
      decision: "APPROVE_CONTENT" as const,
      actionId: "action:approve-fixture",
      reason: "human reviewed exact content",
    };
    const authorization = {
      actor: "reviewer-fixture",
      actorType: "HUMAN" as const,
      roles: ["MESSAGE_REVIEWER" as const],
    };
    expect(db.reviewGroundedMessage(input, authorization)).toMatchObject({
      created: true,
      decision: "APPROVE_CONTENT",
      derivedStatus: "APPROVED",
      externalSendAuthorized: false,
    });
    expect(db.reviewGroundedMessage(input, authorization)).toMatchObject({ created: false });
    expect(db.getGroundedMessageReviewState(message.messageVersionId)).toMatchObject({
      persisted_status: "PENDING_APPROVAL",
      derived_status: "APPROVED",
      decision: "APPROVE_CONTENT",
      external_send_authorized: 0,
    });
    expect(db.db.prepare(
      "SELECT send_authorized FROM message_versions WHERE id=?",
    ).get(message.messageVersionId)).toMatchObject({ send_authorized: 0 });
    expect(db.db.prepare(
      "SELECT actor_type, actor_role, external_send_authorized FROM message_review_decisions",
    ).get()).toMatchObject({
      actor_type: "HUMAN",
      actor_role: "MESSAGE_REVIEWER",
      external_send_authorized: 0,
    });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toMatchObject({ count: 0 });
    expect(() => db.db.prepare(
      "UPDATE message_review_decisions SET reason='changed' WHERE action_id=?",
    ).run(input.actionId)).toThrow(/immutable/i);
    db.close();
  });

  it("rejects unauthorized, expired, superseded, mismatched, and ungrounded review material", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:00.000Z"));
    const db = new AgentDatabase(tempDatabase("message-review-v13-rejections-"));
    const unauthorized = createReviewableMessage(db, "unauthorized-fixture");
    const unauthorizedCard = db.issueGroundedMessageReviewCard({
      messageVersionId: unauthorized.messageVersionId,
      reviewHash: unauthorized.reviewHash,
    });
    const reviewInput = {
      reviewCardId: unauthorizedCard.id,
      messageVersionId: unauthorized.messageVersionId,
      reviewHash: unauthorized.reviewHash,
      decision: "APPROVE_CONTENT" as const,
      actionId: "action:unauthorized",
    };
    expect(() => db.reviewGroundedMessage(reviewInput, {
      actor: "agent-fixture",
      actorType: "AGENT",
      roles: ["MESSAGE_REVIEWER"],
    })).toThrow(/authorized human/i);
    expect(() => db.reviewGroundedMessage(reviewInput, {
      actor: "human-without-role",
      actorType: "HUMAN",
      roles: ["CONTENT_REVIEW"],
    })).toThrow(/MESSAGE_REVIEWER/);
    expect(() => db.reviewGroundedMessage({ ...reviewInput, reviewHash: "f".repeat(64) }, {
      actor: "reviewer",
      actorType: "HUMAN",
      roles: ["MESSAGE_REVIEWER"],
    })).toThrow(/does not match/i);
    vi.setSystemTime(new Date(Date.parse(unauthorizedCard.expiresAt) + 1));
    expect(() => db.reviewGroundedMessage(reviewInput, {
      actor: "reviewer",
      actorType: "HUMAN",
      roles: ["MESSAGE_REVIEWER"],
    })).toThrow(/expired/i);
    vi.setSystemTime(new Date("2026-07-20T08:00:00.000Z"));

    const stale = createReviewableMessage(db, "stale-fixture", "Original grounded content");
    const staleCard = db.issueGroundedMessageReviewCard({
      messageVersionId: stale.messageVersionId,
      reviewHash: stale.reviewHash,
    });
    const planId = stale.planId;
    db.saveMessageVersion({
      messageKey: "stale-fixture",
      personalizationPlanId: planId,
      subject: "Grounded subject stale-fixture",
      body: "Changed grounded content",
      destination: "buyer@example.test",
      sequenceIndex: 0,
      generationMode: "DETERMINISTIC_COMPILER",
      promptVersion: "deterministic-no-prompt",
      model: "deterministic-no-model",
      templateVersion: "grounded-message-compiler-v1",
      lintVersion: "message-grounding-lint-v2",
      lintResult: { passed: true, blockers: [], warnings: [] },
      angle: "fixture angle",
      locale: "en-MY",
      sellerFactSetVersion: "seller-facts-v1",
      factIds: ["fact-fixture"],
      createdBy: "fixture",
      status: "PENDING_APPROVAL",
    });
    expect(() => db.reviewGroundedMessage({
      reviewCardId: staleCard.id,
      messageVersionId: stale.messageVersionId,
      reviewHash: stale.reviewHash,
      decision: "APPROVE_CONTENT",
      actionId: "action:stale",
    }, {
      actor: "reviewer",
      actorType: "HUMAN",
      roles: ["MESSAGE_REVIEWER"],
    })).toThrow(/content changed/i);

    const generated = createReviewableMessage(db, "legacy-draft-fixture", "Ungrounded legacy draft", "GENERATED");
    expect(() => db.issueGroundedMessageReviewCard({
      messageVersionId: generated.messageVersionId,
      reviewHash: generated.reviewHash,
    })).toThrow(/latest grounded/i);
    expect(db.db.prepare("SELECT count(*) AS count FROM message_review_decisions").get())
      .toMatchObject({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toMatchObject({ count: 0 });
    db.close();
  });

  it("records NEEDS_REWRITE once and rejects action-id reuse for another message", () => {
    const db = new AgentDatabase(tempDatabase("message-review-v13-rewrite-"));
    const first = createReviewableMessage(db, "rewrite-first");
    const firstCard = db.issueGroundedMessageReviewCard({
      messageVersionId: first.messageVersionId,
      reviewHash: first.reviewHash,
    });
    const authorization = {
      actor: "reviewer",
      actorType: "HUMAN" as const,
      roles: ["MESSAGE_REVIEWER" as const],
    };
    const actionId = "action:rewrite-once";
    expect(db.reviewGroundedMessage({
      reviewCardId: firstCard.id,
      messageVersionId: first.messageVersionId,
      reviewHash: first.reviewHash,
      decision: "NEEDS_REWRITE",
      actionId,
    }, authorization)).toMatchObject({ derivedStatus: "NEEDS_REWRITE", created: true });

    const second = createReviewableMessage(db, "rewrite-second");
    const secondCard = db.issueGroundedMessageReviewCard({
      messageVersionId: second.messageVersionId,
      reviewHash: second.reviewHash,
    });
    expect(() => db.reviewGroundedMessage({
      reviewCardId: secondCard.id,
      messageVersionId: second.messageVersionId,
      reviewHash: second.reviewHash,
      decision: "NEEDS_REWRITE",
      actionId,
    }, authorization)).toThrow(/action id was reused/i);
    db.close();
  });

  it("renders only local content actions and CommandService records them without queueing or sending", async () => {
    const db = new AgentDatabase(tempDatabase("message-review-v13-card-command-"));
    const message = createReviewableMessage(db, "card-command-fixture");
    const reviewCard = db.issueGroundedMessageReviewCard({
      messageVersionId: message.messageVersionId,
      reviewHash: message.reviewHash,
    });
    const result: GroundedMessageJobResult = {
      status: "PENDING_APPROVAL",
      qualificationRunId: "qualification-fixture",
      experimentAssignmentId: null,
      experimentArm: null,
      planId: message.planId,
      messageVersionId: message.messageVersionId,
      planVersion: 1,
      messageVersion: 1,
      reviewHash: message.reviewHash,
      reviewCardId: reviewCard.id,
      reviewExpiresAt: reviewCard.expiresAt,
      lint: {
        passed: true,
        status: "PENDING_APPROVAL",
        blockers: [],
        warnings: [],
        referencedFactIds: ["fact-fixture"],
      },
      qualification: null,
      externalSendAuthorized: false,
      review: {
        accountId: message.accountId,
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
    const actions = callbackValues(card);
    expect(serialized).toContain("批准邮件内容");
    expect(serialized).toContain("需要重写");
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intent: "review_grounded_message",
        decision: "APPROVE_CONTENT",
        messageVersionId: message.messageVersionId,
        reviewHash: message.reviewHash,
      }),
      expect.objectContaining({
        intent: "review_grounded_message",
        decision: "NEEDS_REWRITE",
        messageVersionId: message.messageVersionId,
        reviewHash: message.reviewHash,
      }),
    ]));
    expect(serialized).not.toContain("send_message");
    expect(serialized).not.toContain("activate");

    const nonReviewerService = new CommandService(
      loadConfig({ FEISHU_ALLOWED_USERS: "message-reviewer" }),
      db,
      { isConfigured: () => false } as unknown as AgentLlm,
      {} as OutboundDispatcher,
    );
    const approveAction = actions.find((action) => action.decision === "APPROVE_CONTENT")!;
    expect(await nonReviewerService.handleAction({
      action: approveAction,
      senderId: "message-reviewer",
      chatId: "chat-fixture",
      messageId: "feishu-card-message-unprivileged",
    })).toContain("系统未执行任何变更");
    expect(db.db.prepare("SELECT count(*) AS count FROM message_review_decisions").get())
      .toMatchObject({ count: 0 });

    const service = new CommandService(
      loadConfig({
        FEISHU_ALLOWED_USERS: "message-reviewer",
        FEISHU_MESSAGE_REVIEWER_USERS: "message-reviewer",
      }),
      db,
      { isConfigured: () => false } as unknown as AgentLlm,
      {} as OutboundDispatcher,
    );
    const response = await service.handleAction({
      action: approveAction,
      senderId: "message-reviewer",
      chatId: "chat-fixture",
      messageId: "feishu-card-message-1",
    });
    expect(response).toContain("已记录为 APPROVED");
    expect(response).toContain("仍未授权客户外发");
    expect(await service.handleAction({
      action: approveAction,
      senderId: "message-reviewer",
      chatId: "chat-fixture",
      messageId: "feishu-card-message-1",
    })).toContain("已经记录为");
    expect(await service.handleAction({
      action: {
        ...approveAction,
        messageVersionId: "legacy-outbound-draft",
        reviewHash: "d".repeat(64),
      },
      senderId: "message-reviewer",
      chatId: "chat-fixture",
      messageId: "feishu-card-message-legacy",
    })).toContain("失败");
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get())
      .toMatchObject({ count: 0 });
    expect(db.db.prepare("SELECT count(*) AS count FROM jobs").get()).toMatchObject({ count: 0 });
    db.close();
  });
});
