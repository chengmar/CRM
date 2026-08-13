import type { AgentDatabase } from "../db.js";

export interface DailyOperationsDispatchItem {
  allowed: boolean;
}

export interface DailyOperationsProviderCost {
  currency: string;
  units: number;
  costMicros: number;
}

export interface DailyOperationsLlmModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DailyOperationsReport {
  version: "daily-operations-v1";
  localDate: string;
  timeZone: string;
  startAt: string;
  endAt: string;
  generatedAt: string;
  activity: {
    discoveredCompanies: number;
    contactsCreated: number;
    messagesSent: number;
    messagesDelivered: number;
    humanReplies: number;
    inquiries: number;
    hardBounces: number;
    softBounces: number;
  };
  inventory: {
    pendingSendMessages: number;
    sendableMessages: number;
    blockedMessages: number;
    persistedPolicyBlockedMessages: number;
    oldestPolicyBlockedAgeSeconds: number | null;
    topPolicyBlockers: Array<{ reason: string; count: number }>;
    pendingReviewLeads: number;
    dispatchPlanLimit: number;
  };
  ratios: {
    sentDeliveryRatio: number;
    repliesToSendsActivityRatio: number;
    hardBouncesToSendsActivityRatio: number;
    replyAndBounceBasis: "same-day-activity-not-cohort";
  };
  providers: {
    calls: number;
    planned: number;
    running: number;
    succeeded: number;
    partial: number;
    failed: number;
    skipped: number;
    budgetBlocked: number;
    disabled: number;
    costs: DailyOperationsProviderCost[];
  };
  llm: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    models: DailyOperationsLlmModelUsage[];
    monetaryCostAvailable: false;
  };
  reconciliation: {
    newlyQuarantined: number;
    currentlyRequired: number;
  };
  notificationOutbox: {
    pendingCount: number;
    dueCount: number;
    deadLetterCount: number;
    oldestPendingAt: string | null;
    oldestPendingAgeSeconds: number | null;
  };
  inboundMonitoring: {
    state: string;
    lastPollSuccessAt: string | null;
    consecutiveFailures: number;
    retryPendingMessages: number;
    quarantinedMessages: number;
    unreplayableMessages: number;
    outboundPaused: boolean;
  };
}

export interface DailyOperationsReportInput {
  localDate: string;
  timeZone: string;
  startAt: string;
  endAt: string;
  generatedAt?: string;
  dispatchPlan: DailyOperationsDispatchItem[];
  dispatchPlanLimit: number;
}

const HUMAN_REPLY_CLASSES = [
  "P1_INQUIRY",
  "P2_INTEREST",
  "REFERRAL",
  "WRONG_PERSON",
  "NEEDS_INFO",
  "NOT_FIT",
  "AMBIGUOUS",
  "OTHER_REPLY",
  "NEGATIVE",
  "UNSUBSCRIBE",
] as const;

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function assertInput(input: DailyOperationsReportInput, generatedAt: string): void {
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(generated)) {
    throw new Error("Daily operations report requires valid ISO timestamps");
  }
  if (end <= start) throw new Error("Daily operations report endAt must be later than startAt");
  if (!Number.isInteger(input.dispatchPlanLimit) || input.dispatchPlanLimit < 0) {
    throw new Error("Daily operations report dispatchPlanLimit must be a non-negative integer");
  }
  if (input.dispatchPlan.length > input.dispatchPlanLimit) {
    throw new Error("Daily operations dispatch plan exceeds dispatchPlanLimit");
  }
}

export function buildDailyOperationsReport(
  db: AgentDatabase,
  input: DailyOperationsReportInput,
): DailyOperationsReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  assertInput(input, generatedAt);
  const count = (sql: string, ...parameters: Array<string | number>): number => {
    const row = db.db.prepare(sql).get(...parameters) as { count: number };
    return Number(row.count);
  };
  const period = [input.startAt, input.endAt];
  const discoveredCompanies = count(
    `SELECT COUNT(DISTINCT lower(trim(domain))) AS count
     FROM discovery_candidates WHERE created_at>=? AND created_at<?`,
    ...period,
  );
  const contactsCreated = count(
    "SELECT COUNT(*) AS count FROM contacts WHERE created_at>=? AND created_at<?",
    ...period,
  );
  const messagesSent = count(
    "SELECT COUNT(*) AS count FROM outbound_messages WHERE sent_at>=? AND sent_at<?",
    ...period,
  );
  const messagesDelivered = count(
    `SELECT COUNT(*) AS count FROM outbound_messages
     WHERE sent_at>=? AND sent_at<? AND status IN ('DELIVERED','REPLIED')`,
    ...period,
  );
  const replyPlaceholders = HUMAN_REPLY_CLASSES.map(() => "?").join(",");
  const humanReplies = count(
    `SELECT COUNT(*) AS count FROM inbound_messages
     WHERE received_at>=? AND received_at<? AND classification IN (${replyPlaceholders})`,
    ...period,
    ...HUMAN_REPLY_CLASSES,
  );
  const inquiries = count(
    `SELECT COUNT(*) AS count FROM inbound_messages
     WHERE received_at>=? AND received_at<? AND classification IN ('P1_INQUIRY','P2_INTEREST')`,
    ...period,
  );
  const hardBounces = count(
    `SELECT COUNT(*) AS count FROM inbound_messages
     WHERE received_at>=? AND received_at<? AND channel='email' AND classification='BOUNCE'`,
    ...period,
  );
  const softBounces = count(
    `SELECT COUNT(*) AS count FROM inbound_messages
     WHERE received_at>=? AND received_at<? AND channel='email' AND classification='SOFT_BOUNCE'`,
    ...period,
  );
  const providerStatus = db.db.prepare(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN status='PLANNED' THEN 1 ELSE 0 END) AS planned,
            SUM(CASE WHEN status='RUNNING' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN status='PARTIAL' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN status='BUDGET_BLOCKED' THEN 1 ELSE 0 END) AS budget_blocked,
            SUM(CASE WHEN status='DISABLED' THEN 1 ELSE 0 END) AS disabled
     FROM provider_runs WHERE started_at>=? AND started_at<?`,
  ).get(...period) as Record<string, number | null>;
  const costs = db.db.prepare(
    `SELECT currency, COALESCE(SUM(units), 0) AS units,
            COALESCE(SUM(cost_micros), 0) AS cost_micros
     FROM resource_usage WHERE occurred_at>=? AND occurred_at<?
     GROUP BY currency ORDER BY currency`,
  ).all(...period) as Array<{ currency: string; units: number; cost_micros: number }>;
  const llmModels = db.db.prepare(
    `SELECT model, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM llm_usage WHERE created_at>=? AND created_at<?
     GROUP BY model ORDER BY model`,
  ).all(...period) as Array<{
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  const llmUsage = llmModels.map((row) => ({
    model: row.model,
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  }));
  const newlyQuarantined = count(
    `SELECT COUNT(*) AS count FROM events
     WHERE event_type='MESSAGE_DELIVERY_UNKNOWN_REQUIRES_RECONCILIATION'
       AND created_at>=? AND created_at<?`,
    ...period,
  );
  const currentlyRequired = count(
    `SELECT COUNT(*) AS count FROM outbound_messages
     WHERE status='UNKNOWN_RECONCILIATION_REQUIRED'`,
  );
  const pendingSendMessages = input.dispatchPlan.length;
  const sendableMessages = input.dispatchPlan.filter((item) => item.allowed).length;
  const imapFailures = db.getImapFailureSummary();
  const policyBlocks = db.getOutboundPolicyBlockSummary(new Date(generatedAt));
  const notificationOutbox = db.getNotificationOutboxSummary(new Date(generatedAt));

  return {
    version: "daily-operations-v1",
    localDate: input.localDate,
    timeZone: input.timeZone,
    startAt: input.startAt,
    endAt: input.endAt,
    generatedAt,
    activity: {
      discoveredCompanies,
      contactsCreated,
      messagesSent,
      messagesDelivered,
      humanReplies,
      inquiries,
      hardBounces,
      softBounces,
    },
    inventory: {
      pendingSendMessages,
      sendableMessages,
      blockedMessages: pendingSendMessages - sendableMessages,
      persistedPolicyBlockedMessages: policyBlocks.blockedMessages,
      oldestPolicyBlockedAgeSeconds: policyBlocks.oldestBlockedAgeSeconds,
      topPolicyBlockers: policyBlocks.topReasons,
      pendingReviewLeads: count(
        "SELECT COUNT(*) AS count FROM leads WHERE status='READY_FOR_REVIEW'",
      ),
      dispatchPlanLimit: input.dispatchPlanLimit,
    },
    ratios: {
      sentDeliveryRatio: safeRatio(messagesDelivered, messagesSent),
      repliesToSendsActivityRatio: safeRatio(humanReplies, messagesSent),
      hardBouncesToSendsActivityRatio: safeRatio(hardBounces, messagesSent),
      replyAndBounceBasis: "same-day-activity-not-cohort",
    },
    providers: {
      calls: Number(providerStatus.calls ?? 0),
      planned: Number(providerStatus.planned ?? 0),
      running: Number(providerStatus.running ?? 0),
      succeeded: Number(providerStatus.succeeded ?? 0),
      partial: Number(providerStatus.partial ?? 0),
      failed: Number(providerStatus.failed ?? 0),
      skipped: Number(providerStatus.skipped ?? 0),
      budgetBlocked: Number(providerStatus.budget_blocked ?? 0),
      disabled: Number(providerStatus.disabled ?? 0),
      costs: costs.map((row) => ({
        currency: row.currency,
        units: Number(row.units),
        costMicros: Number(row.cost_micros),
      })),
    },
    llm: {
      calls: llmUsage.reduce((sum, row) => sum + row.calls, 0),
      inputTokens: llmUsage.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: llmUsage.reduce((sum, row) => sum + row.outputTokens, 0),
      models: llmUsage,
      monetaryCostAvailable: false,
    },
    reconciliation: { newlyQuarantined, currentlyRequired },
    notificationOutbox,
    inboundMonitoring: {
      state: db.getSetting("imap_runtime_health_state") ?? "NOT_STARTED",
      lastPollSuccessAt: db.getSetting("imap_last_poll_success_at"),
      consecutiveFailures: Math.max(
        0,
        Number.parseInt(db.getSetting("imap_consecutive_failures") ?? "0", 10) || 0,
      ),
      retryPendingMessages: imapFailures.retryPending,
      quarantinedMessages: imapFailures.quarantined,
      unreplayableMessages: imapFailures.unreplayable,
      outboundPaused: db.getSetting("outbound_paused") === "true",
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function providerCostLines(report: DailyOperationsReport): string[] {
  if (report.providers.costs.length === 0) return ["- Provider 成本：0"];
  return report.providers.costs.map((cost) =>
    `- Provider 成本（${cost.currency}）：${(cost.costMicros / 1_000_000).toFixed(6)}；用量 ${cost.units}`,
  );
}

export function formatDailyOperationsReport(report: DailyOperationsReport): string {
  const {
    activity,
    inventory,
    providers,
    llm,
    ratios,
    reconciliation,
    notificationOutbox,
    inboundMonitoring,
  } = report;
  return [
    `**外贸智能体运营日报 ${report.localDate}（${report.timeZone}）**`,
    `统计窗口：[${report.startAt}, ${report.endAt})`,
    "",
    `- 发现公司：${activity.discoveredCompanies}`,
    `- 新增联系人：${activity.contactsCreated}`,
    `- 待发送库存（计划窗口）：${inventory.pendingSendMessages}（可发 ${inventory.sendableMessages}，阻断 ${inventory.blockedMessages}，计划上限 ${inventory.dispatchPlanLimit}）`,
    `- 持久策略阻断：${inventory.persistedPolicyBlockedMessages}（最老等待 ${inventory.oldestPolicyBlockedAgeSeconds === null ? "无" : `${inventory.oldestPolicyBlockedAgeSeconds} 秒`}）`,
    ...(inventory.topPolicyBlockers.length > 0
      ? inventory.topPolicyBlockers.map((item) => `  - ${item.reason}：${item.count}`)
      : []),
    `- 待审核客户：${inventory.pendingReviewLeads}`,
    `- 发送：${activity.messagesSent}`,
    `- 送达：${activity.messagesDelivered}（当日发送 cohort 当前送达比 ${percent(ratios.sentDeliveryRatio)}；REPLIED 已计入送达）`,
    `- 人工回复：${activity.humanReplies}`,
    `- 回复/发送活动比（非同一 cohort，不是真实回复率）：${percent(ratios.repliesToSendsActivityRatio)}`,
    `- 询盘/兴趣回复：${activity.inquiries}`,
    `- 硬退信：${activity.hardBounces}`,
    `- 硬退信/发送活动比（非同一 cohort）：${percent(ratios.hardBouncesToSendsActivityRatio)}`,
    `- 软退信：${activity.softBounces}`,
    `- Provider 调用：${providers.calls}（计划 ${providers.planned}，运行中 ${providers.running}，成功 ${providers.succeeded}，部分成功 ${providers.partial}，失败 ${providers.failed}，跳过 ${providers.skipped}，预算阻断 ${providers.budgetBlocked}，停用 ${providers.disabled}）`,
    ...providerCostLines(report),
    `- AI 模型用量：${llm.calls} 次调用，输入 ${llm.inputTokens} tokens，输出 ${llm.outputTokens} tokens`,
    ...(llm.models.length > 0
      ? llm.models.map((item) => `  - ${item.model}：${item.calls} 次，输入 ${item.inputTokens}，输出 ${item.outputTokens}`)
      : []),
    "- AI 模型金额：未换算（未配置可信的模型/网关单价，不虚报成本）",
    `- 未知投递待对账：当前 ${reconciliation.currentlyRequired}，当日新增 ${reconciliation.newlyQuarantined}`,
    `- 飞书通知队列：待处理 ${notificationOutbox.pendingCount}（已到期 ${notificationOutbox.dueCount}；最老等待 ${notificationOutbox.oldestPendingAgeSeconds === null ? "无" : `${notificationOutbox.oldestPendingAgeSeconds} 秒`}）；死信 ${notificationOutbox.deadLetterCount}`,
    `- 收件监控：${inboundMonitoring.state}（上次成功：${inboundMonitoring.lastPollSuccessAt ?? "尚无"}；连续失败 ${inboundMonitoring.consecutiveFailures}；待重试 ${inboundMonitoring.retryPendingMessages}；已隔离 ${inboundMonitoring.quarantinedMessages}；不可重放 ${inboundMonitoring.unreplayableMessages}；外发暂停 ${inboundMonitoring.outboundPaused ? "是" : "否"}）`,
  ].join("\n");
}
