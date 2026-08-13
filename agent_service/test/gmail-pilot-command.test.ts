import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";
import { ensureGmailPilotState, markGmailPilotSelfTestPassed } from "../src/outreach/gmail-pilot.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-gmail-command-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  db.setSetting("outbound_paused", "true");
  const sender = ["pilot.sender", "gmail.com"].join("@");
  const config = loadConfig({
    AGENT_MODE: "production",
    OUTBOUND_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL_BEFORE_SEND: "true",
    OUTREACH_APPROVAL_REQUIRED: "true",
    CONSUMER_EMAIL_PILOT_ENABLED: "true",
    EMAIL_OUTREACH_ENABLED: "true",
    EMAIL_INBOUND_ENABLED: "true",
    AUTO_FOLLOWUP_ENABLED: "false",
    EMAIL_FROM_ADDRESS: sender,
    SMTP_HOST: "smtp.gmail.com",
    SMTP_USER: sender,
    SMTP_PASSWORD: "test-only",
    IMAP_HOST: "imap.gmail.com",
    IMAP_USER: sender,
    IMAP_PASSWORD: "test-only",
    EMAIL_DAILY_LIMIT: "50",
    EMAIL_HOURLY_LIMIT: "5",
    EMAIL_MIN_INTERVAL_SECONDS: "600",
    FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_tester: ["SALES_MANAGER"] }),
  });
  ensureGmailPilotState(config, db);
  const disabledLlm = { isConfigured: () => false } as unknown as AgentLlm;
  const dispatcher = {
    testGmailPilot: vi.fn(),
    plan: vi.fn(() => []),
  } as unknown as OutboundDispatcher;
  return { config, db, service: new CommandService(config, db, disabledLlm, dispatcher) };
}

const input = {
  senderId: "ou_tester",
  chatId: "oc_test",
  messageId: "om_test",
};

describe("Gmail pilot command gates", () => {
  it("does not let the generic resume command activate a new pilot", async () => {
    const { db, service } = setup();
    const output = await service.handleText({ ...input, text: "恢复系统" });

    expect(String(output)).toContain("不能用“恢复系统”绕过首次授权");
    expect(db.getSetting("outbound_paused")).toBe("true");
    db.close();
  });

  it("requires the confirmation card action after the self-test", async () => {
    const { config, db, service } = setup();
    markGmailPilotSelfTestPassed(config, db, input.senderId, "<self-test@example.com>");

    const card = await service.handleText({ ...input, text: "开启 Gmail 试发" });
    expect(card).toHaveProperty("card");
    expect(JSON.stringify(card)).not.toContain('"tag":"action"');
    expect(JSON.stringify(card)).toContain('"type":"callback"');
    expect(ensureGmailPilotState(config, db).activated).toBe(false);

    const result = await service.handleAction({
      ...input,
      action: { intent: "activate_gmail_pilot" },
    });
    expect(String(result)).toContain("Gmail 真实试发已启用");
    expect(ensureGmailPilotState(config, db).activated).toBe(true);
    expect(db.getSetting("outbound_paused")).toBe("false");
    db.close();
  });
});
