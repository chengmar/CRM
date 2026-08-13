import crypto from "node:crypto";
import path from "node:path";
import type { InstallStepId, InstallerBlocker, InstallerConfig } from "../../shared/contracts.js";
import type { InstallerStepDefinition, InstallerStepMap, StepOutcome } from "../engine/engine.js";
import type { InstallerSecretStore } from "../engine/secrets.js";
import { checkOperatorSystem } from "./system-check.js";
import { verifyAiProvider, verifyEmail, verifyFeishu, verifySearchProvider, verifyWhatsApp } from "./integrations.js";
import { buildCustomerPayload, verifyBasePayload } from "./customer-payload.js";
import { probeServer, resolveSshCredentials, shellQuote } from "./ssh.js";
import { deployRelease, rollbackRemoteRelease, runRemoteCommand } from "./deployment.js";
import { hasAuthorizedFeishuOperator } from "./pairing.js";
import { CONFIGURED_EMAIL_MIN_INTERVAL_SECONDS } from "./env-builder.js";

export interface RuntimeStepDependencies {
  userDataDir: string;
  payloadDir: string;
  secretStore: InstallerSecretStore;
}

export interface EnterpriseEmailLaunchPolicy {
  launchMode: "staged_controlled_ramp" | "configured_limits";
  stage: "enterprise_initial_reputation_check" | "configured";
  effectiveDailyLimit: number;
  effectiveHourlyLimit: number;
  effectiveMinimumIntervalSeconds: number;
  smtpImapAuthSmokeRequired: true;
  sendReceiveSelfTestRequired: true;
  explicitGlobalPauseReleaseRequired: true;
  humanApprovalRequired: true;
}

export function getEnterpriseEmailLaunchPolicy(
  email: Pick<InstallerConfig["email"], "dailyLimit" | "hourlyLimit" | "warmupComplete">,
): EnterpriseEmailLaunchPolicy {
  const sharedRequirements = {
    smtpImapAuthSmokeRequired: true,
    sendReceiveSelfTestRequired: true,
    explicitGlobalPauseReleaseRequired: true,
    humanApprovalRequired: true,
  } as const;
  if (email.warmupComplete) {
    return {
      launchMode: "configured_limits",
      stage: "configured",
      effectiveDailyLimit: email.dailyLimit,
      effectiveHourlyLimit: email.hourlyLimit,
      effectiveMinimumIntervalSeconds: CONFIGURED_EMAIL_MIN_INTERVAL_SECONDS,
      ...sharedRequirements,
    };
  }
  return {
    launchMode: "staged_controlled_ramp",
    stage: "enterprise_initial_reputation_check",
    effectiveDailyLimit: Math.min(email.dailyLimit, 10),
    effectiveHourlyLimit: Math.min(email.hourlyLimit, 2),
    effectiveMinimumIntervalSeconds: Math.max(CONFIGURED_EMAIL_MIN_INTERVAL_SECONDS, 900),
    ...sharedRequirements,
  };
}

function blocker(
  code: string,
  title: string,
  message: string,
  externalUrl?: string,
): { type: "blocked"; blocker: InstallerBlocker } {
  return {
    type: "blocked",
    blocker: {
      code,
      title,
      message,
      actionLabel: externalUrl ? "Open platform" : "Review configuration",
      externalUrl,
      requiredFields: [],
      canRetry: true,
    },
  };
}

function configOf(state: { config: InstallerConfig | null }): InstallerConfig {
  if (!state.config) throw new Error("Installer configuration is missing.");
  return state.config;
}

function appDirExpression(config: InstallerConfig): string {
  if (config.server.appDir.startsWith("~/")) return `\${HOME}/${config.server.appDir.slice(2)}`;
  return config.server.appDir;
}

export function createRuntimeStepMap(deps: RuntimeStepDependencies): InstallerStepMap {
  const definitions: InstallerStepDefinition[] = [
    {
      id: "collect_configuration",
      run: async () => ({ type: "completed", checkpoint: true }),
    },
    {
      id: "check_windows",
      run: async (context) => {
        const report = await checkOperatorSystem(deps.userDataDir);
        if (!report.supported) throw new Error(report.blockers.join(" "));
        await context.log(`Windows ${report.release}, ${report.architecture}, free ${Math.round(report.freeBytes / 1024 ** 3)} GB.`);
        return { type: "completed", checkpoint: true, metadata: { systemReport: report } };
      },
    },
    {
      id: "confirm_feishu",
      run: async (context) => {
        const config = configOf(context.state);
        if (!config.feishu.setupConfirmed) {
          return blocker(
            "FEISHU_SETUP_REQUIRED",
            "Complete the Feishu application setup",
            "Enable the bot, import the required scopes, select WebSocket events, subscribe to im.message.receive_v1 and card.action.trigger, publish the app, and include the operator in its availability range.",
            config.feishu.domain === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
          );
        }
        try {
          await verifyFeishu(config, await deps.secretStore.get("feishu_app_secret"));
        } catch (error) {
          return blocker("FEISHU_AUTH_FAILED", "Feishu credentials need correction", error instanceof Error ? error.message : String(error));
        }
        return { type: "completed", checkpoint: true };
      },
    },
    {
      id: "confirm_email",
      run: async (context) => {
        const config = configOf(context.state);
        if (config.email.mode === "disabled") return { type: "skipped" };
        if (config.email.mode === "enterprise" && !config.email.domainAuthVerified) {
          return blocker(
            "EMAIL_DOMAIN_SETUP_REQUIRED",
            "Complete enterprise email authentication",
            "Confirm SPF, DKIM, and DMARC before continuing. SMTP and IMAP credentials are verified in the next check. No email is sent during installation.",
          );
        }
        try {
          await verifyEmail(config, await deps.secretStore.get("email_password"));
        } catch {
          return blocker(
            "EMAIL_AUTH_FAILED",
            "Email application password needs correction",
            "SMTP or IMAP authentication failed. Check the mailbox, ports, two-step verification, and application password. No email was sent.",
          );
        }
        if (config.email.mode !== "enterprise") return { type: "completed", checkpoint: true };

        const emailLaunchPolicy = getEnterpriseEmailLaunchPolicy(config.email);
        const limits = `${emailLaunchPolicy.effectiveDailyLimit}/day, ${emailLaunchPolicy.effectiveHourlyLimit}/hour, minimum interval ${emailLaunchPolicy.effectiveMinimumIntervalSeconds} seconds`;
        if (emailLaunchPolicy.launchMode === "staged_controlled_ramp") {
          await context.log(
            `Enterprise email authentication passed. Installation will continue in controlled staged mode (${limits}). Global outbound remains paused until final acceptance and explicit release.`,
            "warn",
          );
        } else {
          await context.log(
            `Enterprise email authentication passed. Configured limits will apply after final acceptance and explicit global pause release (${limits}).`,
          );
        }
        return { type: "completed", checkpoint: true, metadata: { emailLaunchPolicy } };
      },
    },
    {
      id: "confirm_search",
      run: async (context) => {
        const config = configOf(context.state);
        try {
          await verifyAiProvider(config, await deps.secretStore.get("ai_api_key"));
          await verifySearchProvider(config, await deps.secretStore.get("search_api_key"));
        } catch (error) {
          return blocker("AI_OR_SEARCH_AUTH_FAILED", "AI or search credentials need correction", error instanceof Error ? error.message : String(error));
        }
        return { type: "completed", checkpoint: true };
      },
    },
    {
      id: "confirm_whatsapp",
      run: async (context) => {
        const config = configOf(context.state);
        if (!config.whatsapp.enabled) return { type: "skipped" };
        if (!config.whatsapp.setupConfirmed) {
          return blocker(
            "WHATSAPP_SETUP_REQUIRED",
            "Complete WhatsApp Business setup",
            "Create or verify the Meta business, WABA, dedicated phone number, system-user token, approved template, public HTTPS webhook, and messages subscription.",
            "https://business.facebook.com/wa/manage/home/",
          );
        }
        try {
          await verifyWhatsApp(config, await deps.secretStore.get("whatsapp_access_token"));
        } catch (error) {
          return blocker("WHATSAPP_AUTH_FAILED", "WhatsApp credentials need correction", error instanceof Error ? error.message : String(error));
        }
        return { type: "completed", checkpoint: true };
      },
    },
    {
      id: "verify_server",
      run: async (context): Promise<StepOutcome> => {
        const config = configOf(context.state);
        const credentials = await resolveSshCredentials(
          config,
          await deps.secretStore.get("server_password"),
          await deps.secretStore.get("server_private_key"),
        );
        try {
          const probe = await probeServer(config, credentials, config.server.hostFingerprint);
          if (!config.server.hostFingerprint) {
            context.state.metadata.pendingHostFingerprint = probe.fingerprint;
            await context.log(`Discovered VPS host fingerprint ${probe.fingerprint}.`);
            return blocker(
              "HOST_FINGERPRINT_CONFIRMATION",
              "Confirm the VPS host fingerprint",
              "Compare the fingerprint in the secure panel with the value shown by your VPS provider. Continue only when they match.",
            );
          }
          if (probe.osId !== "ubuntu" || !new Set(["22.04", "24.04"]).has(probe.osVersion)) {
            return blocker(
              "UNSUPPORTED_VPS_OS",
              "Use a supported Ubuntu VPS",
              `Detected ${probe.osId || "unknown"} ${probe.osVersion || "unknown"}. Ubuntu 22.04 or 24.04 is required.`,
            );
          }
          if (!probe.sudoReady) {
            return blocker(
              "PASSWORDLESS_SUDO_REQUIRED",
              "Grant deployment privileges",
              "Use the root account or configure passwordless sudo for this dedicated deployment user, then resume. The installer does not place sudo passwords in remote command lines.",
            );
          }
          return { type: "completed", checkpoint: true, metadata: { serverProbe: probe } };
        } catch (error) {
          return blocker("VPS_CONNECTION_FAILED", "VPS connection needs correction", error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      id: "verify_payload",
      run: async (context) => {
        const config = configOf(context.state);
        const verified = await verifyBasePayload(deps.payloadDir);
        const configHash = crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
        const outputPath = path.join(deps.userDataDir, "staging", context.state.installationId, `customer-release-${configHash.slice(0, 12)}.zip`);
        const result = await buildCustomerPayload(verified.zipPath, outputPath, config, context.state.installationId);
        return {
          type: "completed",
          checkpoint: true,
          metadata: {
            customerPayload: { ...result, configHash, baseVersion: verified.manifest.productVersion },
          },
        };
      },
    },
    {
      id: "deploy_release",
      run: async (context) => {
        const config = configOf(context.state);
        const payload = context.state.metadata.customerPayload as { path?: string } | undefined;
        if (!payload?.path) throw new Error("Customer deployment payload is missing.");
        const metadata = await deployRelease(context, config, deps.secretStore, payload.path);
        return { type: "completed", checkpoint: true, metadata };
      },
      rollback: async (context) => {
        await rollbackRemoteRelease(configOf(context.state), deps.secretStore);
      },
    },
    {
      id: "bootstrap_bitable",
      run: async (context) => {
        const config = configOf(context.state);
        const appDir = appDirExpression(config);
        const command = `cd "${appDir}/agent_service" && node dist/cli.js bootstrap-bitable ${shellQuote(config.feishu.crmName)} && sudo -n systemctl restart export-ai-agent-service`;
        const result = await runRemoteCommand(config, deps.secretStore, command, 5 * 60_000);
        if (result.code !== 0) {
          return blocker("BITABLE_BOOTSTRAP_FAILED", "Feishu Bitable could not be created", result.stderr || result.stdout);
        }
        return { type: "completed", checkpoint: true, metadata: { bitableBootstrap: result.stdout.trim() } };
      },
    },
    {
      id: "pair_feishu",
      run: async (context) => {
        const config = configOf(context.state);
        const appDir = appDirExpression(config);
        const status = await runRemoteCommand(
          config,
          deps.secretStore,
          `cd "${appDir}/agent_service" && node dist/cli.js status`,
        );
        if (status.code !== 0) throw new Error(status.stderr || "Unable to read Agent status.");
        if (!hasAuthorizedFeishuOperator(status.stdout)) {
          return blocker(
            "FEISHU_PAIRING_REQUIRED",
            "Bind the Feishu operator and alert destination",
            "In a private chat send '绑定 <配对码>'. In the sales group send '绑定群 <配对码>'. Then return here and continue.",
          );
        }
        const clearPairing = await runRemoteCommand(
          config,
          deps.secretStore,
          `sed -i 's/^FEISHU_PAIRING_CODE=.*/FEISHU_PAIRING_CODE=/' "${appDir}/.env" && sudo -n systemctl restart export-ai-agent-service`,
        );
        if (clearPairing.code !== 0) throw new Error(clearPairing.stderr || "Unable to clear the one-time pairing code.");
        await deps.secretStore.remove("feishu_pairing_code");
        return { type: "completed", checkpoint: true };
      },
    },
    {
      id: "final_acceptance",
      run: async (context) => {
        const config = configOf(context.state);
        const appDir = appDirExpression(config);
        const result = await runRemoteCommand(
          config,
          deps.secretStore,
          `cd "${appDir}" && pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/run-fresh-install-acceptance.ps1 -Workspace "${appDir}"`,
          20 * 60_000,
        );
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Fresh-install acceptance failed.");
        return { type: "completed", checkpoint: true, metadata: { finalAcceptance: result.stdout.trim() } };
      },
    },
  ];

  return Object.fromEntries(definitions.map((definition) => [definition.id, definition])) as Record<
    InstallStepId,
    InstallerStepDefinition
  >;
}
