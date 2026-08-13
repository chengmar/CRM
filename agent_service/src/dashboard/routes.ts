import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";
import {
  buildOperationsDashboardSnapshot,
  type DashboardRuntimeState,
} from "./service.js";
import { DashboardMailTranslator } from "./translation.js";

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" ||
    normalized === "::ffff:127.0.0.1";
}

function secureDashboardReply(reply: FastifyReply): void {
  reply
    .header("Cache-Control", "no-store, max-age=0")
    .header("Content-Security-Policy", DASHBOARD_CSP)
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY");
}

async function assertPrivateAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  secureDashboardReply(reply);
  if (!isLoopbackAddress(request.ip)) {
    await reply.code(403).send({ error: "The operations dashboard is available only through a local tunnel." });
  }
}

export async function registerOperationsDashboard(
  app: FastifyInstance,
  config: AgentConfig,
  db: AgentDatabase,
  runtime: DashboardRuntimeState,
  llm?: Pick<AgentLlm, "isConfigured" | "json">,
): Promise<void> {
  if (!config.DASHBOARD_ENABLED) return;

  const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));
  const index = fs.readFileSync(`${publicDirectory}index.html`, "utf8");
  const stylesheet = fs.readFileSync(`${publicDirectory}dashboard.css`, "utf8");
  const script = fs.readFileSync(`${publicDirectory}dashboard.js`, "utf8");
  const preHandler = (request: FastifyRequest, reply: FastifyReply): Promise<void> =>
    assertPrivateAccess(request, reply);
  const translator = new DashboardMailTranslator(config, db, llm);

  app.get("/dashboard", { preHandler }, async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(index));
  app.get("/dashboard/assets/dashboard.css", { preHandler }, async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(stylesheet));
  app.get("/dashboard/assets/dashboard.js", { preHandler }, async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").send(script));

  app.get("/api/dashboard/snapshot", { preHandler }, async (_request, reply) =>
    reply.type("application/json; charset=utf-8").send(
      buildOperationsDashboardSnapshot(config, db, runtime),
    ));

  app.post("/api/dashboard/mail-translation", { preHandler }, async (request, reply) => {
    const body = request.body as { kind?: unknown; messageId?: unknown } | null;
    try {
      const result = await translator.translate(String(body?.kind ?? ""), String(body?.messageId ?? ""));
      return reply.type("application/json; charset=utf-8").send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MAIL_NOT_FOUND") return reply.code(404).send({ error: "没有找到对应邮件" });
      if (code === "TRANSLATION_UNAVAILABLE") return reply.code(503).send({ error: "中文翻译服务暂未配置" });
      return reply.code(502).send({ error: "中文译文生成失败，请稍后重试" });
    }
  });

  app.get("/api/dashboard/stream", { preHandler }, async (request, reply) => {
    if (reply.sent) return;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Content-Security-Policy": DASHBOARD_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });

    const sendSnapshot = (): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        const snapshot = buildOperationsDashboardSnapshot(config, db, runtime);
        reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        reply.raw.write(`event: unavailable\ndata: {"retry":true}\n\n`);
      }
    };
    sendSnapshot();
    const interval = setInterval(sendSnapshot, config.DASHBOARD_REFRESH_SECONDS * 1_000);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.once("close", () => {
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  });
}
