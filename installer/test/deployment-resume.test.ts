import { describe, expect, it } from "vitest";
import type { InstallerConfig, SecretName, SecretPresence } from "../src/shared/contracts.js";
import { defaultInstallerConfig } from "../src/shared/defaults.js";
import type { InstallerSecretStore } from "../src/main/engine/secrets.js";
import type { InstallerStepContext } from "../src/main/engine/engine.js";
import { createInitialState } from "../src/main/engine/state.js";
import {
  deployRelease,
  type DeploymentDependencies,
  type RemoteDeploymentSession,
} from "../src/main/runtime/deployment.js";

const job = {
  id: "installation-1-existing",
  runDir: ".crm-agent-installer/installation-1-existing",
  statusPath: ".crm-agent-installer/installation-1-existing/status.json",
  logPath: ".crm-agent-installer/installation-1-existing/install.log",
  pidPath: ".crm-agent-installer/installation-1-existing/pid",
  startedAt: "2026-07-14T00:00:00.000Z",
};

function config(): InstallerConfig {
  const value = structuredClone(defaultInstallerConfig);
  value.server = {
    host: "203.0.113.10",
    port: 22,
    user: "root",
    authMode: "password",
    privateKeyPath: "",
    appDir: "~/export-ai-agent",
    replaceExistingEnv: false,
    hostFingerprint: "sha256:test",
  };
  return value;
}

const secretStore: InstallerSecretStore = {
  set: async () => undefined,
  get: async (_name: SecretName) => "",
  remove: async () => undefined,
  presence: async () => ({}) as SecretPresence,
  knownValues: async () => [],
};

class FakeSession implements RemoteDeploymentSession {
  commands: string[] = [];
  uploadedBuffers: Array<{ path: string; text: string }> = [];
  uploads = 0;
  closed = false;

  constructor(
    private readonly status: string | null,
    private readonly alive = true,
    private readonly checkpointFiles = true,
    private readonly remoteEnvExists = true,
  ) {}

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    this.commands.push(command);
    if (command.startsWith("tail -n")) return { code: 0, stdout: "remote log", stderr: "" };
    if (command.includes("export-ai-agent/.env") && !command.includes("release.zip")) {
      return { code: this.remoteEnvExists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command.includes("kill -0")) return { code: this.alive ? 0 : 1, stdout: "", stderr: "" };
    if (command.includes("release.zip") && command.includes("run.sh") && !command.includes("nohup")) {
      return { code: this.checkpointFiles ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command.includes("nohup bash")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async uploadFile(): Promise<void> {
    this.uploads += 1;
  }

  async uploadBuffer(remotePath: string, data: Buffer): Promise<void> {
    this.uploads += 1;
    this.uploadedBuffers.push({ path: remotePath, text: data.toString("utf8") });
  }

  async readRemoteFile(): Promise<string | null> {
    return this.status;
  }

  close(): void {
    this.closed = true;
  }
}

function context(existingJob = true) {
  const state = createInitialState("0.1.0");
  state.installationId = "installation-1";
  state.config = config();
  if (existingJob) state.metadata.deploymentJob = structuredClone(job);
  const logs: string[] = [];
  const value: InstallerStepContext = {
    state,
    stepId: "deploy_release",
    log: async (message) => void logs.push(message),
  };
  return { value, logs };
}

function dependencies(
  sessions: Array<RemoteDeploymentSession | Error>,
): DeploymentDependencies {
  return {
    connect: async () => {
      const next = sessions.shift();
      if (!next) throw new Error("No fake SSH session available.");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async () => undefined,
    randomSuffix: () => "fixed",
  };
}

describe("remote deployment resume", () => {
  it("continues polling an already running checkpoint without re-uploading or relaunching", async () => {
    const running = new FakeSession(JSON.stringify({ state: "RUNNING", exitCode: 0 }), true);
    const succeeded = new FakeSession(JSON.stringify({ state: "SUCCEEDED", exitCode: 0 }), false);
    const { value } = context();

    const result = await deployRelease(value, config(), secretStore, "C:\\staging\\customer.zip", dependencies([running, succeeded]));

    expect(result.deployedPackage).toBe("customer.zip");
    expect(running.uploads).toBe(0);
    expect(running.commands.some((command) => command.includes("nohup bash"))).toBe(false);
  });

  it("relaunches the uploaded checkpoint after a failed remote attempt", async () => {
    const failed = new FakeSession(JSON.stringify({ state: "FAILED", exitCode: 17 }), false, true);
    const succeeded = new FakeSession(JSON.stringify({ state: "SUCCEEDED", exitCode: 0 }), false);
    const { value, logs } = context();

    await deployRelease(value, config(), secretStore, "C:\\staging\\customer.zip", dependencies([failed, succeeded]));

    expect(failed.uploads).toBe(0);
    expect(failed.commands.some((command) => command.includes("nohup bash"))).toBe(true);
    expect(logs.some((message) => message.includes("Retrying failed remote deployment"))).toBe(true);
    expect((value.state.metadata.deploymentJob as { launchAttempts?: number }).launchAttempts).toBe(1);
  });

  it("tolerates a temporary polling disconnect and keeps the same remote job", async () => {
    const running = new FakeSession(JSON.stringify({ state: "RUNNING", exitCode: 0 }), true);
    const succeeded = new FakeSession(JSON.stringify({ state: "SUCCEEDED", exitCode: 0 }), false);
    const { value, logs } = context();

    await deployRelease(
      value,
      config(),
      secretStore,
      "C:\\staging\\customer.zip",
      dependencies([running, new Error("temporary network loss"), succeeded]),
    );

    expect(logs.some((message) => message.includes("VPS connection interrupted"))).toBe(true);
    expect(value.state.metadata.deploymentJob).toMatchObject({ id: job.id });
  });

  it("preserves an existing remote env by default without uploading replacement secrets", async () => {
    const upload = new FakeSession(null, true, true, true);
    const succeeded = new FakeSession(JSON.stringify({ state: "SUCCEEDED", exitCode: 0 }), false);
    const { value, logs } = context(false);

    await deployRelease(value, config(), secretStore, "C:\\staging\\customer.zip", dependencies([upload, succeeded]));

    expect(upload.uploadedBuffers.map((item) => item.path)).not.toContain(".crm-agent-installer/installation-1-fixed/agent.env");
    const runner = upload.uploadedBuffers.find((item) => item.path.endsWith("/run.sh"))?.text ?? "";
    expect(runner).toContain("Existing remote .env disappeared before the upgrade started.");
    expect(runner).not.toContain("REMOTE_ENV_PATH=");
    expect(logs).toContain("Existing remote configuration detected and will be preserved.");
    expect(value.state.metadata.deploymentJob).toMatchObject({ useStagedEnv: false });
  });

  it("uploads staged configuration for a fresh install and for explicit replacement", async () => {
    for (const fixture of [
      { remoteEnvExists: false, replaceExistingEnv: false },
      { remoteEnvExists: true, replaceExistingEnv: true },
    ]) {
      const upload = new FakeSession(null, true, true, fixture.remoteEnvExists);
      const succeeded = new FakeSession(JSON.stringify({ state: "SUCCEEDED", exitCode: 0 }), false);
      const { value } = context(false);
      const configured = config();
      configured.server.replaceExistingEnv = fixture.replaceExistingEnv;

      await deployRelease(value, configured, secretStore, "C:\\staging\\customer.zip", dependencies([upload, succeeded]));

      expect(upload.uploadedBuffers.map((item) => item.path)).toContain(".crm-agent-installer/installation-1-fixed/agent.env");
      const runner = upload.uploadedBuffers.find((item) => item.path.endsWith("/run.sh"))?.text ?? "";
      expect(runner).toContain("REMOTE_ENV_PATH=");
      expect(value.state.metadata.deploymentJob).toMatchObject({ useStagedEnv: true });
    }
  });
});
