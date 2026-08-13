import type { AgentConfig } from "../config.js";
import type { AgentLlm } from "../llm.js";

export type AgentCommand =
  | { intent: "HELP" }
  | { intent: "STATUS" }
  | { intent: "OPERATIONS" }
  | { intent: "PAUSE"; reason: string }
  | { intent: "RESUME" }
  | { intent: "TEST_EMAIL" }
  | { intent: "TEST_GMAIL" }
  | { intent: "ACTIVATE_GMAIL_PILOT" }
  | { intent: "ENABLE_DAILY_RESEARCH" }
  | { intent: "DISABLE_DAILY_RESEARCH" }
  | { intent: "SEND_PILOTS" }
  | { intent: "FUNNEL"; period: "TODAY" | "ALL" }
  | { intent: "REVIEW"; limit: number }
  | { intent: "FIND"; market: string; product: string; buyerType: string; count: number }
  | { intent: "PREPARE_SEQUENCE"; leadId: string; contactId?: string }
  | { intent: "APPROVE"; leadIds: string[] }
  | { intent: "REJECT"; leadIds: string[]; reason: string }
  | { intent: "HANDOFF"; leadId: string; reason: string }
  | { intent: "SYNC_CRM" }
  | { intent: "DISPATCH_PLAN" }
  | { intent: "UNKNOWN"; text: string };

const knownMarkets = [
  "越南",
  "马来西亚",
  "菲律宾",
  "印度尼西亚",
  "印尼",
  "墨西哥",
  "Vietnam",
  "Malaysia",
  "Philippines",
  "Indonesia",
  "Mexico",
];

const marketMap: Record<string, string> = {
  越南: "Vietnam",
  马来西亚: "Malaysia",
  菲律宾: "Philippines",
  印度尼西亚: "Indonesia",
  印尼: "Indonesia",
  墨西哥: "Mexico",
};

function ids(text: string): string[] {
  return [...new Set(text.match(/lead_[0-9a-f-]{20,}/gi) ?? [])];
}

function inferBuyerType(text: string, config: AgentConfig): string {
  if (/集成商|integrator/i.test(text)) return "system integrator";
  if (/经销商|分销商|distributor/i.test(text)) return "industrial distributor";
  if (/工程公司|contractor|engineering/i.test(text)) return "engineering company";
  if (/工厂|manufacturer|plant/i.test(text)) return "industrial manufacturer";
  return config.DEFAULT_BUYER_TYPE;
}

function isExplicitReadinessQuestion(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^\//, "")
    .replace(/[\s?？!！。,.，:：]/g, "")
    .toLowerCase();
  if (new Set([
    "status",
    "状态",
    "运行状态",
    "获客就绪",
    "获客就绪状态",
    "能不能用了",
    "能用了吗",
    "可以用了吗",
    "现在能用吗",
    "现在可以用吗",
    "现在能发吗",
    "现在可以发吗",
    "能发邮件了吗",
    "可以发邮件了吗",
    "可以开始获客了吗",
    "现在可以开始获客吗",
    "能开始获客了吗",
    "现在能开始获客吗",
    "ready",
    "readiness",
    "canisendnow",
  ]).has(normalized)) return true;
  return /^(这个|当前|现在)?(agent|智能体|系统)(现在)?(能不能用(了)?|能用了吗|可以用了吗|是否可用)$/.test(normalized);
}

function explicitCommand(text: string, config: AgentConfig): AgentCommand | null {
  const trimmed = text.trim();
  if (/^\/?(help|帮助|怎么用)$/i.test(trimmed)) return { intent: "HELP" };
  if (isExplicitReadinessQuestion(trimmed)) return { intent: "STATUS" };
  if (/^(实时|当前|今日|今天)?\s*(运营|数据|监控|监测|看板|收发)(状态|数据|看板|报告|情况)?$|^(operations?|ops)( dashboard| status)?$/i.test(trimmed)) {
    return { intent: "OPERATIONS" };
  }
  if (/^(今日|今天|当日).*(漏斗|funnel)|^(漏斗|funnel).*(今日|今天|当日|today)$/i.test(trimmed)) {
    return { intent: "FUNNEL", period: "TODAY" };
  }
  if (/^(漏斗|funnel)(报告|report)?$/i.test(trimmed)) return { intent: "FUNNEL", period: "ALL" };
  if (/暂停全部|急停|pause all/i.test(trimmed)) return { intent: "PAUSE", reason: trimmed };
  if (/^(测试\s*(?:企业)?邮箱|邮箱\s*测试|test\s*email)$/i.test(trimmed)) return { intent: "TEST_EMAIL" };
  if (/^(测试\s*Gmail|Gmail\s*测试|test\s*gmail)$/i.test(trimmed)) return { intent: "TEST_GMAIL" };
  if (/^(开启\s*Gmail\s*试发|启用\s*Gmail\s*试发|activate\s*gmail\s*pilot)$/i.test(trimmed)) {
    return { intent: "ACTIVATE_GMAIL_PILOT" };
  }
  if (/^(开启|启用).*(每日|每天).*(自动获客|客户开发|市场开发)/i.test(trimmed)) {
    return { intent: "ENABLE_DAILY_RESEARCH" };
  }
  if (/^(关闭|停止|暂停).*(每日|每天).*(自动获客|客户开发|市场开发)/i.test(trimmed)) {
    return { intent: "DISABLE_DAILY_RESEARCH" };
  }
  if (/^(准备真实发送|真实发送方案|发送实验|准备发送实验|send pilot)$/i.test(trimmed)) {
    return { intent: "SEND_PILOTS" };
  }
  if (/恢复系统|恢复外联|resume/i.test(trimmed)) return { intent: "RESUME" };
  if (/同步.*(crm|多维表格)|sync crm/i.test(trimmed)) return { intent: "SYNC_CRM" };
  if (/发送计划|dispatch plan/i.test(trimmed)) return { intent: "DISPATCH_PLAN" };
  if (/待审核|审核列表|review/i.test(trimmed)) {
    const limit = Number.parseInt(trimmed.match(/\d+/)?.[0] ?? "10", 10);
    return { intent: "REVIEW", limit: Math.min(Math.max(limit, 1), 20) };
  }
  if (/^批准|^approve/i.test(trimmed)) {
    return { intent: "APPROVE", leadIds: ids(trimmed) };
  }
  if (/^拒绝|^reject/i.test(trimmed)) {
    return { intent: "REJECT", leadIds: ids(trimmed), reason: trimmed };
  }
  if (/人工接管|handoff/i.test(trimmed)) {
    return { intent: "HANDOFF", leadId: ids(trimmed)[0] ?? "", reason: trimmed };
  }
  if (/生成.*开发信|准备.*邮件|prepare sequence/i.test(trimmed)) {
    return { intent: "PREPARE_SEQUENCE", leadId: ids(trimmed)[0] ?? "" };
  }
  if (/开发|寻找|找客户|获客|find leads/i.test(trimmed)) {
    const market = knownMarkets.find((item) => trimmed.toLowerCase().includes(item.toLowerCase()));
    const count = Number.parseInt(trimmed.match(/(\d+)\s*家/)?.[1] ?? "20", 10);
    return {
      intent: "FIND",
      market: marketMap[market ?? ""] ?? market ?? "",
      product: config.DEFAULT_PRODUCT,
      buyerType: inferBuyerType(trimmed, config),
      count: Math.min(Math.max(count, 1), 100),
    };
  }
  return null;
}

export async function parseCommand(
  text: string,
  llm: AgentLlm,
  config: AgentConfig,
): Promise<AgentCommand> {
  const explicit = explicitCommand(text, config);
  if (explicit && explicit.intent !== "FIND") return explicit;
  if (!llm.isConfigured()) return explicit ?? { intent: "UNKNOWN", text };
  try {
    const parsed = await llm.json<AgentCommand>(
      "feishu_command_parse",
      [
        "Parse a Chinese or English command for a B2B lead-generation agent.",
        "Allowed intents: HELP, STATUS, OPERATIONS, FUNNEL, PAUSE, RESUME, TEST_EMAIL, TEST_GMAIL, ACTIVATE_GMAIL_PILOT, ENABLE_DAILY_RESEARCH, DISABLE_DAILY_RESEARCH, SEND_PILOTS, REVIEW, FIND, PREPARE_SEQUENCE, APPROVE, REJECT, HANDOFF, SYNC_CRM, DISPATCH_PLAN, UNKNOWN.",
        "FUNNEL requires period TODAY or ALL.",
        "FIND requires market, product, buyerType, count. Never infer approval or external-send permission.",
        "APPROVE requires explicit lead IDs. Return JSON only.",
      ].join(" "),
      text,
      config.OPENAI_CLASSIFIER_MODEL || config.OPENAI_MODEL,
    );
    return parsed;
  } catch {
    return explicit ?? { intent: "UNKNOWN", text };
  }
}
