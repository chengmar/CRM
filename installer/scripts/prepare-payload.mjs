import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installerDir = path.resolve(scriptDir, "..");
const workspaceDir = path.resolve(installerDir, "..");
const payloadDir = path.join(installerDir, "payload");
const zipPath = path.join(payloadDir, "deployment.zip");
const manifestPath = path.join(payloadDir, "payload-manifest.json");
const stagePath = path.join(payloadDir, "deployment-stage");
const expectedDatabaseSchemaVersion = 18;

function assertUnderInstaller(target) {
  const relative = path.relative(installerDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing payload operation outside installer directory: ${target}`);
  }
}

async function sha256File(target) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(target));
  return hash.digest("hex");
}

async function removeGenerated(target) {
  assertUnderInstaller(target);
  await fs.rm(target, { recursive: true, force: true });
}

await fs.mkdir(payloadDir, { recursive: true });
await removeGenerated(zipPath);
await removeGenerated(manifestPath);
await removeGenerated(stagePath);

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const packageScript = path.join(workspaceDir, "scripts", "package-deployment-bundle.ps1");
const result = spawnSync(
  powershell,
  [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    packageScript,
    "-Workspace",
    workspaceDir,
    "-OutputDir",
    payloadDir,
    "-PackageName",
    "deployment.zip",
  ],
  { cwd: workspaceDir, encoding: "utf8", stdio: "inherit" },
);
await removeGenerated(stagePath);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Deployment package generation failed with exit code ${result.status}.`);

const zip = new AdmZip(zipPath);
const entries = zip.getEntries().map((entry) => entry.entryName.replaceAll("\\", "/"));
const required = [
  ".env.example",
  "deployment-manifest.json",
  "agent_service/package.json",
  "agent_service/src/acquisition/manual-research-launch.ts",
  "agent_service/src/app.ts",
  "agent_service/src/db.ts",
  "agent_service/src/inbound/email-health.ts",
  "agent_service/src/inbound/email-listener.ts",
  "agent_service/src/integrations/feishu/cards.ts",
  "agent_service/src/outreach/dispatcher.ts",
  "infra/support-services.compose.yml",
  "scripts/activate-vps-release.sh",
  "scripts/rollback-vps-release.sh",
  "scripts/bootstrap-vps-production.sh",
  "scripts/install-agent-support-services.sh",
  "scripts/install-agent-service-systemd.sh",
  "scripts/run-vps-activation-acceptance.ps1",
  "scripts/run-fresh-install-acceptance.ps1",
];
const missing = required.filter((entry) => !entries.includes(entry));
if (missing.length > 0) throw new Error(`Base payload is missing required entries: ${missing.join(", ")}`);

const deploymentManifest = JSON.parse(zip.readAsText("deployment-manifest.json").replace(/^\uFEFF/, ""));
if (
  deploymentManifest.manifestSchemaVersion !== 1 ||
  deploymentManifest.databaseSchemaVersion !== expectedDatabaseSchemaVersion ||
  typeof deploymentManifest.productVersion !== "string" ||
  !deploymentManifest.productVersion.trim()
) {
  throw new Error(`Base payload must declare database schema ${expectedDatabaseSchemaVersion}.`);
}
const dbSource = zip.readAsText("agent_service/src/db.ts");
if (!new RegExp(`^export const LATEST_SCHEMA_VERSION = ${expectedDatabaseSchemaVersion};\\s*$`, "m").test(dbSource)) {
  throw new Error(`Base payload database source is not schema ${expectedDatabaseSchemaVersion}.`);
}

const forbidden = entries.filter(
  (entry) =>
    entry === ".env" ||
    /^\.env\.(?!example$)/.test(entry) ||
    entry.startsWith("case_inputs/") ||
    entry.startsWith("real_leadgen_") ||
    entry.startsWith("local_mvp_") ||
    entry.startsWith("workbook_build/") ||
    entry.startsWith("dist/skills-stage/") ||
    entry.startsWith("customer_business_data/") ||
    entry.startsWith("agent_service/data/") ||
    entry.startsWith("agent_service/logs/") ||
    entry.startsWith("backups/") ||
    entry.startsWith("outputs/") ||
    entry === "PRODUCTION_ACCEPTANCE.md" ||
    entry === "NEXT_PRODUCTION_INPUTS.md",
);
if (forbidden.length > 0) {
  throw new Error(`Base payload contains private or generated paths: ${forbidden.slice(0, 10).join(", ")}`);
}

const packageJson = JSON.parse(await fs.readFile(path.join(installerDir, "package.json"), "utf8"));
const manifest = {
  schemaVersion: 1,
  databaseSchemaVersion: expectedDatabaseSchemaVersion,
  productVersion: String(packageJson.version),
  file: path.basename(zipPath),
  sha256: await sha256File(zipPath),
  createdAt: new Date().toISOString(),
};
const tempManifest = `${manifestPath}.tmp`;
await fs.writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.rename(tempManifest, manifestPath);
process.stdout.write(`[OK] Installer payload ready: ${zipPath}\n[OK] SHA-256: ${manifest.sha256}\n`);
