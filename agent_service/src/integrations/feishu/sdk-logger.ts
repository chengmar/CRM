import type { Logger } from "@larksuiteoapi/node-sdk";
import { logger } from "../../logger.js";
import { safeError, safeLogArguments } from "../../safe-error.js";

export function createFeishuSdkLogger(appSecret: string): Logger {
  const secrets = [appSecret];
  return {
    error: (...values: unknown[]) =>
      logger.error({ details: safeLogArguments(values, secrets) }, "Feishu SDK error"),
    warn: (...values: unknown[]) =>
      logger.warn({ details: safeLogArguments(values, secrets) }, "Feishu SDK warning"),
    info: (...values: unknown[]) =>
      logger.info({ details: safeLogArguments(values, secrets) }, "Feishu SDK info"),
    debug: (...values: unknown[]) =>
      logger.debug({ details: safeLogArguments(values, secrets) }, "Feishu SDK debug"),
    trace: (...values: unknown[]) =>
      logger.trace({ details: safeLogArguments(values, secrets) }, "Feishu SDK trace"),
  };
}

export function safeFeishuError(error: unknown, appSecret: string): Record<string, unknown> {
  return safeError(error, [appSecret]);
}
