import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";

function settingIds(db: AgentDatabase, prefix: string): string[] {
  return Object.keys(db.listSettings(prefix))
    .map((key) => key.slice(prefix.length))
    .filter(Boolean);
}

export function listFeishuAlertDestinations(
  config: AgentConfig,
  db: AgentDatabase,
): string[] {
  return [...new Set([
    ...config.alertOpenIds,
    ...(config.FEISHU_ALERT_CHAT_ID ? [config.FEISHU_ALERT_CHAT_ID] : []),
    ...settingIds(db, "feishu_alert_user:"),
    ...settingIds(db, "feishu_alert_chat:"),
    ...settingIds(db, "feishu_user:"),
    ...settingIds(db, "feishu_chat:"),
  ])];
}

export function hasFeishuAlertDestination(config: AgentConfig, db: AgentDatabase): boolean {
  return listFeishuAlertDestinations(config, db).length > 0;
}

export function resolveFeishuJobDestination(
  config: AgentConfig,
  db: AgentDatabase,
  requestedDestination: unknown,
): string {
  const requested = String(requestedDestination ?? "").trim();
  if (requested) return requested;

  const fallback = String(config.FEISHU_ALERT_CHAT_ID ?? "").trim();
  if (!fallback) return "";
  return listFeishuAlertDestinations(config, db).includes(fallback) ? fallback : "";
}
