import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { registerOperationsDashboard } from "../src/dashboard/routes.js";
import type { DashboardRuntimeState } from "../src/dashboard/service.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import { DEMAND_POLICY_VERSION } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-dashboard-"));
  tempDirs.push(directory);
  return new AgentDatabase(path.join(directory, "agent.db"));
}

function seedConversation(db: AgentDatabase): void {
  const campaignId = db.createCampaign({
    name: "dashboard-conversation",
    market: "Malaysia",
    product: "sample products",
    buyerType: "system integrator",
    targetCount: 1,
    createdBy: "test",
    dailyLimit: 50,
    hourlyLimit: 5,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: "Dashboard Buyer",
    domain: "dashboard-buyer.example",
    website: "https://dashboard-buyer.example",
    country: "Malaysia",
    buyerType: "product-control system integrator",
    product: "sample products",
    fitScore: 24,
    intentScore: 18,
    activityScore: 12,
    contactScore: 20,
    channelScore: 5,
    totalScore: 79,
    grade: "SILVER",
    lastActivityAt: "2026-07-25T00:00:00.000Z",
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "INDUSTRY_FIT",
    demandEvidence: [{ stage: "INDUSTRY_FIT", sourceUrl: "https://dashboard-buyer.example/solutions" }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.addLeadSource(
    leadId,
    "https://dashboard-buyer.example/solutions",
    "official_website",
    "2026-07-25",
    "The company designs sample product application systems.",
  );
  db.addLeadSource(
    leadId,
    "https://www.linkedin.com/company/dashboard-buyer",
    "linkedin_public",
    "2026-07-25",
    "Public company profile confirms the system-integration business.",
  );
  const contactId = db.upsertContact({
    leadId,
    name: "Amina Buyer",
    title: "Engineering Director",
    email: "amina@dashboard-buyer.example",
    linkedin: "https://www.linkedin.com/in/amina-buyer",
    sourceUrl: "https://dashboard-buyer.example/team",
    employmentVerifiedAt: "2026-07-25T00:00:00.000Z",
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
    destination: "amina@dashboard-buyer.example",
    subject: "sample product components for your projects",
    body: "We can supply sample product components for your integration projects.",
    sequenceIndex: 0,
    scheduledAt: "2026-07-25T00:00:00.000Z",
    status: "PENDING_APPROVAL",
  });
  db.db.prepare(
    `UPDATE outbound_messages SET status='SENT', sent_at=?, provider_message_id=?,
       thread_id=?, updated_at=? WHERE id=?`,
  ).run(
    "2026-07-25T00:01:00.000Z",
    "<dashboard-message@example.test>",
    "<dashboard-message@example.test>",
    "2026-07-25T00:01:00.000Z",
    messageId,
  );
  const providerId = "dashboard-inbound-1";
  db.insertInbound({
    channel: "email",
    providerId,
    threadId: "<dashboard-message@example.test>",
    fromAddress: "amina@dashboard-buyer.example",
    toAddress: "sales@example.test",
    subject: "Re: sample product components for your projects",
    bodyText: "Please quote sample components for our next sample application project.",
    receivedAt: "2026-07-25T01:00:00.000Z",
    classification: "P1_INQUIRY",
    confidence: 0.98,
    reason: "explicit quotation request",
    leadId,
    contactId,
    outboundMessageId: messageId,
  });
  db.upsertInquiryIntake({
    source: "EMAIL",
    providerEventId: providerId,
    messageId: "<dashboard-inbound@example.test>",
    sender: "amina@dashboard-buyer.example",
    recipient: "sales@example.test",
    subject: "Re: sample product components for your projects",
    bodyText: "Please quote sample components for our next sample application project.",
    receivedAt: "2026-07-25T01:00:00.000Z",
    classification: "P1_INQUIRY",
    leadId,
    outboundMessageId: messageId,
    correlationMethod: "exact_provider_reference",
    correlationConfidence: 1,
  });
  db.recordSourceOutcome(leadId, "reply");
  db.recordSourceOutcome(leadId, "inquiry");
}

const runtime: DashboardRuntimeState = {
  feishuConnected: () => true,
  imapHealth: () => ({ state: "HEALTHY", sendReady: true, consecutiveFailures: 0 }),
  dailyResearchEnabled: () => false,
  dispatchPlan: () => [],
  deliverabilityPolicy: () => ({
    mode: "adaptive",
    dailyTarget: 5,
    hourlyCeiling: 1,
    minimumIntervalSeconds: 1200,
    stage: "deliverability_recovery",
  }),
  deliverabilityRecovery: () => ({
    required: false,
    bounceStats: { sent: 0, bounced: 0, rate: 0 },
    requiredSuccessfulMessages: 0,
    unresolvedIncidents: 0,
    authorizationId: null,
    authorizationExpiresAt: null,
    authorizedMessages: 0,
    claimedMessages: 0,
    remainingMessages: 0,
    invalidatedByNewBounce: false,
  }),
};

describe("private operations dashboard", () => {
  it("serves the dashboard and a secret-free operational snapshot on loopback", async () => {
    const db = database();
    const app = Fastify();
    const config = loadConfig({
      DASHBOARD_ENABLED: "true",
      SMTP_PASSWORD: "must-not-leak",
      FEISHU_APP_SECRET: "must-not-leak-either",
    });
    await registerOperationsDashboard(app, config, db, runtime);

    const page = await app.inject({ method: "GET", url: "/dashboard" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.body).toContain("外贸获客智能体");
    expect(page.body).not.toContain("EXPORT INTELLIGENCE");
    const snapshot = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      timezone: "Asia/Shanghai",
      runtime: { feishuConnected: true, dailyResearchEnabled: false },
    });
    expect(snapshot.body).not.toContain("must-not-leak");

    await app.close();
    db.close();
  });

  it("rejects direct non-loopback clients", async () => {
    const db = database();
    const app = Fastify();
    await registerOperationsDashboard(app, loadConfig({ DASHBOARD_ENABLED: "true" }), db, runtime);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/snapshot",
      remoteAddress: "203.0.113.10",
    });
    expect(response.statusCode).toBe(403);

    await app.close();
    db.close();
  });

  it("caches the expensive SQLite integrity scan across live refreshes", async () => {
    const db = database();
    const checkIntegrity = vi.spyOn(db, "checkIntegrity");
    const app = Fastify();
    await registerOperationsDashboard(app, loadConfig({ DASHBOARD_ENABLED: "true" }), db, runtime);

    const first = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    const second = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(checkIntegrity).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  it("joins sent content, customer rationale, sources, and inbound inquiry details", async () => {
    const db = database();
    seedConversation(db);
    const app = Fastify();
    await registerOperationsDashboard(app, loadConfig({
      DASHBOARD_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sales@example.test",
    }), db, runtime);

    const response = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json();
    expect(snapshot.summary).toMatchObject({ confirmed_replies: 1, confirmed_inquiries: 1 });
    expect(snapshot.inbox.metrics).toMatchObject({ confirmed_replies: 1, confirmed_inquiries: 1 });
    expect(snapshot.inbox.messages[0]).toMatchObject({
      classification: "P1_INQUIRY",
      intake_status: "MATCHED",
      company: "Dashboard Buyer",
      outbound_subject: "sample product components for your projects",
    });
    expect(snapshot.messages[0]).toMatchObject({
      company: "Dashboard Buyer",
      title: "Engineering Director",
      lead_product: "sample products",
      reply_count: 1,
      inquiry_count: 1,
    });
    expect(snapshot.messages[0].acquisition_sources).toHaveLength(2);
    expect(snapshot.sources.performance).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "official_website", leads: 1, replies: 1, inquiries: 1 }),
      expect.objectContaining({ source_type: "linkedin_public", leads: 1, replies: 1, inquiries: 1 }),
    ]));

    await app.close();
    db.close();
  });

  it("shows only the current enterprise inbox while retaining legacy mailbox audit counts", async () => {
    const db = database();
    seedConversation(db);
    db.insertInbound({
      channel: "email",
      providerId: "legacy-gmail-inbound",
      fromAddress: "notice@example.test",
      toAddress: "legacy-user@gmail.com",
      subject: "Legacy inbox notification",
      bodyText: "This belongs to the previous mailbox configuration.",
      receivedAt: "2026-07-24T01:00:00.000Z",
      classification: "OTHER_REPLY",
      confidence: 0.9,
      reason: "legacy fixture",
    });
    const app = Fastify();
    await registerOperationsDashboard(app, loadConfig({
      DASHBOARD_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sales@example.test",
    }), db, runtime);

    const response = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json();
    expect(snapshot.summary).toMatchObject({
      inbound_messages: 1,
      matched_inbound: 1,
      confirmed_replies: 1,
    });
    expect(snapshot.inbox.metrics).toMatchObject({
      inbox_total: 1,
      stored_inbound_total: 2,
      historical_other_mailboxes: 1,
      mailbox_domain: "example.test",
    });
    expect(snapshot.inbox.messages).toHaveLength(1);
    expect(snapshot.inbox.messages[0].to_address).toBe("sales@example.test");

    await app.close();
    db.close();
  });

  it("generates and caches a faithful Chinese translation for a selected mail record", async () => {
    const db = database();
    seedConversation(db);
    const app = Fastify();
    const json = vi.fn().mockResolvedValue({
      subject: "为贵司项目提供示例产品部件",
      body: "我们可以为贵司的集成项目供应示例产品部件。",
      fields: {
        country: "马来西亚",
        contactTitle: "工程总监",
        buyerType: "示例系统集成商",
        product: "示例产品",
        demandStage: "行业与产品适配",
        qualificationTrack: "理想客户适配",
        campaignName: "大屏会话测试",
        verificationNotes: "",
      },
      demandEvidence: ["客户官网展示了工业示例系统相关方案。"],
      sourceEvidence: ["该公司设计工业示例系统。", "公开公司主页确认其系统集成业务。"],
    });
    const llm = { isConfigured: () => true, json } as unknown as Pick<AgentLlm, "isConfigured" | "json">;
    await registerOperationsDashboard(
      app,
      loadConfig({ DASHBOARD_ENABLED: "true", EMAIL_FROM_ADDRESS: "sales@example.test" }),
      db,
      runtime,
      llm,
    );
    const snapshot = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    const messageId = snapshot.json().messages[0].id as string;
    const first = await app.inject({
      method: "POST",
      url: "/api/dashboard/mail-translation",
      payload: { kind: "outbound", messageId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      kind: "outbound",
      messageId,
      cached: false,
      translation: { subject: "为贵司项目提供示例产品部件" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/dashboard/mail-translation",
      payload: { kind: "outbound", messageId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ cached: true });
    expect(json).toHaveBeenCalledTimes(1);

    await app.close();
    db.close();
  });

  it("translates an inbound reply and its linked outbound message without exposing a client-supplied body", async () => {
    const db = database();
    seedConversation(db);
    const app = Fastify();
    const json = vi.fn().mockResolvedValue({
      subject: "回复：贵司项目的示例产品部件",
      body: "请为我们下一个产品项目报价示例配件。",
      fields: {
        contactTitle: "工程总监",
        buyerType: "示例系统集成商",
        product: "示例产品",
        reason: "客户明确要求报价。",
        correlationMethod: "按邮件线程精确关联",
        intakeStatus: "已匹配处理",
        opportunityStage: "询盘",
        outboundSubject: "为贵司项目提供示例产品部件",
        outboundBody: "我们可以为贵司的集成项目供应示例产品部件。",
      },
      demandEvidence: ["官网显示该公司从事示例系统集成。"],
      sourceEvidence: [],
    });
    const llm = { isConfigured: () => true, json } as unknown as Pick<AgentLlm, "isConfigured" | "json">;
    await registerOperationsDashboard(
      app,
      loadConfig({ DASHBOARD_ENABLED: "true", EMAIL_FROM_ADDRESS: "sales@example.test" }),
      db,
      runtime,
      llm,
    );
    const snapshot = await app.inject({ method: "GET", url: "/api/dashboard/snapshot" });
    const inboundId = snapshot.json().inbox.messages[0].id as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/mail-translation",
      payload: { kind: "inbound", messageId: inboundId, body: "这段客户端伪造正文不能被采用" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "inbound",
      messageId: inboundId,
      translation: {
        body: "请为我们下一个产品项目报价示例配件。",
        fields: { outboundBody: "我们可以为贵司的集成项目供应示例产品部件。" },
      },
    });
    expect(json).toHaveBeenCalledWith(
      "dashboard_mail_translation_zh_cn",
      expect.any(String),
      expect.not.stringContaining("客户端伪造正文"),
      expect.any(String),
    );

    await app.close();
    db.close();
  });
});
