import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandService } from "../src/commands/service.js";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import type { AgentLlm } from "../src/llm.js";
import type { OutboundDispatcher } from "../src/outreach/dispatcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture(): { db: AgentDatabase; service: CommandService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-replay-command-"));
  tempDirs.push(dir);
  const db = new AgentDatabase(path.join(dir, "agent.db"));
  const service = new CommandService(
    loadConfig({
      FEISHU_TRUSTED_USER_ROLES: JSON.stringify({ operator: ["INBOUND_REVIEW"] }),
    }),
    db,
    { isConfigured: () => false } as unknown as AgentLlm,
    {} as OutboundDispatcher,
  );
  return { db, service };
}

describe("Feishu IMAP quarantine replay action", () => {
  it("requeues the exact current UID without moving the cursor or resuming outbound", async () => {
    const { db, service } = fixture();
    db.setSetting("imap_uid_validity", "777");
    db.setSetting("imap_last_uid", "88");
    db.setSetting("outbound_paused", "true");
    const failure = db.recordImapMessageFailure({
      uidValidity: "777",
      uid: 42,
      maxAttempts: 1,
      sourceSha256: "a".repeat(64),
      sourceSize: 120,
      preview: { subject: "redacted" },
      errorClass: "ParseError",
      errorMessage: "failed",
    });

    const response = await service.handleAction({
      action: { intent: "replay_quarantined_imap_message", failureId: failure.id },
      senderId: "operator",
      chatId: "chat-fixture",
      messageId: "replay-fixture",
    });

    expect(response).toContain("已加入重新处理队列");
    expect(db.getImapMessageFailure("777", 42)).toMatchObject({
      status: "RETRY_PENDING",
      attempts: 0,
    });
    expect(db.getSetting("imap_last_uid")).toBe("88");
    expect(db.getSetting("outbound_paused")).toBe("true");
    db.close();
  });

  it("rejects a stale mailbox identity without changing the quarantine", async () => {
    const { db, service } = fixture();
    db.setSetting("imap_uid_validity", "new");
    const failure = db.recordImapMessageFailure({
      uidValidity: "old",
      uid: 42,
      maxAttempts: 1,
      sourceSha256: "b".repeat(64),
      sourceSize: 120,
      preview: { subject: "redacted" },
      errorClass: "ParseError",
      errorMessage: "failed",
    });

    const response = await service.handleAction({
      action: { intent: "replay_quarantined_imap_message", failureId: failure.id },
      senderId: "operator",
      chatId: "chat-fixture",
      messageId: "replay-stale-fixture",
    });

    expect(response).toContain("UIDVALIDITY 已变化");
    expect(db.getImapMessageFailure("old", 42)).toMatchObject({ status: "QUARANTINED" });
    db.close();
  });
});
