import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallerConfig, SecretName, SecretPresence } from "../src/shared/contracts.js";
import { defaultInstallerConfig } from "../src/shared/defaults.js";
import type { InstallerSecretStore } from "../src/main/engine/secrets.js";
import type { InstallerStepContext } from "../src/main/engine/engine.js";
import { createInitialState } from "../src/main/engine/state.js";
import { buildRemoteEnv } from "../src/main/runtime/env-builder.js";

const integrationMocks = vi.hoisted(() => ({
  verifyAiProvider: vi.fn(),
  verifyEmail: vi.fn(),
  verifyFeishu: vi.fn(),
  verifySearchProvider: vi.fn(),
  verifyWhatsApp: vi.fn(),
}));

vi.mock("../src/main/runtime/integrations.js", () => integrationMocks);

import {
  createRuntimeStepMap,
  getEnterpriseEmailLaunchPolicy,
} from "../src/main/runtime/steps.js";

function enterpriseConfig(overrides: Partial<InstallerConfig["email"]> = {}): InstallerConfig {
  const config = structuredClone(defaultInstallerConfig);
  config.email = {
    ...config.email,
    mode: "enterprise",
    fromAddress: "sales@example.com",
    fromName: "Example Sales",
    replyTo: "sales@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpUser: "sales@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapUser: "sales@example.com",
    dailyLimit: 500,
    hourlyLimit: 100,
    unsubscribeText: "Reply unsubscribe to stop future messages.",
    domainAuthVerified: true,
    warmupComplete: false,
    ...overrides,
  };
  return config;
}

const secretStore: InstallerSecretStore = {
  set: async () => undefined,
  get: async (_name: SecretName) => "test-password",
  remove: async () => undefined,
  presence: async () => ({}) as SecretPresence,
  knownValues: async () => [],
};

function emailStepContext(config: InstallerConfig) {
  const state = createInitialState("test");
  state.config = config;
  const logs: Array<{ message: string; level?: "info" | "warn" | "error" }> = [];
  const context: InstallerStepContext = {
    state,
    stepId: "confirm_email",
    log: async (message, level) => void logs.push({ message, level }),
  };
  return { context, logs };
}

function emailStep() {
  return createRuntimeStepMap({
    userDataDir: "C:\\test-user-data",
    payloadDir: "C:\\test-payload",
    secretStore,
  }).confirm_email;
}

beforeEach(() => {
  for (const mock of Object.values(integrationMocks)) mock.mockReset();
  integrationMocks.verifyEmail.mockResolvedValue(undefined);
});

describe("enterprise email staged launch", () => {
  it("allows an authenticated but un-warmed mailbox in the initial controlled stage", async () => {
    const config = enterpriseConfig();
    const { context, logs } = emailStepContext(config);

    const result = await emailStep().run(context);

    expect(integrationMocks.verifyEmail).toHaveBeenCalledWith(config, "test-password");
    expect(result).toMatchObject({
      type: "completed",
      metadata: {
        emailLaunchPolicy: {
          launchMode: "staged_controlled_ramp",
          stage: "enterprise_initial_reputation_check",
          effectiveDailyLimit: 10,
          effectiveHourlyLimit: 2,
          effectiveMinimumIntervalSeconds: 900,
          smtpImapAuthSmokeRequired: true,
          sendReceiveSelfTestRequired: true,
          explicitGlobalPauseReleaseRequired: true,
          humanApprovalRequired: true,
        },
      },
    });
    expect(logs).toEqual([
      expect.objectContaining({ level: "warn", message: expect.stringContaining("controlled staged mode") }),
    ]);
  });

  it("uses the configured limits only after warm-up is marked complete", async () => {
    const policy = getEnterpriseEmailLaunchPolicy(enterpriseConfig({ warmupComplete: true }).email);

    expect(policy).toMatchObject({
      launchMode: "configured_limits",
      stage: "configured",
      effectiveDailyLimit: 500,
      effectiveHourlyLimit: 100,
      effectiveMinimumIntervalSeconds: 120,
    });
  });

  it("keeps domain authentication as a hard blocker before credential checks", async () => {
    const { context } = emailStepContext(enterpriseConfig({ domainAuthVerified: false }));

    const result = await emailStep().run(context);

    expect(result).toMatchObject({
      type: "blocked",
      blocker: { code: "EMAIL_DOMAIN_SETUP_REQUIRED" },
    });
    expect(integrationMocks.verifyEmail).not.toHaveBeenCalled();
  });

  it("keeps SMTP and IMAP authentication failure as a hard blocker", async () => {
    integrationMocks.verifyEmail.mockRejectedValueOnce(new Error("authentication rejected"));
    const { context } = emailStepContext(enterpriseConfig());

    const result = await emailStep().run(context);

    expect(result).toMatchObject({
      type: "blocked",
      blocker: { code: "EMAIL_AUTH_FAILED" },
    });
  });

  it("installs enterprise outbound capability while preserving pause and approval gates", () => {
    const env = buildRemoteEnv(enterpriseConfig(), { email_password: "test-password" });

    expect(env).toContain("OUTBOUND_ENABLED=true");
    expect(env).toContain("EMAIL_OUTREACH_ENABLED=true");
    expect(env).toContain("EMAIL_INBOUND_ENABLED=true");
    expect(env).toContain("EMAIL_DOMAIN_AUTH_VERIFIED=true");
    expect(env).toContain("EMAIL_WARMUP_COMPLETE=false");
    expect(env).toContain("EMAIL_DAILY_LIMIT=500");
    expect(env).toContain("EMAIL_HOURLY_LIMIT=100");
    expect(env).toContain("EMAIL_MIN_INTERVAL_SECONDS=120");
    expect(env).toContain("EMAIL_SEND_REQUIRES_CONFIRMATION=true");
    expect(env).toContain("EXTERNAL_SEND_REQUIRES_CONFIRMATION=true");
    expect(env).toContain("REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true");
    expect(env).toContain("OUTREACH_APPROVAL_REQUIRED=true");
  });

  it("does not install outbound capability when email is disabled", () => {
    const config = enterpriseConfig();
    config.email.mode = "disabled";

    const env = buildRemoteEnv(config, {});

    expect(env).toContain("OUTBOUND_ENABLED=false");
    expect(env).toContain("EMAIL_OUTREACH_ENABLED=false");
    expect(env).toContain("EMAIL_INBOUND_ENABLED=false");
  });
});
