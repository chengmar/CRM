import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];
const disabledLlm = { isConfigured: () => false } as unknown as AgentLlm;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("live operations command", () => {
  it("renders current send inventory and operating outcomes without sending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operations-command-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const plan = vi.fn(() => [
      {
        messageId: "message-allowed",
        company: "Acceptance Company",
        channel: "email" as const,
        destination: "private-recipient@example.invalid",
        allowed: true,
        blockers: [],
      },
      {
        messageId: "message-blocked",
        company: "Blocked Company",
        channel: "email" as const,
        destination: "private-blocked@example.invalid",
        allowed: false,
        blockers: ["acceptance blocker"],
      },
    ]);
    const dispatcher = { plan } as unknown as OutboundDispatcher;
    const config = loadConfig({
      EMAIL_DAILY_LIMIT: "10",
      DAILY_OPERATIONS_REPORT_TIMEZONE: "Asia/Shanghai",
    });
    const service = new CommandService(config, db, disabledLlm, dispatcher);

    const output = await service.handleText({
      text: "实时运营",
      senderId: "operator-fixture",
      chatId: "chat-fixture",
      messageId: "message-fixture",
    });
    const rendered = JSON.stringify(output);

    expect(rendered).toContain("实时运营看板");
    expect(rendered).toContain("待发送库存（计划窗口）：2（可发 1，阻断 1，计划上限 10）");
    expect(rendered).toContain("Provider 调用：0");
    expect(rendered).toContain("未知投递待对账：当前 0");
    expect(rendered).toContain("收件监控：NOT_STARTED");
    expect(rendered).not.toContain("private-recipient@example.invalid");
    expect(rendered).not.toContain("private-blocked@example.invalid");
    expect(plan).toHaveBeenCalledWith(10);
    db.close();
  });
});
