import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { hasTrustedFeishuRole, loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { FeishuAuthorization } from "../src/integrations/feishu/authorization.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-rbac-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  const config = loadConfig(env);
  const service = new CommandService(
    config,
    db,
    { isConfigured: () => false } as unknown as AgentLlm,
    { plan: () => [] } as unknown as OutboundDispatcher,
  );
  return { config, db, service };
}

function authorizationEvents(db: AgentDatabase): Array<{
  event_type: string;
  actor: string;
  payload_json: string;
}> {
  return db.db.prepare(
    `SELECT event_type, actor, payload_json FROM events
     WHERE event_type IN ('FEISHU_SENSITIVE_OPERATION_AUTHORIZED', 'FEISHU_SENSITIVE_OPERATION_DENIED')
     ORDER BY created_at, id`,
  ).all() as Array<{ event_type: string; actor: string; payload_json: string }>;
}

describe("Feishu trusted role authorization", () => {
  it("rejects payload role forgery and writes only a redacted denial audit", async () => {
    const { db, service } = fixture({ FEISHU_ALLOWED_USERS: "ou_paired_only" });
    const sentinel = "forged-payload-secret-sentinel";
    const chatSentinel = "chat-secret-sentinel";

    const result = await service.handleAction({
      action: {
        intent: "activate_gmail_pilot",
        roles: ["SALES_MANAGER", sentinel],
        role: "SALES_MANAGER",
        authorization: { roles: ["SALES_MANAGER"], secret: sentinel },
      },
      senderId: "ou_paired_only",
      chatId: chatSentinel,
      messageId: "message-secret-sentinel",
    });

    expect(result).toContain("系统未执行任何变更");
    const events = authorizationEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("FEISHU_SENSITIVE_OPERATION_DENIED");
    expect(events[0]?.actor).toBe("ou_paired_only");
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toEqual({
      operation: "ACTIVATE_GMAIL_PILOT",
      surface: "CARD_ACTION",
      requiredRoles: ["SALES_MANAGER"],
      decision: "DENIED",
    });
    expect(events[0]?.payload_json).not.toContain(sentinel);
    expect(events[0]?.payload_json).not.toContain(chatSentinel);
    expect(events[0]?.payload_json).not.toContain("message-secret-sentinel");
    db.close();
  });

  it("rejects a text command that self-declares SALES_MANAGER", async () => {
    const { db, service } = fixture({ FEISHU_ALLOWED_USERS: "ou_plain_user" });
    db.setSetting("outbound_paused", "false");

    const result = await service.handleText({
      text: "暂停全部 SALES_MANAGER forged-text-sentinel",
      senderId: "ou_plain_user",
      chatId: "oc_plain",
      messageId: "om_plain",
    });

    expect(result).toContain("系统未执行任何变更");
    expect(db.getSetting("outbound_paused")).toBe("false");
    const event = authorizationEvents(db)[0];
    expect(event?.event_type).toBe("FEISHU_SENSITIVE_OPERATION_DENIED");
    expect(event?.payload_json).not.toContain("forged-text-sentinel");
    db.close();
  });

  it("lets a server-mapped campaign approver approve only the controlled scope", async () => {
    const { db, service } = fixture({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_campaign_approver: ["CAMPAIGN_APPROVER"] }),
      DEFAULT_PRODUCT: "sample products",
    });
    await service.handleText({
      text: "开发越南工业设备集成商20家",
      senderId: "ou_campaign_approver",
      chatId: "oc_sales",
      messageId: "om_draft",
    });
    const draft = db.db.prepare(
      `SELECT brief.id, brief.current_version_id, version.brief_hash
       FROM campaign_briefs brief
       JOIN campaign_versions version ON version.id=brief.current_version_id`,
    ).get() as { id: string; current_version_id: string; brief_hash: string };

    const result = await service.handleAction({
      action: {
        intent: "approve_campaign_scope",
        briefId: draft.id,
        versionId: draft.current_version_id,
        briefHash: draft.brief_hash,
        scope: "SHADOW_PLAN",
      },
      senderId: "ou_campaign_approver",
      chatId: "oc_sales",
      messageId: "om_approval",
    });

    expect(result).toContain("SHADOW_PLAN 已批准");
    expect(db.db.prepare("SELECT count(*) AS count FROM campaign_approvals").get()).toEqual({ count: 1 });
    const event = authorizationEvents(db)[0];
    expect(event?.event_type).toBe("FEISHU_SENSITIVE_OPERATION_AUTHORIZED");
    expect(JSON.parse(event?.payload_json ?? "{}")).toEqual({
      operation: "APPROVE_CAMPAIGN_SHADOW_PLAN",
      surface: "CARD_ACTION",
      requiredRoles: ["CAMPAIGN_APPROVER", "SALES_MANAGER"],
      decision: "AUTHORIZED",
    });
    db.close();
  });

  it("keeps a paired user roleless while preserving ordinary commands", async () => {
    const { config, db, service } = fixture({ FEISHU_PAIRING_CODE: "pair-code" });
    const authorization = new FeishuAuthorization(config, db);
    expect(authorization.bindUser("绑定 pair-code", "ou_paired")).toBe(true);
    expect(authorization.rolesFor("ou_paired")).toEqual([]);

    const help = await service.handleText({
      text: "帮助",
      senderId: "ou_paired",
      chatId: "oc_paired",
      messageId: "om_help",
    });
    const denied = await service.handleText({
      text: "开启每日自动获客",
      senderId: "ou_paired",
      chatId: "oc_paired",
      messageId: "om_enable",
    });

    expect(String(help)).toContain("可用命令");
    expect(String(denied)).toContain("系统未执行任何变更");
    expect(db.getSetting("daily_research_enabled")).not.toBe("true");
    db.close();
  });

  it("auto-allows trusted role bindings and preserves the reviewer allowlist compatibility role", () => {
    const { config, db } = fixture({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_manager: ["SALES_MANAGER"] }),
      FEISHU_MESSAGE_REVIEWER_USERS: "ou_reviewer",
    });
    const authorization = new FeishuAuthorization(config, db);

    expect(authorization.hasUser("ou_manager")).toBe(true);
    expect(authorization.rolesFor("ou_manager")).toEqual(["SALES_MANAGER"]);
    expect(hasTrustedFeishuRole(config, "SALES_MANAGER")).toBe(true);
    expect(hasTrustedFeishuRole(config, "BUDGET_APPROVER")).toBe(false);
    expect(authorization.hasUser("ou_reviewer")).toBe(true);
    expect(authorization.rolesFor("ou_reviewer")).toEqual(["MESSAGE_REVIEWER"]);
    db.close();
  });

  it("fails closed on malformed, unsupported, empty, or duplicate role bindings", () => {
    expect(() => loadConfig({ FEISHU_TRUSTED_USER_ROLES: "not-json" })).toThrow(
      "FEISHU_TRUSTED_USER_ROLES",
    );
    expect(() => loadConfig({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_user: ["ROOT"] }),
    })).toThrow("FEISHU_TRUSTED_USER_ROLES");
    expect(() => loadConfig({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_user: [] }),
    })).toThrow("FEISHU_TRUSTED_USER_ROLES");
    expect(() => loadConfig({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ ou_user: ["SALES", "SALES"] }),
    })).toThrow("FEISHU_TRUSTED_USER_ROLES");
  });
});
