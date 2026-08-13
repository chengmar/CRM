import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { FeishuAuthorization } from "../src/integrations/feishu/authorization.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Feishu authorization", () => {
  it("binds a user and group once and persists both allowlists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-auth-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const auth = new FeishuAuthorization(loadConfig({ FEISHU_PAIRING_CODE: "pair-code" }), db);

    expect(auth.requiresBootstrapPairing()).toBe(true);
    expect(auth.bindUser("绑定 pair-code", "ou_owner")).toBe(true);
    expect(auth.hasUser("ou_owner")).toBe(true);
    expect(auth.bindUser("绑定 pair-code", "ou_other")).toBe(false);
    expect(auth.bindChat("绑定群 pair-code", "ou_owner", "oc_sales")).toBe(true);
    expect(auth.hasChat("oc_sales")).toBe(true);
    expect(auth.bindChat("绑定群 pair-code", "ou_owner", "oc_other")).toBe(false);

    db.close();
  });

  it("merges static allowlists with persisted bindings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-auth-static-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    db.setSetting("feishu_user:ou_persisted", "true");
    const auth = new FeishuAuthorization(loadConfig({ FEISHU_ALLOWED_USERS: "ou_static" }), db);
    expect([...auth.users()].sort()).toEqual(["ou_persisted", "ou_static"]);
    db.close();
  });

  it("recovers when a stale used marker exists without an authorized user", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-auth-recovery-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    db.setSetting("feishu_pairing_used:user", "true");
    const auth = new FeishuAuthorization(loadConfig({ FEISHU_PAIRING_CODE: "pair-code" }), db);

    expect(auth.requiresBootstrapPairing()).toBe(true);
    expect(auth.bindUser("绑定 pair-code", "ou_recovered")).toBe(true);
    expect(auth.hasUser("ou_recovered")).toBe(true);

    db.close();
  });
});
