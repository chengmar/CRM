import type { AgentConfig } from "../config.js";
import type {
  AgentDatabase,
  ContentVersionStatus,
  GroundedMessageReviewDecision,
  OpportunityStage,
  WorkflowRole,
} from "../db.js";
import type { AgentLlm } from "../llm.js";
import type { OutboundDispatcher } from "../outreach/dispatcher.js";
import { activateGmailPilot, ensureGmailPilotState } from "../outreach/gmail-pilot.js";
import { ensureEmailChannelState } from "../outreach/email-channel.js";
import { cardV2Buttons } from "../integrations/feishu/card-v2.js";
import { autonomousPilotCatalogCard } from "../integrations/feishu/cards.js";
import { FeishuAuthorization } from "../integrations/feishu/authorization.js";
import { buildFunnelReport, formatFunnelReport, localDayUtcWindow } from "../reporting/funnel.js";
import {
  buildDailyOperationsReport,
  formatDailyOperationsReport,
} from "../reporting/daily-operations.js";
import { parseCommand } from "./parser.js";
import {
  CAMPAIGN_BRIEF_SCHEMA_VERSION,
  validateCampaignBriefDraft,
} from "../acquisition/campaign-brief.js";
import {
  assessAcquisitionReadiness,
  researchReadinessConclusion,
} from "../acquisition/operator-readiness.js";
import {
  launchManualResearchFromApprovedTemplate,
  ManualResearchLaunchError,
} from "../acquisition/manual-research-launch.js";
import {
  AutonomousPilotCatalogError,
  AutonomousPilotLaunchBlockedError,
  autonomousPilotCapabilityWarnings,
  autonomousPilotLaunchBlockers,
  launchAutonomousPilotFromCatalog,
  loadAutonomousPilotCatalog,
} from "../acquisition/autonomous-pilot-catalog.js";
import { getAutonomousMessageBridgeDiagnostics } from
  "../acquisition/autonomous-discovery-message-bridge.js";

function textCard(title: string, content: string, template = "blue"): { card: object } {
  return {
    card: {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: title }, template },
      body: { elements: [{ tag: "markdown", content }] },
    },
  };
}

export class CommandService {
  private readonly feishuAuthorization: FeishuAuthorization;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    private readonly dispatcher: OutboundDispatcher,
  ) {
    this.feishuAuthorization = new FeishuAuthorization(config, db);
  }

  private authorizeSensitiveOperation(input: {
    senderId: string;
    operation: string;
    surface: "TEXT_COMMAND" | "CARD_ACTION";
    requiredRoles: readonly WorkflowRole[];
  }): WorkflowRole[] | null {
    const roles = this.feishuAuthorization.rolesFor(input.senderId);
    const actual = new Set(roles);
    const authorized = input.requiredRoles.some((role) => actual.has(role));
    this.db.recordEvent(
      "system",
      "feishu_rbac",
      authorized
        ? "FEISHU_SENSITIVE_OPERATION_AUTHORIZED"
        : "FEISHU_SENSITIVE_OPERATION_DENIED",
      input.senderId,
      {
        operation: input.operation,
        surface: input.surface,
        requiredRoles: [...input.requiredRoles],
        decision: authorized ? "AUTHORIZED" : "DENIED",
      },
    );
    return authorized ? roles : null;
  }

  private authorizeTextCommand(
    senderId: string,
    operation: string,
    requiredRoles: readonly WorkflowRole[],
  ): WorkflowRole[] | null {
    return this.authorizeSensitiveOperation({
      senderId,
      operation,
      surface: "TEXT_COMMAND",
      requiredRoles,
    });
  }

  private authorizeCardAction(
    senderId: string,
    operation: string,
    requiredRoles: readonly WorkflowRole[],
  ): WorkflowRole[] | null {
    return this.authorizeSensitiveOperation({
      senderId,
      operation,
      surface: "CARD_ACTION",
      requiredRoles,
    });
  }

  private sensitiveOperationDenied(): string {
    return "该操作需要由已配置相应职责的飞书用户执行。系统未执行任何变更。";
  }

  async handleText(input: {
    text: string;
    senderId: string;
    chatId: string;
    messageId: string;
  }): Promise<string | { card: object }> {
    const command = await parseCommand(input.text, this.llm, this.config);
    switch (command.intent) {
      case "HELP":
        return [
          "可用命令：",
          "1. 开发越南工业设备集成商20家，主推定制设备和OEM配件",
          "2. 待审核客户",
          "3. 生成开发信 lead_xxx",
          "4. 批准 lead_xxx",
          "5. 人工接管 lead_xxx",
          "6. 同步CRM",
          "7. 发送计划",
          "8. 测试邮箱（企业邮箱会同时验收 SMTP 发送和 IMAP 收件）",
          "9. 开启每日自动获客 / 关闭每日自动获客",
          "10. 准备真实发送（查看并批准有界发送实验）",
          "11. 状态 / 暂停全部 / 恢复系统",
          "12. 今日漏斗 / 漏斗报告",
          "13. 实时运营（当日收发、库存、退信、成本和待处理事项）",
        ].join("\n");
      case "STATUS": {
        const metrics = this.db.getMetrics();
        const gmailPilot = ensureGmailPilotState(this.config, this.db);
        const emailChannel = gmailPilot.mode
          ? { configured: false, selfTestPassed: false, selfTestPassedAt: null }
          : ensureEmailChannelState(this.config, this.db);
        let dispatchPlan: ReturnType<OutboundDispatcher["plan"]> | null = null;
        try {
          dispatchPlan = this.dispatcher.plan(Math.max(100, this.config.EMAIL_DAILY_LIMIT));
        } catch {
          dispatchPlan = null;
        }
        const outboundPaused = this.db.getSetting("outbound_paused") === "true";
        const readiness = assessAcquisitionReadiness({
          config: this.config,
          outboundPaused,
          gmailPilot,
          emailChannel,
          dispatchPlan,
        });
        const providerLines = readiness.providers
          .map((provider) => `- ${provider.name}：${provider.ready ? "就绪" : "未就绪"}`);
        const blockerLines = readiness.blockers.length > 0
          ? readiness.blockers.map((blocker) => `- ${blocker}`)
          : ["- 无"];
        const capabilityLines = readiness.capabilityWarnings.length > 0
          ? readiness.capabilityWarnings.map((warning) => `- ${warning}`)
          : ["- A 类具名联系人和 B 类官网职能邮箱均可进入各自审核链路"];
        const bridge = getAutonomousMessageBridgeDiagnostics(this.db);
        const bridgeBlockers = bridge.topBlockers.length > 0
          ? bridge.topBlockers.map((item) => `${item.code} (${item.count})`).join("；")
          : "无";
        const bridgeLines = [
          "",
          "**消息生产链路**",
          `- 已授权 Campaign：${bridge.authorizedCampaigns}`,
          `- 授权范围线索：${bridge.authorizedLeads}；有邮箱联系人：${bridge.contactsWithEmail}`,
          `- 消息暂存任务：${bridge.stageJobs}；已生成消息：${bridge.outboundMessages}；逐消息授权：${bridge.messageAuthorizations}`,
          `- 主要桥接阻塞：${bridgeBlockers}`,
        ];
        return textCard(
          "外贸获客 Agent 状态",
          [
            "**直接结论**",
            `**研究链路：** ${researchReadinessConclusion(readiness)}`,
            `**现在能发：** ${readiness.canSendNow
              ? `可以。当前调度窗口有 ${readiness.allowedMessageCount} 条客户消息通过全部发送门禁。`
              : "不能。当前调度窗口没有任何通过全部发送门禁的客户消息。"}`,
            "",
            "**主要阻塞**",
            ...blockerLines,
            ...bridgeLines,
            "",
            "**联系人能力范围**",
            ...capabilityLines,
            "",
            "**Provider 就绪状态**",
            ...providerLines,
            "",
            "---",
            "**次级技术明细**",
            `**模式：** ${this.config.AGENT_MODE}`,
            `**外发开关：** ${this.config.OUTBOUND_ENABLED ? "开启" : "关闭"}`,
            `**Gmail 试运行：** ${gmailPilot.mode ? "是" : "否"}`,
            `**Gmail 自测：** ${gmailPilot.selfTestPassed ? `已通过（${gmailPilot.selfTestPassedAt ?? ""}）` : "未通过"}`,
            `**Gmail 试发授权：** ${gmailPilot.activated ? "已启用" : "未启用"}`,
            ...(gmailPilot.mode ? [] : [`**企业邮箱收发自测：** ${emailChannel.selfTestPassed ? `已通过（${emailChannel.selfTestPassedAt ?? ""}）` : "未通过"}`]),
            `**飞书敏感操作管理员：** ${readiness.sensitiveOperatorConfigured ? "已配置" : "未配置"}`,
            `**全局暂停：** ${outboundPaused ? "是" : "否"}`,
            `**每日自动获客：** ${(this.db.getSetting("daily_research_enabled") ?? String(this.config.DAILY_RESEARCH_ENABLED)) === "true" ? "开启" : "关闭"}`,
            `**每日运营报告：** ${(this.db.getSetting("daily_operations_enabled") ?? String(this.config.DAILY_OPERATIONS_REPORT_ENABLED)) === "true" ? "开启" : "关闭"}`,
            `**当前调度窗口候选消息：** ${readiness.plannedMessageCount}`,
            `**通过全部门禁、可调度：** ${readiness.allowedMessageCount}`,
            `**线索：** ${metrics.leads}`,
            `**通过质量门槛：** ${metrics.eligibleLeads}`,
            `**待审核：** ${metrics.pendingReview}`,
            `**已发送：** ${metrics.messagesSent}`,
            `**已关联客户回复：** ${metrics.replies}`,
            `**已关联询价：** ${metrics.inquiries}`,
            `**未关联收件箱消息（不计业务结果）：** ${metrics.unmatchedInbound}`,
            `**人工接管：** ${metrics.humanTakeovers}`,
            `**待处理任务：** ${metrics.pendingJobs}`,
            `**投递结果待对账：** ${metrics.deliveryReconciliations}`,
          ].join("\n"),
        );
      }
      case "OPERATIONS": {
        const now = new Date();
        const window = localDayUtcWindow(now, this.config.DAILY_OPERATIONS_REPORT_TIMEZONE);
        const dispatchPlanLimit = Math.max(1, this.config.EMAIL_DAILY_LIMIT);
        let dispatchPlan: ReturnType<OutboundDispatcher["plan"]>;
        try {
          dispatchPlan = this.dispatcher.plan(dispatchPlanLimit);
        } catch {
          return textCard(
            "实时运营看板",
            "当前无法生成外发库存计划。系统仍保持原有发送状态，请先查看“状态”中的阻塞原因。",
            "yellow",
          );
        }
        const report = buildDailyOperationsReport(this.db, {
          ...window,
          timeZone: this.config.DAILY_OPERATIONS_REPORT_TIMEZONE,
          generatedAt: now.toISOString(),
          dispatchPlan,
          dispatchPlanLimit,
        });
        return textCard(
          "实时运营看板",
          [
            `**刷新时间：** ${report.generatedAt}`,
            formatDailyOperationsReport(report),
          ].join("\n\n"),
          report.reconciliation.currentlyRequired > 0 ? "red" : "blue",
        );
      }
      case "FUNNEL": {
        const now = new Date();
        const window = command.period === "TODAY"
          ? localDayUtcWindow(now, this.config.DAILY_RESEARCH_TIMEZONE)
          : null;
        const report = buildFunnelReport(this.db, {
          startAt: window?.startAt,
          endAt: window?.endAt,
          generatedAt: now,
        });
        return textCard(
          window ? `${window.localDate} 漏斗` : "全量漏斗",
          formatFunnelReport(report),
          "blue",
        );
      }
      case "PAUSE":
        if (!this.authorizeTextCommand(input.senderId, "PAUSE_OUTBOUND", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        this.db.setSetting("outbound_paused", "true");
        this.db.recordEvent("system", "outbound", "OUTBOUND_PAUSED", input.senderId, {
          reason: "requested_from_feishu",
        });
        return "已暂停全部外发。搜索、验证和收件箱监听仍会继续运行。";
      case "RESUME":
        if (!this.authorizeTextCommand(input.senderId, "RESUME_OUTBOUND", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        if (this.db.listUnknownDeliveryReconciliations(1).length > 0) {
          return "仍有投递结果不确定的邮件，不能恢复外发。请先在飞书告警卡中确认这些邮件是已发送，还是未发送并重排。";
        }
        if (ensureGmailPilotState(this.config, this.db).mode) {
          const pilot = ensureGmailPilotState(this.config, this.db);
          if (!pilot.activated) {
            return "Gmail 试发尚未启用，不能用“恢复系统”绕过首次授权。请先发送“测试 Gmail”，再发送“开启 Gmail 试发”并点击确认按钮。";
          }
        }
        if (!ensureGmailPilotState(this.config, this.db).mode && !ensureEmailChannelState(this.config, this.db).selfTestPassed) {
          return "企业邮箱收发自测尚未通过，不能解除外发暂停。请先发送“测试邮箱”。";
        }
        this.db.setSetting("outbound_paused", "false");
        this.db.recordEvent("system", "outbound", "OUTBOUND_RESUMED", input.senderId, {});
        return "已解除全局暂停。只有通过质量门槛并明确批准的消息才可能发送。";
      case "TEST_EMAIL": {
        if (!this.authorizeTextCommand(input.senderId, "TEST_EMAIL_CHANNEL", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        try {
          const result = await this.dispatcher.testEmailChannel(input.senderId);
          if (!result.sent) {
            return `邮箱收发自测在 5 分钟内已经通过，不重复发送。通过时间：${result.passedAt}`;
          }
          return `企业邮箱自发自收已通过。SMTP 已发送，IMAP 已确认收件；客户外发仍保持暂停。通过时间：${result.passedAt}`;
        } catch (error) {
          return `邮箱收发自测未通过，系统仍保持暂停。\n${String(error)}`;
        }
      }
      case "TEST_GMAIL": {
        if (!this.authorizeTextCommand(input.senderId, "TEST_GMAIL_CHANNEL", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        try {
          const result = await this.dispatcher.testGmailPilot(input.senderId);
          if (!result.sent) {
            return `Gmail 自测在 5 分钟内已经通过，不重复发送。通过时间：${result.passedAt}`;
          }
          return `Gmail 自测邮件已真实发送到 ${this.config.EMAIL_FROM_ADDRESS}。请确认收件箱收到后，发送“开启 Gmail 试发”。`;
        } catch (error) {
          return `Gmail 自测未通过，系统仍保持暂停。\n${String(error)}`;
        }
      }
      case "ACTIVATE_GMAIL_PILOT": {
        if (!this.authorizeTextCommand(input.senderId, "REQUEST_GMAIL_PILOT_ACTIVATION", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        const pilot = ensureGmailPilotState(this.config, this.db);
        if (!pilot.mode) return "当前不是 Gmail 试运行模式。";
        if (!pilot.selfTestPassed) return "Gmail 自测尚未通过。请先发送“测试 Gmail”。";
        if (pilot.activated) return "Gmail 试发已经启用，无需重复操作。";
        return {
          card: {
            schema: "2.0",
            header: {
              title: { tag: "plain_text", content: "确认开启 Gmail 真实试发" },
              template: "yellow",
            },
            body: {
              elements: [
                {
                  tag: "markdown",
                  content: [
                    `**发件邮箱：** ${this.config.EMAIL_FROM_ADDRESS}`,
                    `**每日发送目标：** ${this.config.EMAIL_DAILY_LIMIT} 封高质量、已批准的首封邮件`,
                    "**调度方式：** 系统根据累计发送、退信和送达表现自动调速，不使用固定 600 秒死间隔。",
                    "**范围：** 仅发送你在完整审核卡片中明确批准的首封邮件，不自动跟进。",
                    "**停止条件：** 客户回复、询价、退订、人工接管或硬退信都会停止该客户自动化；硬退信会暂停全局外发。",
                    "",
                    "点击后服务器会解除全局暂停，后续批准动作可能产生真实客户邮件。",
                  ].join("\n"),
                },
                ...cardV2Buttons([
                  {
                    text: "确认启用真实试发",
                    type: "primary_filled",
                    value: { intent: "activate_gmail_pilot" },
                    elementId: "activate_gmail",
                    confirm: {
                      title: "确认开启真实邮件外发",
                      text: "开启后，只有你在审核卡片中批准的客户邮件才会真实发送。",
                    },
                  },
                ]),
              ],
            },
          },
        };
      }
      case "ENABLE_DAILY_RESEARCH":
        if (!this.authorizeTextCommand(input.senderId, "ENABLE_DAILY_RESEARCH", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        this.db.setSetting("daily_research_enabled", "true");
        this.db.recordEvent("system", "daily_research", "DAILY_RESEARCH_ENABLED", input.senderId, {});
        return `每日自动研究已开启。系统会在每天 ${this.config.DAILY_RESEARCH_HOUR}:00（${this.config.DAILY_RESEARCH_TIMEZONE}）从允许市场中按已批准的 play、研究配额、探索比例和历史结果选择任务，完成市场研究、公司背调、联系人查找和 CRM 同步，并在飞书反馈真实阶段数据。本开关不授权客户邮件外发。`;
      case "DISABLE_DAILY_RESEARCH":
        if (!this.authorizeTextCommand(
          input.senderId,
          "DISABLE_DAILY_RESEARCH",
          ["CAMPAIGN_APPROVER", "SALES_MANAGER"],
        )) {
          return this.sensitiveOperationDenied();
        }
        this.db.setSetting("daily_research_enabled", "false");
        this.db.recordEvent("system", "daily_research", "DAILY_RESEARCH_DISABLED", input.senderId, {});
        return "每日自动研究已关闭。当前正在执行的研究任务会完成，但不会再创建新的每日研究任务。";
      case "SEND_PILOTS": {
        if (!this.authorizeTextCommand(input.senderId, "VIEW_SEND_PILOT_CATALOG", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        try {
          const catalog = loadAutonomousPilotCatalog(this.config, this.db);
          return {
            card: autonomousPilotCatalogCard({
              planId: catalog.planId,
              targetTotal: catalog.targetTotal,
              entries: catalog.entries.map((entry) => ({
                ...entry,
                blockers: autonomousPilotLaunchBlockers(this.config, this.db, entry),
                capabilityWarnings: autonomousPilotCapabilityWarnings(this.config, entry),
              })),
            }),
          };
        } catch (error) {
          if (error instanceof AutonomousPilotCatalogError && error.code === "CATALOG_MISSING") {
            return textCard(
              "真实发送实验",
              "服务器尚未安装经过审核的真实发送方案。当前不会创建发送授权，也不会发送客户邮件；请先由维护流程把公司专属方案写入私密业务资料目录。",
              "yellow",
            );
          }
          return textCard(
            "真实发送实验",
            `发送方案校验失败，系统没有创建任何授权：${String(error)}`,
            "red",
          );
        }
      }
      case "FIND": {
        if (!command.market) return "缺少目标国家，请明确国家后重试。";
        const draft = {
          schemaVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
          id: `brief:${input.messageId}`,
          version: 1,
          market: command.market,
          productFamily: command.product,
          buyerTypes: [command.buyerType],
          exclusions: [],
          targetCount: command.count,
          transport: "NONE" as const,
        };
        const validation = validateCampaignBriefDraft(draft);
        const missingFields = validation.missingFields;
        const persisted = this.db.saveCampaignDraft({
          briefKey: `feishu:${input.messageId}`,
          brief: draft,
          status: validation.status,
          parserVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
          createdBy: input.senderId,
        });
        const draftId = this.db.recordEvent("campaign_brief", persisted.briefId, "CAMPAIGN_PLAN_NEEDS_INPUT", input.senderId, {
          schemaVersion: CAMPAIGN_BRIEF_SCHEMA_VERSION,
          status: validation.status,
          draft,
          persisted,
          missingFields: validation.missingFields,
          blockers: validation.blockers,
          externalActionsAuthorized: false,
        });
        return {
          card: {
            schema: "2.0",
            config: { update_multi: true, wide_screen_mode: true },
            header: {
              title: { tag: "plain_text", content: "获客研究草稿" },
              template: "yellow",
            },
            body: {
              elements: [
                {
                  tag: "markdown",
                  content: [
                    `**市场：** ${command.market}`,
                    `**产品：** ${command.product}`,
                    `**目标客户：** ${command.buyerType}`,
                    `**目标数量：** ${command.count} 家待研究公司`,
                    `**草稿记录：** ${draftId}`,
                    "",
                    "点击下方按钮后，系统会复核这份草稿，并只复用已经批准、仍可执行且有当前市场证据的研究模板。研究会真实调用已配置的搜索和网页抓取服务，但不会批准、排队或发送任何客户邮件。",
                    ...(missingFields.length > 0
                      ? [`**将由已批准模板补齐：** ${missingFields.join("、")}`]
                      : []),
                  ].join("\n"),
                },
                ...cardV2Buttons([{
                  text: "按已批准模板开始研究（不发邮件）",
                  type: "primary_filled",
                  value: {
                    intent: "start_research_from_approved_template",
                    briefId: persisted.briefId,
                    versionId: persisted.versionId,
                    briefHash: persisted.briefHash,
                  },
                  confirm: {
                    title: "确认开始获客研究",
                    text: "将创建真实研究任务并使用已批准的研究预算；不会解除外发暂停，也不会发送客户邮件。",
                  },
                }]),
              ],
            },
          },
        };
      }
      case "REVIEW": {
        const leads = this.db.listReviewLeads(command.limit);
        if (leads.length === 0) return "当前没有通过最高质量门槛的待审核客户。";
        return {
          card: {
            schema: "2.0",
            header: { title: { tag: "plain_text", content: "待审核高质量客户" }, template: "green" },
            body: {
              elements: leads.flatMap((lead) => [
                {
                  tag: "markdown",
                  content: `**${lead.company}**\n国家：${lead.country}｜评分：${lead.total_score}｜来源：${lead.source_count}｜联系人：${lead.contact_count}\nID：${lead.id}`,
                },
                ...cardV2Buttons([
                  {
                    text: "生成外联序列",
                    type: "primary",
                    value: { intent: "prepare_sequence", leadId: lead.id },
                  },
                  {
                    text: "拒绝",
                    type: "default",
                    value: { intent: "reject", leadId: lead.id },
                  },
                ]),
                { tag: "hr" },
              ]),
            },
          },
        };
      }
      case "PREPARE_SEQUENCE":
        if (!this.authorizeTextCommand(
          input.senderId,
          "PREPARE_OUTREACH_SEQUENCE",
          ["SALES", "SALES_MANAGER"],
        )) {
          return this.sensitiveOperationDenied();
        }
        if (!command.leadId) return "缺少 lead_id。";
        this.db.enqueueJob("BUILD_EMAIL_SEQUENCE", {
          leadId: command.leadId,
          contactId: command.contactId ?? null,
          replyChatId: input.chatId,
        });
        return `已开始生成可审核的邮件：${command.leadId}`;
      case "APPROVE":
        if (command.leadIds.length === 0) return "批准命令必须包含明确的 lead_id。";
        return "文字批准已禁用。请打开该客户的完整邮件序列审核卡片，并点击“批准完整序列”。";
      case "REJECT":
        if (!this.authorizeTextCommand(
          input.senderId,
          "REJECT_LEAD",
          ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
        )) {
          return this.sensitiveOperationDenied();
        }
        if (command.leadIds.length === 0) return "拒绝命令必须包含明确的 lead_id。";
        for (const leadId of command.leadIds) {
          this.db.markLeadDoNotContact(leadId, input.senderId, command.reason);
        }
        return `已拒绝并停止联系 ${command.leadIds.length} 个客户。`;
      case "HANDOFF":
        if (!this.authorizeTextCommand(
          input.senderId,
          "HANDOFF_LEAD",
          ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
        )) {
          return this.sensitiveOperationDenied();
        }
        if (!command.leadId) return "人工接管命令必须包含明确的 lead_id。";
        this.db.setHumanTakeover(command.leadId, input.senderId, command.reason);
        return `已人工接管 ${command.leadId}，所有自动消息和跟进均已取消。`;
      case "SYNC_CRM": {
        if (!this.authorizeTextCommand(input.senderId, "SYNC_CRM", ["SALES_MANAGER"])) {
          return this.sensitiveOperationDenied();
        }
        const jobId = this.db.enqueueJob(
          "SYNC_BITABLE",
          { replyChatId: input.chatId },
          undefined,
          { dedupeKey: "sync-bitable" },
        );
        return `CRM 同步任务已入队：${jobId}`;
      }
      case "DISPATCH_PLAN": {
        const plan = this.dispatcher.plan(Math.max(10, this.config.EMAIL_DAILY_LIMIT));
        if (plan.length === 0) return "当前没有到期的已批准消息。";
        return textCard(
          "外发计划（不发送）",
          plan
            .map(
              (item) =>
                `**${item.company}**｜${item.channel}｜${item.allowed ? "可发送" : "已阻止"}\n${item.blockers.join("；") || "无阻止项"}`,
            )
            .join("\n\n"),
          "yellow",
        );
      }
      default:
        return "无法识别该命令。发送“帮助”查看可用指令。任何含糊表达都不会被视为发送批准。";
    }
  }

  async handleAction(input: {
    action: unknown;
    senderId: string;
    chatId: string;
    messageId: string;
  }): Promise<string | { card: object }> {
    const action = input.action as {
      intent?: string;
      leadId?: string;
      intakeId?: string;
      contentVersionId?: string;
      opportunityId?: string;
      to?: string;
      wonQuoteId?: string;
      briefId?: string;
      versionId?: string;
      scope?: string;
      briefHash?: string;
      budgetHash?: string;
      reason?: string;
      reviewHash?: string;
      reviewCardId?: string;
      messageVersionId?: string;
      messageId?: string;
      resolution?: string;
      decision?: string;
      failureId?: string;
      specFile?: string;
      specHash?: string;
    };
    if (!action.intent) return "无效操作。";
    if (action.intent === "launch_autonomous_pilot_from_catalog") {
      if (!this.authorizeCardAction(input.senderId, "LAUNCH_AUTONOMOUS_PILOT", ["SALES_MANAGER"])) {
        return this.sensitiveOperationDenied();
      }
      if (!action.specFile || !action.specHash) {
        return "真实发送方案缺少版本指纹，请重新发送“准备真实发送”并使用最新卡片。";
      }
      try {
        const launched = launchAutonomousPilotFromCatalog(this.config, this.db, {
          file: action.specFile,
          fileHash: action.specHash,
          actor: input.senderId,
          replyChatId: input.chatId,
        });
        const capabilityWarnings = autonomousPilotCapabilityWarnings(this.config, launched.entry);
        return [
          `${launched.entry.market} 真实发送实验已创建。`,
          `授权上限：总计 ${launched.entry.totalLimit}、每日 ${launched.entry.dailyLimit}、每小时 ${launched.entry.hourlyLimit} 封首封邮件。`,
          "系统会开始公司研究、官网证据核验、联系人查找和证据化邮件生成；A 类具名联系人仅在独立官方验证通过后才会进入授权。",
          ...capabilityWarnings.map((warning) => `能力提示：${warning}`),
          "本次点击不会立即发送，也不会改动当前全局暂停或每日研究开关。请查看“状态”和“发送计划”；只有通过全部实时门禁且全局未暂停的邮件才可能投递。",
        ].join("\n");
      } catch (error) {
        if (error instanceof AutonomousPilotLaunchBlockedError) {
          return textCard(
            "真实发送实验暂未创建",
            [
              "以下条件尚未完成，本次没有创建 Campaign 发送授权：",
              ...error.blockers.map((blocker) => `- ${blocker}`),
            ].join("\n"),
            "yellow",
          );
        }
        if (error instanceof AutonomousPilotCatalogError) {
          return `真实发送实验未创建：${error.message}`;
        }
        return `真实发送实验未创建，系统仍保持暂停：${String(error)}`;
      }
    }
    if (action.intent === "start_research_from_approved_template") {
      if (!this.authorizeCardAction(input.senderId, "START_APPROVED_RESEARCH", ["SALES_MANAGER"])) {
        return this.sensitiveOperationDenied();
      }
      if (!action.briefId || !action.versionId || !action.briefHash) {
        return "研究草稿的版本信息不完整，请重新发送找客指令。";
      }
      try {
        const result = launchManualResearchFromApprovedTemplate(this.db, {
          briefId: action.briefId,
          versionId: action.versionId,
          briefHash: action.briefHash,
          clickedBy: input.senderId,
          replyChatId: input.chatId,
          maxProviderUnits: this.config.MAX_PAGES_PER_CAMPAIGN,
        });
        return [
          result.reused ? "这项获客研究已经启动，不会重复创建任务。" : "获客研究已正式启动。",
          `研究任务：${result.launch.ids.jobId}`,
          `研究模板：${result.playId}`,
          "系统会继续完成公司发现、官网证据、联系人查找和验证，并把进度写入实时运营看板。",
          "客户邮件外发仍保持暂停；本次操作没有创建发送授权，也没有排队或发送邮件。",
        ].join("\n");
      } catch (error) {
        if (error instanceof ManualResearchLaunchError) {
          if (error.blocker === "STALE_DRAFT") {
            return "这张卡对应的研究草稿已经变化。请重新发送找客指令，使用新卡开始研究。";
          }
          if (error.blocker === "INCOMPLETE_DRAFT") {
            return "研究草稿缺少市场、产品、客户类型或目标数量，请在找客指令中补充后重试。";
          }
          if (error.blocker === "NO_APPROVED_TEMPLATE") {
            return "当前没有与该市场和产品匹配的可执行研究模板。需要先准备：已批准的最新 play、仍在有效期内且经人工审核的市场证据，以及大于 0 的研究配额；系统不会偷偷套用其他市场的模板。";
          }
          if (error.blocker === "TEMPLATE_CHANGED") {
            return "研究模板在点击后发生变化，本次没有创建任务。请刷新模板状态后重新开始。";
          }
        }
        return `研究任务未启动，系统没有调用外发：${String(error)}`;
      }
    }
    if (action.intent === "replay_quarantined_imap_message") {
      if (!this.authorizeCardAction(
        input.senderId,
        "REPLAY_QUARANTINED_IMAP_MESSAGE",
        ["INBOUND_REVIEW", "SALES_MANAGER"],
      )) {
        return this.sensitiveOperationDenied();
      }
      if (!action.failureId) return "隔离邮件记录缺少编号，不能重新处理。";
      const currentUidValidity = this.db.getSetting("imap_uid_validity");
      if (!currentUidValidity) {
        return "收件箱当前尚未建立有效连接，无法核对邮件定位。系统保持外发暂停，请先恢复 IMAP 连接。";
      }
      try {
        const result = this.db.requestImapMessageReplay(
          action.failureId,
          input.senderId,
          currentUidValidity,
        );
        if (!result.requested) return result.reason;
        return [
          "这封隔离邮件已加入重新处理队列，收件监听会在下一轮重新读取。",
          "收件游标没有回退，外发仍保持暂停；处理成功后隔离状态会自动更新。",
        ].join("\n");
      } catch (error) {
        return `重新处理请求失败，收件游标和外发状态均未改变：${String(error)}`;
      }
    }
    if (action.intent === "review_grounded_message") {
      const roles = this.authorizeCardAction(
        input.senderId,
        "REVIEW_GROUNDED_MESSAGE",
        ["MESSAGE_REVIEWER"],
      );
      if (!roles) return this.sensitiveOperationDenied();
      if (!action.reviewCardId || !action.messageVersionId || !action.reviewHash || !action.decision) {
        return "邮件内容审核材料不完整，请打开最新审核卡重试。";
      }
      if (!new Set<GroundedMessageReviewDecision>(["APPROVE_CONTENT", "NEEDS_REWRITE"])
        .has(action.decision as GroundedMessageReviewDecision)) {
        return "不支持该邮件内容审核决定。";
      }
      const decision = action.decision as GroundedMessageReviewDecision;
      try {
        const result = this.db.reviewGroundedMessage({
          reviewCardId: action.reviewCardId,
          messageVersionId: action.messageVersionId,
          reviewHash: action.reviewHash,
          decision,
          actionId: `feishu:${input.messageId}:message-review:${decision}`,
          reason: action.reason ?? "reviewed from exact grounded-message Feishu card",
        }, {
          actor: input.senderId,
          actorType: "HUMAN",
          roles,
        });
        return result.created
          ? `邮件内容审核结果已记录为 ${result.derivedStatus}。该操作仍未授权客户外发。`
          : `这份邮件内容已经记录为 ${result.derivedStatus}，不重复处理。该操作仍未授权客户外发。`;
      } catch (error) {
        return `邮件内容审核失败：${String(error)}`;
      }
    }
    if (action.intent === "approve_campaign_scope") {
      if (!action.briefId || !action.versionId || !action.scope || !action.briefHash) {
        return "获客任务方案的审核材料不完整，请打开最新审核卡重试。";
      }
      if (!new Set(["SHADOW_PLAN", "PROVIDER_BUDGET"]).has(action.scope)) {
        return "本卡不能授权客户外发或内容发布。";
      }
      const requiredRoles: readonly WorkflowRole[] = action.scope === "SHADOW_PLAN"
        ? ["CAMPAIGN_APPROVER", "SALES_MANAGER"]
        : ["BUDGET_APPROVER", "SALES_MANAGER"];
      const roles = this.authorizeCardAction(
        input.senderId,
        action.scope === "SHADOW_PLAN" ? "APPROVE_CAMPAIGN_SHADOW_PLAN" : "APPROVE_PROVIDER_BUDGET",
        requiredRoles,
      );
      if (!roles) return this.sensitiveOperationDenied();
      const current = this.db.getCurrentCampaignBrief(action.briefId);
      if (!current || current.current_version_id !== action.versionId || current.brief_hash !== action.briefHash) {
        return "获客任务方案在本卡生成后已经变化，请使用最新审核卡。";
      }
      const scope = action.scope as "SHADOW_PLAN" | "PROVIDER_BUDGET";
      try {
        const result = this.db.saveCampaignScopedApproval({
          briefId: action.briefId,
          versionId: action.versionId,
          scope,
          actionId: `feishu:${input.messageId}:${scope}`,
          authorizationSource: "EXPLICIT_FEISHU_ACTION",
          budgetHash: scope === "PROVIDER_BUDGET" ? action.budgetHash ?? null : null,
          reason: "approved from signed Feishu Campaign Brief card",
        }, {
          actor: input.senderId,
          actorType: "HUMAN",
          roles,
        });
        return result.created
          ? `${scope} 已批准并绑定到当前方案版本。本次没有执行客户外发。`
          : `当前方案版本的 ${scope} 已经批准，不重复处理。`;
      } catch (error) {
        return `获客任务方案审批失败：${String(error)}`;
      }
    }
    if (action.intent === "activate_gmail_pilot") {
      if (!this.authorizeCardAction(input.senderId, "ACTIVATE_GMAIL_PILOT", ["SALES_MANAGER"])) {
        return this.sensitiveOperationDenied();
      }
      try {
        const state = activateGmailPilot(this.config, this.db, input.senderId);
        return `Gmail 真实试发已启用。服务器仍只会发送通过最高质量门槛并由你明确批准的首封邮件。启用时间：${state.activatedAt ?? ""}`;
      } catch (error) {
        return `启用失败，系统仍保持暂停。${String(error)}`;
      }
    }
    if (action.intent === "accept_inbound_quarantine") {
      const roles = this.authorizeCardAction(
        input.senderId,
        "ACCEPT_INBOUND_QUARANTINE",
        ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
      );
      if (!roles) return this.sensitiveOperationDenied();
      if (!action.intakeId) return "入站隔离记录 ID 缺失。";
      try {
        const result = this.db.acceptQuarantinedInquiry(
          action.intakeId,
          { metadata: { acceptedFrom: "feishu_quarantine_card" } },
          { actor: input.senderId, actorType: "HUMAN", roles },
          "accepted from signed Feishu quarantine card",
        );
        return result.changed
          ? `已接受入站记录 ${action.intakeId}，创建待核验 prospect ${result.prospectId}。系统不会自动回复或将其设为可发送。`
          : `入站记录 ${action.intakeId} 已处理，未重复创建 prospect。`;
      } catch (error) {
        return `入站接受失败：${String(error)}`;
      }
    }
    if (action.intent === "reject_inbound_quarantine") {
      const roles = this.authorizeCardAction(
        input.senderId,
        "REJECT_INBOUND_QUARANTINE",
        ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
      );
      if (!roles) return this.sensitiveOperationDenied();
      if (!action.intakeId) return "入站隔离记录 ID 缺失。";
      try {
        const result = this.db.rejectQuarantinedInquiry(
          action.intakeId,
          { actor: input.senderId, actorType: "HUMAN", roles },
          "rejected from signed Feishu quarantine card",
        );
        return result.changed
          ? `已拒绝入站记录 ${action.intakeId}，原始审计记录保留。`
          : `入站记录 ${action.intakeId} 已拒绝，未重复处理。`;
      } catch (error) {
        return `入站拒绝失败：${String(error)}`;
      }
    }
    if (action.intent === "reconcile_unknown_delivery") {
      if (!this.authorizeCardAction(input.senderId, "RECONCILE_UNKNOWN_DELIVERY", ["SALES_MANAGER"])) {
        return this.sensitiveOperationDenied();
      }
      if (!action.messageId || !action.resolution) return "投递对账信息不完整，请使用最新告警卡片。";
      const allowed = new Set(["CONFIRMED_SENT", "CONFIRMED_NOT_SENT_REQUEUE"]);
      if (!allowed.has(action.resolution)) return "不支持的投递对账结果。";
      try {
        const result = this.db.resolveUnknownDelivery(
          action.messageId,
          action.resolution as "CONFIRMED_SENT" | "CONFIRMED_NOT_SENT_REQUEUE",
          input.senderId,
        );
        if (!result.changed) {
          return `邮件 ${action.messageId} 已完成处理，当前状态：${result.status}。`;
        }
        return action.resolution === "CONFIRMED_SENT"
          ? `已确认邮件 ${action.messageId} 已发送。全局外发仍保持暂停，请核对其他待对账记录后再恢复。`
          : `已确认邮件 ${action.messageId} 未发送并重新排队。全局外发仍保持暂停，恢复系统后才会再次发送。`;
      } catch (error) {
        return `投递对账失败：${String(error)}`;
      }
    }
    if (action.intent === "transition_content_version") {
      if (!action.contentVersionId || !action.to) return "内容版本或目标状态缺失。";
      const allowed = new Set<ContentVersionStatus>([
        "TECHNICAL_REVIEW",
        "LOCALIZATION_REVIEW",
        "APPROVED",
      ]);
      if (!allowed.has(action.to as ContentVersionStatus)) return "该卡不允许发布或设置此内容状态。";
      const to = action.to as ContentVersionStatus;
      const requiredRoles: readonly WorkflowRole[] = to === "LOCALIZATION_REVIEW"
        ? ["ENGINEERING", "COMPLIANCE"]
        : to === "APPROVED"
          ? ["LOCALIZATION", "CONTENT_REVIEW"]
          : ["CONTENT_REVIEW"];
      const roles = this.authorizeCardAction(
        input.senderId,
        `TRANSITION_CONTENT_TO_${to}`,
        requiredRoles,
      );
      if (!roles) return this.sensitiveOperationDenied();
      try {
        const result = this.db.transitionContentVersion(
          action.contentVersionId,
          to,
          { actor: input.senderId, actorType: "HUMAN", roles },
          action.reason ?? "reviewed from signed Feishu content card",
        );
        return result.changed
          ? `内容版本 ${action.contentVersionId} 已更新为 ${result.status}。该状态不代表网站已发布。`
          : `内容版本 ${action.contentVersionId} 已是 ${result.status}。`;
      } catch (error) {
        return `内容状态更新失败：${String(error)}`;
      }
    }
    if (action.intent === "update_opportunity_stage") {
      if (!action.opportunityId || !action.to) return "商机或目标阶段缺失。";
      const allowed = new Set<OpportunityStage>([
        "TECHNICAL_DISCOVERY",
        "QUOTED",
        "NEGOTIATION",
        "WON",
        "LOST",
      ]);
      if (!allowed.has(action.to as OpportunityStage)) return "该卡不允许设置此商机阶段。";
      const to = action.to as OpportunityStage;
      const requiredRoles: readonly WorkflowRole[] = to === "WON"
        ? ["SALES_MANAGER"]
        : ["SALES", "SALES_MANAGER"];
      const roles = this.authorizeCardAction(
        input.senderId,
        `UPDATE_OPPORTUNITY_TO_${to}`,
        requiredRoles,
      );
      if (!roles) return this.sensitiveOperationDenied();
      try {
        const result = this.db.transitionOpportunityStage(
          action.opportunityId,
          to,
          { actor: input.senderId, actorType: "HUMAN", roles },
          action.reason ?? "updated from signed Feishu opportunity card",
          { wonQuoteId: action.wonQuoteId ?? null, lostReason: action.reason ?? null },
        );
        return result.changed
          ? `商机 ${action.opportunityId} 已更新为 ${result.stage}。`
          : `商机 ${action.opportunityId} 已是 ${result.stage}。`;
      } catch (error) {
        return `商机阶段更新失败：${String(error)}`;
      }
    }
    if (!action.leadId) return "无效操作。";
    if (action.intent === "prepare_sequence") {
      if (!this.authorizeCardAction(
        input.senderId,
        "PREPARE_OUTREACH_SEQUENCE",
        ["SALES", "SALES_MANAGER"],
      )) {
        return this.sensitiveOperationDenied();
      }
      this.db.enqueueJob("BUILD_EMAIL_SEQUENCE", {
        leadId: action.leadId,
        replyChatId: input.chatId,
      });
      return `正在生成邮件序列：${action.leadId}`;
    }
    if (action.intent === "approve") {
      if (!this.authorizeCardAction(input.senderId, "APPROVE_OUTREACH_SEQUENCE", ["SALES_MANAGER"])) {
        return this.sensitiveOperationDenied();
      }
      if (!action.reviewHash) return "审核卡片缺少内容校验值，请重新生成邮件序列审核卡片。";
      this.db.approveLeadSequence(action.leadId, input.senderId, action.reviewHash);
      return `已批准：${action.leadId}`;
    }
    if (action.intent === "reject") {
      if (!this.authorizeCardAction(
        input.senderId,
        "REJECT_LEAD",
        ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
      )) {
        return this.sensitiveOperationDenied();
      }
      this.db.markLeadDoNotContact(action.leadId, input.senderId, "rejected from Feishu card");
      return `已拒绝并停止联系：${action.leadId}`;
    }
    if (action.intent === "handoff") {
      if (!this.authorizeCardAction(
        input.senderId,
        "HANDOFF_LEAD",
        ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
      )) {
        return this.sensitiveOperationDenied();
      }
      this.db.setHumanTakeover(action.leadId, input.senderId, "acknowledged from inquiry card");
      return `人工接管已确认：${action.leadId}`;
    }
    if (action.intent === "mark_false_positive") {
      if (!this.authorizeCardAction(
        input.senderId,
        "MARK_INQUIRY_FALSE_POSITIVE",
        ["INBOUND_REVIEW", "SALES", "SALES_MANAGER"],
      )) {
        return this.sensitiveOperationDenied();
      }
      this.db.recordEvent("lead", action.leadId, "INQUIRY_FALSE_POSITIVE", input.senderId, {});
      return `已记录误报，但为安全起见仍保持暂停：${action.leadId}`;
    }
    return "不支持的操作。";
  }
}
