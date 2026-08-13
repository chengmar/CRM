import { hasTrustedFeishuRole, type AgentConfig } from "../config.js";
import type { DispatchPlanItem } from "../outreach/dispatcher.js";
import type { EmailChannelState } from "../outreach/email-channel.js";
import type { GmailPilotState } from "../outreach/gmail-pilot.js";

export interface ReadinessProvider {
  name: "SearXNG" | "Local Public Web" | "Hunter" | "Bouncer";
  ready: boolean;
}

export interface AcquisitionReadiness {
  publicResearchReady: boolean;
  tierBOfficialMailboxReady: boolean;
  tierANamedContactReady: boolean;
  researchChainReady: boolean;
  sensitiveOperatorConfigured: boolean;
  canSendNow: boolean;
  allowedMessageCount: number;
  plannedMessageCount: number;
  providers: ReadinessProvider[];
  blockers: string[];
  capabilityWarnings: string[];
}

export function assessAcquisitionReadiness(input: {
  config: AgentConfig;
  outboundPaused: boolean;
  gmailPilot: GmailPilotState;
  emailChannel: EmailChannelState;
  dispatchPlan: DispatchPlanItem[] | null;
}): AcquisitionReadiness {
  const { config, outboundPaused, gmailPilot, emailChannel, dispatchPlan } = input;
  const searxngReady = Boolean(
    config.SEARCH_PROVIDER === "searxng" &&
      config.ACQ_SEARXNG_V2_ENABLED &&
      config.SEARXNG_BASE_URL &&
      config.SEARXNG_LOCAL_ENDPOINT_ALLOWED,
  );
  const localPublicWebReady = config.ACQ_LOCAL_PUBLIC_WEB_ENABLED;
  const hunterReady = Boolean(config.ACQ_HUNTER_V2_ENABLED && config.HUNTER_API_KEY);
  const bouncerReady = Boolean(config.ACQ_BOUNCER_V2_ENABLED && config.BOUNCER_API_KEY);
  const publicResearchReady = searxngReady && localPublicWebReady;
  const tierBOfficialMailboxReady = publicResearchReady;
  const tierANamedContactReady = publicResearchReady && (hunterReady || bouncerReady);
  const researchChainReady = tierBOfficialMailboxReady;
  const sensitiveOperatorConfigured = hasTrustedFeishuRole(config, "SALES_MANAGER");
  const allowedMessageCount = dispatchPlan?.filter((item) => item.allowed).length ?? 0;
  const canSendNow = dispatchPlan !== null && allowedMessageCount > 0;
  const blockers: string[] = [];

  if (!canSendNow) {
    if (dispatchPlan === null) blockers.push("调度器状态检查失败，系统按不可发送处理");
    if (outboundPaused) blockers.push("全局外发处于暂停状态");
    if (!publicResearchReady) blockers.push("严格公开网页研究链路未完整配置");
    if (!sensitiveOperatorConfigured) blockers.push("飞书敏感操作管理员尚未配置");
    if (config.AGENT_MODE !== "production" || !config.OUTBOUND_ENABLED) {
      blockers.push("客户邮件外发能力未开启");
    }
    if (
      !config.EMAIL_OUTREACH_ENABLED ||
      !config.EMAIL_INBOUND_ENABLED ||
      !config.SMTP_HOST ||
      !config.SMTP_USER ||
      !config.SMTP_PASSWORD ||
      !config.IMAP_HOST ||
      !config.IMAP_USER ||
      !config.IMAP_PASSWORD ||
      !config.EMAIL_UNSUBSCRIBE_TEXT ||
      !config.COMPANY_POSTAL_ADDRESS
    ) {
      blockers.push("邮件发送与回复监听配置未完整就绪");
    }
    if (!gmailPilot.mode && !config.EMAIL_DOMAIN_AUTH_VERIFIED) {
      blockers.push("企业邮箱域名认证（SPF/DKIM/DMARC）未完成");
    }
    if (!gmailPilot.mode && emailChannel.configured && !emailChannel.selfTestPassed) {
      blockers.push("企业邮箱自发自收验收尚未通过");
    }
    if (gmailPilot.mode && !gmailPilot.selfTestPassed) blockers.push("Gmail pilot 自测未通过");
    if (gmailPilot.mode && !gmailPilot.activated) blockers.push("Gmail pilot 未激活");
    if (dispatchPlan !== null && allowedMessageCount === 0) {
      blockers.push("无通过全部发送门禁的可发消息");
    }
  }

  const capabilityWarnings = !publicResearchReady
    ? ["公开检索或官网取证未就绪，当前无法形成新的 A 类或 B 类合格联系人"]
    : !tierANamedContactReady
      ? ["B 类官网精确公开职能邮箱链路已就绪；A 类具名联系人因官方验证器未就绪而暂停"]
      : [];

  return {
    publicResearchReady,
    tierBOfficialMailboxReady,
    tierANamedContactReady,
    researchChainReady,
    sensitiveOperatorConfigured,
    canSendNow,
    allowedMessageCount,
    plannedMessageCount: dispatchPlan?.length ?? 0,
    providers: [
      { name: "SearXNG", ready: searxngReady },
      { name: "Local Public Web", ready: localPublicWebReady },
      { name: "Hunter", ready: hunterReady },
      { name: "Bouncer", ready: bouncerReady },
    ],
    blockers: [...new Set(blockers)],
    capabilityWarnings,
  };
}

export function researchReadinessConclusion(readiness: AcquisitionReadiness): string {
  if (readiness.tierANamedContactReady) {
    return "完整就绪。B 类官网职能邮箱可用，A 类具名联系人也可进行独立官方验证。";
  }
  if (readiness.tierBOfficialMailboxReady) {
    return "B 类链路已就绪。官网精确公开职能邮箱可继续；A 类具名联系人等待官方验证器。";
  }
  return "未就绪。严格公开网页研究链路配置不完整。";
}
