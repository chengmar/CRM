import { describe, expect, it, vi } from "vitest";
import type { InstallerBlocker, InstallerConfig } from "../src/shared/contracts.js";
import { defaultInstallerConfig } from "../src/shared/defaults.js";
import { InstallerEngine, createNoopStepMap } from "../src/main/engine/engine.js";
import { MemoryInstallStateRepository } from "../src/main/engine/repository.js";
import { replaceConfiguration } from "../src/main/engine/state.js";

function validConfig(): InstallerConfig {
  const gmailTestAddress = ["operator", "gmail.com"].join("@");
  return {
    ...structuredClone(defaultInstallerConfig),
    business: {
      legalName: "Example Manufacturing Co., Ltd.",
      brandName: "Example",
      website: "https://example.com",
      country: "China",
      city: "Shanghai",
      postalAddress: "100 Example Road, Shanghai, China",
      contactName: "Alex Chen",
      contactTitle: "Sales Manager",
      contactEmail: "sales@example.com",
      whatsapp: "+8613800000000",
      introduction: "Example Manufacturing produces configurable products for overseas buyers.",
    },
    product: {
      name: "Sample Product",
      hsCode: "8421",
      specifications: ["customized"],
      sellingPoints: ["OEM support"],
      targetMarkets: ["Vietnam"],
      buyerTypes: ["industrial distributor"],
      moq: "1 unit",
      leadTime: "30 days",
      priceRule: "Quote by specification",
    },
    ai: { baseUrl: "https://api.example.com/v1", model: "example-model" },
    feishu: {
      enabled: true,
      domain: "feishu",
      appId: "cli_example123",
      setupConfirmed: true,
      crmName: "Example CRM",
    },
    email: {
      ...defaultInstallerConfig.email,
      mode: "gmail_pilot",
      fromAddress: gmailTestAddress,
      fromName: "Alex Chen",
      replyTo: gmailTestAddress,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      smtpUser: gmailTestAddress,
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapUser: gmailTestAddress,
      dailyLimit: 50,
      hourlyLimit: 20,
      unsubscribeText: "Reply unsubscribe to stop future messages.",
    },
    server: {
      host: "203.0.113.10",
      port: 22,
      user: "root",
      authMode: "password",
      privateKeyPath: "",
      appDir: "~/export-ai-agent",
      replaceExistingEnv: false,
      hostFingerprint: "",
    },
  };
}

async function configuredEngine(overrides = {}) {
  const repository = new MemoryInstallStateRepository();
  const engine = new InstallerEngine(repository, createNoopStepMap(overrides), "0.1.0");
  await engine.initialize();
  const state = engine.getState();
  replaceConfiguration(state, validConfig(), {
    ai_api_key: true,
    feishu_app_secret: true,
    email_password: true,
    server_password: true,
  });
  await engine.replaceState(state);
  return engine;
}

describe("InstallerEngine", () => {
  it("completes each step once and survives reloading from the repository", async () => {
    const repository = new MemoryInstallStateRepository();
    const engine = new InstallerEngine(repository, createNoopStepMap(), "0.1.0");
    await engine.initialize();
    const state = engine.getState();
    replaceConfiguration(state, validConfig(), {
      ai_api_key: true,
      feishu_app_secret: true,
      email_password: true,
      server_password: true,
    });
    await engine.replaceState(state);
    const result = await engine.start();
    expect(result.state.status).toBe("COMPLETED");
    expect(result.state.steps.every((step) => ["COMPLETED", "SKIPPED"].includes(step.status))).toBe(true);

    const reloaded = new InstallerEngine(repository, createNoopStepMap(), "0.1.0");
    const snapshot = await reloaded.initialize();
    expect(snapshot.state.status).toBe("COMPLETED");
  });

  it("pauses on a human blocker and resumes from that exact step", async () => {
    const blocker: InstallerBlocker = {
      code: "MANUAL_TEST",
      title: "Manual test",
      message: "Complete the external action.",
      requiredFields: [],
      canRetry: true,
    };
    let ready = false;
    const engine = await configuredEngine({
      confirm_feishu: {
        id: "confirm_feishu",
        run: async () => (ready ? { type: "completed" as const } : { type: "blocked" as const, blocker }),
      },
    });
    const blocked = await engine.start();
    expect(blocked.state.status).toBe("BLOCKED");
    expect(blocked.state.currentStepId).toBe("confirm_feishu");
    expect(blocked.state.steps.find((step) => step.id === "check_windows")?.status).toBe("COMPLETED");

    ready = true;
    const completed = await engine.resume();
    expect(completed.state.status).toBe("COMPLETED");
    expect(completed.state.steps.find((step) => step.id === "confirm_feishu")?.attempts).toBe(2);
    expect(completed.state.steps.find((step) => step.id === "check_windows")?.attempts).toBe(1);
  });

  it("retries only the failed step", async () => {
    let failures = 1;
    const engine = await configuredEngine({
      verify_server: {
        id: "verify_server",
        run: async () => {
          if (failures-- > 0) throw new Error("temporary network failure");
          return { type: "completed" as const };
        },
      },
    });
    const failed = await engine.start();
    expect(failed.state.status).toBe("FAILED");
    expect(failed.state.currentStepId).toBe("verify_server");
    const completed = await engine.retry();
    expect(completed.state.status).toBe("COMPLETED");
    expect(completed.state.steps.find((step) => step.id === "verify_server")?.attempts).toBe(2);
  });

  it("rolls reversible steps back in reverse order", async () => {
    const calls: string[] = [];
    const rollback = (id: string) => vi.fn(async () => void calls.push(id));
    const engine = await configuredEngine({
      check_windows: {
        id: "check_windows",
        run: async () => ({ type: "completed" as const, checkpoint: true }),
        rollback: rollback("check_windows"),
      },
      verify_server: {
        id: "verify_server",
        run: async () => ({ type: "completed" as const, checkpoint: true }),
        rollback: rollback("verify_server"),
      },
      deploy_release: {
        id: "deploy_release",
        run: async () => ({ type: "blocked" as const, blocker: {
          code: "STOP",
          title: "Stop",
          message: "Stop here",
          requiredFields: [],
          canRetry: true,
        } }),
      },
    });
    await engine.start();
    const rolledBack = await engine.rollback();
    expect(rolledBack.state.status).toBe("DRAFT");
    expect(calls).toEqual(["verify_server", "check_windows"]);
  });
});
