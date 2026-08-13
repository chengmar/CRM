import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { DispatchPlanItem, OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];
const disabledLlm = { isConfigured: () => false } as unknown as AgentLlm;
const input = {
  text: "获客就绪",
  senderId: "operator-fixture",
  chatId: "chat-fixture",
  messageId: "message-fixture",
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function setup(config: AgentConfig, plan: DispatchPlanItem[], paused: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acquisition-readiness-status-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  db.setSetting("outbound_paused", String(paused));
  const planMock = vi.fn(() => plan);
  const dispatcher = { plan: planMock } as unknown as OutboundDispatcher;
  return {
    db,
    planMock,
    service: new CommandService(config, db, disabledLlm, dispatcher),
  };
}

function safeEmailConfig(overrides: NodeJS.ProcessEnv = {}): AgentConfig {
  return loadConfig({
    AGENT_MODE: "production",
    OUTBOUND_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
    OUTREACH_APPROVAL_REQUIRED: "true",
    EMAIL_OUTREACH_ENABLED: "true",
    EMAIL_INBOUND_ENABLED: "true",
    EMAIL_FROM_ADDRESS: "private-sender@example.invalid",
    EMAIL_UNSUBSCRIBE_TEXT: "Private unsubscribe text",
    COMPANY_POSTAL_ADDRESS: "Private postal address",
    SMTP_HOST: "smtp.example.invalid",
    SMTP_USER: "private-smtp-user",
    SMTP_PASSWORD: "private-smtp-password",
    IMAP_HOST: "imap.example.invalid",
    IMAP_USER: "private-imap-user",
    IMAP_PASSWORD: "private-imap-password",
    SEARCH_PROVIDER: "searxng",
    SEARXNG_BASE_URL: "https://private-search.example.invalid",
    ACQ_SEARXNG_V2_ENABLED: "true",
    SEARXNG_LOCAL_ENDPOINT_ALLOWED: "true",
    ACQ_LOCAL_PUBLIC_WEB_ENABLED: "true",
    ...overrides,
  });
}

describe("Feishu acquisition readiness status", () => {
  it("shows missing official providers and a global pause without exposing private configuration", async () => {
    const privateMailbox = "private-pilot@gmail.com";
    const config = safeEmailConfig({
      CONSUMER_EMAIL_PILOT_ENABLED: "true",
      EMAIL_FROM_ADDRESS: privateMailbox,
      SMTP_USER: privateMailbox,
      IMAP_USER: privateMailbox,
    });
    const { db, planMock, service } = setup(config, [], true);

    const output = await service.handleText(input);
    const rendered = JSON.stringify(output);

    expect(rendered).toContain("研究链路：** B 类链路已就绪");
    expect(rendered).toContain("现在能发：** 不能");
    expect(rendered).toContain("全局外发处于暂停状态");
    expect(rendered).toContain("B 类官网精确公开职能邮箱链路已就绪；A 类具名联系人因官方验证器未就绪而暂停");
    expect(rendered).toContain("无通过全部发送门禁的可发消息");
    expect(rendered).toContain("Gmail pilot 未激活");
    expect(rendered).toContain("Hunter：未就绪");
    expect(rendered).toContain("Bouncer：未就绪");
    expect(rendered).not.toContain(privateMailbox);
    expect(rendered).not.toContain(config.SMTP_PASSWORD);
    expect(rendered).not.toContain(config.COMPANY_POSTAL_ADDRESS);
    expect(planMock).toHaveBeenCalledOnce();
    expect(planMock).toHaveBeenCalledWith(100);
    db.close();
  });

  it("distinguishes enterprise domain authentication and self-test blockers", async () => {
    const { db, service } = setup(safeEmailConfig(), [], true);

    const output = await service.handleText({ ...input, text: "状态" });
    const rendered = JSON.stringify(output);

    expect(rendered).toContain("企业邮箱域名认证（SPF/DKIM/DMARC）未完成");
    expect(rendered).toContain("企业邮箱自发自收验收尚未通过");
    expect(rendered).toContain("飞书敏感操作管理员尚未配置");
    expect(rendered).toContain("飞书敏感操作管理员：** 未配置");
    expect(rendered).not.toContain("private-smtp-password");
    db.close();
  });

  it("uses an allowed dispatcher plan as the authoritative now-send signal", async () => {
    const privateProviderKey = "private-bouncer-key";
    const privateDestination = "private-customer@example.invalid";
    const config = safeEmailConfig({
      ACQ_BOUNCER_V2_ENABLED: "true",
      BOUNCER_API_KEY: privateProviderKey,
    });
    const plan: DispatchPlanItem[] = [{
      messageId: "message-allowed",
      company: "Private Customer",
      channel: "email",
      destination: privateDestination,
      allowed: true,
      blockers: [],
    }];
    const { db, service } = setup(config, plan, false);

    const output = await service.handleText({ ...input, text: "现在能发吗" });
    const rendered = JSON.stringify(output);

    expect(rendered).toContain("研究链路：** 完整就绪");
    expect(rendered).toContain("现在能发：** 可以");
    expect(rendered).toContain("当前调度窗口有 1 条客户消息通过全部发送门禁");
    expect(rendered).toContain("通过全部门禁、可调度：** 1");
    expect(rendered).toContain("Bouncer：就绪");
    expect(rendered).not.toContain(privateProviderKey);
    expect(rendered).not.toContain(privateDestination);
    expect(rendered).not.toContain("Private Customer");
    db.close();
  });
});
