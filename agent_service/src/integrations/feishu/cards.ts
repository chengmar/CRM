import type {
  FeishuDeliveryReconciliationPayload,
  FeishuImapHealthPayload,
  FeishuImapMessageQuarantinePayload,
  FeishuNotificationPayload,
  FeishuQuarantinePayload,
} from "./types.js";
import { cardV2Buttons } from "./card-v2.js";
import type { GroundedMessageJobResult } from "../../acquisition/grounded-message-workflow.js";

function truncate(value: unknown, max = 1800): string {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export function inquiryCard(payload: FeishuNotificationPayload): object {
  const { lead, inbound, classification } = payload;
  const leadId = String(lead.id ?? inbound.leadId ?? "");
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "客户询价，已切换人工接管" },
      template: classification.classification === "P1_INQUIRY" ? "red" : "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**公司：** ${truncate(lead.company, 200)}`,
            `**联系人：** ${truncate(lead.contact_name, 120)} ${truncate(lead.contact_title, 120)}`,
            `**渠道：** ${inbound.channel}`,
            `**来源：** ${truncate(inbound.fromAddress, 200)}`,
            `**级别：** ${classification.classification} (${Math.round(classification.confidence * 100)}%)`,
            `**主题：** ${truncate(inbound.subject, 300)}`,
            `**原文：**\n${truncate(inbound.bodyText)}`,
            "",
            "该客户的全部自动发送和跟进已取消，请在原邮箱或 WhatsApp 会话中人工回复。",
          ].join("\n"),
        },
        ...cardV2Buttons([
          {
            text: "确认人工接管",
            type: "primary_filled",
            value: { intent: "handoff", leadId },
          },
          {
            text: "标记误报",
            type: "default",
            value: { intent: "mark_false_positive", leadId },
          },
        ]),
      ],
    },
  };
}

export function quarantineCard(payload: FeishuQuarantinePayload): object {
  const intakeId = String(payload.intake.id ?? "");
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "未匹配入站，等待人工核验" },
      template: payload.classification.classification === "P1_INQUIRY" ? "orange" : "yellow",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**来源：** ${truncate(payload.intake.source, 80)}`,
            `**发送方：** ${truncate(payload.inbound.fromAddress, 200)}`,
            `**接收方：** ${truncate(payload.inbound.toAddress, 200)}`,
            `**初步分类：** ${payload.classification.classification} (${Math.round(payload.classification.confidence * 100)}%)`,
            `**主题：** ${truncate(payload.inbound.subject, 300)}`,
            `**原文：**\n${truncate(payload.inbound.bodyText)}`,
            "",
            "该消息尚未关联到现有客户。接受前不会创建可发送 lead、自动回复或报价。",
          ].join("\n"),
        },
        ...cardV2Buttons([
          {
            text: "接受并人工核验",
            type: "primary_filled",
            value: { intent: "accept_inbound_quarantine", intakeId },
          },
          {
            text: "拒绝并保留审计",
            type: "default",
            value: { intent: "reject_inbound_quarantine", intakeId },
          },
        ]),
      ],
    },
  };
}

export function contentReviewCard(payload: {
  asset: Record<string, unknown>;
  version: Record<string, unknown>;
  claims: Array<Record<string, unknown>>;
}): object {
  const versionId = String(payload.version.id ?? "");
  const status = String(payload.version.status ?? "DRAFT");
  const buttons = status === "DRAFT"
    ? [{ text: "提交技术审核", type: "primary_filled" as const, value: {
      intent: "transition_content_version", contentVersionId: versionId, to: "TECHNICAL_REVIEW",
    } }]
    : status === "TECHNICAL_REVIEW"
      ? [{ text: "技术审核通过", type: "primary_filled" as const, value: {
        intent: "transition_content_version", contentVersionId: versionId, to: "LOCALIZATION_REVIEW",
      } }]
      : status === "LOCALIZATION_REVIEW"
        ? [{ text: "本地化审核通过", type: "primary_filled" as const, value: {
          intent: "transition_content_version", contentVersionId: versionId, to: "APPROVED",
        } }]
        : [];
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "技术内容审核" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**资产：** ${truncate(payload.asset.title, 300)}`,
            `**目标市场：** ${truncate(payload.asset.target_markets_json, 300)}`,
            `**Locale：** ${truncate(payload.version.locale, 80)}`,
            `**状态：** ${status}`,
            `**版本：** ${truncate(payload.version.version_number, 40)}`,
            `**Claims：** ${payload.claims.length}`,
            ...payload.claims.map((claim) =>
              `- ${truncate(claim.statement, 300)} | ${truncate(claim.status, 50)} | ${truncate(claim.source_hash, 80)}`),
            "",
            "此卡不提供发布动作；APPROVED 也不代表网站已发布。",
          ].join("\n"),
        },
        ...cardV2Buttons(buttons),
      ],
    },
  };
}

export function opportunityCard(payload: {
  opportunity: Record<string, unknown>;
  intake?: Record<string, unknown> | null;
  facts?: Array<Record<string, unknown>>;
  acceptedQuoteId?: string | null;
}): object {
  const opportunityId = String(payload.opportunity.id ?? "");
  const stage = String(payload.opportunity.stage ?? "NEW");
  const actions: Array<{ text: string; type: "primary_filled" | "default"; value: Record<string, unknown> }> = [];
  if (["NEW", "INQUIRY_QUALIFIED", "QUALIFIED", "NEEDS_INFO", "TECHNICAL_REVIEW"].includes(stage)) {
    actions.push({ text: "进入技术澄清", type: "primary_filled", value: {
      intent: "update_opportunity_stage", opportunityId, to: "TECHNICAL_DISCOVERY",
    } });
  }
  if (["TECHNICAL_DISCOVERY", "QUOTE_PENDING", "NEGOTIATION"].includes(stage)) {
    actions.push({ text: "标记已报价", type: "default", value: {
      intent: "update_opportunity_stage", opportunityId, to: "QUOTED",
    } });
  }
  if (stage === "QUOTED") {
    actions.push({ text: "进入谈判", type: "default", value: {
      intent: "update_opportunity_stage", opportunityId, to: "NEGOTIATION",
    } });
  }
  if (["QUOTED", "NEGOTIATION"].includes(stage) && payload.acceptedQuoteId) {
    actions.push({ text: "标记成交", type: "primary_filled", value: {
      intent: "update_opportunity_stage", opportunityId, to: "WON", wonQuoteId: payload.acceptedQuoteId,
    } });
  }
  if (!["WON", "LOST"].includes(stage)) {
    actions.push({ text: "标记丢单", type: "default", value: {
      intent: "update_opportunity_stage", opportunityId, to: "LOST",
    } });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "入站商机" },
      template: stage === "WON" ? "green" : "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**阶段：** ${stage}`,
            `**来源：** ${truncate(payload.opportunity.source, 100)}`,
            `**Owner：** ${truncate(payload.opportunity.owner, 120)}`,
            `**主题：** ${truncate(payload.intake?.subject, 300)}`,
            `**原文：** ${truncate(payload.intake?.body_text, 1_000)}`,
            `**已提取参数：** ${(payload.facts ?? []).map((fact) =>
              `${truncate(fact.field_name, 80)}=${truncate(fact.normalized_value, 160)}`).join("；") || "无"}`,
            "",
            "报价金额、币种和毛利只能由授权销售在本地记录；此卡不能让模型填写金额。",
          ].join("\n"),
        },
        ...cardV2Buttons(actions),
      ],
    },
  };
}

export function replyCard(payload: FeishuNotificationPayload): object {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: "客户回复，自动跟进已暂停" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**公司：** ${truncate(payload.lead.company, 200)}`,
            `**分类：** ${payload.classification.classification}`,
            `**主题：** ${truncate(payload.inbound.subject, 300)}`,
            `**原文：**\n${truncate(payload.inbound.bodyText)}`,
          ].join("\n"),
        },
      ],
    },
  };
}

export function safetyPauseCard(payload: FeishuNotificationPayload): object {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: "Gmail 试运行已因硬退信自动暂停" },
      template: "red",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**公司：** ${truncate(payload.lead.company, 200)}`,
            `**退信地址：** ${truncate(payload.inbound.fromAddress, 200)}`,
            `**原因：** ${truncate(payload.classification.reason, 500)}`,
            "",
            "系统已暂停全部外发。请先核查邮箱来源和验证规则，再由授权人员手动恢复。",
          ].join("\n"),
        },
      ],
    },
  };
}

export function hardBounceCard(payload: FeishuNotificationPayload): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "企业邮箱发生硬退信" },
      template: "red",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
          `**公司：** ${truncate(payload.lead.company, 200)}`,
          `**退信地址：** ${truncate(payload.inbound.fromAddress, 200)}`,
          `**原因：** ${truncate(payload.classification.reason, 500)}`,
          "",
          "该地址已标记为无效，该客户的自动跟进已停止。系统会继续按当前退信率策略决定是否暂停全部外发。",
          ].join("\n"),
        },
      ],
    },
  };
}

export function imapRuntimeHealthCard(payload: FeishuImapHealthPayload): object {
  const recovered = payload.recovered;
  const stateLabel = payload.state === "HEALTHY" || recovered ? "已恢复" : "异常";
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: recovered
          ? "收件监控已恢复，外发仍保持暂停"
          : "收件监控异常，系统已暂停外发",
      },
      template: recovered ? "green" : "red",
    },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `**当前状态：** ${stateLabel}（${truncate(payload.state, 80)}）`,
          `**连续检查失败：** ${payload.consecutiveFailures} / ${payload.failurePauseThreshold}`,
          `**上次成功收件检查：** ${truncate(payload.lastPollSuccessAt ?? "本次启动后尚未成功", 100)}`,
          `**安全事件编号：** ${payload.episode}`,
          `**外发仍暂停：** ${payload.globalPauseRemains ? "是" : "否"}`,
          "",
          recovered
            ? "系统已重新连上收件箱，但不会自动恢复发信。请先确认新回复和退信能够正常入库，再由授权人员手动恢复外发。"
            : "系统目前无法可靠监测客户回复和退信，因此已阻止所有新邮件发送。请检查企业邮箱的 IMAP 开关、客户端专用密码和网络；恢复后系统会另行提示。",
        ].join("\n"),
      }],
    },
  };
}

export function imapMessageQuarantineCard(payload: FeishuImapMessageQuarantinePayload): object {
  const subjectPreview = typeof payload.preview.subject === "string" && payload.preview.subject
    ? payload.preview.subject
    : "无可用主题";
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "一封异常邮件已隔离，后续收件继续处理" },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
          `**隔离记录：** ${truncate(payload.failureId, 160)}`,
          `**邮件定位：** UIDVALIDITY ${truncate(payload.uidValidity, 80)} / UID ${payload.uid}`,
          `**已尝试次数：** ${payload.attempts} / ${payload.maxAttempts}`,
          `**隔离轮次：** ${payload.quarantineEpisode}`,
          `**邮件指纹：** ${truncate(payload.sourceSha256, 80)}（${payload.sourceSize} 字节）`,
          `**错误类型：** ${truncate(payload.errorClass, 120)}`,
          `**脱敏主题预览：** ${truncate(subjectPreview, 200)}`,
          "",
          "系统已跳过这封异常邮件并继续处理后续回复，不会让整个收件箱卡住。定位信息和指纹已保存在数据库中，技术人员可按记录人工重放；隔离表不会复制整封邮件原文。",
          ].join("\n"),
        },
        ...cardV2Buttons([{
          text: "重新处理这封邮件",
          type: "primary_filled",
          value: {
            intent: "replay_quarantined_imap_message",
            failureId: payload.failureId,
          },
          confirm: {
            title: "确认重新处理",
            text: "系统会按原 UID 从收件箱重新读取。若邮箱 UIDVALIDITY 已变化，将拒绝操作且不会改动收件游标。",
          },
        }]),
      ],
    },
  };
}

export function deliveryReconciliationCard(
  payload: FeishuDeliveryReconciliationPayload,
): object {
  const messageId = String(payload.message.id ?? "");
  const rawAttempt = Number(payload.message.attempts ?? 0);
  const attempt = Number.isSafeInteger(rawAttempt) && rawAttempt >= 0 ? rawAttempt : 0;
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "投递结果不确定，外发已暂停" },
      template: "red",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**公司：** ${truncate(payload.message.company, 200)}`,
            `**收件地址：** ${truncate(payload.message.destination, 200)}`,
            `**邮件记录：** ${truncate(messageId, 160)}`,
            `**投递轮次：** ${attempt}`,
            `**Message-ID：** ${truncate(payload.message.provider_message_id, 260)}`,
            `**开始投递时间：** ${truncate(payload.message.sending_started_at ?? payload.message.updated_at, 100)}`,
            "",
            "系统无法确认 SMTP 是否已接受这封邮件，因此不会自动重发。请先在企业邮箱“已发送”中按 Message-ID 核对，再选择下方结果。",
          ].join("\n"),
        },
        ...cardV2Buttons([
          {
            text: "确认已经发送",
            type: "primary_filled",
            value: {
              intent: "reconcile_unknown_delivery",
              messageId,
              resolution: "CONFIRMED_SENT",
            },
          },
          {
            text: "确认未发送并重排",
            type: "default",
            value: {
              intent: "reconcile_unknown_delivery",
              messageId,
              resolution: "CONFIRMED_NOT_SENT_REQUEUE",
            },
          },
        ]),
      ],
    },
  };
}

export function fallbackNotificationCard(): object {
  return {
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content: "智能体通知" }] },
  };
}

export function dailyOperationsReportCard(text: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "外贸智能体运营日报" },
      template: "blue",
    },
    body: {
      elements: [{ tag: "markdown", content: truncate(text, 12_000) }],
    },
  };
}

export function campaignBriefCard(payload: {
  briefId: string;
  versionId: string;
  status: string;
  briefHash: string;
  brief: Record<string, unknown>;
  providerBudgetHash?: string | null;
  forecast?: Record<string, unknown> | null;
}): object {
  const actions: Array<{
    text: string;
    type: "primary_filled" | "default";
    value: Record<string, unknown>;
  }> = [];
  if (payload.status === "PLAN_DRAFT") {
    actions.push({
      text: "批准研究方案（不发邮件）",
      type: "primary_filled",
      value: {
        intent: "approve_campaign_scope",
        briefId: payload.briefId,
        versionId: payload.versionId,
        scope: "SHADOW_PLAN",
        briefHash: payload.briefHash,
      },
    });
  }
  if (payload.providerBudgetHash && ["PLAN_APPROVED", "BUDGET_PENDING"].includes(payload.status)) {
    actions.push({
      text: "批准本次研究预算",
      type: "default",
      value: {
        intent: "approve_campaign_scope",
        briefId: payload.briefId,
        versionId: payload.versionId,
        scope: "PROVIDER_BUDGET",
        briefHash: payload.briefHash,
        budgetHash: payload.providerBudgetHash,
      },
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "获客任务方案审核" }, template: "blue" },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**状态：** ${truncate(payload.status, 80)}`,
            `**目标市场：** ${truncate(payload.brief.market, 120)}`,
            `**产品：** ${truncate(payload.brief.productFamily, 240)}`,
            `**目标：** ${truncate(payload.brief.targetMetric, 80)} = ${truncate(payload.brief.targetCount, 40)}`,
            `**资格路径：** ${truncate(JSON.stringify(payload.brief.qualificationTracks ?? []), 300)}`,
            `**触达方式：** ${truncate(payload.brief.transport, 80)}`,
            `**方案版本：** ${truncate(payload.versionId, 160)}`,
            `**方案指纹：** ${truncate(payload.briefHash, 80)}`,
            `**结果预估：** ${truncate(JSON.stringify(payload.forecast ?? { unavailable: true }), 900)}`,
            "",
            "研究方案和 Provider 预算需要分别批准。本卡不能批准客户外发，也不能发布任何内容。",
          ].join("\n"),
        },
        ...cardV2Buttons(actions),
      ],
    },
  };
}

export function autonomousPilotCatalogCard(payload: {
  planId: string;
  targetTotal: number;
  entries: Array<{
    file: string;
    fileHash: string;
    name: string;
    market: string;
    product: string;
    buyerType: string;
    senderEmail: string;
    targetCount: number;
    totalLimit: number;
    dailyLimit: number;
    hourlyLimit: number;
    verifier: "hunter" | "bouncer";
    expiresAt: string;
    alreadyLaunched: boolean;
    blockers: string[];
    capabilityWarnings: string[];
  }>;
}): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "真实发送实验" },
      template: payload.entries.some((entry) => entry.blockers.length === 0 && !entry.alreadyLaunched)
        ? "yellow"
        : "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**发送方案：** ${truncate(payload.planId, 160)}`,
            `**总授权上限：** ${payload.targetTotal} 封首封邮件`,
            "每个市场独立绑定方案版本、Provider 预算、发送总量、日限额、小时限额和有效期。点击批准只会创建研究与发送授权，不会当场发送客户邮件，也不会改动当前全局暂停或每日研究开关。",
          ].join("\n"),
        },
        ...payload.entries.flatMap((entry) => [
          { tag: "hr" },
          {
            tag: "markdown",
            content: [
              `**${truncate(entry.market, 120)}｜${truncate(entry.name, 240)}**`,
              `产品：${truncate(entry.product, 300)}`,
              `目标客户：${truncate(entry.buyerType, 220)}`,
              `发件邮箱：${truncate(entry.senderEmail, 220)}`,
              `发送上限：总计 ${entry.totalLimit} / 每日 ${entry.dailyLimit} / 每小时 ${entry.hourlyLimit}`,
              `邮箱验证：${entry.verifier === "hunter" ? "Hunter" : "Bouncer"}`,
              ...entry.capabilityWarnings.map((warning) => `能力提示：${truncate(warning, 800)}`),
              `授权有效期至：${truncate(entry.expiresAt, 80)}`,
              entry.alreadyLaunched
                ? "状态：已创建，不会重复启动"
                : entry.blockers.length > 0
                  ? `状态：暂不可创建｜${truncate(entry.blockers.join("；"), 1200)}`
                  : entry.capabilityWarnings.length > 0
                    ? "状态：B 类官网职能邮箱链路已就绪，可批准创建；A 类具名联系人暂不进入授权"
                    : "状态：A/B 类联系人链路均已就绪，可批准创建",
            ].join("\n"),
          },
          ...(!entry.alreadyLaunched && entry.blockers.length === 0
            ? cardV2Buttons([{
                text: `批准并创建 ${entry.market} 发送实验`,
                type: "primary_filled",
                value: {
                  intent: "launch_autonomous_pilot_from_catalog",
                  specFile: entry.file,
                  specHash: entry.fileHash,
                },
                confirm: {
                  title: `确认 ${entry.market} 真实发送授权`,
                  text: `将创建总计 ${entry.totalLimit}、每日 ${entry.dailyLimit}、每小时 ${entry.hourlyLimit} 的精确 Campaign 授权。本操作不会改动当前全局暂停或每日研究开关；实际投递仍须逐封通过实时门禁。`,
                },
              }])
            : []),
        ]),
      ],
    },
  };
}

export function groundedMessageReviewCard(payload: GroundedMessageJobResult): object {
  const review = payload.review;
  const campaignAuthorized = payload.externalSendAuthorized && payload.outboundStatus === "APPROVED";
  const reviewActions = !payload.externalSendAuthorized &&
    payload.status === "PENDING_APPROVAL" && review &&
    payload.messageVersionId && payload.reviewHash && payload.reviewCardId && payload.reviewExpiresAt
    ? [
        {
          text: "批准邮件内容",
          type: "primary_filled" as const,
          value: {
            intent: "review_grounded_message",
            decision: "APPROVE_CONTENT",
            reviewCardId: payload.reviewCardId,
            messageVersionId: payload.messageVersionId,
            reviewHash: payload.reviewHash,
          },
        },
        {
          text: "需要重写",
          type: "default" as const,
          value: {
            intent: "review_grounded_message",
            decision: "NEEDS_REWRITE",
            reviewCardId: payload.reviewCardId,
            messageVersionId: payload.messageVersionId,
            reviewHash: payload.reviewHash,
          },
        },
      ]
    : [];
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: campaignAuthorized ? "已获 Campaign 授权的邮件审计" : "证据化邮件内容审核",
      },
      template: campaignAuthorized ? "green" : payload.status === "PENDING_APPROVAL" ? "yellow" : "red",
    },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `**状态：** ${truncate(payload.status, 80)}`,
          `**资格路径：** ${truncate(payload.qualification?.track ?? "BLOCKED", 80)}`,
          `**邮件版本：** ${truncate(payload.messageVersionId ?? "尚未保存", 180)}`,
          `**审核指纹：** ${truncate(payload.reviewHash ?? "暂无", 80)}`,
          `**审核有效期：** ${truncate(payload.reviewExpiresAt ?? "暂无", 80)}`,
          `**客户外发已授权：** ${payload.externalSendAuthorized ? "是" : "否"}`,
          `**Campaign 发送授权：** ${truncate(payload.campaignSendAuthorizationId ?? "暂无", 180)}`,
          `**单封邮件授权：** ${truncate(payload.campaignMessageAuthorizationId ?? "暂无", 180)}`,
          `**外发记录 / 状态：** ${truncate(payload.outboundMessageId ?? "尚未排队", 180)} / ${truncate(payload.outboundStatus ?? "未批准", 80)}`,
          `**内容阻塞：** ${truncate(payload.lint.blockers.join(" | ") || "无", 1000)}`,
          `**内容提醒：** ${truncate(payload.lint.warnings.join(" | ") || "无", 1000)}`,
          ...(review ? [
            `**账户 / 线索 / 联系人：** ${truncate(review.accountId, 120)} / ${truncate(review.leadId, 120)} / ${truncate(review.contactId, 120)}`,
            `**语言区域 / 资格路径：** ${truncate(review.locale, 80)} / ${truncate(review.qualificationTrack, 80)}`,
            `**引用证据：** ${truncate(review.referencedFactIds.join(", "), 800)}`,
            `**收件人：** ${truncate(review.destination, 320)}`,
            `**主题：** ${truncate(review.subject, 500)}`,
            "",
            truncate(review.body, 6000),
          ] : []),
          "",
          campaignAuthorized
            ? "这是只读审计通知。Campaign 策略在本卡生成前已绑定并授权这封邮件；本卡不能再次授权或发送，实际投递仍必须通过全局暂停和领取时门禁。"
            : "本卡只审核内容，不能授权或执行邮件、LinkedIn、WhatsApp、Provider 调用或内容发布。",
        ].join("\n"),
      }, ...cardV2Buttons(reviewActions)],
    },
  };
}

export function marketAllocationCard(payload: {
  policyVersion: string;
  totalResearchUnits: number;
  explorationShare: number;
  rows: Array<Record<string, unknown>>;
  applied: false;
  requiresHumanApproval: true;
  automaticKills: 0;
}): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "市场研究配额建议" }, template: "yellow" },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `**策略版本：** ${truncate(payload.policyVersion, 120)}`,
          `**研究配额：** ${payload.totalResearchUnits}`,
          `**探索份额下限：** ${Math.round(payload.explorationShare * 100)}%`,
          `**已应用：** ${payload.applied ? "是" : "否"}`,
          `**需要人工批准：** ${payload.requiresHumanApproval ? "是" : "否"}`,
          `**自动终止数量：** ${payload.automaticKills}`,
          "",
          ...payload.rows.map((row) =>
            `- ${truncate(row.country, 50)} / ${truncate(row.playId, 100)}: ${truncate(row.recommendation, 80)}, ` +
            `${truncate(row.recommendedUnits, 40)} 个研究单位（份额 ${truncate(row.recommendedShare, 40)}）`),
          "",
          "这只是研究配额建议，本卡不会自动应用配额，也不会授权发送。",
        ].join("\n"),
      }],
    },
  };
}

export function manualSalesTaskCard(payload: {
  task: Record<string, unknown>;
  account?: Record<string, unknown> | null;
  person?: Record<string, unknown> | null;
  evidence?: Array<Record<string, unknown>>;
}): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "人工销售任务" }, template: "blue" },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `**任务：** ${truncate(payload.task.task_type ?? payload.task.taskType, 100)}`,
          `**状态：** ${truncate(payload.task.status, 80)}`,
          `**负责人：** ${truncate(payload.task.owner, 120)}`,
          `**截止时间：** ${truncate(payload.task.due_at ?? payload.task.dueAt, 80)}`,
          `**客户账户：** ${truncate(payload.account?.display_name ?? payload.account?.displayName, 240)}`,
          `**联系人：** ${truncate(payload.person?.display_name ?? payload.person?.displayName, 200)}`,
          `**证据：** ${(payload.evidence ?? []).map((item) => truncate(item.exact_quote ?? item.exactQuote, 260)).join(" | ") || "无"}`,
          "",
          "该任务需要人工执行。本卡不会自动操作 LinkedIn、电话、邮件或 WhatsApp。",
        ].join("\n"),
      }],
    },
  };
}

export function commercialReportCard(payload: {
  title: string;
  dimensions: Record<string, unknown>;
  delivered: number;
  positiveReplies: number;
  inquiries: number;
  quotes: number;
  wins: number;
  revenueMinor: number;
  grossMarginMinor: number;
  costMinor: number;
  attributionMode: "DESCRIPTIVE_FIRST_LAST_ASSIST";
}): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: truncate(payload.title, 200) }, template: "green" },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `**统计维度：** ${truncate(JSON.stringify(payload.dimensions), 800)}`,
          `**已送达样本：** ${payload.delivered}`,
          `**积极回复 / 询盘 / 报价 / 成交：** ${payload.positiveReplies} / ${payload.inquiries} / ${payload.quotes} / ${payload.wins}`,
          `**收入 / 毛利 / 成本（最小货币单位）：** ${payload.revenueMinor} / ${payload.grossMarginMinor} / ${payload.costMinor}`,
          `**归因方式：** ${payload.attributionMode}`,
          "",
          "该归因只用于描述业务结果，不能证明单一动作造成了结果提升。",
        ].join("\n"),
      }],
    },
  };
}
