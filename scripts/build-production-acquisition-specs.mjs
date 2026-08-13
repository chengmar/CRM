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

const planPath = process.argv[2]
  ? insideWorkspace(process.argv[2])
  : path.join(workspace, "config", "production-acquisition-plan-20260721.json");
const plan = readJson(planPath);
if (plan.schemaVersion !== "production-acquisition-plan-v1") {
  throw new Error("Unsupported production acquisition plan schema");
}

const sellerPath = insideWorkspace(path.resolve(path.dirname(planPath), "..", plan.sellerKnowledgePath));
const sellerKnowledge = readJson(sellerPath);
if (sellerKnowledge?.profile?.sender?.email !== plan.senderMailbox) {
  throw new Error("Plan sender mailbox does not match approved seller knowledge");
}

const campaigns = Array.isArray(plan.campaigns) ? plan.campaigns : [];
const targetTotal = campaigns.reduce((sum, campaign) => sum + Number(campaign.targetCount || 0), 0);
if (campaigns.length === 0 || targetTotal !== Number(plan.targetTotal)) {
  throw new Error("Campaign target counts do not match targetTotal");
}

const defaults = plan.campaignDefaults;
const offer = sellerKnowledge.offers?.find((candidate) => candidate.id === defaults.offerId);
if (!offer) throw new Error("Plan offer is missing from approved seller knowledge");

const outputDir = process.argv[3]
  ? insideWorkspace(process.argv[3])
  : path.join(workspace, "config", "production-acquisition-specs-20260721");
fs.mkdirSync(outputDir, { recursive: true });

const manifest = [];
for (const campaign of campaigns) {
  if (!offer.allowedMarkets.includes(campaign.market)) {
    throw new Error(`Offer is not approved for market: ${campaign.market}`);
  }
  const spec = {
    launchKey: campaign.key,
    actionId: `${plan.planId}:${campaign.key}:authorized`,
    campaign: {
      name: campaign.name,
      market: campaign.market,
      product: defaults.productFamily,
      buyerType: campaign.buyerType,
      targetCount: campaign.targetCount,
    },
    brief: {
      schemaVersion: "campaign-brief-v2",
      id: `production-plan:${campaign.key}`,
      version: 1,
      market: campaign.market,
      productFamily: defaults.productFamily,
      buyerTypes: defaults.buyerTypes,
      industries: defaults.industries,
      roleFamilies: defaults.roleFamilies,
      qualificationTracks: defaults.qualificationTracks,
      requiredSignals: defaults.requiredSignals,
      exclusions: defaults.exclusions,
      targetMetric: defaults.targetMetric,
      targetCount: campaign.targetCount,
      providerBudget: plan.providerBudgetPerCampaign,
      llmBudget: plan.llmBudgetPerCampaign,
      offerIds: [defaults.offerId],
      transport: "SMTP",
      deadline: defaults.deadline,
      hypothesis: defaults.hypothesis,
    },
    sellerKnowledge,
    provider: {
      providerKey: "SEARXNG",
      operation: "EVIDENCE_SEARCH",
    },
    authorization: {
      actor: "workspace-owner",
      source: "THREAD_EXPLICIT_AUTHORIZATION",
      reason: "Workspace owner explicitly authorized capped provider use and autonomous external sending for this bounded campaign on 2026-07-21.",
    },
    validFrom: plan.validFrom,
    expiresAt: plan.expiresAt,
    limits: {
      total: campaign.targetCount,
      daily: campaign.targetCount,
      hourly: campaign.hourlyLimit,
    },
    replyChatId: "",
  };
  const file = `${campaign.key}.json`;
  fs.writeFileSync(path.join(outputDir, file), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  manifest.push({ file, market: campaign.market, targetCount: campaign.targetCount });
}

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify({
    schemaVersion: "production-acquisition-spec-manifest-v1",
    planId: plan.planId,
    targetTotal,
    campaigns: manifest,
  }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${JSON.stringify({ outputDir, campaigns: manifest.length, targetTotal })}\n`);
