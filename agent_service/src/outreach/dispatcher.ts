import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase, DueMessageCursor, MessageClaimPolicy } from "../db.js";
import { hasFeishuAlertDestination } from "../integrations/feishu-destinations.js";
import { logger } from "../logger.js";
import { outreachQualificationSatisfied } from "../acquisition/recipient-tier.js";
import {
  emailDraftPolicyBlockers,
  GMAIL_PILOT_DAILY_LIMIT,
  GMAIL_PILOT_HOURLY_LIMIT,
  GMAIL_PILOT_MIN_INTERVAL_SECONDS,
  isConsumerMailbox,
  isGmailPilotMode,
} from "./email-policy.js";
import {
  ensureGmailPilotState,
  markGmailPilotSelfTestFailed,
  markGmailPilotSelfTestPassed,
} from "./gmail-pilot.js";
import { currentDeliverabilityPolicy } from "./deliverability-policy.js";
import {
  enforceImapHealthFreshness,
  imapClaimPolicy,
} from "../inbound/email-health.js";
import {
  ensureEmailChannelState,
  markEmailChannelSelfTestFailed,
  markEmailChannelSelfTestPassed,
} from "./email-channel.js";

function startOfHour(): string {
  const date = new Date();
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function startOfDay(): string {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function isDefinitiveSmtpFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const smtpError = error as { responseCode?: unknown; code?: unknown };
  const responseCode = Number(smtpError.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599) return true;
  return new Set(["EAUTH", "EENVELOPE", "EDNS", "EMESSAGE"]).has(String(smtpError.code ?? ""));
}

const DISPATCH_SCAN_CURSOR_SETTING = "outbound_dispatch_scan_cursor_v1";
const DISPATCH_SCAN_PAGE_SIZE = 50;
const DISPATCH_MIN_SCAN_LIMIT = 100;
const DISPATCH_MAX_SCAN_LIMIT = 1_000;

function dueMessageCursor(message: Record<string, unknown>): DueMessageCursor {
  return {
    dueAt: String(message.dispatch_due_at ?? message.scheduled_at ?? message.created_at),
    sequenceIndex: Number(message.sequence_index),
    messageId: String(message.id),
  };
}

function compareDueMessageCursor(left: DueMessageCursor, right: DueMessageCursor): number {
  return left.dueAt.localeCompare(right.dueAt) ||
    left.sequenceIndex - right.sequenceIndex ||
    left.messageId.localeCompare(right.messageId);
}

function parseDispatchScanCursor(value: string | null): DueMessageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DueMessageCursor>;
    if (
      typeof parsed.dueAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.dueAt)) ||
      !Number.isInteger(parsed.sequenceIndex) ||
      Number(parsed.sequenceIndex) < 0 ||
      typeof parsed.messageId !== "string" ||
      !parsed.messageId.trim()
    ) return null;
    return {
      dueAt: parsed.dueAt,
      sequenceIndex: Number(parsed.sequenceIndex),
      messageId: parsed.messageId,
    };
  } catch {
    return null;
  }
}

function claimPolicyBlocker(error: unknown): string | null {
  const message = String(error);
  const match = message.match(/Message is not claimable:[^(]+\((.+)\)$/s);
  return match?.[1]?.trim() ? `claim gate: ${match[1].trim()}` : null;
}

export interface DispatchPlanItem {
  messageId: string;
  company: string;
  channel: string;
  destination: string;
  allowed: boolean;
  blockers: string[];
}

export class OutboundDispatcher {
  private readonly transporter;
  private running = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      requireTLS: config.SMTP_PORT !== 465,
      auth: config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
      pool: true,
      maxConnections: 1,
      maxMessages: Math.max(1, config.EMAIL_HOURLY_LIMIT),
    });
  }

  close(): void {
    this.transporter.close();
  }

  async testEmailChannel(actor: string): Promise<{
    sent: boolean;
    received: boolean;
    passedAt: string;
  }> {
    if (isGmailPilotMode(this.config)) {
      const result = await this.testGmailPilot(actor);
      return { sent: result.sent, received: true, passedAt: result.passedAt };
    }

    const state = ensureEmailChannelState(this.config, this.db);
    const blockers: string[] = [];
    if (this.config.AGENT_MODE !== "production") blockers.push("AGENT_MODE 必须为 production");
    if (!this.config.OUTBOUND_ENABLED) blockers.push("服务器外发能力未开启");
    if (!state.configured) blockers.push("企业邮箱 SMTP/IMAP 配置不完整");
    if (!this.config.EMAIL_DOMAIN_AUTH_VERIFIED) blockers.push("SPF/DKIM/DMARC 尚未确认完成");
    if (!this.config.COMPANY_POSTAL_ADDRESS) blockers.push("企业邮寄地址未配置");
    if (!this.config.EMAIL_UNSUBSCRIBE_TEXT) blockers.push("退订说明未配置");
    if (!hasFeishuAlertDestination(this.config, this.db)) blockers.push("飞书询价通知接收人尚未绑定");
    if (isConsumerMailbox(this.config.EMAIL_FROM_ADDRESS)) blockers.push("企业邮箱自测不能使用个人邮箱");
    if (blockers.length > 0) throw new Error(blockers.join("；"));

    if (state.selfTestPassedAt) {
      const elapsedMs = Date.now() - new Date(state.selfTestPassedAt).getTime();
      if (elapsedMs >= 0 && elapsedMs < 5 * 60_000) {
        return { sent: false, received: true, passedAt: state.selfTestPassedAt };
      }
    }

    const testId = crypto.randomUUID();
    const startedAt = new Date();
    try {
      await this.transporter.verify();
      await this.transporter.sendMail({
        from: { address: this.config.EMAIL_FROM_ADDRESS, name: this.config.EMAIL_FROM_NAME },
        to: this.config.EMAIL_FROM_ADDRESS,
        subject: `[外贸获客智能体] 企业邮箱收发自测 ${testId}`,
        text: [
          "这是一封由外贸获客智能体发送到企业邮箱自身的收发闭环测试。",
          "系统只有在 SMTP 发送和 IMAP 收件均通过后才会记录成功。",
          "本邮件不会发给客户，也不会解除客户外发暂停。",
        ].join("\n"),
        headers: {
          "X-CRM-Agent-System-Test": testId,
          "Auto-Submitted": "auto-generated",
        },
      });

      const received = await this.waitForSelfTestReceipt(testId, startedAt);
      if (!received) throw new Error("SMTP 已接受自测邮件，但 IMAP 未在时限内确认收件");
      const passed = markEmailChannelSelfTestPassed(this.config, this.db, actor);
      return { sent: true, received: true, passedAt: passed.selfTestPassedAt ?? new Date().toISOString() };
    } catch (error) {
      markEmailChannelSelfTestFailed(this.config, this.db, actor, String(error));
      throw new Error(`企业邮箱收发自测失败：${String(error)}`);
    }
  }

  private async waitForSelfTestReceipt(testId: string, startedAt: Date): Promise<boolean> {
    const client = new ImapFlow({
      host: this.config.IMAP_HOST,
      port: this.config.IMAP_PORT,
      secure: true,
      auth: { user: this.config.IMAP_USER, pass: this.config.IMAP_PASSWORD },
      logger: false,
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const matches = await client.search({
          since: new Date(startedAt.getTime() - 60_000),
          header: { "x-crm-agent-system-test": testId },
        }, { uid: true });
        if (matches && matches.length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return false;
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  async testGmailPilot(actor: string): Promise<{
    sent: boolean;
    providerMessageId: string | null;
    passedAt: string;
  }> {
    const state = ensureGmailPilotState(this.config, this.db);
    if (!state.mode) throw new Error("当前不是 Gmail 试运行模式。");
    const blockers: string[] = [];
    if (this.config.AGENT_MODE !== "production") blockers.push("AGENT_MODE 必须为 production");
    if (!this.config.OUTBOUND_ENABLED) blockers.push("服务器外发能力未开启");
    if (!this.config.EMAIL_OUTREACH_ENABLED) blockers.push("邮件外联未开启");
    if (!this.config.EMAIL_INBOUND_ENABLED) blockers.push("IMAP 收件监听未开启");
    if (!this.config.SMTP_HOST || !this.config.SMTP_USER || !this.config.SMTP_PASSWORD) {
      blockers.push("SMTP 配置不完整");
    }
    if (!this.config.IMAP_HOST || !this.config.IMAP_USER || !this.config.IMAP_PASSWORD) {
      blockers.push("IMAP 配置不完整");
    }
    if (!this.config.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND || !this.config.OUTREACH_APPROVAL_REQUIRED) {
      blockers.push("人工审批保护未开启");
    }
    if (this.config.AUTO_FOLLOWUP_ENABLED) blockers.push("Gmail 试运行必须关闭自动跟进");
    if (!hasFeishuAlertDestination(this.config, this.db)) blockers.push("飞书询价通知接收人尚未绑定");
    if (blockers.length > 0) throw new Error(blockers.join("；"));

    if (state.selfTestPassedAt) {
      const elapsedMs = Date.now() - new Date(state.selfTestPassedAt).getTime();
      if (elapsedMs >= 0 && elapsedMs < 5 * 60_000) {
        return { sent: false, providerMessageId: null, passedAt: state.selfTestPassedAt };
      }
    }

    try {
      await this.transporter.verify();
      const sentAt = new Date().toISOString();
      const info = await this.transporter.sendMail({
        from: { address: this.config.EMAIL_FROM_ADDRESS, name: this.config.EMAIL_FROM_NAME },
        to: this.config.EMAIL_FROM_ADDRESS,
        subject: "[外贸获客智能体] Gmail 试运行自测成功",
        text: [
          "这是一封由外贸获客智能体发送到本邮箱的自测邮件。",
          "收到此邮件表示 Gmail SMTP 真实外发链路可用。",
          `测试时间：${sentAt}`,
          "本邮件不会发给客户，也不会启用客户外发。请回到飞书发送“开启 Gmail 试发”，并在确认卡片中点击启用。",
        ].join("\n"),
        headers: {
          "X-CRM-Agent-System-Test": "gmail-pilot",
          "Auto-Submitted": "auto-generated",
        },
      });
      const passed = markGmailPilotSelfTestPassed(
        this.config,
        this.db,
        actor,
        info.messageId,
      );
      return {
        sent: true,
        providerMessageId: info.messageId,
        passedAt: passed.selfTestPassedAt ?? sentAt,
      };
    } catch (error) {
      markGmailPilotSelfTestFailed(this.config, this.db, actor, String(error));
      throw new Error(`Gmail 自测失败：${String(error)}`);
    }
  }

  private blockers(message: Record<string, unknown>): string[] {
    const blockers: string[] = [];
    if (this.db.getSetting("outbound_paused") === "true") blockers.push("global outbound pause is active");
    if (this.config.AGENT_MODE !== "production") blockers.push("AGENT_MODE is not production");
    if (!this.config.OUTBOUND_ENABLED) blockers.push("OUTBOUND_ENABLED is false");
    if (!this.config.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND || !this.config.OUTREACH_APPROVAL_REQUIRED) {
      blockers.push("human approval guards must remain enabled");
    }
    if (
      !this.config.FEISHU_BOT_ENABLED ||
      !this.config.FEISHU_APP_ID ||
      !this.config.FEISHU_APP_SECRET ||
      !hasFeishuAlertDestination(this.config, this.db)
    ) {
      blockers.push("Feishu inquiry alert channel is not ready");
    }
    if (!message.approved_by || !message.approved_at) blockers.push("message sequence is not approved");
    blockers.push(...this.db.getCampaignPolicyAuthorizationBlockers(message));
    if (!message.send_eligible) blockers.push("lead quality gate is not satisfied");
    if (!outreachQualificationSatisfied(message)) {
      blockers.push("current deterministic demand evidence gate is not satisfied");
    }
    if (message.human_takeover) blockers.push("lead is under human takeover");
    if (message.lead_id && this.db.hasUnknownDeliveryForLead(String(message.lead_id))) {
      blockers.push("lead has an unresolved delivery reconciliation");
    }
    if (!["APPROVED", "CONTACTED"].includes(String(message.lead_status))) {
      blockers.push(`lead status is ${message.lead_status}`);
    }
    if (this.db.hasDncMatch([{ type: String(message.channel), value: String(message.destination) }])) {
      blockers.push("destination matches do-not-contact list");
    }

    if (String(message.channel) === "email") {
      const imapHealth = enforceImapHealthFreshness(this.config, this.db).health;
      if (!imapHealth.sendReady) {
        blockers.push(`IMAP runtime reply monitoring is not healthy (${imapHealth.state})`);
      }
      const gmailPilot = isGmailPilotMode(this.config);
      if (gmailPilot && !ensureGmailPilotState(this.config, this.db).activated) {
        blockers.push("Gmail pilot has not been explicitly activated");
      }
      if (!gmailPilot) {
        const emailChannel = ensureEmailChannelState(this.config, this.db);
        if (!emailChannel.configured) {
          blockers.push("enterprise SMTP/IMAP channel is not configured");
        } else if (!emailChannel.selfTestPassed) {
          blockers.push("enterprise SMTP/IMAP send-receive self-test has not passed");
        }
      }
      if (!this.config.EMAIL_OUTREACH_ENABLED) blockers.push("EMAIL_OUTREACH_ENABLED is false");
      if (!this.config.SMTP_HOST || !this.config.SMTP_USER || !this.config.SMTP_PASSWORD) {
        blockers.push("SMTP configuration is incomplete");
      }
      if (
        !this.config.EMAIL_INBOUND_ENABLED ||
        !this.config.IMAP_HOST ||
        !this.config.IMAP_USER ||
        !this.config.IMAP_PASSWORD
      ) {
        blockers.push("IMAP reply monitoring is not ready");
      }
      if (!this.config.COMPANY_POSTAL_ADDRESS) blockers.push("company postal address is missing");
      if (!gmailPilot && !this.config.EMAIL_DOMAIN_AUTH_VERIFIED) {
        blockers.push("SPF/DKIM/DMARC verification is not confirmed");
      }
      if (isConsumerMailbox(this.config.EMAIL_FROM_ADDRESS) && !gmailPilot) {
        blockers.push("consumer mailbox is not allowed for production outreach");
      }
      blockers.push(
        ...emailDraftPolicyBlockers(
          this.config,
          message,
          {
            ...message,
            name: message.contact_name,
            title: message.contact_title,
            source_url: message.contact_source_url,
          },
        ),
      );
      if (gmailPilot && Number(message.sequence_index) > 0) {
        blockers.push("Gmail pilot only permits the manually approved first email");
      } else if (Number(message.sequence_index) > 0 && !this.config.AUTO_FOLLOWUP_ENABLED) {
        blockers.push("AUTO_FOLLOWUP_ENABLED is false");
      }
      const hourly = this.db.countSentSince(startOfHour(), "email");
      const daily = this.db.countSentSince(startOfDay(), "email");
      const deliverability = currentDeliverabilityPolicy(this.config, this.db);
      const hourlyLimit = Math.min(
        deliverability.hourlyCeiling,
        Number(message.campaign_hourly_limit ?? Number.MAX_SAFE_INTEGER),
        gmailPilot ? GMAIL_PILOT_HOURLY_LIMIT : Number.MAX_SAFE_INTEGER,
      );
      const dailyLimit = Math.min(
        deliverability.dailyTarget,
        Number(message.campaign_daily_limit ?? Number.MAX_SAFE_INTEGER),
        gmailPilot ? GMAIL_PILOT_DAILY_LIMIT : Number.MAX_SAFE_INTEGER,
      );
      if (hourly >= hourlyLimit) blockers.push(`hourly email limit reached (${hourlyLimit})`);
      if (daily >= dailyLimit) blockers.push(`daily email limit reached (${dailyLimit})`);
      const latestSentAt = this.db.getLatestSentAt("email");
      const minimumIntervalSeconds = Math.max(
        gmailPilot ? GMAIL_PILOT_MIN_INTERVAL_SECONDS : 0,
        deliverability.minimumIntervalSeconds,
      );
      if (latestSentAt && minimumIntervalSeconds > 0) {
        const elapsedSeconds = (Date.now() - new Date(latestSentAt).getTime()) / 1000;
        if (elapsedSeconds < minimumIntervalSeconds) {
          blockers.push(`adaptive deliverability spacing is active (${deliverability.stage})`);
        }
      }
      const bounce = this.db.getBounceStats();
      if (bounce.sent >= 20 && bounce.rate > this.config.EMAIL_MAX_HARD_BOUNCE_RATE) {
        const recovery = this.db.getDeliverabilityRecoveryState({
          maxHardBounceRate: this.config.EMAIL_MAX_HARD_BOUNCE_RATE,
          hardBounceWindowSize: 50,
          hardBounceMinimumSample: 20,
        });
        if (!recovery.authorizationId) {
          blockers.push(`hard bounce rate ${Math.round(bounce.rate * 1000) / 10}% exceeds limit`);
        }
      }
    }

    if (String(message.channel) === "whatsapp") {
      if (!this.config.WHATSAPP_OUTREACH_ENABLED || !this.config.WHATSAPP_BUSINESS_API_ENABLED) {
        blockers.push("WhatsApp Business API is disabled");
      }
      if (!this.config.WHATSAPP_APP_SECRET || !this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        blockers.push("WhatsApp signed webhook is not ready");
      }
      if (!message.whatsapp_opt_in_at) blockers.push("WhatsApp opt-in is missing");
      const daily = this.db.countSentSince(startOfDay(), "whatsapp");
      if (daily >= this.config.WHATSAPP_DAILY_LIMIT) blockers.push("WhatsApp daily limit reached");
    }
    return blockers;
  }

  private claimPolicy(message: Record<string, unknown>): MessageClaimPolicy {
    if (String(message.channel) === "whatsapp") {
      return {
        globalDailyLimit: this.config.WHATSAPP_DAILY_LIMIT,
      };
    }
    const gmailPilot = isGmailPilotMode(this.config);
    const deliverability = currentDeliverabilityPolicy(this.config, this.db);
    return {
      ...imapClaimPolicy(this.config),
      allowRiskyEmail: gmailPilot,
      requireGmailPilotActivation: gmailPilot,
      maximumSequenceIndex: gmailPilot || !this.config.AUTO_FOLLOWUP_ENABLED
        ? 0
        : Number.MAX_SAFE_INTEGER,
      minimumLeadScore: gmailPilot ? 90 : 0,
      minimumSourceCount: gmailPilot ? 2 : 0,
      globalHourlyLimit: Math.min(
        deliverability.hourlyCeiling,
        gmailPilot ? GMAIL_PILOT_HOURLY_LIMIT : Number.MAX_SAFE_INTEGER,
      ),
      globalDailyLimit: Math.min(
        deliverability.dailyTarget,
        gmailPilot ? GMAIL_PILOT_DAILY_LIMIT : Number.MAX_SAFE_INTEGER,
      ),
      minimumIntervalSeconds: Math.max(
        deliverability.minimumIntervalSeconds,
        gmailPilot ? GMAIL_PILOT_MIN_INTERVAL_SECONDS : 0,
      ),
      hardBounceWindowSize: 50,
      hardBounceMinimumSample: 20,
      maxHardBounceRate: this.config.EMAIL_MAX_HARD_BOUNCE_RATE,
      allowAuditedDeliverabilityRecovery: true,
    };
  }

  plan(limit = 20): DispatchPlanItem[] {
    return this.db.getDueMessages(limit).map((message) => {
      const blockers = this.blockers(message);
      return {
        messageId: String(message.id),
        company: String(message.company),
        channel: String(message.channel),
        destination: String(message.destination),
        allowed: blockers.length === 0,
        blockers,
      };
    });
  }

  private dueMessagesForBoundedScan(limit: number, now: string): Array<Record<string, unknown>> {
    if (limit <= 0) return [];
    const initialCursor = parseDispatchScanCursor(this.db.getSetting(DISPATCH_SCAN_CURSOR_SETTING));
    let cursor = initialCursor;
    let wrapped = false;
    let finished = false;
    const messages: Array<Record<string, unknown>> = [];

    while (!finished && messages.length < limit) {
      const pageLimit = Math.min(DISPATCH_SCAN_PAGE_SIZE, limit - messages.length);
      const page = this.db.getDueMessagesPage(pageLimit, now, cursor);
      if (page.length === 0) {
        if (!wrapped && initialCursor) {
          wrapped = true;
          cursor = null;
          continue;
        }
        break;
      }

      for (const message of page) {
        const nextCursor = dueMessageCursor(message);
        const initialComparison = wrapped && initialCursor
          ? compareDueMessageCursor(nextCursor, initialCursor)
          : -1;
        if (initialComparison > 0) {
          finished = true;
          break;
        }
        messages.push(message);
        cursor = nextCursor;
        if (initialComparison === 0 || messages.length >= limit) {
          finished = initialComparison === 0;
          break;
        }
      }

      if (!finished && page.length < pageLimit) {
        if (!wrapped && initialCursor) {
          wrapped = true;
          cursor = null;
        } else {
          break;
        }
      }
    }

    return messages;
  }

  async runOnce(limit = 10): Promise<{ sent: number; blocked: number; failed: number; unknown: number }> {
    if (this.running) {
      logger.warn("Skipped overlapping outbound dispatcher run");
      return { sent: 0, blocked: 0, failed: 0, unknown: 0 };
    }
    this.running = true;
    try {
      const sendLimit = Math.max(0, Math.trunc(limit));
      if (sendLimit === 0) return { sent: 0, blocked: 0, failed: 0, unknown: 0 };
      const scanLimit = Math.min(
        DISPATCH_MAX_SCAN_LIMIT,
        Math.max(DISPATCH_MIN_SCAN_LIMIT, sendLimit * 10),
      );
      let sent = 0;
      let blocked = 0;
      let failed = 0;
      let unknown = 0;
      let lastProcessedCursor: DueMessageCursor | null = null;
      const scanStartedAt = new Date().toISOString();
      for (const dueMessage of this.dueMessagesForBoundedScan(scanLimit, scanStartedAt)) {
        if (sent >= sendLimit) break;
        const blockers = this.blockers(dueMessage);
        if (blockers.length > 0) {
          blocked += 1;
          const newlyRecorded = this.db.recordOutboundPolicyBlock(
            String(dueMessage.id),
            blockers,
            scanStartedAt,
          );
          lastProcessedCursor = dueMessageCursor(dueMessage);
          const log = newlyRecorded ? logger.warn.bind(logger) : logger.debug.bind(logger);
          log({ messageId: dueMessage.id, blockers }, "Outbound message blocked");
          continue;
        }
        let emailSubmissionPrepared = false;
        let claimed = false;
        try {
          const message = this.db.claimMessageForSending(
            String(dueMessage.id),
            this.claimPolicy(dueMessage),
          );
          claimed = true;
          if (String(message.channel) === "email") {
            const footer = [
              this.config.EMAIL_UNSUBSCRIBE_TEXT.trim(),
              this.config.COMPANY_POSTAL_ADDRESS.trim(),
            ].filter(Boolean).join("\n");
            const body = footer && !String(message.body).includes(footer)
              ? `${String(message.body).trim()}\n\n${footer}`
              : String(message.body);
            const replyTo = this.config.EMAIL_REPLY_TO || this.config.EMAIL_FROM_ADDRESS;
            const senderDomain = this.config.EMAIL_FROM_ADDRESS.split("@").at(-1)?.toLowerCase() || "invalid";
            const submissionMessageId = `<crm-${crypto.createHash("sha256").update(String(message.id)).digest("hex").slice(0, 32)}@${senderDomain}>`;
            this.db.prepareMessageSubmissionReference(String(message.id), submissionMessageId);
            emailSubmissionPrepared = true;
            const info = await this.transporter.sendMail({
              from: { address: this.config.EMAIL_FROM_ADDRESS, name: this.config.EMAIL_FROM_NAME },
              replyTo,
              to: String(message.destination),
              subject: String(message.subject),
              text: body,
              messageId: submissionMessageId,
              inReplyTo: message.parent_message_id ? String(message.parent_message_id) : undefined,
              references: message.parent_message_id ? [String(message.parent_message_id)] : undefined,
              headers: {
                "X-CRM-Agent-Message-Id": String(message.id),
                "X-CRM-Agent-Campaign-Id": String(message.campaign_id ?? ""),
                "List-Unsubscribe": `<mailto:${replyTo}?subject=unsubscribe>`,
              },
            });
            this.db.markMessageSent(
              String(message.id),
              info.messageId || submissionMessageId,
              info.messageId || submissionMessageId,
            );
          } else {
            const providerId = await this.sendWhatsAppTemplate(message);
            this.db.markMessageSent(String(message.id), providerId, providerId);
          }
          sent += 1;
        } catch (error) {
          const claimBlocker = claimed ? null : claimPolicyBlocker(error);
          if (claimBlocker) {
            blocked += 1;
            const newlyRecorded = this.db.recordOutboundPolicyBlock(
              String(dueMessage.id),
              [claimBlocker],
              scanStartedAt,
            );
            lastProcessedCursor = dueMessageCursor(dueMessage);
            const log = newlyRecorded ? logger.warn.bind(logger) : logger.debug.bind(logger);
            log({ messageId: dueMessage.id, blocker: claimBlocker }, "Outbound claim blocked");
            continue;
          }
          if (
            emailSubmissionPrepared &&
            !isDefinitiveSmtpFailure(error) &&
            this.db.markMessageDeliveryUnknown(
              String(dueMessage.id),
              `SMTP submission outcome is unknown: ${String(error)}`,
              "dispatcher",
            )
          ) {
            unknown += 1;
            logger.error(
              { error, messageId: dueMessage.id },
              "SMTP outcome is unknown; message quarantined and outbound paused",
            );
          } else {
            failed += 1;
            this.db.markMessageFailed(String(dueMessage.id), String(error));
            logger.error({ error, messageId: dueMessage.id }, "Outbound send failed");
          }
        }
        lastProcessedCursor = dueMessageCursor(dueMessage);
      }
      if (lastProcessedCursor) {
        this.db.setSetting(DISPATCH_SCAN_CURSOR_SETTING, JSON.stringify(lastProcessedCursor));
      }
      return { sent, blocked, failed, unknown };
    } finally {
      this.running = false;
    }
  }

  private async sendWhatsAppTemplate(message: Record<string, unknown>): Promise<string> {
    if (
      !this.config.WHATSAPP_PHONE_NUMBER_ID ||
      !this.config.WHATSAPP_ACCESS_TOKEN ||
      !this.config.WHATSAPP_TEMPLATE_NAME
    ) {
      throw new Error("WhatsApp configuration is incomplete");
    }
    const number = String(message.destination).replace(/\D/g, "");
    const response = await fetch(
      `https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: number,
          type: "template",
          template: {
            name: this.config.WHATSAPP_TEMPLATE_NAME,
            language: { code: this.config.WHATSAPP_TEMPLATE_LANGUAGE },
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: String(message.company) }],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await response.json()) as { messages?: Array<{ id?: string }>; error?: unknown };
    if (!response.ok || !body.messages?.[0]?.id) {
      throw new Error(`WhatsApp send failed: ${JSON.stringify(body.error ?? body)}`);
    }
    return body.messages[0].id ?? "";
  }
}
