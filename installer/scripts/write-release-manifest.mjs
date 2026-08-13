import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installerDir = path.resolve(scriptDir, "..");
const workspaceDir = path.resolve(installerDir, "..");
const releaseDir = path.join(installerDir, "release");
const packageJson = JSON.parse(await fs.readFile(path.join(installerDir, "package.json"), "utf8"));
const payloadManifest = JSON.parse(await fs.readFile(path.join(installerDir, "payload", "payload-manifest.json"), "utf8"));

async function sha256(target) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(target));
  return hash.digest("hex");
}

const escapedVersion = String(packageJson.version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const artifactPattern = new RegExp(`-${escapedVersion}-(x64|arm64)-(Setup|Portable)\\.exe$`, "i");
const names = (await fs.readdir(releaseDir))
  .filter((name) => artifactPattern.test(name))
  .sort((left, right) => left.localeCompare(right));
const artifacts = [];
for (const name of names) {
  const match = name.match(artifactPattern);
  if (!match) continue;
  const target = path.join(releaseDir, name);
  const stats = await fs.stat(target);
  artifacts.push({
    file: name,
    platform: "windows",
    architecture: match[1].toLowerCase(),
    distribution: match[2].toLowerCase(),
    bytes: stats.size,
    sha256: await sha256(target),
  });
}
if (artifacts.length !== 4) {
  throw new Error(`Expected four Windows artifacts, found ${artifacts.length}.`);
}

const manifest = {
  schemaVersion: 1,
  productName: packageJson.build.productName,
  productVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  payload: {
    productVersion: payloadManifest.productVersion,
    sha256: payloadManifest.sha256,
  },
  artifacts,
  signing: {
    requiredForCommercialRelease: true,
    configuration: "Set CSC_LINK and CSC_KEY_PASSWORD in the Windows build environment.",
  },
};
await fs.writeFile(path.join(releaseDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.writeFile(
  path.join(releaseDir, "SHA256SUMS.txt"),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join("\n")}\n`,
  "utf8",
);
await fs.copyFile(
  path.join(workspaceDir, "WINDOWS_INSTALLER_USER_GUIDE.md"),
  path.join(releaseDir, "WINDOWS_INSTALLER_USER_GUIDE.md"),
);
process.stdout.write(`[OK] Release manifest contains ${artifacts.length} Windows artifacts.\n`);
