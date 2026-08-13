import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDir, "..");

function insideWorkspace(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the workspace: ${candidate}`);
  }
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(insideWorkspace(filePath), "utf8").replace(/^\uFEFF/, ""));
}

const sourceDir = process.argv[2]
  ? insideWorkspace(process.argv[2])
  : path.join(workspace, "config", "production-acquisition-specs-20260721");
const outputDir = process.argv[3]
  ? insideWorkspace(process.argv[3])
  : path.join(workspace, "config", "production-research-specs-20260721");
const runLabel = String(process.argv[4] ?? "").trim().toLowerCase();
if (runLabel && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(runLabel)) {
  throw new Error("Research run label must contain only lowercase letters, digits, and hyphens");
}
const sourceManifest = readJson(path.join(sourceDir, "manifest.json"));
const campaigns = Array.isArray(sourceManifest.campaigns) ? sourceManifest.campaigns : [];
const targetTotal = campaigns.reduce((sum, campaign) => sum + Number(campaign.targetCount || 0), 0);
if (campaigns.length !== 5 || targetTotal !== 500) {
  throw new Error("Expected five approved campaigns with a combined target of 500");
}

fs.mkdirSync(outputDir, { recursive: true });
const manifest = [];
for (const entry of campaigns) {
  const source = readJson(path.join(sourceDir, entry.file));
  if (source.campaign?.market !== entry.market || source.campaign?.targetCount !== entry.targetCount) {
    throw new Error(`Source manifest mismatch: ${entry.file}`);
  }
  const researchLaunchKey = `${source.launchKey}-research${runLabel ? `-${runLabel}` : ""}`;
  const spec = {
    launchKey: researchLaunchKey,
    actionId: `${source.actionId}:research-only`,
    campaign: source.campaign,
    brief: {
      ...source.brief,
      id: `production-research:${researchLaunchKey}`,
      providerBudget: {
        ...source.brief.providerBudget,
        allowedProviders: ["searxng", "local-public-web"],
        maxAmountUsd: 0,
      },
      transport: "NONE",
    },
    authorization: {
      actor: source.authorization.actor,
      source: source.authorization.source,
      reason: "Workspace owner authorized autonomous public-web lead research for this bounded campaign; external sending is not authorized by this research launch.",
    },
    replyChatId: source.replyChatId ?? "",
  };
  fs.writeFileSync(path.join(outputDir, entry.file), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  manifest.push({ file: entry.file, market: entry.market, targetCount: entry.targetCount });
}

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify({
    schemaVersion: "production-research-spec-manifest-v1",
    sourcePlanId: sourceManifest.planId,
    runLabel: runLabel || "base",
    targetTotal,
    campaigns: manifest,
    externalSendAuthorized: false,
  }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${JSON.stringify({ outputDir, campaigns: manifest.length, targetTotal })}\n`);
