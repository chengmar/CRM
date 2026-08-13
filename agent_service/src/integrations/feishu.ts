import {
  Domain,
  LoggerLevel,
  createLarkChannel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { GroundedMessageJobResult } from "../acquisition/grounded-message-workflow.js";
import type { DailyOperationsNotification } from "../jobs/daily-operations.js";
import { logger } from "../logger.js";
import type { InquiryNotifier } from "../inbound/processor.js";
import { FeishuAuthorization } from "./feishu/authorization.js";
import {
  dailyOperationsReportCard,
  deliveryReconciliationCard,
  fallbackNotificationCard,
  groundedMessageReviewCard,
  hardBounceCard,
  imapMessageQuarantineCard,
  imapRuntimeHealthCard,
  inquiryCard,
  quarantineCard,
  replyCard,
  safetyPauseCard,
} from "./feishu/cards.js";
import { createFeishuSdkLogger, safeFeishuError } from "./feishu/sdk-logger.js";
import type {
  FeishuActionHandler,
  FeishuCommandHandler,
  FeishuDeliveryReconciliationPayload,
  FeishuImapHealthPayload,
  FeishuImapMessageQuarantinePayload,
  FeishuNotificationPayload,
  FeishuQuarantinePayload,
} from "./feishu/types.js";
import { listFeishuAlertDestinations } from "./feishu-destinations.js";

export type { FeishuActionHandler, FeishuCommandHandler } from "./feishu/types.js";

const pendingAlertDestination = "__configured_alert_destination__";

export class FeishuIntegration implements InquiryNotifier {
  private channel: LarkChannel | null = null;
  private readonly authorization: FeishuAuthorization;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
  ) {
    this.authorization = new FeishuAuthorization(config, db);
  }

  isEnabled(): boolean {
    return Boolean(
      this.config.FEISHU_BOT_ENABLED &&
        this.config.FEISHU_APP_ID &&
        this.config.FEISHU_APP_SECRET,
    );
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  authorizedUserCount(): number {
    return this.authorization.userCount();
  }

  authorizedChatCount(): number {
    return this.authorization.chatCount();
  }

  async start(
    commandHandler: FeishuCommandHandler,
    actionHandler: FeishuActionHandler,
  ): Promise<void> {
    if (!this.isEnabled()) {
      logger.info("Feishu bot is disabled");
      return;
    }
    this.authorization.assertCanStart();
    const bootstrapPairing = this.authorization.requiresBootstrapPairing();
    const channel = createLarkChannel({
      appId: this.config.FEISHU_APP_ID,
      appSecret: this.config.FEISHU_APP_SECRET,
      domain: Domain.Feishu,
      transport: "websocket",
      loggerLevel: LoggerLevel.info,
      logger: createFeishuSdkLogger(this.config.FEISHU_APP_SECRET),
      source: "export-ai-agent",
      handshakeTimeoutMs: 20_000,
      policy: {
        dmMode: bootstrapPairing ? "open" : "allowlist",
        dmAllowlist: [...this.authorization.users()],
        groupAllowlist:
          this.authorization.chatCount() > 0 ? [...this.authorization.chats()] : undefined,
        requireMention: true,
        respondToMentionAll: false,
      },
      safety: {
        dedup: { ttl: 10 * 60_000, maxEntries: 5000 },
        staleMessageWindowMs: 5 * 60_000,
        chatQueue: { enabled: true },
      },
    });
    const sendHandlerOutput = async (
      chatId: string,
      output: string | { card: object },
      replyTo?: string,
    ): Promise<void> => {
      if (typeof output === "string") {
        await channel.send(chatId, { text: output }, replyTo ? { replyTo } : undefined);
        return;
      }
      try {
        await channel.send(chatId, output, replyTo ? { replyTo } : undefined);
      } catch (error) {
        logger.error(
          { error: safeFeishuError(error, this.config.FEISHU_APP_SECRET), chatId },
          "Feishu response card failed",
        );
        await channel.send(
          chatId,
          {
            text: "卡片发送失败，本次操作未执行。系统已记录错误，请稍后重新发送原命令。",
          },
          replyTo ? { replyTo } : undefined,
        );
      }
    };
    channel.on("message", async (message: NormalizedMessage) => {
      if (
        message.chatType === "p2p" &&
        this.authorization.bindUser(message.content, message.senderId)
      ) {
        channel.updatePolicy({
          dmMode: "allowlist",
          dmAllowlist: [...this.authorization.users()],
        });
        await channel.send(message.chatId, { text: "用户绑定成功。以后只有已绑定用户可以下达命令。" });
        return;
      }
      if (
        message.chatType === "group" &&
        this.authorization.bindChat(
          message.content.replace(/^@\S+\s*/, ""),
          message.senderId,
          message.chatId,
        )
      ) {
        channel.updatePolicy({ groupAllowlist: [...this.authorization.chats()] });
        await channel.send(message.chatId, { text: "销售群绑定成功。" });
        return;
      }
      if (!this.authorization.hasUser(message.senderId)) {
        await channel.send(message.chatId, {
          text: "该用户未授权。请在安装器的“绑定飞书”步骤查看一次性配对码，然后发送：绑定 <配对码>",
        });
        return;
      }
      if (message.chatType === "group" && !this.authorization.hasChat(message.chatId)) {
        await channel.send(message.chatId, { text: "该群尚未绑定。请发送：绑定群 配对码" });
        return;
      }
      const output = await commandHandler({
        text: message.content,
        senderId: message.senderId,
        chatId: message.chatId,
        messageId: message.messageId,
      });
      await sendHandlerOutput(message.chatId, output, message.messageId);
    });
    channel.on("cardAction", async (event: CardActionEvent) => {
      if (!this.authorization.hasUser(event.operator.openId)) {
        await channel.send(event.chatId, { text: "该用户无权执行审批操作。" });
        return;
      }
      const output = await actionHandler({
        action: event.action.value,
        senderId: event.operator.openId,
        chatId: event.chatId,
        messageId: event.messageId,
      });
      await sendHandlerOutput(event.chatId, output);
    });
    channel.on("reject", (event) => logger.warn({ event }, "Feishu command rejected by policy"));
    channel.on("error", (error) =>
      logger.error(
        { error: safeFeishuError(error, this.config.FEISHU_APP_SECRET) },
        "Feishu channel error",
      ),
    );
    await channel.connect();
    this.channel = channel;
    logger.info("Feishu command channel connected");
  }

  async stop(): Promise<void> {
    await this.channel?.disconnect();
    this.channel = null;
  }

  private destinations(): string[] {
    return listFeishuAlertDestinations(this.config, this.db);
  }

  hasAlertDestinations(): boolean {
    return this.destinations().length > 0;
  }

  private async sendOrQueue(
    eventType: string,
    payload: Record<string, unknown>,
    card: object,
  ): Promise<void> {
    const eventId = this.db.recordEvent("notification", "feishu", eventType, "system", payload);
    const destinations = this.destinations();
    if (destinations.length === 0) {
      logger.error({ eventId, eventType }, "Feishu notification has no configured destination");
      this.db.queueNotification(eventId, "feishu", pendingAlertDestination);
      return;
    }
    for (const destination of destinations) {
      if (this.channel) {
        try {
          await this.channel.send(destination, { card });
          continue;
        } catch (error) {
          logger.error({ error, destination }, "Feishu notification failed; queued for retry");
        }
      }
      this.db.queueNotification(eventId, "feishu", destination);
    }
  }

  private stageNotification(
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const eventId = this.db.recordEvent("notification", "feishu", eventType, "system", payload);
    const destinations = this.destinations();
    if (destinations.length === 0) {
      this.db.queueNotification(eventId, "feishu", pendingAlertDestination);
      return;
    }
    for (const destination of destinations) {
      this.db.queueNotification(eventId, "feishu", destination);
    }
  }

  stageInquiryNotification(payload: FeishuNotificationPayload): void {
    this.stageNotification("INQUIRY_ALERT", payload as unknown as Record<string, unknown>);
  }

  async notifyInquiry(payload: FeishuNotificationPayload): Promise<void> {
    await this.sendOrQueue(
      "INQUIRY_ALERT",
      payload as unknown as Record<string, unknown>,
      inquiryCard(payload),
    );
  }

  async notifyReply(payload: FeishuNotificationPayload): Promise<void> {
    await this.sendOrQueue(
      "REPLY_ALERT",
      payload as unknown as Record<string, unknown>,
      replyCard(payload),
    );
  }

  async notifySafetyPause(payload: FeishuNotificationPayload): Promise<void> {
    await this.sendOrQueue(
      "GMAIL_PILOT_SAFETY_PAUSE",
      payload as unknown as Record<string, unknown>,
      safetyPauseCard(payload),
    );
  }

  async notifyHardBounce(payload: FeishuNotificationPayload): Promise<void> {
    await this.sendOrQueue(
      "EMAIL_HARD_BOUNCE_ALERT",
      payload as unknown as Record<string, unknown>,
      hardBounceCard(payload),
    );
  }

  stageImapRuntimeHealth(payload: FeishuImapHealthPayload): boolean {
    const destinations = this.destinations();
    return this.db.stageNotificationOnce({
      idempotencyKey: `imap-runtime-health:${payload.episode}:${payload.recovered ? "recovered" : "paused"}`,
      eventType: payload.recovered ? "IMAP_RUNTIME_RECOVERED" : "IMAP_RUNTIME_HEALTH_PAUSE",
      payload: payload as unknown as Record<string, unknown>,
      channel: "feishu",
      destinations: destinations.length > 0 ? destinations : [pendingAlertDestination],
    });
  }

  stageImapMessageQuarantine(payload: FeishuImapMessageQuarantinePayload): boolean {
    const destinations = this.destinations();
    return this.db.stageNotificationOnce({
      idempotencyKey: `imap-message-quarantine:${payload.uidValidity}:${payload.uid}:${payload.quarantineEpisode}`,
      eventType: "IMAP_MESSAGE_QUARANTINED",
      payload: payload as unknown as Record<string, unknown>,
      channel: "feishu",
      destinations: destinations.length > 0 ? destinations : [pendingAlertDestination],
    });
  }

  async notifyDeliveryReconciliation(
    payload: FeishuDeliveryReconciliationPayload,
  ): Promise<void> {
    this.stageDeliveryReconciliation(payload);
    await this.flushPendingNotifications();
  }

  stageDeliveryReconciliation(payload: FeishuDeliveryReconciliationPayload): boolean {
    const messageId = String(payload.message.id ?? "").trim();
    if (!messageId) throw new Error("Delivery reconciliation notification requires a message ID");
    const rawAttempt = Number(payload.message.attempts ?? 0);
    const attempt = Number.isSafeInteger(rawAttempt) && rawAttempt >= 0 ? rawAttempt : 0;
    const destinations = this.destinations();
    return this.db.stageNotificationOnce({
      idempotencyKey: `email-delivery-reconciliation:${messageId}:attempt:${attempt}`,
      eventType: "EMAIL_DELIVERY_RECONCILIATION_REQUIRED",
      payload: payload as unknown as Record<string, unknown>,
      channel: "feishu",
      destinations: destinations.length > 0 ? destinations : [pendingAlertDestination],
    });
  }

  async enqueueDailyOperationsReport(
    notification: DailyOperationsNotification,
  ): Promise<void> {
    const destinations = this.destinations();
    this.db.stageNotificationOnce({
      idempotencyKey: notification.idempotencyKey,
      eventType: notification.eventType,
      payload: {
        report: notification.report as unknown as Record<string, unknown>,
        text: notification.text,
      },
      channel: "feishu",
      destinations: destinations.length > 0 ? destinations : [pendingAlertDestination],
    });
  }

  async notifyQuarantinedIntake(payload: FeishuQuarantinePayload): Promise<void> {
    await this.sendOrQueue(
      "QUARANTINED_INBOUND_ALERT",
      payload as unknown as Record<string, unknown>,
      quarantineCard(payload),
    );
  }

  async flushPendingNotifications(now = new Date()): Promise<void> {
    if (!this.channel) return;
    for (const notification of this.db.listDueNotifications(20, now)) {
      try {
        if (String(notification.destination) === pendingAlertDestination) {
          const destinations = this.destinations();
          if (destinations.length === 0) {
            this.db.deferNotification(
              String(notification.id),
              "No configured Feishu alert destination",
              now,
            );
            continue;
          }
          for (const destination of destinations) {
            this.db.queueNotification(String(notification.event_id), "feishu", destination);
          }
          this.db.markNotificationSent(String(notification.id), now);
          continue;
        }
        const rawPayload = JSON.parse(String(notification.payload_json ?? "{}")) as Record<string, unknown>;
        const payload = rawPayload as Partial<FeishuNotificationPayload>;
        const quarantinePayload = payload as Partial<FeishuQuarantinePayload>;
        const reconciliationPayload = rawPayload as unknown as Partial<FeishuDeliveryReconciliationPayload>;
        const imapHealthPayload = rawPayload as unknown as Partial<FeishuImapHealthPayload>;
        const imapQuarantinePayload = rawPayload as unknown as Partial<FeishuImapMessageQuarantinePayload>;
        const groundedPayload = rawPayload as unknown as GroundedMessageJobResult;
        const card = notification.event_type === "GROUNDED_MESSAGE_REVIEW" &&
          typeof groundedPayload.status === "string" && groundedPayload.lint &&
          typeof groundedPayload.lint === "object"
          ? groundedMessageReviewCard(groundedPayload)
          : notification.event_type === "QUARANTINED_INBOUND_ALERT" &&
          quarantinePayload.intake && quarantinePayload.inbound && quarantinePayload.classification
          ? quarantineCard(quarantinePayload as FeishuQuarantinePayload)
          : notification.event_type === "INQUIRY_ALERT" && payload.lead && payload.inbound && payload.classification
          ? inquiryCard(payload as Required<typeof payload>)
          : notification.event_type === "GMAIL_PILOT_SAFETY_PAUSE" && payload.lead && payload.inbound && payload.classification
            ? safetyPauseCard(payload as Required<typeof payload>)
          : notification.event_type === "EMAIL_HARD_BOUNCE_ALERT" && payload.lead && payload.inbound && payload.classification
            ? hardBounceCard(payload as Required<typeof payload>)
          : notification.event_type === "EMAIL_DELIVERY_RECONCILIATION_REQUIRED" && reconciliationPayload.message
            ? deliveryReconciliationCard(reconciliationPayload as FeishuDeliveryReconciliationPayload)
          : (notification.event_type === "IMAP_RUNTIME_HEALTH_PAUSE" || notification.event_type === "IMAP_RUNTIME_RECOVERED") &&
              typeof imapHealthPayload.state === "string"
            ? imapRuntimeHealthCard(imapHealthPayload as FeishuImapHealthPayload)
          : notification.event_type === "IMAP_MESSAGE_QUARANTINED" &&
              typeof imapQuarantinePayload.failureId === "string"
            ? imapMessageQuarantineCard(imapQuarantinePayload as FeishuImapMessageQuarantinePayload)
          : notification.event_type === "DAILY_OPERATIONS_REPORT" && typeof rawPayload.text === "string"
            ? dailyOperationsReportCard(rawPayload.text)
          : payload.lead && payload.inbound && payload.classification
            ? replyCard(payload as Required<typeof payload>)
            : fallbackNotificationCard();
        await this.channel.send(String(notification.destination), { card });
        this.db.markNotificationSent(String(notification.id), now);
      } catch (error) {
        this.db.markNotificationFailed(String(notification.id), String(error), now);
      }
    }
  }

  async sendText(destination: string, text: string): Promise<void> {
    if (!this.channel) throw new Error("Feishu channel is not connected");
    await this.channel.send(destination, { text });
  }

  async sendCard(destination: string, card: object): Promise<void> {
    if (!this.channel) throw new Error("Feishu channel is not connected");
    await this.channel.send(destination, { card });
  }
}
