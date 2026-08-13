import crypto from "node:crypto";
import type { AgentConfig } from "../../config.js";
import type { AgentDatabase, WorkflowRole } from "../../db.js";

type PairingKind = "user" | "chat";

export class FeishuAuthorization {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
  ) {}

  users(): Set<string> {
    const stored = this.settingIds("feishu_user:");
    return new Set([
      ...this.config.allowedFeishuUsers,
      ...this.config.trustedFeishuUserRoles.keys(),
      ...this.config.messageReviewerFeishuUsers,
      ...stored,
    ]);
  }

  chats(): Set<string> {
    const stored = this.settingIds("feishu_chat:");
    return new Set([...this.config.allowedFeishuChats, ...stored]);
  }

  userCount(): number {
    return this.users().size;
  }

  chatCount(): number {
    return this.chats().size;
  }

  hasUser(userId: string): boolean {
    return this.users().has(userId);
  }

  hasChat(chatId: string): boolean {
    return this.chats().has(chatId);
  }

  rolesFor(userId: string): WorkflowRole[] {
    const roles = new Set<WorkflowRole>(this.config.trustedFeishuUserRoles.get(userId) ?? []);
    if (this.config.messageReviewerFeishuUsers.has(userId)) roles.add("MESSAGE_REVIEWER");
    return [...roles];
  }

  requiresBootstrapPairing(): boolean {
    return this.userCount() === 0 && Boolean(this.config.FEISHU_PAIRING_CODE);
  }

  assertCanStart(): void {
    if (this.userCount() === 0 && !this.config.FEISHU_PAIRING_CODE) {
      throw new Error("Configure FEISHU_ALLOWED_USERS or a one-time FEISHU_PAIRING_CODE");
    }
  }

  bindUser(text: string, userId: string): boolean {
    if (!this.pairingMatches(text, "user")) return false;
    this.db.setSetting(`feishu_user:${userId}`, "true");
    this.db.setSetting(`feishu_alert_user:${userId}`, "true");
    this.db.setSetting("feishu_pairing_used:user", "true");
    return true;
  }

  bindChat(text: string, userId: string, chatId: string): boolean {
    if (!this.hasUser(userId) || !this.pairingMatches(text, "chat")) return false;
    this.db.setSetting(`feishu_chat:${chatId}`, "true");
    this.db.setSetting(`feishu_alert_chat:${chatId}`, "true");
    this.db.setSetting("feishu_pairing_used:chat", "true");
    return true;
  }

  private settingIds(prefix: string): string[] {
    return Object.keys(this.db.listSettings(prefix))
      .map((key) => key.slice(prefix.length))
      .filter(Boolean);
  }

  private pairingMatches(text: string, kind: PairingKind): boolean {
    if (!this.config.FEISHU_PAIRING_CODE) return false;
    if (this.pairingWasConsumedByExistingBinding(kind)) return false;
    const pattern = kind === "user" ? /^绑定\s+(.+)$/ : /^绑定群\s+(.+)$/;
    const supplied = text.trim().match(pattern)?.[1]?.trim() ?? "";
    const expected = this.config.FEISHU_PAIRING_CODE;
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  private pairingWasConsumedByExistingBinding(kind: PairingKind): boolean {
    if (this.db.getSetting(`feishu_pairing_used:${kind}`) !== "true") return false;
    return kind === "user" ? this.userCount() > 0 : this.chatCount() > 0;
  }
}
