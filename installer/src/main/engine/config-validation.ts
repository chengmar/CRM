import {
  installerConfigSchema,
  type InstallerConfig,
  type SecretName,
  type SecretPresence,
} from "../../shared/contracts.js";

export interface ConfigurationValidation {
  ok: boolean;
  errors: string[];
}

function requireSecret(
  errors: string[],
  presence: SecretPresence,
  name: SecretName,
  label: string,
): void {
  if (!presence[name]) errors.push(`${label} is required.`);
}

export function validateConfiguration(
  config: InstallerConfig,
  presence: SecretPresence,
): ConfigurationValidation {
  const parsed = installerConfigSchema.safeParse(config);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

  requireSecret(errors, presence, "ai_api_key", "AI API key");
  if (!config.feishu.enabled) {
    errors.push("Feishu or Lark is required for Agent commands and inquiry alerts.");
  } else {
    requireSecret(errors, presence, "feishu_app_secret", "Feishu App Secret");
  }

  if (config.email.mode === "disabled") {
    errors.push("SMTP/IMAP email is required for a complete lead-generation installation.");
  } else {
    for (const [value, label] of [
      [config.email.fromAddress, "Sender email"],
      [config.email.smtpHost, "SMTP host"],
      [config.email.smtpUser, "SMTP user"],
      [config.email.imapHost, "IMAP host"],
      [config.email.imapUser, "IMAP user"],
      [config.email.unsubscribeText, "Unsubscribe text"],
    ]) {
      if (!value) errors.push(`${label} is required when email is enabled.`);
    }
    requireSecret(errors, presence, "email_password", "Email app password");
    if (config.email.mode === "gmail_pilot") {
      if (!/@gmail\.com$/i.test(config.email.fromAddress)) {
        errors.push("Gmail pilot mode requires a gmail.com sender.");
      }
      if (config.email.smtpHost.toLowerCase() !== "smtp.gmail.com") {
        errors.push("Gmail pilot SMTP host must be smtp.gmail.com.");
      }
      if (![465, 587].includes(config.email.smtpPort)) {
        errors.push("Gmail pilot SMTP port must be 465 or 587.");
      }
      if (config.email.imapHost.toLowerCase() !== "imap.gmail.com" || config.email.imapPort !== 993) {
        errors.push("Gmail pilot IMAP must use imap.gmail.com:993.");
      }
      if (config.email.smtpUser.toLowerCase() !== config.email.fromAddress.toLowerCase()) {
        errors.push("Gmail pilot SMTP user must match the sender email.");
      }
      if (config.email.imapUser.toLowerCase() !== config.email.fromAddress.toLowerCase()) {
        errors.push("Gmail pilot IMAP user must match the sender email.");
      }
      if (config.email.dailyLimit > 100 || config.email.hourlyLimit > 20) {
        errors.push("Gmail pilot target cannot exceed 100/day or an adaptive ceiling of 20/hour.");
      }
    }
  }

  if (config.search.provider === "serper" || config.search.provider === "exa") {
    requireSecret(errors, presence, "search_api_key", `${config.search.provider} API key`);
  }

  if (config.server.authMode === "password") {
    requireSecret(errors, presence, "server_password", "VPS SSH password");
  } else if (!config.server.privateKeyPath && !presence.server_private_key) {
    errors.push("A private-key path or pasted private key is required.");
  }

  if (config.whatsapp.enabled) {
    requireSecret(errors, presence, "whatsapp_access_token", "WhatsApp access token");
    requireSecret(errors, presence, "whatsapp_app_secret", "WhatsApp App Secret");
    requireSecret(errors, presence, "whatsapp_verify_token", "WhatsApp verify token");
    if (!config.whatsapp.phoneNumberId || !config.whatsapp.templateName || !config.whatsapp.publicBaseUrl) {
      errors.push("WhatsApp Phone Number ID, template name, and public HTTPS URL are required.");
    }
  }

  return { ok: errors.length === 0, errors };
}
