import { z } from "zod";

export const installStepIds = [
  "collect_configuration",
  "check_windows",
  "confirm_feishu",
  "confirm_email",
  "confirm_search",
  "confirm_whatsapp",
  "verify_server",
  "verify_payload",
  "deploy_release",
  "bootstrap_bitable",
  "pair_feishu",
  "final_acceptance",
] as const;

export const installStepIdSchema = z.enum(installStepIds);
export type InstallStepId = z.infer<typeof installStepIdSchema>;

export const installStatusSchema = z.enum([
  "DRAFT",
  "RUNNING",
  "BLOCKED",
  "FAILED",
  "ROLLING_BACK",
  "COMPLETED",
]);
export type InstallStatus = z.infer<typeof installStatusSchema>;

export const stepStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "ROLLED_BACK",
  "SKIPPED",
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const emailModeSchema = z.enum(["disabled", "gmail_pilot", "enterprise"]);
export const searchProviderSchema = z.enum(["searxng", "serper", "exa"]);
export const sshAuthModeSchema = z.enum(["password", "private_key"]);

export const installerConfigSchema = z.object({
  business: z.object({
    legalName: z.string().trim().min(2),
    brandName: z.string().trim().min(1),
    website: z.url(),
    country: z.string().trim().min(2),
    city: z.string().trim().min(1),
    postalAddress: z.string().trim().min(5),
    contactName: z.string().trim().min(2),
    contactTitle: z.string().trim().min(2),
    contactEmail: z.email(),
    whatsapp: z.string().trim().optional().default(""),
    introduction: z.string().trim().min(30),
  }),
  product: z.object({
    name: z.string().trim().min(3),
    hsCode: z.string().trim().min(2),
    specifications: z.array(z.string().trim().min(1)).min(1),
    sellingPoints: z.array(z.string().trim().min(1)).min(1),
    targetMarkets: z.array(z.string().trim().min(2)).min(1),
    buyerTypes: z.array(z.string().trim().min(2)).min(1),
    moq: z.string().trim().min(1),
    leadTime: z.string().trim().min(1),
    priceRule: z.string().trim().min(1),
  }),
  ai: z.object({
    baseUrl: z.url(),
    model: z.string().trim().min(1),
  }),
  feishu: z.object({
    enabled: z.boolean().default(true),
    domain: z.enum(["feishu", "lark"]).default("feishu"),
    appId: z.string().trim().min(5),
    setupConfirmed: z.boolean().default(false),
    crmName: z.string().trim().min(2),
  }),
  email: z.object({
    mode: emailModeSchema,
    fromAddress: z.string().trim().refine((value) => value === "" || z.email().safeParse(value).success),
    fromName: z.string().trim().min(2),
    replyTo: z.string().trim().refine((value) => value === "" || z.email().safeParse(value).success),
    smtpHost: z.string().trim(),
    smtpPort: z.number().int().min(1).max(65535),
    smtpUser: z.string().trim(),
    imapHost: z.string().trim(),
    imapPort: z.number().int().min(1).max(65535),
    imapUser: z.string().trim(),
    dailyLimit: z.number().int().min(1).max(500),
    hourlyLimit: z.number().int().min(1).max(100),
    unsubscribeText: z.string().trim(),
    domainAuthVerified: z.boolean().default(false),
    warmupComplete: z.boolean().default(false),
  }),
  search: z.object({
    provider: searchProviderSchema,
    baseUrl: z.string().trim().default(""),
  }),
  server: z.object({
    host: z.string().trim().min(3),
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().trim().min(1),
    authMode: sshAuthModeSchema,
    privateKeyPath: z.string().trim().default(""),
    appDir: z
      .string()
      .trim()
      .regex(/^(?:~\/|\/)[A-Za-z0-9_./-]+$/, "Use a safe absolute path or a path beginning with ~/.")
      .default("~/export-ai-agent"),
    replaceExistingEnv: z.boolean().default(false),
    hostFingerprint: z.string().trim().default(""),
  }),
  whatsapp: z.object({
    enabled: z.boolean().default(false),
    setupConfirmed: z.boolean().default(false),
    graphApiVersion: z.string().trim().default("v23.0"),
    phoneNumberId: z.string().trim().default(""),
    templateName: z.string().trim().default(""),
    templateLanguage: z.string().trim().default("en_US"),
    publicBaseUrl: z.string().trim().default(""),
    dailyLimit: z.number().int().min(1).max(1000).default(20),
  }),
  confirmations: z.object({
    publicDataOnly: z.literal(true),
    humanApprovalBeforeSend: z.literal(true),
    initialOutboundPause: z.literal(true),
  }),
});

export type InstallerConfig = z.infer<typeof installerConfigSchema>;

export const secretNames = [
  "ai_api_key",
  "feishu_app_secret",
  "feishu_pairing_code",
  "email_password",
  "search_api_key",
  "server_password",
  "server_private_key",
  "whatsapp_access_token",
  "whatsapp_app_secret",
  "whatsapp_verify_token",
] as const;
export type SecretName = (typeof secretNames)[number];

export const secretPresenceSchema = z.object({
  ai_api_key: z.boolean().optional(),
  feishu_app_secret: z.boolean().optional(),
  feishu_pairing_code: z.boolean().optional(),
  email_password: z.boolean().optional(),
  search_api_key: z.boolean().optional(),
  server_password: z.boolean().optional(),
  server_private_key: z.boolean().optional(),
  whatsapp_access_token: z.boolean().optional(),
  whatsapp_app_secret: z.boolean().optional(),
  whatsapp_verify_token: z.boolean().optional(),
});
export type SecretPresence = z.infer<typeof secretPresenceSchema>;

export interface InstallerConfigurationInput {
  config: InstallerConfig;
  secrets?: Partial<Record<SecretName, string>>;
}

export const blockerSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  message: z.string().min(1),
  actionLabel: z.string().optional(),
  externalUrl: z.string().optional(),
  requiredFields: z.array(z.string()).default([]),
  canRetry: z.boolean().default(true),
});
export type InstallerBlocker = z.infer<typeof blockerSchema>;

export const stepRecordSchema = z.object({
  id: installStepIdSchema,
  status: stepStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  checkpointId: z.string().nullable(),
  blocker: blockerSchema.nullable(),
  error: z.string().nullable(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;

export const installEventSchema = z.object({
  at: z.string(),
  stepId: installStepIdSchema.nullable(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
});
export type InstallEvent = z.infer<typeof installEventSchema>;

export const installStateSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: z.string().uuid(),
  productVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: installStatusSchema,
  currentStepId: installStepIdSchema.nullable(),
  config: installerConfigSchema.nullable(),
  secretPresence: secretPresenceSchema,
  steps: z.array(stepRecordSchema).length(installStepIds.length),
  events: z.array(installEventSchema),
  metadata: z.record(z.string(), z.unknown()),
});
export type InstallState = z.infer<typeof installStateSchema>;

export interface InstallerSnapshot {
  state: InstallState;
  canStart: boolean;
  canResume: boolean;
  canRetry: boolean;
  canRollback: boolean;
}

export interface DiagnosticsExportResult {
  path: string;
}

export interface InstallerApi {
  getSnapshot(): Promise<InstallerSnapshot>;
  saveConfiguration(input: InstallerConfigurationInput): Promise<InstallerSnapshot>;
  start(): Promise<InstallerSnapshot>;
  resume(): Promise<InstallerSnapshot>;
  retry(): Promise<InstallerSnapshot>;
  rollback(): Promise<InstallerSnapshot>;
  getPairingCode(): Promise<string>;
  exportDiagnostics(): Promise<DiagnosticsExportResult>;
  openExternal(url: string): Promise<void>;
  onSnapshot(listener: (snapshot: InstallerSnapshot) => void): () => void;
}
