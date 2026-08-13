import { randomUUID } from "node:crypto";
import {
  installStepIds,
  type InstallEvent,
  type InstallState,
  type InstallerConfig,
  type SecretPresence,
  type StepRecord,
} from "../../shared/contracts.js";

export function createInitialState(productVersion: string): InstallState {
  const now = new Date().toISOString();
  const steps: StepRecord[] = installStepIds.map((id) => ({
    id,
    status: "PENDING",
    attempts: 0,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    blocker: null,
    error: null,
  }));
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    productVersion,
    createdAt: now,
    updatedAt: now,
    status: "DRAFT",
    currentStepId: "collect_configuration",
    config: null,
    secretPresence: {},
    steps,
    events: [],
    metadata: {},
  };
}

export function cloneState(state: InstallState): InstallState {
  return structuredClone(state);
}

export function touchState(state: InstallState): void {
  state.updatedAt = new Date().toISOString();
}

export function appendEvent(
  state: InstallState,
  event: Omit<InstallEvent, "at"> & { at?: string },
): void {
  state.events.push({
    at: event.at ?? new Date().toISOString(),
    stepId: event.stepId,
    level: event.level,
    message: event.message,
  });
  if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  touchState(state);
}

export function replaceConfiguration(
  state: InstallState,
  config: InstallerConfig,
  secretPresence: SecretPresence,
): void {
  state.config = config;
  state.secretPresence = { ...secretPresence };
  const step = state.steps.find((item) => item.id === "collect_configuration");
  if (step) {
    step.status = "PENDING";
    step.blocker = null;
    step.error = null;
  }
  const active = state.steps.find((item) => item.id === state.currentStepId);
  if (active && (active.status === "BLOCKED" || active.status === "FAILED")) {
    active.status = "PENDING";
    active.blocker = null;
    active.error = null;
  }
  if (state.status === "COMPLETED") {
    state.status = "DRAFT";
    for (const item of state.steps) {
      if (item.id !== "collect_configuration") {
        item.status = "PENDING";
        item.startedAt = null;
        item.completedAt = null;
        item.checkpointId = null;
        item.blocker = null;
        item.error = null;
      }
    }
  }
  state.currentStepId = "collect_configuration";
  touchState(state);
}
