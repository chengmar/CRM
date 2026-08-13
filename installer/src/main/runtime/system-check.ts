import fs from "node:fs/promises";
import os from "node:os";

export interface SystemCheckReport {
  platform: NodeJS.Platform;
  release: string;
  architecture: string;
  freeBytes: number;
  supported: boolean;
  blockers: string[];
}

export async function checkOperatorSystem(targetPath: string): Promise<SystemCheckReport> {
  const blockers: string[] = [];
  const release = os.release();
  const architecture = os.arch();
  let freeBytes = 0;
  try {
    const stats = await fs.statfs(targetPath);
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    blockers.push("Unable to determine free disk space for the installer data directory.");
  }

  if (process.platform !== "win32") blockers.push("Commercial installer builds require Windows.");
  if (!new Set(["x64", "arm64"]).has(architecture)) {
    blockers.push(`Unsupported architecture: ${architecture}.`);
  }
  const parts = release.split(".").map((value) => Number.parseInt(value, 10));
  const build = parts[2] ?? 0;
  if (process.platform === "win32" && build < 17763) {
    blockers.push(`Windows build ${build} is unsupported; Windows 10 1809 or newer is required.`);
  }
  if (freeBytes > 0 && freeBytes < 4 * 1024 ** 3) {
    blockers.push("At least 4 GB of free disk space is required.");
  }

  return {
    platform: process.platform,
    release,
    architecture,
    freeBytes,
    supported: blockers.length === 0,
    blockers,
  };
}
