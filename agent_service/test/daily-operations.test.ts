import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import {
  buildDailyOperationsReport,
  formatDailyOperationsReport,
} from "../src/reporting/daily-operations.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];
const window = {
  localDate: "2026-07-19",
  timeZone: "Asia/Shanghai",
  startAt: "2026-07-18T16:00:00.000Z",
  endAt: "2026-07-19T16:00:00.000Z",
  generatedAt: "2026-07-19T12:00:00.000Z",
};
const inside = "2026-07-19T08:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDatabase(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-daily-operations-report-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function createCampaign(db: AgentDatabase, suffix: string): string {
  return db.createCampaign({
    name: `report-${suffix}`,
    market: "Malaysia",
    product: "sample products",
    buyerType: "integrator",
    targetCount: 10,
    createdBy: "fixture",
    dailyLimit: 500,
    hourlyLimit: 50,
    followupDays: [3, 7, 14],
  });
}

function createLeadAndMessage(
  db: AgentDatabase,
  campaignId: string,
  suffix: string,
  status: "DELIVERED" | "REPLIED" | "BOUNCED" | "UNKNOWN_RECONCILIATION_REQUIRED",
): { leadId: string; messageId: string } {
  const domain = `${suffix}.example`;
  const leadId = db.upsertLead({
    campaignId,
    company: suffix,
    domain,
    website: `https://${domain}`,
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
    lastActivityAt: inside,
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ sourceUrl: `https://${domain}/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const contactId = db.upsertContact({
    leadId,
    name: `${suffix} buyer`,
    title: "Procurement Manager",
    email: `buyer@${domain}`,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt: inside,
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
    destination: `buyer@${domain}`,
    subject: "Fixture",
    body: "Fixture",
    sequenceIndex: 0,
    status: "DRAFT",
  });
  db.db.prepare(
    "UPDATE contacts SET created_at=?, updated_at=? WHERE id=?",
  ).run(inside, inside, contactId);
  db.db.prepare(
    `UPDATE outbound_messages SET status=?, sent_at=?, updated_at=? WHERE id=?`,
  ).run(status, status === "UNKNOWN_RECONCILIATION_REQUIRED" ? null : inside, inside, messageId);
  return { leadId, messageId };
}

function insertInbound(
  db: AgentDatabase,
  leadId: string,
  suffix: string,
  classification: "P1_INQUIRY" | "OTHER_REPLY" | "BOUNCE" | "SOFT_BOUNCE",
): void {
  db.insertInbound({
    channel: "email",
    providerId: `provider-${suffix}`,
    fromAddress: `${suffix}@example.invalid`,
    bodyText: "Fixture",
    receivedAt: inside,
    classification,
    confidence: 1,
    reason: "fixture",
    leadId,
  });
}

function seedProviderUsage(db: AgentDatabase): void {
  db.db.prepare(
    `INSERT INTO provider_registry(
       id, provider_key, display_name, provider_kind, status, capabilities_json,
       policy_json, created_at, updated_at
     ) VALUES ('provider-report', 'report', 'Report fixture', 'OTHER', 'ENABLED', '[]', '{}', ?, ?)`,
  ).run(inside, inside);
  for (const [id, status] of [["run-success", "SUCCEEDED"], ["run-failed", "FAILED"]] as const) {
    db.db.prepare(
      `INSERT INTO provider_runs(
         id, provider_id, operation, status, idempotency_key, request_hash,
         started_at, completed_at, metadata_json, created_at, updated_at
       ) VALUES (?, 'provider-report', 'lookup', ?, ?, ?, ?, ?, '{}', ?, ?)`,
    ).run(id, status, `idem-${id}`, "a".repeat(16), inside, inside, inside, inside);
  }
  for (const [id, currency, units, cost] of [
    ["usage-usd-1", "USD", 2, 1_500_000],
    ["usage-usd-2", "USD", 3, 500_000],
    ["usage-cny", "CNY", 4, 3_000_000],
  ] as const) {
    db.db.prepare(
      `INSERT INTO resource_usage(
         id, provider_id, resource_type, operation, units, cost_micros, currency,
         idempotency_key, occurred_at, metadata_json, created_at
       ) VALUES (?, 'provider-report', 'record', 'lookup', ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(id, units, cost, currency, `idem-${id}`, inside, inside);
  }
}

function seedLlmUsage(db: AgentDatabase): void {
  for (const [id, model, inputTokens, outputTokens] of [
    ["llm-1", "gpt-fixture", 120, 30],
    ["llm-2", "gpt-fixture", 80, 20],
    ["llm-3", "classifier-fixture", 40, 10],
  ] as const) {
    db.db.prepare(
      `INSERT INTO llm_usage(id, purpose, model, input_tokens, output_tokens, created_at)
       VALUES (?, 'fixture', ?, ?, ?, ?)`,
    ).run(id, model, inputTokens, outputTokens, inside);
  }
}

describe("daily operations report", () => {
  it("reports the complete operating picture without presenting activity counts as a cohort reply rate", () => {
    const db = makeDatabase();
    const firstCampaign = createCampaign(db, "first");
    const secondCampaign = createCampaign(db, "second");
    const replied = createLeadAndMessage(db, firstCampaign, "replied", "REPLIED");
    const delivered = createLeadAndMessage(db, firstCampaign, "delivered", "DELIVERED");
    const bounced = createLeadAndMessage(db, firstCampaign, "bounced", "BOUNCED");
    const unknown = createLeadAndMessage(
      db,
      firstCampaign,
      "unknown",
      "UNKNOWN_RECONCILIATION_REQUIRED",
    );
    const policyBlocked = createLeadAndMessage(db, secondCampaign, "policy-blocked", "DELIVERED");
    db.db.prepare("UPDATE contacts SET created_at=?, updated_at=? WHERE lead_id=?")
      .run("2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z", policyBlocked.leadId);
    db.db.prepare(
      `UPDATE outbound_messages SET status='APPROVED', sent_at=NULL,
         approved_by='fixture', approved_at=?, scheduled_at=?, updated_at=? WHERE id=?`,
    ).run(inside, inside, inside, policyBlocked.messageId);
    db.recordOutboundPolicyBlock(
      policyBlocked.messageId,
      ["destination matches do-not-contact list"],
      "2026-07-19T11:00:00.000Z",
    );
    db.db.prepare("UPDATE leads SET status='READY_FOR_REVIEW' WHERE id=?").run(delivered.leadId);

    db.upsertDiscoveryCandidate({
      campaignId: firstCampaign,
      domain: "same.example",
      company: "same",
      website: "https://same.example",
      round: 1,
      stage: "CONTACT_ENRICHMENT",
      outcome: "SEND_READY",
      reason: "fixture",
      sourceCount: 1,
    });
    db.upsertDiscoveryCandidate({
      campaignId: secondCampaign,
      domain: "SAME.EXAMPLE",
      company: "same duplicate",
      website: "https://same.example",
      round: 1,
      stage: "CONTACT_ENRICHMENT",
      outcome: "SEND_READY",
      reason: "fixture",
      sourceCount: 1,
    });
    db.db.prepare("UPDATE discovery_candidates SET created_at=?, updated_at=?")
      .run(inside, inside);

    insertInbound(db, replied.leadId, "inquiry", "P1_INQUIRY");
    insertInbound(db, replied.leadId, "reply", "OTHER_REPLY");
    insertInbound(db, bounced.leadId, "hard", "BOUNCE");
    insertInbound(db, bounced.leadId, "soft", "SOFT_BOUNCE");
    const eventId = db.recordEvent(
      "message",
      unknown.messageId,
      "MESSAGE_DELIVERY_UNKNOWN_REQUIRES_RECONCILIATION",
      "fixture",
      {},
    );
    db.db.prepare("UPDATE events SET created_at=? WHERE id=?").run(inside, eventId);
    seedProviderUsage(db);
    seedLlmUsage(db);
    db.setSettings({
      imap_runtime_health_state: "HEALTHY",
      imap_last_poll_success_at: inside,
      imap_consecutive_failures: "0",
      outbound_paused: "true",
    });
    db.recordImapMessageFailure({
      uidValidity: "777",
      uid: 42,
      maxAttempts: 1,
      sourceSha256: "a".repeat(64),
      sourceSize: 100,
      preview: { subject: "redacted" },
      errorClass: "ParseError",
      errorMessage: "failed",
    });
    const pendingNotificationId = db.queueNotification(
      db.recordEvent("notification", "feishu", "INQUIRY_ALERT", "fixture", {}),
      "feishu",
      "chat-operations",
    );
    db.db.prepare(
      "UPDATE notifications SET created_at=?, updated_at=?, next_attempt_at=? WHERE id=?",
    ).run("2026-07-19T11:00:00.000Z", "2026-07-19T11:00:00.000Z", "2026-07-19T11:00:00.000Z", pendingNotificationId);
    const deadNotificationId = db.queueNotification(
      db.recordEvent("notification", "feishu", "REPLY_ALERT", "fixture", {}),
      "feishu",
      "chat-dead",
    );
    db.db.prepare(
      `UPDATE notifications
       SET status='DEAD_LETTER', attempts=5, next_attempt_at=NULL,
           dead_lettered_at=?, updated_at=? WHERE id=?`,
    ).run("2026-07-19T11:30:00.000Z", "2026-07-19T11:30:00.000Z", deadNotificationId);

    const report = buildDailyOperationsReport(db, {
      ...window,
      dispatchPlan: [{ allowed: true }, { allowed: false }, { allowed: true }],
      dispatchPlanLimit: 500,
    });

    expect(report.activity).toEqual({
      discoveredCompanies: 1,
      contactsCreated: 4,
      messagesSent: 3,
      messagesDelivered: 2,
      humanReplies: 2,
      inquiries: 1,
      hardBounces: 1,
      softBounces: 1,
    });
    expect(report.inventory).toEqual({
      pendingSendMessages: 3,
      sendableMessages: 2,
      blockedMessages: 1,
      persistedPolicyBlockedMessages: 1,
      oldestPolicyBlockedAgeSeconds: 3_600,
      topPolicyBlockers: [{ reason: "destination matches do-not-contact list", count: 1 }],
      pendingReviewLeads: 1,
      dispatchPlanLimit: 500,
    });
    expect(report.ratios).toEqual({
      sentDeliveryRatio: 2 / 3,
      repliesToSendsActivityRatio: 2 / 3,
      hardBouncesToSendsActivityRatio: 1 / 3,
      replyAndBounceBasis: "same-day-activity-not-cohort",
    });
    expect(report.providers).toMatchObject({
      calls: 2,
      succeeded: 1,
      failed: 1,
      costs: [
        { currency: "CNY", units: 4, costMicros: 3_000_000 },
        { currency: "USD", units: 5, costMicros: 2_000_000 },
      ],
    });
    expect(report.reconciliation).toEqual({ newlyQuarantined: 1, currentlyRequired: 1 });
    expect(report.notificationOutbox).toEqual({
      pendingCount: 1,
      dueCount: 1,
      deadLetterCount: 1,
      oldestPendingAt: "2026-07-19T11:00:00.000Z",
      oldestPendingAgeSeconds: 3_600,
    });
    expect(report.llm).toEqual({
      calls: 3,
      inputTokens: 240,
      outputTokens: 60,
      monetaryCostAvailable: false,
      models: [
        { model: "classifier-fixture", calls: 1, inputTokens: 40, outputTokens: 10 },
        { model: "gpt-fixture", calls: 2, inputTokens: 200, outputTokens: 50 },
      ],
    });
    expect(report.inboundMonitoring).toEqual({
      state: "HEALTHY",
      lastPollSuccessAt: inside,
      consecutiveFailures: 0,
      retryPendingMessages: 0,
      quarantinedMessages: 1,
      unreplayableMessages: 0,
      outboundPaused: true,
    });

    const text = formatDailyOperationsReport(report);
    expect(text).toContain("REPLIED 已计入送达");
    expect(text).toContain("回复/发送活动比（非同一 cohort，不是真实回复率）");
    expect(text).not.toMatch(/(^|[^真])实回复率/);
    expect(text).toContain("Provider 成本（CNY）：3.000000");
    expect(text).toContain("AI 模型用量：3 次调用，输入 240 tokens，输出 60 tokens");
    expect(text).toContain("AI 模型金额：未换算");
    expect(text).toContain("未知投递待对账：当前 1，当日新增 1");
    expect(text).toContain("飞书通知队列：待处理 1（已到期 1；最老等待 3600 秒）；死信 1");
    expect(text).toContain("收件监控：HEALTHY");
    expect(text).toContain("已隔离 1");
    expect(text).toContain("持久策略阻断：1（最老等待 3600 秒）");
    expect(text).toContain("destination matches do-not-contact list：1");
    db.close();
  });

  it("is zero-safe and rejects an undersized plan declaration", () => {
    const db = makeDatabase();
    const report = buildDailyOperationsReport(db, {
      ...window,
      dispatchPlan: [],
      dispatchPlanLimit: 0,
    });
    expect(report.ratios).toMatchObject({
      sentDeliveryRatio: 0,
      repliesToSendsActivityRatio: 0,
      hardBouncesToSendsActivityRatio: 0,
    });
    expect(formatDailyOperationsReport(report)).not.toMatch(/NaN|Infinity/);
    expect(() => buildDailyOperationsReport(db, {
      ...window,
      dispatchPlan: [{ allowed: true }],
      dispatchPlanLimit: 0,
    })).toThrow("exceeds dispatchPlanLimit");
    db.close();
  });
});
