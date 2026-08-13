import type { AgentConfig } from "../config.js";
import {
  cardV2Buttons,
  type FeishuCardButtonOptions,
} from "../integrations/feishu/card-v2.js";
import { isGmailPilotMode } from "../outreach/email-policy.js";
import { DEMAND_POLICY_VERSION } from "../types.js";

interface ReviewDemandEvidence {
  stage?: string;
  sourceUrl?: string;
  publisherDomain?: string;
  sourceDate?: string | null;
  quote?: string;
}

function demandDetails(lead: Record<string, unknown>): {
  stage: string;
  evidence: ReviewDemandEvidence[];
} {
  try {
    const evidence = JSON.parse(String(lead.demand_evidence_json ?? "[]")) as unknown;
    if (Array.isArray(evidence)) {
      return {
        stage: String(lead.demand_stage ?? "UNKNOWN"),
        evidence: evidence.filter(
          (item): item is ReviewDemandEvidence => Boolean(item && typeof item === "object"),
        ),
      };
    }
  } catch {
    // Fall back to the discovery audit record for pre-v5 display compatibility.
  }
  try {
    const parsed = JSON.parse(String(lead.candidate_evidence_json ?? "{}")) as Record<string, unknown>;
    return {
      stage: String(parsed.demandStage ?? "UNKNOWN"),
      evidence: Array.isArray(parsed.demandEvidence)
        ? parsed.demandEvidence.filter((item): item is ReviewDemandEvidence => Boolean(item && typeof item === "object"))
        : [],
    };
  } catch {
    return { stage: "UNKNOWN", evidence: [] };
  }
}

export function reviewCard(
  config: AgentConfig,
  lead: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  reviewHash: string,
): object {
  const gmailPilot = isGmailPilotMode(config);
  const riskyEmail = String(lead.email_status) === "RISKY";
  const demandGateCurrent = Boolean(lead.demand_evidence_qualified) &&
    lead.demand_policy_version === DEMAND_POLICY_VERSION;
  const allMessagesReviewable = messages.length > 0 &&
    messages.every((message) => message.status === "PENDING_APPROVAL");
  const demand = demandDetails(lead);
  const demandLines = demand.evidence.slice(0, 3).flatMap((item, index) => {
    const sourceUrl = String(item.sourceUrl ?? "");
    if (!/^https?:\/\//i.test(sourceUrl)) return [];
    const label = [item.publisherDomain, item.sourceDate ? String(item.sourceDate).slice(0, 10) : null]
      .filter(Boolean)
      .join(" · ");
    const quote = String(item.quote ?? "").replace(/\s+/g, " ").slice(0, 280);
    return [`**需求证据 ${index + 1}：** [${label || "公开来源"}](${sourceUrl}) ${quote}`];
  });
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `审核外联序列：${String(lead.company)}` },
      template: "yellow",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**客户：** ${String(lead.company)}`,
            `**联系人：** ${String(lead.contact_name ?? "")} ${String(lead.contact_title ?? "")}`,
            `**邮箱：** ${String(lead.email ?? "")}`,
            `**评分：** ${String(lead.total_score ?? "")}`,
            `**评分拆分：** 匹配 ${Number(lead.fit_score ?? 0)} / 需求 ${Number(lead.intent_score ?? 0)} / 活跃 ${Number(lead.activity_score ?? 0)} / 联系人 ${Number(lead.contact_score ?? 0)} / 渠道 ${Number(lead.channel_score ?? 0)}`,
            `**需求阶段：** ${demand.stage}（${String(lead.buying_likelihood ?? "UNKNOWN")}）`,
            ...(demandLines.length > 0 ? demandLines : ["**需求证据：** 无已验证的近期直接采购证据"]),
            gmailPilot
              ? "**发送模式：** Gmail 高质量试运行，仅发送首封（每小时最多 5 封、每天最多 50 封、至少间隔 10 分钟）"
              : "**发送模式：** 企业邮箱正式外联",
            riskyEmail
              ? "**邮箱风险：** RISKY，仅确认域名 MX 可收信，无法保证该具体邮箱一定存在。"
              : `**邮箱验证：** ${String(lead.email_status ?? "UNKNOWN")}`,
            ...(!allMessagesReviewable
              ? ["**文案状态：** NEEDS_REWRITE；缺少通过确定性 lint 的 PersonalizationPlan，不能批准。"]
              : []),
            `**ID：** ${String(lead.id)}`,
          ].join("\n"),
        },
        ...messages.flatMap((message) => [
          { tag: "hr" },
          {
            tag: "markdown",
            content: `**第 ${Number(message.sequence_index) + 1} 封｜${String(message.scheduled_at)}**\n**To:** ${String(message.destination ?? "")}\n**Subject:** ${String(message.subject)}\n\n${String(message.body).slice(0, 2800)}`,
          },
        ]),
        ...cardV2Buttons([
          ...(demandGateCurrent && allMessagesReviewable ? [
          {
            text: gmailPilot ? "批准发送首封" : "批准完整序列",
            type: "primary_filled",
            value: { intent: "approve", leadId: lead.id, reviewHash },
            confirm: {
              title: "确认批准外发",
              text: gmailPilot
                ? "确认后，首封邮件将在限流和安全检查通过后真实发送。"
                : "确认后，已审核的邮件序列将在限流和安全检查通过后真实发送。",
            },
          } satisfies FeishuCardButtonOptions] : []),
          {
            text: "拒绝并停止联系",
            type: "danger",
            value: { intent: "reject", leadId: lead.id },
          } satisfies FeishuCardButtonOptions,
        ]),
      ],
    },
  };
}
