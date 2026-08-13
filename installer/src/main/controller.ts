import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  installStepIds,
  installerConfigSchema,
  type DiagnosticsExportResult,
  type InstallerConfigurationInput,
  type InstallerSnapshot,
  type InstallStepId,
  type SecretName,
} from "../shared/contracts.js";
import { InstallerEngine } from "./engine/engine.js";
import type { InstallerSecretStore } from "./engine/secrets.js";
import { appendEvent, replaceConfiguration } from "./engine/state.js";

const stepIndex = new Map(installStepIds.map((id, index) => [id, index]));

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function earliestChangedStep(
  previous: InstallerConfigurationInput["config"] | null,
  next: InstallerConfigurationInput["config"],
  changedSecrets: SecretName[],
): InstallStepId {
  if (!previous) return "collect_configuration";
  const candidates: InstallStepId[] = [];
  if (!same(previous.business, next.business) || !same(previous.product, next.product)) candidates.push("verify_payload");
  if (!same(previous.ai, next.ai)) candidates.push("confirm_search");
  if (!same(previous.feishu, next.feishu)) candidates.push("confirm_feishu");
  if (!same(previous.email, next.email)) candidates.push("confirm_email");
  if (!same(previous.search, next.search)) candidates.push("confirm_search");
  if (!same(previous.whatsapp, next.whatsapp)) candidates.push("confirm_whatsapp");
  if (!same(previous.server, next.server)) candidates.push("verify_server");
  if (!same(previous.confirmations, next.confirmations)) candidates.push("collect_configuration");

  const secretSteps: Partial<Record<SecretName, InstallStepId>> = {
    ai_api_key: "confirm_search",
    feishu_app_secret: "confirm_feishu",
    feishu_pairing_code: "pair_feishu",
    email_password: "confirm_email",
    search_api_key: "confirm_search",
    server_password: "verify_server",
    server_private_key: "verify_server",
    whatsapp_access_token: "confirm_whatsapp",
    whatsapp_app_secret: "confirm_whatsapp",
    whatsapp_verify_token: "confirm_whatsapp",
  };
  for (const name of changedSecrets) {
    const candidate = secretSteps[name];
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => (stepIndex.get(a) ?? 0) - (stepIndex.get(b) ?? 0))[0] ?? "collect_configuration";
}

export class InstallerController {
  constructor(
    private readonly engine: InstallerEngine,
    private readonly secretStore: InstallerSecretStore,
    private readonly diagnosticsDir: string,
  ) {}

  async initialize(): Promise<InstallerSnapshot> {
    return this.engine.initialize();
  }

  snapshot(): InstallerSnapshot {
    return this.engine.snapshot();
  }

  onSnapshot(listener: (snapshot: InstallerSnapshot) => void): () => void {
    this.engine.on("snapshot", listener);
    return () => this.engine.off("snapshot", listener);
  }

  async saveConfiguration(input: InstallerConfigurationInput): Promise<InstallerSnapshot> {
    const config = installerConfigSchema.parse(input.config);
    const changedSecrets = Object.entries(input.secrets ?? {})
      .filter(([, value]) => Boolean(value))
      .map(([name]) => name as SecretName);
    await this.secretStore.set(input.secrets ?? {});
    if (config.feishu.enabled && !(await this.secretStore.get("feishu_pairing_code"))) {
      await this.secretStore.set({ feishu_pairing_code: crypto.randomBytes(12).toString("base64url") });
      changedSecrets.push("feishu_pairing_code");
    }

    const state = this.engine.getState();
    const invalidateFrom = earliestChangedStep(state.config, config, changedSecrets);
    replaceConfiguration(state, config, await this.secretStore.presence());
    const start = stepIndex.get(invalidateFrom) ?? 0;
    for (let index = start; index < state.steps.length; index += 1) {
      const step = state.steps[index];
      if (!step) continue;
      step.status = "PENDING";
      step.startedAt = null;
      step.completedAt = null;
      step.checkpointId = null;
      step.blocker = null;
      step.error = null;
    }
    state.steps[0]!.status = "PENDING";
    state.status = "DRAFT";
    state.currentStepId = "collect_configuration";
    if ((stepIndex.get(invalidateFrom) ?? 0) <= (stepIndex.get("verify_payload") ?? 0)) {
      delete state.metadata.customerPayload;
    }
    if ((stepIndex.get(invalidateFrom) ?? 0) <= (stepIndex.get("deploy_release") ?? 0)) {
      delete state.metadata.deploymentJob;
    }
    appendEvent(state, {
      stepId: "collect_configuration",
      level: "info",
      message: `Configuration saved; validation will continue from ${invalidateFrom}.`,
    });
    return this.engine.replaceState(state);
  }

  async start(): Promise<InstallerSnapshot> {
    return this.engine.start();
  }

  async resume(): Promise<InstallerSnapshot> {
    const state = this.engine.getState();
    const current = state.steps.find((step) => step.id === state.currentStepId);
    if (current?.blocker?.code === "HOST_FINGERPRINT_CONFIRMATION") {
      const fingerprint = String(state.metadata.pendingHostFingerprint ?? "");
      if (!state.config || !fingerprint) throw new Error("The pending VPS fingerprint is unavailable.");
      state.config.server.hostFingerprint = fingerprint;
      delete state.metadata.pendingHostFingerprint;
      await this.engine.replaceState(state);
    }
    return this.engine.resume();
  }

  async retry(): Promise<InstallerSnapshot> {
    return this.engine.retry();
  }

  async rollback(): Promise<InstallerSnapshot> {
    return this.engine.rollback();
  }

  async getPairingCode(): Promise<string> {
    return this.secretStore.get("feishu_pairing_code");
  }

  async exportDiagnostics(destination?: string): Promise<DiagnosticsExportResult> {
    const target = destination ?? path.join(this.diagnosticsDir, `crm-agent-installer-diagnostics-${Date.now()}.json`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const snapshot = this.engine.snapshot();
    const report = {
      generatedAt: new Date().toISOString(),
      installerVersion: snapshot.state.productVersion,
      installationId: snapshot.state.installationId,
      status: snapshot.state.status,
      currentStepId: snapshot.state.currentStepId,
      steps: snapshot.state.steps,
      events: snapshot.state.events,
      system: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: process.versions.electron,
      },
    };
    await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { path: target };
  }
}
