import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  installStepIds,
  type InstallState,
  type InstallerBlocker,
  type InstallerSnapshot,
  type InstallStepId,
} from "../../shared/contracts.js";
import { validateConfiguration } from "./config-validation.js";
import type { InstallStateRepository } from "./repository.js";
import { appendEvent, cloneState, createInitialState, touchState } from "./state.js";

export type StepOutcome =
  | { type: "completed"; checkpoint?: boolean; metadata?: Record<string, unknown> }
  | { type: "blocked"; blocker: InstallerBlocker }
  | { type: "skipped"; metadata?: Record<string, unknown> };

export interface InstallerStepContext {
  state: InstallState;
  stepId: InstallStepId;
  log(message: string, level?: "info" | "warn" | "error"): Promise<void>;
}

export interface InstallerStepDefinition {
  id: InstallStepId;
  run(context: InstallerStepContext): Promise<StepOutcome>;
  rollback?(context: InstallerStepContext): Promise<void>;
}

export type InstallerStepMap = Record<InstallStepId, InstallerStepDefinition>;

export class InstallerEngine extends EventEmitter {
  private state: InstallState | null = null;
  private activeRun: Promise<InstallerSnapshot> | null = null;

  constructor(
    private readonly repository: InstallStateRepository,
    private readonly steps: InstallerStepMap,
    private readonly productVersion: string,
  ) {
    super();
  }

  async initialize(): Promise<InstallerSnapshot> {
    this.state = (await this.repository.load()) ?? createInitialState(this.productVersion);
    const interrupted = this.state.steps.find((step) => step.status === "RUNNING");
    if (interrupted) {
      interrupted.status = "PENDING";
      interrupted.error = null;
      this.state.status = "DRAFT";
      this.state.currentStepId = interrupted.id;
      appendEvent(this.state, {
        stepId: interrupted.id,
        level: "warn",
        message: "Recovered an interrupted step; it will resume from its persisted checkpoint.",
      });
    }
    await this.persist();
    return this.snapshot();
  }

  getState(): InstallState {
    if (!this.state) throw new Error("Installer engine has not been initialized.");
    return this.state;
  }

  async replaceState(state: InstallState): Promise<InstallerSnapshot> {
    this.state = cloneState(state);
    await this.persist();
    return this.snapshot();
  }

  snapshot(): InstallerSnapshot {
    const state = cloneState(this.getState());
    return {
      state,
      canStart: state.status === "DRAFT" || state.status === "BLOCKED",
      canResume: state.status === "BLOCKED",
      canRetry: state.status === "FAILED",
      canRollback: state.steps.some((step) => step.status === "COMPLETED" && Boolean(this.steps[step.id].rollback)),
    };
  }

  async start(): Promise<InstallerSnapshot> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.runUntilPause().finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async resume(): Promise<InstallerSnapshot> {
    const state = this.getState();
    if (state.status !== "BLOCKED") return this.snapshot();
    const current = state.steps.find((step) => step.id === state.currentStepId);
    if (current?.status === "BLOCKED") {
      current.status = "PENDING";
      current.blocker = null;
      current.error = null;
    }
    state.status = "DRAFT";
    await this.persist();
    return this.start();
  }

  async retry(): Promise<InstallerSnapshot> {
    const state = this.getState();
    if (state.status !== "FAILED") return this.snapshot();
    const current = state.steps.find((step) => step.id === state.currentStepId);
    if (current?.status === "FAILED") {
      current.status = "PENDING";
      current.error = null;
    }
    state.status = "DRAFT";
    await this.persist();
    return this.start();
  }

  async rollback(): Promise<InstallerSnapshot> {
    const state = this.getState();
    if (state.status === "RUNNING" || state.status === "ROLLING_BACK") return this.snapshot();
    state.status = "ROLLING_BACK";
    await this.persist();
    const completed = [...state.steps]
      .reverse()
      .filter((step) => step.status === "COMPLETED" && Boolean(this.steps[step.id].rollback));
    for (const record of completed) {
      const definition = this.steps[record.id];
      try {
        await definition.rollback?.(this.context(record.id));
        record.status = "ROLLED_BACK";
        record.completedAt = null;
        appendEvent(state, {
          stepId: record.id,
          level: "info",
          message: `Rolled back ${record.id}.`,
        });
        await this.persist();
      } catch (error) {
        state.status = "FAILED";
        state.currentStepId = record.id;
        record.error = error instanceof Error ? error.message : String(error);
        appendEvent(state, {
          stepId: record.id,
          level: "error",
          message: `Rollback failed: ${record.error}`,
        });
        await this.persist();
        return this.snapshot();
      }
    }
    for (const record of state.steps) {
      if (record.status === "ROLLED_BACK") record.status = "PENDING";
    }
    const next = state.steps.find((step) => step.status === "PENDING");
    state.currentStepId = next?.id ?? "collect_configuration";
    state.status = "DRAFT";
    await this.persist();
    return this.snapshot();
  }

  private async runUntilPause(): Promise<InstallerSnapshot> {
    const state = this.getState();
    while (true) {
      const record = state.steps.find((step) => step.status === "PENDING");
      if (!record) {
        state.status = "COMPLETED";
        state.currentStepId = null;
        appendEvent(state, { stepId: null, level: "info", message: "Installation completed." });
        await this.persist();
        return this.snapshot();
      }

      state.status = "RUNNING";
      state.currentStepId = record.id;
      record.status = "RUNNING";
      record.startedAt = new Date().toISOString();
      record.attempts += 1;
      record.blocker = null;
      record.error = null;
      appendEvent(state, { stepId: record.id, level: "info", message: `Starting ${record.id}.` });
      await this.persist();

      try {
        if (record.id === "collect_configuration") {
          if (!state.config) {
            const blocker: InstallerBlocker = {
              code: "CONFIGURATION_REQUIRED",
              title: "Complete installation information",
              message: "Fill every required account, business, product, and server field before installation.",
              actionLabel: "Edit configuration",
              requiredFields: [],
              canRetry: true,
            };
            record.status = "BLOCKED";
            record.blocker = blocker;
            state.status = "BLOCKED";
            await this.persist();
            return this.snapshot();
          }
          const validation = validateConfiguration(state.config, state.secretPresence);
          if (!validation.ok) {
            record.status = "BLOCKED";
            record.blocker = {
              code: "CONFIGURATION_INVALID",
              title: "Configuration needs attention",
              message: validation.errors.join("\n"),
              actionLabel: "Edit configuration",
              requiredFields: validation.errors,
              canRetry: true,
            };
            state.status = "BLOCKED";
            await this.persist();
            return this.snapshot();
          }
        }

        const outcome = await this.steps[record.id].run(this.context(record.id));
        if (outcome.type === "blocked") {
          record.status = "BLOCKED";
          record.blocker = outcome.blocker;
          state.status = "BLOCKED";
          appendEvent(state, { stepId: record.id, level: "warn", message: outcome.blocker.message });
          await this.persist();
          return this.snapshot();
        }

        record.status = outcome.type === "skipped" ? "SKIPPED" : "COMPLETED";
        record.completedAt = new Date().toISOString();
        record.checkpointId = outcome.type === "completed" && outcome.checkpoint ? randomUUID() : null;
        if (outcome.metadata) state.metadata = { ...state.metadata, ...outcome.metadata };
        appendEvent(state, { stepId: record.id, level: "info", message: `Finished ${record.id}.` });
        await this.persist();
      } catch (error) {
        record.status = "FAILED";
        record.error = error instanceof Error ? error.message : String(error);
        state.status = "FAILED";
        appendEvent(state, { stepId: record.id, level: "error", message: record.error });
        await this.persist();
        return this.snapshot();
      }
    }
  }

  private context(stepId: InstallStepId): InstallerStepContext {
    return {
      state: this.getState(),
      stepId,
      log: async (message, level = "info") => {
        appendEvent(this.getState(), { stepId, level, message });
        await this.persist();
      },
    };
  }

  private async persist(): Promise<void> {
    touchState(this.getState());
    await this.repository.save(this.getState());
    this.emit("snapshot", this.snapshot());
  }
}

export function createNoopStepMap(
  overrides: Partial<InstallerStepMap> = {},
): InstallerStepMap {
  return Object.fromEntries(
    installStepIds.map((id) => [
      id,
      overrides[id] ?? {
        id,
        run: async () => ({ type: "completed" as const, checkpoint: id !== "collect_configuration" }),
      },
    ]),
  ) as InstallerStepMap;
}
