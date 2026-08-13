import crypto from "node:crypto";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";
import { logger } from "../logger.js";
import { safeError } from "../safe-error.js";
import type {
  FeishuImapHealthPayload,
  ImapOperationsNotifier,
} from "../integrations/feishu/types.js";
import { classifyInbound } from "./classifier.js";
import type { InboundProcessor } from "./processor.js";
import {
  enforceImapHealthFreshness,
  getImapRuntimeHealth,
  initializeImapRuntimeHealth,
  recordImapPollFailure,
  recordImapPollSuccess,
  type ImapHealthTransition,
  type ImapRuntimeHealth,
} from "./email-health.js";

function addressOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const candidate = value as { value?: Array<{ address?: string }> };
  return candidate.value?.[0]?.address?.trim().toLowerCase() ?? "";
}

function toAddresses(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const candidate = value as { value?: Array<{ address?: string }> };
  return (candidate.value ?? [])
    .map((item) => item.address?.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

const dsnEnvelopePattern = /mailer-daemon|mail delivery subsystem|delivery status notification|undeliverable|delivery failed|returned mail|final-recipient|original-recipient/i;

function dsnReferences(source: string): string[] {
  const references: string[] = [];
  for (const match of source.matchAll(
    /^(?:original-message-id|x-original-message-id|message-id|in-reply-to|references):[^\r\n]*/gim,
  )) {
    references.push(...[...match[0].matchAll(/<[^>\r\n]+>/g)].map((item) => item[0]));
  }
  return [...new Set(references)];
}

function dsnRecipients(source: string): string[] {
  const recipients: string[] = [];
  for (const match of source.matchAll(
    /^(?:final-recipient|original-recipient|x-failed-recipients):[^\r\n]*/gim,
  )) {
    recipients.push(
      ...[...match[0].matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
        .map((item) => item[0].toLowerCase()),
    );
  }
  return [...new Set(recipients)];
}

export class EmailInboundListener {
  private client: ImapFlow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopping = false;
  private uidValidity = "unknown";

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    private readonly processor: InboundProcessor,
    private readonly operationsNotifier?: ImapOperationsNotifier,
  ) {}

  async start(): Promise<void> {
    if (!this.config.EMAIL_INBOUND_ENABLED) {
      logger.info("Email inbound listener is disabled");
      return;
    }
    if (
      !this.config.IMAP_HOST ||
      !this.config.IMAP_USER ||
      !this.config.IMAP_PASSWORD
    ) {
      throw new Error("EMAIL_INBOUND_ENABLED=true but IMAP configuration is incomplete");
    }
    this.stopping = false;
    initializeImapRuntimeHealth(this.config, this.db);
    this.timer = setInterval(
      () => void this.runPollCycle("timer"),
      Math.max(15, this.config.EMAIL_POLL_SECONDS) * 1000,
    );
    await this.runPollCycle("startup");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        this.client.close();
      }
    }
    this.client = null;
  }

  private async connect(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.IMAP_HOST,
      port: this.config.IMAP_PORT,
      secure: true,
      auth: { user: this.config.IMAP_USER, pass: this.config.IMAP_PASSWORD },
      logger: false,
    });
    client.on("error", (error) => {
      if (this.stopping) return;
      logger.error({ errorClass: this.failureDetail(error).errorClass }, "IMAP client error");
    });
    client.on("close", () => {
      if (!this.stopping) logger.warn("IMAP connection closed; next poll will reconnect");
    });
    client.on("exists", () => void this.runPollCycle("mailbox_event"));
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
    const uidValidity = String(mailbox.uidValidity);
    const storedValidity = this.db.getSetting("imap_uid_validity");
    if (storedValidity !== uidValidity) {
      this.db.setSetting("imap_uid_validity", uidValidity);
      this.db.setSetting("imap_last_uid", "0");
      this.db.expireImapFailuresForUidValidity(uidValidity);
    }
    this.uidValidity = uidValidity;
    this.client = client;
    logger.info({ mailbox: "INBOX", uidValidity }, "IMAP listener connected");
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Ignore stale connection cleanup.
      }
    }
    await this.connect();
    if (!this.client) throw new Error("IMAP reconnect failed");
    return this.client;
  }

  private async poll(): Promise<boolean> {
    if (this.polling || this.stopping) return false;
    this.polling = true;
    try {
      const client = await this.ensureConnected();
      const lastUid = Number.parseInt(this.db.getSetting("imap_last_uid") ?? "0", 10) || 0;
      const discoveredUids = lastUid > 0
        ? await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
        : await client.search({ since: new Date(Date.now() - 7 * 86_400_000) }, { uid: true });
      const retryUids = this.db.listImapRetryUids(this.uidValidity, 100);
      const uidList = [...new Set([
        ...retryUids,
        ...(discoveredUids || []).filter((uid: number) => uid > lastUid),
      ])].sort((left, right) => left - right);
      let highWatermark = lastUid;
      for (const uid of uidList) {
        let safeToAdvance = false;
        try {
          const fetched = await client.fetchOne(
            uid,
            {
              uid: true,
              source: { maxLength: 5_000_000 },
              envelope: true,
              threadId: true,
              headers: ["message-id", "in-reply-to", "references", "auto-submitted", "precedence"],
            },
            { uid: true },
          );
          if (!fetched) throw new Error("IMAP message could not be fetched by UID");
          await this.handleFetchedMessage(fetched);
          safeToAdvance = true;
        } catch (error) {
          if (!client.usable) throw error;
          await this.quarantineFailedMessage(
            { uid } as FetchMessageObject,
            error,
          );
          safeToAdvance = true;
        } finally {
          if (safeToAdvance && uid > highWatermark) {
            highWatermark = uid;
            this.db.setSetting("imap_last_uid", String(highWatermark));
          }
        }
      }
      return true;
    } finally {
      this.polling = false;
    }
  }

  getHealth(now = new Date()): ImapRuntimeHealth {
    return getImapRuntimeHealth(this.config, this.db, now);
  }

  enforceHealthGate(now = new Date()): ImapRuntimeHealth {
    const transition = enforceImapHealthFreshness(this.config, this.db, now);
    this.stageHealthNotification(transition);
    return transition.health;
  }

  private async runPollCycle(trigger: string): Promise<void> {
    if (this.stopping) return;
    try {
      const completed = await this.poll();
      if (!completed) {
        this.enforceHealthGate();
        return;
      }
      const transition = recordImapPollSuccess(this.config, this.db);
      this.stageHealthNotification(transition);
    } catch (error) {
      const detail = this.failureDetail(error);
      const transition = recordImapPollFailure(this.config, this.db, detail);
      this.stageHealthNotification(transition);
      logger.error(
        { trigger, healthState: transition.health.state, errorClass: detail.errorClass },
        "IMAP poll failed",
      );
    } finally {
      this.enforceHealthGate();
    }
  }

  private failureDetail(error: unknown): { errorClass: string; message: string } {
    const summary = safeError(error, [this.config.IMAP_PASSWORD]);
    const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const errorClass = String(candidate.code ?? candidate.name ?? "Error")
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 120) || "Error";
    const message = String(summary.message ?? summary.code ?? "IMAP operation failed")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[host]")
      .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted-token]")
      .slice(0, 500);
    return { errorClass, message };
  }

  private stageHealthNotification(transition: ImapHealthTransition): void {
    if (!this.operationsNotifier) return;
    const unhealthy = transition.health.state === "UNHEALTHY" || transition.health.state === "STALE";
    if (!unhealthy && !transition.recovered) return;
    const payload: FeishuImapHealthPayload = {
      episode: transition.health.pauseEpisode,
      state: transition.health.state,
      reason: transition.health.reason,
      consecutiveFailures: transition.health.consecutiveFailures,
      failurePauseThreshold: transition.health.failurePauseThreshold,
      lastPollSuccessAt: transition.health.lastPollSuccessAt,
      pausedAt: this.db.getSetting("imap_health_paused_at"),
      recovered: transition.recovered,
      globalPauseRemains: this.db.getSetting("outbound_paused") === "true",
    };
    try {
      this.operationsNotifier.stageImapRuntimeHealth(payload);
    } catch (error) {
      logger.error({ error: safeError(error) }, "Failed to persist IMAP health notification");
    }
  }

  private messagePreview(message: FetchMessageObject): Record<string, unknown> {
    const envelope = message.envelope as unknown as {
      subject?: string | null;
      from?: Array<{ address?: string | null }>;
    } | undefined;
    const subject = String(envelope?.subject ?? "")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
      .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted-token]")
      .slice(0, 160);
    const sender = envelope?.from?.[0]?.address?.trim().toLowerCase() ?? "";
    return {
      subject,
      senderSha256: sender ? crypto.createHash("sha256").update(sender).digest("hex") : null,
      sourceAvailable: Boolean(message.source),
    };
  }

  private async handleFetchedMessage(message: FetchMessageObject): Promise<void> {
    try {
      await this.processMessage(message);
      if (message.uid) this.db.resolveImapMessageFailure(this.uidValidity, message.uid);
    } catch (error) {
      await this.quarantineFailedMessage(message, error);
    }
  }

  private async quarantineFailedMessage(message: FetchMessageObject, error: unknown): Promise<void> {
    const uid = Number(message.uid ?? 0);
    if (uid <= 0) throw error;
    const source = message.source ? Buffer.from(message.source) : Buffer.alloc(0);
    const detail = this.failureDetail(error);
    const failure = this.db.recordImapMessageFailure({
      uidValidity: this.uidValidity,
      uid,
      maxAttempts: Math.max(1, this.config.IMAP_MESSAGE_MAX_ATTEMPTS),
      sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
      sourceSize: source.length,
      preview: this.messagePreview(message),
      errorClass: detail.errorClass,
      errorMessage: detail.message,
    });
    logger.warn(
      { failureId: failure.id, uid, attempts: failure.attempts, status: failure.status, errorClass: detail.errorClass },
      "IMAP message processing failed in UID isolation",
    );
    if (failure.status !== "QUARANTINED" || !this.operationsNotifier) return;
    try {
      this.operationsNotifier.stageImapMessageQuarantine({
        failureId: failure.id,
        uidValidity: failure.uid_validity,
        uid: failure.uid,
        attempts: failure.attempts,
        maxAttempts: failure.max_attempts,
        quarantineEpisode: failure.quarantine_episode,
        sourceSha256: failure.source_sha256,
        sourceSize: failure.source_size,
        preview: JSON.parse(failure.preview_json) as Record<string, unknown>,
        errorClass: failure.last_error_class,
        errorMessage: failure.last_error_message,
      });
    } catch (notificationError) {
      logger.error({ error: safeError(notificationError) }, "Failed to persist IMAP quarantine notification");
    }
  }

  private async processMessage(message: FetchMessageObject): Promise<void> {
    if (!message.source || !message.uid) throw new Error("IMAP message source or UID is missing");
    const parsed = await simpleParser(message.source);
    const from = addressOf(parsed.from);
    if (!from || from === this.config.EMAIL_FROM_ADDRESS.toLowerCase()) return;
    const to = toAddresses(parsed.to);
    const subject = parsed.subject ?? message.envelope?.subject ?? "";
    const body = (parsed.text ?? "").trim();
    const inReplyTo = parsed.inReplyTo || message.envelope?.inReplyTo || undefined;
    const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
    const threadId = inReplyTo || references.at(-1) || message.threadId || undefined;
    const headers: Record<string, unknown> = {
      messageId: parsed.messageId,
      inReplyTo,
      references,
      autoSubmitted: parsed.headers.get("auto-submitted"),
      precedence: parsed.headers.get("precedence"),
      attachmentCount: parsed.attachments.length,
      hasNonTextContent: parsed.attachments.length > 0,
    };
    let match = this.db.findInboundMatch(threadId ? String(threadId) : null, from);
    const rawSource = message.source.toString("utf8");
    if (!match && dsnEnvelopePattern.test(`${from}\n${subject}\n${rawSource.slice(0, 20_000)}`)) {
      for (const reference of dsnReferences(rawSource)) {
        match = this.db.findLeadByProviderReference(reference);
        if (match) break;
      }
      if (!match) {
        for (const recipient of dsnRecipients(rawSource)) {
          match = this.db.findContactByAddress(recipient);
          if (match) break;
        }
      }
    }
    if (!match && !to.split(",").includes(this.config.EMAIL_FROM_ADDRESS.trim().toLowerCase())) {
      logger.debug({ uid: message.uid }, "IMAP message was not delivered to the configured business inbox");
      return;
    }
    headers.matchedInbound = Boolean(match);
    const uidValidity = this.db.getSetting("imap_uid_validity") ?? "unknown";
    const rawInput = {
      channel: "email" as const,
      providerId: `imap:${uidValidity}:${message.uid}`,
      threadId: threadId ? String(threadId) : null,
      fromAddress: from,
      toAddress: to,
      subject,
      bodyText: body,
      receivedAt: new Date(parsed.date ?? message.internalDate ?? Date.now()).toISOString(),
      rawHeaders: headers,
      leadId: match?.leadId ?? null,
      contactId: match?.contactId ?? null,
      outboundMessageId: match?.outboundMessageId ?? null,
    };
    const prepared = this.processor.prepare(rawInput);
    const classification = await classifyInbound(
      { from, subject, body, headers },
      this.llm,
      this.config,
    );
    await this.processor.process(
      {
        ...rawInput,
        classification: classification.classification,
        confidence: classification.confidence,
        reason: classification.reason,
      },
      classification,
      prepared,
    );
  }
}
