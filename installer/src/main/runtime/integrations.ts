import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { InstallerConfig } from "../../shared/contracts.js";

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected HTTP ${response.status} response.`);
  }
}

export async function verifyAiProvider(config: InstallerConfig, apiKey: string): Promise<void> {
  const base = config.ai.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`AI provider authentication failed with HTTP ${response.status}.`);
  const body = await readJsonResponse(response);
  if (!Array.isArray(body.data)) {
    throw new Error("AI provider did not return an OpenAI-compatible models response.");
  }
}

export async function verifyFeishu(config: InstallerConfig, appSecret: string): Promise<void> {
  const host = config.feishu.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const response = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.feishu.appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readJsonResponse(response);
  if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== "string") {
    throw new Error(`Feishu application authentication failed: ${String(body.msg ?? `HTTP ${response.status}`)}`);
  }
}

export async function verifyEmail(config: InstallerConfig, password: string): Promise<void> {
  const normalizedPassword = config.email.mode === "gmail_pilot"
    ? password.replace(/\s+/g, "")
    : password;
  const transport = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpPort === 465,
    auth: { user: config.email.smtpUser, pass: normalizedPassword },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });
  await transport.verify();
  transport.close();

  const imap = new ImapFlow({
    host: config.email.imapHost,
    port: config.email.imapPort,
    secure: true,
    auth: { user: config.email.imapUser, pass: normalizedPassword },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });
  try {
    await imap.connect();
  } finally {
    if (imap.usable) await imap.logout();
  }
}

export async function verifySearchProvider(config: InstallerConfig, apiKey: string): Promise<void> {
  if (config.search.provider === "searxng") return;
  if (config.search.provider === "serper") {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ q: "B2B supplier", num: 3 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Serper credential check failed with HTTP ${response.status}.`);
    const body = await readJsonResponse(response);
    if (!Array.isArray(body.organic)) throw new Error("Serper returned no usable organic results.");
    return;
  }
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query: "B2B supplier", numResults: 3 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Exa credential check failed with HTTP ${response.status}.`);
  const body = await readJsonResponse(response);
  if (!Array.isArray(body.results)) throw new Error("Exa returned no usable search results.");
}

export async function verifyWhatsApp(config: InstallerConfig, accessToken: string): Promise<void> {
  const version = config.whatsapp.graphApiVersion.replace(/^v?/, "v");
  const url = new URL(`https://graph.facebook.com/${version}/${config.whatsapp.phoneNumberId}`);
  url.searchParams.set("fields", "display_phone_number,verified_name,quality_rating");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body: Record<string, unknown> = await readJsonResponse(response).catch(() => ({}));
    throw new Error(`WhatsApp credential check failed: ${String(body.error ?? `HTTP ${response.status}`)}`);
  }
}
