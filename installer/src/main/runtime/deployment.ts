import crypto from "node:crypto";
import path from "node:path";
import type { InstallerConfig } from "../../shared/contracts.js";
import type { InstallerSecretStore } from "../engine/secrets.js";
import { redactText } from "../engine/redaction.js";
import type { InstallerStepContext } from "../engine/engine.js";
import { buildRemoteEnv } from "./env-builder.js";
import { resolveSshCredentials, shellQuote, SshSession } from "./ssh.js";

interface RemoteJobMetadata {
  id: string;
  runDir: string;
  statusPath: string;
  logPath: string;
  pidPath: string;
  startedAt: string;
  useStagedEnv?: boolean;
  launchAttempts?: number;
  lastLaunchedAt?: string;
}

export interface RemoteDeploymentSession {
  exec(command: string, options?: { timeoutMs?: number; onOutput?: (text: string) => void }): Promise<{ stdout: string; stderr: string; code: number }>;
  uploadFile(localPath: string, remotePath: string, mode?: number): Promise<void>;
  uploadBuffer(remotePath: string, data: Buffer, mode?: number): Promise<void>;
  readRemoteFile(remotePath: string): Promise<string | null>;
  close(): void;
}

export interface DeploymentDependencies {
  connect(config: InstallerConfig, secretStore: InstallerSecretStore): Promise<RemoteDeploymentSession>;
  sleep(milliseconds: number): Promise<void>;
  randomSuffix(): string;
}

class RemoteDeploymentFailedError extends Error {}
class RemoteDeploymentStoppedError extends Error {}

function normalizeAppDir(value: string): string {
  if (!/^(?:~\/|\/)[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error("Remote application directory contains unsupported characters.");
  }
  if (value.startsWith("~/")) return `\${HOME}/${value.slice(2)}`;
  return value;
}

async function connectDefault(config: InstallerConfig, secretStore: InstallerSecretStore): Promise<SshSession> {
  const credentials = await resolveSshCredentials(
    config,
    await secretStore.get("server_password"),
    await secretStore.get("server_private_key"),
  );
  const session = new SshSession();
  await session.connect(config, credentials, config.server.hostFingerprint);
  return session;
}

const defaultDeploymentDependencies: DeploymentDependencies = {
  connect: connectDefault,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomSuffix: () => crypto.randomBytes(4).toString("hex"),
};

function createRemoteRunner(job: RemoteJobMetadata, appDir: string): string {
  const remoteAppDir = normalizeAppDir(appDir);
  const releaseZip = `${job.runDir}/release.zip`;
  const envPath = `${job.runDir}/agent.env`;
  const activate = job.useStagedEnv === false
    ? `if [[ ! -f "${remoteAppDir}/.env" ]]; then
  echo "[FAIL] Existing remote .env disappeared before the upgrade started." >&2
  (exit 19)
else
  APP_DIR="${remoteAppDir}" bash "$STAGE_DIR/scripts/activate-vps-release.sh" "$STAGE_DIR"
fi
`
    : `APP_DIR="${remoteAppDir}" REMOTE_ENV_PATH=${shellQuote(envPath)} bash "$STAGE_DIR/scripts/activate-vps-release.sh" "$STAGE_DIR"`;
  return `#!/usr/bin/env bash
set +e
STATUS_PATH=${shellQuote(job.statusPath)}
write_status() {
  local state="$1"
  local code="$2"
  local tmp="${job.statusPath}.tmp"
  printf '{"state":"%s","exitCode":%s,"updatedAt":"%s"}\n' "$state" "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
  mv -f "$tmp" "$STATUS_PATH"
}
write_status RUNNING 0
STAGE_DIR="$(mktemp -d /tmp/crm-agent-release.XXXXXX)"
cleanup() { rm -rf -- "$STAGE_DIR"; }
trap cleanup EXIT
unzip -q -o ${shellQuote(releaseZip)} -d "$STAGE_DIR"
${activate}
code=$?
if [[ $code -eq 0 ]]; then
  write_status SUCCEEDED 0
else
  write_status FAILED "$code"
fi
exit "$code"
`;
}

async function launchRemoteJob(
  context: InstallerStepContext,
  session: RemoteDeploymentSession,
  job: RemoteJobMetadata,
): Promise<void> {
  const runScript = `${job.runDir}/run.sh`;
  const releaseZip = `${job.runDir}/release.zip`;
  const envPath = `${job.runDir}/agent.env`;
  const stagedEnvRequirement = job.useStagedEnv === false ? "" : `test -f ${shellQuote(envPath)}; `;
  const attempt = (job.launchAttempts ?? 0) + 1;
  const launch = await session.exec(
    `set -eu; ` +
      `test -f ${shellQuote(runScript)}; test -f ${shellQuote(releaseZip)}; ${stagedEnvRequirement}` +
      `rm -f ${shellQuote(job.statusPath)}; ` +
      `printf '\n== deployment attempt ${attempt} at %s ==\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>${shellQuote(job.logPath)}; ` +
      `nohup bash ${shellQuote(runScript)} >>${shellQuote(job.logPath)} 2>&1 </dev/null & pid=$!; ` +
      `printf '%s\n' "$pid" >${shellQuote(job.pidPath)}`,
  );
  if (launch.code !== 0) throw new Error(launch.stderr || "Unable to launch remote deployment job.");
  job.launchAttempts = attempt;
  job.lastLaunchedAt = new Date().toISOString();
  await context.log(`Remote deployment attempt ${attempt} started.`);
}

async function remoteJobAlive(session: RemoteDeploymentSession, job: RemoteJobMetadata): Promise<boolean> {
  const alive = await session.exec(
    `test -f ${shellQuote(job.pidPath)} && kill -0 "$(cat ${shellQuote(job.pidPath)})" 2>/dev/null`,
  );
  return alive.code === 0;
}

function parseRemoteStatus(statusText: string | null): { state: string; exitCode: number } | null {
  if (!statusText) return null;
  const status = JSON.parse(statusText) as { state?: unknown; exitCode?: unknown };
  if (typeof status.state !== "string" || typeof status.exitCode !== "number") {
    throw new Error("Remote deployment status checkpoint is invalid.");
  }
  return { state: status.state, exitCode: status.exitCode };
}

async function ensureRemoteJob(
  context: InstallerStepContext,
  config: InstallerConfig,
  secretStore: InstallerSecretStore,
  packagePath: string,
  dependencies: DeploymentDependencies,
): Promise<RemoteJobMetadata> {
  const existing = context.state.metadata.deploymentJob as RemoteJobMetadata | undefined;
  if (existing?.id && existing.runDir) {
    const session = await dependencies.connect(config, secretStore);
    try {
      const status = parseRemoteStatus(await session.readRemoteFile(existing.statusPath));
      const alive = await remoteJobAlive(session, existing);
      if (status?.state === "SUCCEEDED" || ((status?.state === "RUNNING" || status === null) && alive)) {
        return existing;
      }
      const files = await session.exec(
        `test -f ${shellQuote(`${existing.runDir}/release.zip`)} && ` +
          (existing.useStagedEnv === false ? "" : `test -f ${shellQuote(`${existing.runDir}/agent.env`)} && `) +
          `test -f ${shellQuote(`${existing.runDir}/run.sh`)}`,
      );
      if (files.code === 0) {
        await context.log(
          status?.state === "FAILED"
            ? `Retrying failed remote deployment exit=${status.exitCode}.`
            : "Remote deployment process stopped; restarting from the uploaded checkpoint.",
          "warn",
        );
        await launchRemoteJob(context, session, existing);
        return existing;
      }
      delete context.state.metadata.deploymentJob;
      await context.log("Remote checkpoint files are missing; creating a replacement deployment checkpoint.", "warn");
    } finally {
      session.close();
    }
  }

  const id = `${context.state.installationId}-${dependencies.randomSuffix()}`;
  const runDir = `.crm-agent-installer/${id}`;
  const job: RemoteJobMetadata = {
    id,
    runDir,
    statusPath: `${runDir}/status.json`,
    logPath: `${runDir}/install.log`,
    pidPath: `${runDir}/pid`,
    startedAt: new Date().toISOString(),
  };
  const session = await dependencies.connect(config, secretStore);
  try {
    const mkdir = await session.exec(`mkdir -p ${shellQuote(runDir)}`);
    if (mkdir.code !== 0) throw new Error(mkdir.stderr || "Unable to create remote installer directory.");
    const remoteAppDir = normalizeAppDir(config.server.appDir);
    const existingEnv = await session.exec(`test -f "${remoteAppDir}/.env"`);
    if (existingEnv.code !== 0 && existingEnv.code !== 1) {
      throw new Error(existingEnv.stderr || "Unable to determine whether the remote Agent configuration exists.");
    }
    job.useStagedEnv = config.server.replaceExistingEnv || existingEnv.code === 1;
    await context.log("Uploading the signed Agent release package.");
    await session.uploadFile(packagePath, `${runDir}/release.zip`, 0o600);

    if (job.useStagedEnv) {
      const secretValues = Object.fromEntries(
        await Promise.all(
          [
            "ai_api_key",
            "feishu_app_secret",
            "feishu_pairing_code",
            "email_password",
            "search_api_key",
            "whatsapp_access_token",
            "whatsapp_app_secret",
            "whatsapp_verify_token",
          ].map(async (name) => [name, await secretStore.get(name as never)]),
        ),
      );
      await session.uploadBuffer(
        `${runDir}/agent.env`,
        Buffer.from(buildRemoteEnv(config, secretValues), "utf8"),
        0o600,
      );
      await context.log(existingEnv.code === 0
        ? "Explicit configuration replacement selected; staged configuration will be installed."
        : "Fresh installation detected; staged configuration will be installed.");
    } else {
      await context.log("Existing remote configuration detected and will be preserved.");
    }
    await session.uploadBuffer(
      `${runDir}/run.sh`,
      Buffer.from(createRemoteRunner(job, config.server.appDir), "utf8"),
      0o700,
    );
    context.state.metadata.deploymentJob = job;
    await context.log("Remote deployment checkpoint created.");
    await launchRemoteJob(context, session, job);
    return job;
  } finally {
    session.close();
  }
}

export async function deployRelease(
  context: InstallerStepContext,
  config: InstallerConfig,
  secretStore: InstallerSecretStore,
  packagePath: string,
  dependencies: DeploymentDependencies = defaultDeploymentDependencies,
): Promise<Record<string, unknown>> {
  const job = await ensureRemoteJob(context, config, secretStore, packagePath, dependencies);
  const deadline = Date.now() + 90 * 60_000;
  let lastLog = "";
  let consecutiveConnectionFailures = 0;
  while (Date.now() < deadline) {
    let session: RemoteDeploymentSession;
    try {
      session = await dependencies.connect(config, secretStore);
    } catch (error) {
      consecutiveConnectionFailures += 1;
      if ([1, 3, 6, 12].includes(consecutiveConnectionFailures)) {
        await context.log(
          `VPS connection interrupted (${consecutiveConnectionFailures}/12); the remote job continues and polling will retry. ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
      }
      if (consecutiveConnectionFailures >= 12) {
        throw new Error("VPS connection remained unavailable while the remote deployment checkpoint was running.");
      }
      await dependencies.sleep(5_000);
      continue;
    }
    try {
      const statusText = await session.readRemoteFile(job.statusPath);
      const tail = await session.exec(`tail -n 25 ${shellQuote(job.logPath)} 2>/dev/null || true`);
      const knownSecrets = await secretStore.knownValues();
      const safeTail = redactText(tail.stdout.trim(), knownSecrets);
      if (safeTail && safeTail !== lastLog) {
        lastLog = safeTail;
        await context.log(safeTail);
      }
      const status = parseRemoteStatus(statusText);
      if (status) {
        if (status.state === "SUCCEEDED") {
          return { remoteDeploymentJob: job, deployedPackage: path.win32.basename(packagePath) };
        }
        if (status.state === "FAILED") {
          throw new RemoteDeploymentFailedError(`Remote deployment failed with exit code ${status.exitCode}.`);
        }
      } else {
        if (!(await remoteJobAlive(session, job))) {
          throw new RemoteDeploymentStoppedError(
            "Remote deployment stopped before writing a status checkpoint; Retry will restart the uploaded job.",
          );
        }
      }
      consecutiveConnectionFailures = 0;
    } catch (error) {
      if (error instanceof RemoteDeploymentFailedError || error instanceof RemoteDeploymentStoppedError) throw error;
      consecutiveConnectionFailures += 1;
      if ([1, 3, 6, 12].includes(consecutiveConnectionFailures)) {
        await context.log(
          `Remote deployment polling was interrupted (${consecutiveConnectionFailures}/12); retrying the same checkpoint. ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
      }
      if (consecutiveConnectionFailures >= 12) throw error;
    } finally {
      session.close();
    }
    await dependencies.sleep(5_000);
  }
  throw new Error("Remote deployment did not finish within 90 minutes.");
}

export async function rollbackRemoteRelease(
  config: InstallerConfig,
  secretStore: InstallerSecretStore,
): Promise<void> {
  const session = await connectDefault(config, secretStore);
  try {
    const appDir = normalizeAppDir(config.server.appDir);
    const result = await session.exec(
      `APP_DIR="${appDir}" bash "${appDir}/scripts/rollback-vps-release.sh" --if-present`,
      { timeoutMs: 10 * 60_000 },
    );
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Remote rollback failed.");
  } finally {
    session.close();
  }
}

export async function runRemoteCommand(
  config: InstallerConfig,
  secretStore: InstallerSecretStore,
  command: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const session = await connectDefault(config, secretStore);
  try {
    return await session.exec(command, { timeoutMs });
  } finally {
    session.close();
  }
}
