import pino from "pino";
import { config } from "./config.js";

const redactedPaths = [
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "request.headers['x-api-key']",
  "headers.authorization",
  "headers['x-api-key']",
  "SMTP_PASSWORD",
  "IMAP_PASSWORD",
  "OPENAI_API_KEY",
  "HUNTER_API_KEY",
  "BOUNCER_API_KEY",
  "config.BOUNCER_API_KEY",
  "metadata.BOUNCER_API_KEY",
  "apiKey",
  "metadata.apiKey",
  "options.apiKey",
  "FEISHU_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
];

export const logger = pino({
  level: config.AGENT_LOG_LEVEL,
  redact: {
    paths: redactedPaths,
    censor: "[REDACTED]",
  },
});
