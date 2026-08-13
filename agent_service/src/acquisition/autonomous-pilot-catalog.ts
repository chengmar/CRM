import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import { hasFeishuAlertDestination } from "../integrations/feishu-destinations.js";
import { ensureEmailChannelState } from "../outreach/email-channel.js";
import { isConsumerMailbox } from "../outreach/email-policy.js";
import {
  launchAutonomousPilot,
  parseAutonomousPilotLaunchSpec,
  type AutonomousPilotLaunchResult,
  type AutonomousPilotLaunchSpec,
} from "./autonomous-pilot-launch.js";

const ManifestSchema = z.object({
  schemaVersion: z.literal("production-acquisition-spec-manifest-v1"),
  planId: z.string().trim().min(1).max(160),
  targetTotal: z.number().int().positive().max(100_000),
  campaigns: z.array(z.object({
    file: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/),
    market: z.string().trim().min(1).max(120),
    targetCount: z.number().int().positive().max(100_000),
  }).strict()).min(1).max(100),
}).strict();

export interface AutonomousPilotCatalogEntry {
  file: string;
  fileHash: string;
  launchKey: string;
  name: string;
  market: string;
  product: string;
  buyerType: string;
  senderEmail: string;
  targetCount: number;
  totalLimit: number;
  dailyLimit: number;
  hourlyLimit: number;
  verifier: "hunter" | "bouncer";
  validFrom: string;
  expiresAt: string;
  alreadyLaunched: boolean;
}

export interface AutonomousPilotCatalog {
  planId: string;
  targetTotal: number;
  directory: string;
  entries: AutonomousPilotCatalogEntry[];
}

export class AutonomousPilotCatalogError extends Error {
  constructor(
    readonly code: "CATALOG_MISSING" | "CATALOG_INVALID" | "CATALOG_STALE" | "PILOT_ALREADY_LAUNCHED",
    message: string,
  ) {
    super(message);
    this.name = "AutonomousPilotCatalogError";
  }
}

export class AutonomousPilotLaunchBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join("; "));
    this.name = "AutonomousPilotLaunchBlockedError";
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function catalogDirectory(config: AgentConfig): string {
  return path.resolve(config.businessDataDir, "autonomous_pilot_specs");
}

function assertInside(directory: string, candidate: string): string {
  const relative = path.relative(directory, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AutonomousPilotCatalogError("CATALOG_INVALID", "发送方案文件不在允许的业务资料目录中");
  }
  return candidate;
}

function readCatalogMaterial(
  config: AgentConfig,
): { directory: string; manifest: z.infer<typeof ManifestSchema>; specs: Map<string, { spec: AutonomousPilotLaunchSpec; hash: string }> } {
  const configuredDirectory = catalogDirectory(config);
  if (!fs.existsSync(configuredDirectory)) {
    throw new AutonomousPilotCatalogError("CATALOG_MISSING", "尚未安装经过审核的真实发送方案");
  }
  let directory: string;
  let manifestPath: string;
  try {
    const businessRoot = fs.realpathSync(config.businessDataDir);
    directory = assertInside(businessRoot, fs.realpathSync(configuredDirectory));
    manifestPath = assertInside(directory, fs.realpathSync(path.join(directory, "manifest.json")));
  } catch (error) {
    if (error instanceof AutonomousPilotCatalogError) throw error;
    throw new AutonomousPilotCatalogError("CATALOG_INVALID", `真实发送方案目录或清单无效：${String(error)}`);
  }
  let manifest: z.infer<typeof ManifestSchema>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as unknown);
  } catch (error) {
    throw new AutonomousPilotCatalogError("CATALOG_INVALID", `真实发送方案清单无效：${String(error)}`);
  }
  const files = new Set<string>();
  const specs = new Map<string, { spec: AutonomousPilotLaunchSpec; hash: string }>();
  let targetTotal = 0;
  for (const item of manifest.campaigns) {
    if (files.has(item.file) || item.file === "manifest.json") {
      throw new AutonomousPilotCatalogError("CATALOG_INVALID", "真实发送方案清单包含重复文件");
    }
    files.add(item.file);
    const unresolved = path.join(directory, item.file);
    if (!fs.existsSync(unresolved)) {
      throw new AutonomousPilotCatalogError("CATALOG_INVALID", `真实发送方案文件缺失：${item.file}`);
    }
    const filePath = assertInside(directory, fs.realpathSync(unresolved));
    const raw = fs.readFileSync(filePath);
    let spec: AutonomousPilotLaunchSpec;
    try {
      spec = parseAutonomousPilotLaunchSpec(
        JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")) as unknown,
      );
    } catch (error) {
      throw new AutonomousPilotCatalogError("CATALOG_INVALID", `真实发送方案 ${item.file} 无效：${String(error)}`);
    }
    if (spec.campaign.market !== item.market || spec.campaign.targetCount !== item.targetCount) {
      throw new AutonomousPilotCatalogError("CATALOG_INVALID", `真实发送方案 ${item.file} 与清单不一致`);
    }
    targetTotal += item.targetCount;
    specs.set(item.file, { spec, hash: sha256(raw) });
  }
  if (targetTotal !== manifest.targetTotal) {
    throw new AutonomousPilotCatalogError("CATALOG_INVALID", "真实发送方案总量与清单不一致");
  }
  return { directory, manifest, specs };
}

function selectedVerifier(spec: AutonomousPilotLaunchSpec): "hunter" | "bouncer" {
  const selected = spec.brief.providerBudget.allowedProviders
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider): provider is "hunter" | "bouncer" => provider === "hunter" || provider === "bouncer");
  if (selected.length !== 1) {
    throw new AutonomousPilotCatalogError("CATALOG_INVALID", "真实发送方案必须且只能选择一个官方邮箱验证服务");
  }
  return selected[0]!;
}

export function loadAutonomousPilotCatalog(
  config: AgentConfig,
  db: AgentDatabase,
): AutonomousPilotCatalog {
  const material = readCatalogMaterial(config);
  const entries = material.manifest.campaigns.map((item) => {
    const stored = material.specs.get(item.file)!;
    const spec = stored.spec;
    return {
      file: item.file,
      fileHash: stored.hash,
      launchKey: spec.launchKey,
      name: spec.campaign.name,
      market: spec.campaign.market,
      product: spec.campaign.product,
      buyerType: spec.campaign.buyerType,
      senderEmail: spec.sellerKnowledge.profile.sender.email,
      targetCount: spec.campaign.targetCount,
      totalLimit: spec.limits.total,
      dailyLimit: spec.limits.daily,
      hourlyLimit: spec.limits.hourly,
      verifier: selectedVerifier(spec),
      validFrom: spec.validFrom,
      expiresAt: spec.expiresAt,
      alreadyLaunched: Boolean(db.getSetting(`autonomous_pilot_launch:${spec.launchKey.toLowerCase()}`)),
    } satisfies AutonomousPilotCatalogEntry;
  });
  return {
    planId: material.manifest.planId,
    targetTotal: material.manifest.targetTotal,
    directory: material.directory,
    entries,
  };
}

export function autonomousPilotLaunchBlockers(
  config: AgentConfig,
  db: AgentDatabase,
  entry: AutonomousPilotCatalogEntry,
  now = new Date(),
): string[] {
  const blockers: string[] = [];
  if (config.AGENT_MODE !== "production") blockers.push("Agent 当前不是生产模式");
  if (!config.OUTBOUND_ENABLED) blockers.push("服务器邮件外发能力未开启");
  if (!config.EMAIL_OUTREACH_ENABLED) blockers.push("企业邮箱外联开关未开启");
  if (!config.EMAIL_INBOUND_ENABLED) blockers.push("企业邮箱收件监听未开启");
  if (!config.ACQ_SEARXNG_V2_ENABLED || !config.SEARXNG_BASE_URL) blockers.push("公开搜索服务未就绪");
  if (!config.ACQ_LOCAL_PUBLIC_WEB_ENABLED) blockers.push("官网证据抓取服务未就绪");
  if (!config.EMAIL_DOMAIN_AUTH_VERIFIED) blockers.push("SPF、DKIM、DMARC 尚未完成验收");
  if (!config.COMPANY_POSTAL_ADDRESS) blockers.push("邮件页脚缺少完整企业邮寄地址");
  if (!config.EMAIL_UNSUBSCRIBE_TEXT) blockers.push("邮件退订说明未配置");
  if (config.EMAIL_FROM_ADDRESS.trim().toLowerCase() !== entry.senderEmail.trim().toLowerCase()) {
    blockers.push("服务器当前发件邮箱与本方案批准的发件身份不一致");
  }
  if (isConsumerMailbox(config.EMAIL_FROM_ADDRESS)) blockers.push("正式发送不能使用个人邮箱");
  if (!hasFeishuAlertDestination(config, db)) blockers.push("飞书询盘和异常告警接收人未绑定");
  const emailChannel = ensureEmailChannelState(config, db);
  if (!emailChannel.configured) blockers.push("企业邮箱 SMTP/IMAP 配置不完整");
  else if (!emailChannel.selfTestPassed) blockers.push("企业邮箱自发自收验收尚未通过");
  if (Date.parse(entry.validFrom) > now.getTime()) blockers.push("本方案尚未进入授权有效期");
  if (Date.parse(entry.expiresAt) <= now.getTime()) blockers.push("本方案授权有效期已过，需要生成新版本");
  if (db.listUnknownDeliveryReconciliations(1).length > 0) blockers.push("仍有投递结果不确定的邮件待对账");
  return blockers;
}

export function autonomousPilotCapabilityWarnings(
  config: AgentConfig,
  entry: AutonomousPilotCatalogEntry,
): string[] {
  const verifierReady = entry.verifier === "hunter"
    ? Boolean(config.ACQ_HUNTER_V2_ENABLED && config.HUNTER_API_KEY)
    : Boolean(config.ACQ_BOUNCER_V2_ENABLED && config.BOUNCER_API_KEY);
  if (verifierReady) return [];
  const verifierName = entry.verifier === "hunter" ? "Hunter" : "Bouncer";
  return [
    `${verifierName} 官方邮箱验证器尚未就绪：B 类官网精确公开职能邮箱仍可研究、生成并授权首封邮件；A 类具名联系人将保持阻断。`,
  ];
}

export function launchAutonomousPilotFromCatalog(
  config: AgentConfig,
  db: AgentDatabase,
  input: {
    file: string;
    fileHash: string;
    actor: string;
    replyChatId: string;
    now?: Date;
  },
): { entry: AutonomousPilotCatalogEntry; result: AutonomousPilotLaunchResult } {
  const catalog = loadAutonomousPilotCatalog(config, db);
  const entry = catalog.entries.find((candidate) => candidate.file === input.file);
  if (!entry || entry.fileHash !== input.fileHash) {
    throw new AutonomousPilotCatalogError("CATALOG_STALE", "真实发送方案在审核卡生成后已经变化");
  }
  if (entry.alreadyLaunched) {
    throw new AutonomousPilotCatalogError("PILOT_ALREADY_LAUNCHED", "这项真实发送实验已经创建，不会重复启动");
  }
  const blockers = autonomousPilotLaunchBlockers(config, db, entry, input.now);
  if (blockers.length > 0) throw new AutonomousPilotLaunchBlockedError(blockers);
  const material = readCatalogMaterial(config).specs.get(input.file);
  if (!material || material.hash !== input.fileHash) {
    throw new AutonomousPilotCatalogError("CATALOG_STALE", "真实发送方案在批准前已经变化");
  }
  const actionFingerprint = sha256(`${material.spec.launchKey}\u0000${input.actor}`).slice(0, 40);
  const spec: AutonomousPilotLaunchSpec = {
    ...material.spec,
    actionId: `feishu-pilot:${actionFingerprint}`,
    authorization: {
      actor: input.actor,
      source: "EXPLICIT_FEISHU_ACTION",
      reason: "Approved from the exact signed Feishu autonomous-pilot card",
    },
    replyChatId: input.replyChatId,
  };
  const outboundPausedBefore = db.getSetting("outbound_paused");
  const dailyResearchBefore = db.getSetting("daily_research_enabled");
  const result = launchAutonomousPilot(db, spec);
  const authority = db.db.prepare(
    `SELECT
       (SELECT count(*) FROM campaign_approvals WHERE brief_id=? AND version_id=?) AS approvals,
       (SELECT count(*) FROM campaign_send_authorizations WHERE id=? AND campaign_id=?) AS send_authorizations,
       (SELECT count(*) FROM outbound_messages WHERE campaign_id=?) AS outbound_messages`,
  ).get(
    result.ids.briefId,
    result.ids.versionId,
    result.ids.sendAuthorizationId,
    result.ids.campaignId,
    result.ids.campaignId,
  ) as { approvals: number; send_authorizations: number; outbound_messages: number };
  if (Number(authority.approvals) !== 3 || Number(authority.send_authorizations) !== 1 ||
    Number(authority.outbound_messages) !== 0 || db.getSetting("outbound_paused") !== outboundPausedBefore ||
    db.getSetting("daily_research_enabled") !== dailyResearchBefore) {
    throw new Error("真实发送实验没有保持完整授权、零初始消息和独立运行边界");
  }
  return { entry, result };
}
