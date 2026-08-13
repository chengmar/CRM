import crypto from "node:crypto";
import {
  stageGroundedMessageJobForApproval,
  type GroundedMessageJobResult,
} from "../acquisition/grounded-message-workflow.js";
import { enqueueAutonomousGroundedMessagesAfterDiscovery } from
  "../acquisition/autonomous-discovery-message-bridge.js";
import type { AgentConfig } from "../config.js";
import type {
  AgentDatabase,
  ClaimedJob,
  JobFollowup,
  JobLane,
  JobNotificationOutbox,
} from "../db.js";
import type { FeishuBitableSync } from "../integrations/bitable.js";
import type { FeishuIntegration } from "../integrations/feishu.js";
import { resolveFeishuJobDestination } from "../integrations/feishu-destinations.js";
import type { WhatsAppInbound } from "../inbound/whatsapp.js";
import { logger } from "../logger.js";
import type { MessageBuilder } from "../outreach/message-builder.js";
import { emailDraftPolicyBlockers } from "../outreach/email-policy.js";
import type { DiscoveryService } from "../search/discovery.js";
import { planJobFailure } from "./failure-policy.js";
import { reviewCard } from "./review-card.js";

export interface JobWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  laneConcurrency?: Partial<Record<JobLane, number>>;
  executeJob?: (jobType: string, payload: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  stageGroundedMessage?: (
    payload: Record<string, unknown>,
    now: Date,
  ) => GroundedMessageJobResult;
}

const JOB_LANES: readonly JobLane[] = ["REALTIME", "OPERATIONS", "RESEARCH"];
const DEFAULT_LANE_CONCURRENCY: Record<JobLane, number> = {
  REALTIME: 2,
  OPERATIONS: 1,
  RESEARCH: 2,
};

type JobLaneConcurrencyConfig = Pick<
  AgentConfig,
  | "JOB_WORKER_REALTIME_CONCURRENCY"
  | "JOB_WORKER_OPERATIONS_CONCURRENCY"
  | "JOB_WORKER_RESEARCH_CONCURRENCY"
>;

export function jobLaneConcurrencyFromConfig(
  config: JobLaneConcurrencyConfig,
): Record<JobLane, number> {
  return {
    REALTIME: config.JOB_WORKER_REALTIME_CONCURRENCY,
    OPERATIONS: config.JOB_WORKER_OPERATIONS_CONCURRENCY,
    RESEARCH: config.JOB_WORKER_RESEARCH_CONCURRENCY,
  };
}

type JobNotification =
  | { destination: string; text: string }
  | { destination: string; card: object };

interface JobControl {
  followup?: JobFollowup | null;
  notification?: JobNotification | null;
  outboxNotification?: JobNotificationOutbox | null;
}

type ControlledResult = Record<string, unknown> & { __jobControl?: JobControl };

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, { lane: JobLane; promise: Promise<void> }>();
  private polling = false;
  private started = false;
  private stopping = false;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly laneConcurrency: Record<JobLane, number>;
  private readonly now: () => Date;
  private readonly stageGroundedMessage: (
    payload: Record<string, unknown>,
    now: Date,
  ) => GroundedMessageJobResult;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly discovery: DiscoveryService,
    private readonly messageBuilder: MessageBuilder,
    private readonly bitable: FeishuBitableSync,
    private readonly whatsapp: WhatsAppInbound,
    private readonly feishu: FeishuIntegration,
    private readonly options: JobWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `job-worker-${process.pid}-${crypto.randomUUID()}`;
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2000);
    this.leaseDurationMs = Math.max(10, options.leaseDurationMs ?? 5 * 60_000);
    this.heartbeatIntervalMs = Math.max(
      1,
      Math.min(
        options.heartbeatIntervalMs ?? 60_000,
        Math.max(1, Math.floor(this.leaseDurationMs / 2)),
      ),
    );
    this.laneConcurrency = {
      REALTIME: Math.max(1, Math.trunc(options.laneConcurrency?.REALTIME ?? DEFAULT_LANE_CONCURRENCY.REALTIME)),
      OPERATIONS: Math.max(1, Math.trunc(options.laneConcurrency?.OPERATIONS ?? DEFAULT_LANE_CONCURRENCY.OPERATIONS)),
      RESEARCH: Math.max(1, Math.trunc(options.laneConcurrency?.RESEARCH ?? DEFAULT_LANE_CONCURRENCY.RESEARCH)),
    };
    this.now = options.now ?? (() => new Date());
    this.stageGroundedMessage = options.stageGroundedMessage ?? ((payload, now) =>
      stageGroundedMessageJobForApproval({ db: this.db, payload, now }));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const recovered = this.db.recoverExpiredJobs();
    if (recovered > 0) {
      logger.warn({ recovered }, "Recovered jobs with expired leases");
    }
    const supersededSyncJobs = this.db.supersedeDuplicateQueuedJobs("SYNC_BITABLE", "sync-bitable");
    if (supersededSyncJobs > 0) {
      logger.info({ supersededSyncJobs }, "Compacted redundant Feishu Bitable sync jobs");
    }
    this.timer = setInterval(
      () => void this.tick().catch((error) => logger.error({ error }, "Job worker tick failed")),
      this.pollIntervalMs,
    );
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((entry) => entry.promise));
    }
    this.started = false;
  }

  async tick(): Promise<void> {
    if (!this.started || this.stopping || this.polling) return;
    this.polling = true;
    try {
      this.db.recoverExpiredJobs();
      for (const lane of JOB_LANES) this.fillLane(lane);
    } finally {
      this.polling = false;
    }
  }

  private fillLane(lane: JobLane): void {
    while (!this.stopping && this.activeCount(lane) < this.laneConcurrency[lane]) {
      const job = this.db.claimDueJob({
        workerId: this.workerId,
        lane,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!job) return;
      this.launch(job);
    }
  }

  private activeCount(lane: JobLane): number {
    let count = 0;
    for (const active of this.active.values()) {
      if (active.lane === lane) count += 1;
    }
    return count;
  }

  private launch(job: ClaimedJob): void {
    const key = job.lease_token;
    const promise = this.runClaimedJob(job)
      .catch((error) => logger.error({ error, jobId: job.id }, "Claimed job runner failed"))
      .finally(() => {
        this.active.delete(key);
        if (!this.stopping && this.started) {
          void this.tick().catch((error) => logger.error({ error }, "Job worker refill failed"));
        }
      });
    this.active.set(key, { lane: job.lane, promise });
  }

  private async runClaimedJob(job: ClaimedJob): Promise<void> {
    const jobId = job.id;
    const jobType = job.job_type;
    const leaseToken = job.lease_token;
    let leaseLost = false;
    let payload: Record<string, unknown> = {};
    const assertActive = (): void => {
      if (leaseLost || !this.db.ownsJobLease(jobId, this.workerId, leaseToken)) {
        leaseLost = true;
        throw new Error(`Job lease lost: ${jobId}`);
      }
    };
    const heartbeat = setInterval(() => {
      try {
        const renewed = this.db.renewJobLease(
          jobId,
          this.workerId,
          leaseToken,
          this.leaseDurationMs,
        );
        if (!renewed) {
          leaseLost = true;
          clearInterval(heartbeat);
          logger.warn({ jobId, jobType }, "Job lease was lost while execution was still active");
        }
      } catch (error) {
        leaseLost = true;
        clearInterval(heartbeat);
        logger.error({ error, jobId, jobType }, "Job lease heartbeat failed");
      }
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      payload = JSON.parse(String(job.payload_json ?? "{}")) as Record<string, unknown>;
      assertActive();
      const rawResult = this.options.executeJob
        ? await this.options.executeJob(jobType, payload)
        : await this.execute(jobType, payload, assertActive);
      assertActive();
      let result = rawResult;
      let control: JobControl | undefined;
      if (rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)) {
        const envelope = rawResult as ControlledResult;
        control = envelope.__jobControl;
        if (control) {
          const { __jobControl: _, ...persisted } = envelope;
          result = persisted;
        }
      }
      const completion = this.db.completeJobWithFollowup(
        jobId,
        this.workerId,
        leaseToken,
        result,
        control?.followup,
        control?.outboxNotification,
      );
      if (!completion.completed) {
        logger.warn({ jobId, jobType }, "Discarded job result because the worker no longer owns the lease");
        return;
      }
      if (control?.notification) {
        const delivery = "card" in control.notification
          ? this.feishu.sendCard(control.notification.destination, control.notification.card)
          : this.feishu.sendText(control.notification.destination, control.notification.text);
        await delivery
          .catch((error) => logger.warn({ error, jobId, jobType }, "Post-commit job notification failed"));
      }
    } catch (error) {
      const failure = this.db.failJob(jobId, this.workerId, leaseToken, String(error));
      if (!failure) {
        logger.warn(
          { error, jobId, jobType },
          "Discarded job failure because the worker no longer owns the lease",
        );
        return;
      }
      const plan = planJobFailure({
        jobType,
        replyChatId: resolveFeishuJobDestination(this.config, this.db, payload.replyChatId),
        error,
        failure,
      });
      if (plan.notification) {
        await this.feishu
          .sendText(plan.notification.destination, plan.notification.text)
          .catch(() => undefined);
      }
      logger.error(
        { error, jobId, jobType, retryScheduled: plan.retryScheduled },
        plan.logMessage,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async execute(
    jobType: string,
    payload: Record<string, unknown>,
    assertActive: () => void = () => undefined,
  ): Promise<unknown> {
    if (jobType === "DISCOVER_CAMPAIGN") {
      assertActive();
      const campaign = this.db.getCampaign(String(payload.campaignId));
      if (!campaign) throw new Error("Campaign not found");
      const chatId = resolveFeishuJobDestination(this.config, this.db, payload.replyChatId);
      const authorizedRuntime = await this.discovery.assertLegacyRuntimeContracts(
        "DISCOVER_CAMPAIGN",
        String(campaign.id),
      );
      assertActive();
      const summary = await this.discovery.run({
        id: String(campaign.id),
        market: String(campaign.market),
        product: String(campaign.product),
        buyerType: String(campaign.buyer_type),
        targetCount: Number(campaign.target_count),
      }, async (progress) => {
        assertActive();
        if (!chatId || progress.stage === "COMPLETED") return;
        await this.feishu.sendText(
          chatId,
          [
            `【${progress.stage}】${progress.message}`,
            progress.searchResults === undefined ? "" : `搜索证据：${progress.searchResults}`,
            progress.candidates === undefined ? "" : `候选公司：${progress.candidates}`,
            progress.researched === undefined ? "" : `已深度评估：${progress.researched}`,
            progress.qualified === undefined ? "" : `公司级高匹配：${progress.qualified}`,
            progress.sendReady === undefined ? "" : `达到发送审核标准：${progress.sendReady}`,
          ].filter(Boolean).join("\n"),
        ).catch((error) => logger.warn({ error, campaignId: campaign.id }, "Feishu discovery progress notification failed"));
      }, assertActive, authorizedRuntime);
      assertActive();
      const autonomousMessageBridge = enqueueAutonomousGroundedMessagesAfterDiscovery({
        db: this.db,
        discoveryPayload: payload,
        now: this.now(),
      });
      assertActive();
      let crmSync: "not_configured" | "completed" | "queued_for_retry" = "not_configured";
      if (this.bitable.isConfigured()) {
        try {
          assertActive();
          await this.bitable.syncAll();
          assertActive();
          crmSync = "completed";
        } catch (error) {
          assertActive();
          crmSync = "queued_for_retry";
          this.db.enqueueJob("SYNC_BITABLE", {
            replyChatId: chatId,
            sourceCampaignId: String(campaign.id),
          }, undefined, { dedupeKey: "sync-bitable" });
          logger.error({ error, campaignId: campaign.id }, "Discovery completed but CRM sync was queued for retry");
        }
      }
      assertActive();
      const enrichmentFollowup: JobFollowup | null = summary.enrichmentPending > 0
        ? {
            jobType: "ENRICH_CONTACTS",
            payload: {
              ...payload,
              campaignId: String(campaign.id),
              replyChatId: chatId,
              pass: 1,
            },
            runAfter: new Date(Date.now() + 30 * 60_000).toISOString(),
            options: { dedupeKey: `contact-enrichment:${String(campaign.id)}` },
          }
        : null;
      const notification = chatId
        ? {
            destination: chatId,
            text: [
            "深度获客任务本轮完成。",
            `研究大脑：${summary.orchestrator}`,
            `搜索轮次：${summary.roundsCompleted}`,
            `搜索证据：${summary.searchResults}`,
            `识别候选公司：${summary.candidateCompanies}`,
            `完成深度评估：${summary.domainsAssessed}`,
            `公司级高匹配：${summary.companyQualified}`,
            `找到具名决策人：${summary.contactsFound}`,
            `找到有效邮箱：${summary.verifiedEmails}`,
            `仅有风险邮箱：${summary.riskyEmails}`,
            `达到发送审核标准：${summary.eligibleForReview}`,
            `高匹配但继续补联系人：${summary.enrichmentPending}`,
            `明确淘汰：${summary.rejected}`,
            `待后续批次：${summary.skipped}`,
            `跨批次重复域名：${summary.duplicatesSkipped}`,
            `模型调用：${summary.llmCallsUsed}/${summary.llmCallLimit}，Hermes：${summary.hermesCallsUsed}`,
            `CRM 同步：${crmSync === "completed" ? "完成" : crmSync === "queued_for_retry" ? "已独立排队重试" : "未配置"}`,
            `联系人二次研究：${enrichmentFollowup ? "已自动排队" : "无需排队"}`,
            autonomousMessageBridge.status === "NOT_AUTONOMOUS"
              ? "自动消息：当前任务未绑定自主发送授权"
              : `自动消息：入队 ${autonomousMessageBridge.enqueued}，已存在 ${autonomousMessageBridge.alreadyStaged}，阻断 ${autonomousMessageBridge.blocked}`,
            summary.eligibleForReview > 0
              ? "发送“待审核客户”查看可审批线索。"
              : "系统没有降低门槛凑数；高匹配公司已保留在继续深挖队列，不会静默丢失。",
            ].join("\n"),
          }
        : null;
      return {
        ...summary,
        crmSync,
        enrichmentScheduled: Boolean(enrichmentFollowup),
        autonomousMessageBridge,
        __jobControl: { followup: enrichmentFollowup, notification },
      } satisfies ControlledResult;
    }

    if (jobType === "ENRICH_CONTACTS") {
      assertActive();
      const campaignId = String(payload.campaignId);
      const chatId = resolveFeishuJobDestination(this.config, this.db, payload.replyChatId);
      const requestedPass = Math.max(1, Number(payload.pass ?? 1));
      const authorizedRuntime = await this.discovery.assertLegacyRuntimeContracts(
        "ENRICH_CONTACTS",
        campaignId,
      );
      assertActive();
      const summary = await this.discovery.enrichPendingContacts(
        campaignId,
        25,
        async (completed, total) => {
          assertActive();
          if (!chatId || completed % 5 !== 0) return;
          await this.feishu
            .sendText(chatId, `联系人二次研究：${completed}/${total}，正在使用公开来源和 Hermes 专属搜索矩阵补全。`)
            .catch((error) => logger.warn({ error, campaignId }, "Feishu enrichment progress notification failed"));
        },
        assertActive,
        authorizedRuntime,
      );
      assertActive();
      let crmSync = "not_configured";
      if (this.bitable.isConfigured()) {
        try {
          assertActive();
          await this.bitable.syncAll();
          assertActive();
          crmSync = "completed";
        } catch (error) {
          assertActive();
          crmSync = "queued_for_retry";
          this.db.enqueueJob(
            "SYNC_BITABLE",
            { replyChatId: chatId, sourceCampaignId: campaignId },
            undefined,
            { dedupeKey: "sync-bitable" },
          );
          logger.error({ error, campaignId }, "Contact enrichment completed but CRM sync was queued for retry");
        }
      }
      const pass = summary.pass ?? requestedPass;
      const autonomousMessageBridge = enqueueAutonomousGroundedMessagesAfterDiscovery({
        db: this.db,
        discoveryPayload: payload,
        now: this.now(),
      });
      assertActive();
      const nextSchedule = summary.remainingEligible > 0 && summary.nextPass !== null && summary.nextRunAt
        ? {
            kind: summary.nextPass === pass ? "same_pass" : "next_pass",
            pass: summary.nextPass,
            runAfter: summary.nextRunAt,
          } as const
        : null;
      const followup: JobFollowup | null = nextSchedule
        ? {
            jobType: "ENRICH_CONTACTS",
            payload: {
              ...payload,
              campaignId,
              replyChatId: chatId,
              pass: nextSchedule.pass,
            },
            runAfter: nextSchedule.runAfter,
            options: { dedupeKey: `contact-enrichment:${campaignId}` },
          }
        : null;
      const notification = chatId
        ? {
            destination: chatId,
            text: [
              `联系人二次研究第 ${pass} 轮完成。`,
              `处理公司：${summary.attempted}`,
              `具名联系人：${summary.contactsFound}`,
              `有效邮箱：${summary.verifiedEmails}`,
              `仅有风险邮箱：${summary.riskyEmails}`,
              `新增待审核客户：${summary.readyForReview}`,
              `本批仍待补全：${summary.stillPending}`,
              `活动剩余待补全：${summary.remainingEligible}`,
              `Hermes 调用：${summary.hermesCallsUsed}`,
              `CRM 同步：${crmSync}`,
              `后续安排：${nextSchedule?.kind === "same_pass"
                ? "当前轮下一批将立即排队"
                : nextSchedule?.kind === "next_pass"
                  ? "下一轮将按最早到期时间排队"
                  : "本周期结束"}`,
            ].join("\n"),
          }
        : null;
      return {
        ...summary,
        crmSync,
        pass,
        nextSchedule: nextSchedule?.kind ?? null,
        autonomousMessageBridge,
        __jobControl: { followup, notification },
      } satisfies ControlledResult;
    }

    if (jobType === "STAGE_GROUNDED_MESSAGE") {
      assertActive();
      const result = this.stageGroundedMessage(payload, this.now());
      assertActive();
      const requestedDestination = String(payload.replyChatId ?? "").trim();
      const reviewDestination = this.config.messageReviewDestinations?.has(requestedDestination)
        ? requestedDestination
        : null;
      return {
        ...result,
        __jobControl: {
          outboxNotification: reviewDestination
            ? {
                eventType: "GROUNDED_MESSAGE_REVIEW",
                channel: "feishu",
                destination: reviewDestination,
                payload: result as unknown as Record<string, unknown>,
              }
            : null,
        },
      } satisfies ControlledResult;
    }

    if (jobType === "BUILD_EMAIL_SEQUENCE") {
      assertActive();
      const leadId = String(payload.leadId);
      const sourceLead = this.db.getLead(leadId);
      if (!sourceLead) throw new Error("Lead not found");
      let contactId = String(payload.contactId ?? "");
      if (!contactId) {
        const contact = this.db
          .listContactsForLead(leadId)
          .find((item) => emailDraftPolicyBlockers(this.config, sourceLead, item).length === 0);
        contactId = String(contact?.id ?? "");
      }
      if (!contactId) throw new Error("No contact satisfies the active email policy for this lead");
      if (!this.db.hasOutboundSequence(leadId, contactId, "email")) {
        await this.messageBuilder.buildEmailSequence(leadId, contactId);
        assertActive();
      }
      const lead = this.db.getLeadDetails(leadId);
      if (!lead) throw new Error("Lead disappeared after sequence generation");
      const messages = this.db.listOutboundMessagesForLead(leadId);
      const reviewHash = this.db.getSequenceReviewHash(leadId);
      const chatId = String(payload.replyChatId ?? "");
      if (chatId) await this.feishu.sendCard(chatId, reviewCard(this.config, lead, messages, reviewHash));
      return { leadId, contactId, messages: messages.length };
    }

    if (jobType === "SYNC_BITABLE") {
      assertActive();
      const result = await this.bitable.syncAll();
      assertActive();
      const chatId = String(payload.replyChatId ?? "");
      if (chatId) {
        await this.feishu.sendText(
          chatId,
          [
            `CRM Leads：新增 ${result.leads.created}，更新 ${result.leads.updated}`,
            `CRM Events：新增 ${result.events.created}，已存在 ${result.events.skipped}`,
          ].join("\n"),
        ).catch((error) => logger.warn({ error }, "Feishu CRM sync notification failed"));
      }
      return result;
    }

    if (jobType === "PROCESS_WHATSAPP_WEBHOOK") {
      assertActive();
      return this.whatsapp.processWebhook(payload.body as never);
    }

    throw new Error(`Unsupported job type: ${jobType}`);
  }
}
