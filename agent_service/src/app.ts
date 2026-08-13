import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { config, hasTrustedFeishuRole } from "./config.js";
import { AgentDatabase } from "./db.js";
import { EmailInboundListener } from "./inbound/email-listener.js";
import { InboundProcessor } from "./inbound/processor.js";
import { WhatsAppInbound } from "./inbound/whatsapp.js";
import { InquiryFormWebhook } from "./inbound/form-webhook.js";
import { FeishuBitableSync } from "./integrations/bitable.js";
import { FeishuIntegration } from "./integrations/feishu.js";
import { JobWorker, jobLaneConcurrencyFromConfig } from "./jobs/worker.js";
import { DailyResearchScheduler } from "./jobs/daily-research.js";
import { DailyOperationsScheduler } from "./jobs/daily-operations.js";
import { registerOperationsDashboard } from "./dashboard/routes.js";
import { AgentLlm } from "./llm.js";
import { logger } from "./logger.js";
import { safeError } from "./safe-error.js";
import { CommandService } from "./commands/service.js";
import { OutboundDispatcher } from "./outreach/dispatcher.js";
import { currentDeliverabilityPolicy } from "./outreach/deliverability-policy.js";
import { MessageBuilder } from "./outreach/message-builder.js";
import { ensureGmailPilotState } from "./outreach/gmail-pilot.js";
import { ensureEmailChannelState } from "./outreach/email-channel.js";
import { DiscoveryService } from "./search/discovery.js";
import { configureHermesResearchHome } from "./search/hermes-research.js";
import {
  GMAIL_PILOT_DAILY_LIMIT,
  GMAIL_PILOT_HOURLY_LIMIT,
  GMAIL_PILOT_MIN_INTERVAL_SECONDS,
  isConsumerMailbox,
  isGmailMailbox,
  isGmailPilotMode,
} from "./outreach/email-policy.js";

const db = new AgentDatabase(config.AGENT_DB_PATH);
if (db.getSetting("outbound_paused") === null) db.setSetting("outbound_paused", "true");
if (db.getSetting("daily_operations_enabled") === null) {
  db.setSetting("daily_operations_enabled", String(config.DAILY_OPERATIONS_REPORT_ENABLED));
}
ensureGmailPilotState(config, db);
ensureEmailChannelState(config, db);
if (config.HERMES_RESEARCH_ENABLED) {
  try {
    const hermesHome = configureHermesResearchHome(config);
    logger.info({ home: hermesHome.home }, "Hermes research provider configured");
  } catch (error) {
    logger.error({ error }, "Hermes research provider is not ready; discovery will report model fallback");
  }
}

const llm = new AgentLlm(config, db);
const feishu = new FeishuIntegration(config, db);
const inboundProcessor = new InboundProcessor(config, db, feishu);
const emailListener = new EmailInboundListener(config, db, llm, inboundProcessor, feishu);
const whatsapp = new WhatsAppInbound(config, db, llm, inboundProcessor);
const inquiryFormWebhook = new InquiryFormWebhook(config, db, llm, inboundProcessor);
const bitable = new FeishuBitableSync(config, db);
const discovery = new DiscoveryService(config, db, llm);
const messageBuilder = new MessageBuilder(config, db, llm);
const dispatcher = new OutboundDispatcher(config, db);
const commands = new CommandService(config, db, llm, dispatcher);
const jobs = new JobWorker(config, db, discovery, messageBuilder, bitable, whatsapp, feishu, {
  laneConcurrency: jobLaneConcurrencyFromConfig(config),
});
const dailyResearch = new DailyResearchScheduler(config, db, feishu);
const dailyOperations = new DailyOperationsScheduler(
  db,
  {
    targetHour: config.DAILY_OPERATIONS_REPORT_HOUR,
    dailySendCapacity: config.EMAIL_DAILY_LIMIT,
    dispatchPlanLimit: config.EMAIL_DAILY_LIMIT,
    timeZone: config.DAILY_OPERATIONS_REPORT_TIMEZONE,
  },
  (limit) => dispatcher.plan(limit),
  { enqueue: (notification) => feishu.enqueueDailyOperationsReport(notification) },
);

function configuredOfficialEmailVerifiers(): Array<"hunter" | "bouncer"> {
  const providers: Array<"hunter" | "bouncer"> = [];
  if (config.ACQ_HUNTER_V2_ENABLED && config.HUNTER_API_KEY) providers.push("hunter");
  if (config.ACQ_BOUNCER_V2_ENABLED && config.BOUNCER_API_KEY) providers.push("bouncer");
  return providers;
}

const app = Fastify({ logger: false, bodyLimit: 2_000_000 });

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: false,
  runFirst: true,
});
await whatsapp.register(app);
await inquiryFormWebhook.register(app);
await registerOperationsDashboard(app, config, db, {
  feishuConnected: () => feishu.isConnected(),
  imapHealth: () => emailListener.getHealth(),
  dailyResearchEnabled: () => dailyResearch.isEnabled(),
  dispatchPlan: (limit) => dispatcher.plan(limit),
  deliverabilityPolicy: () => currentDeliverabilityPolicy(config, db),
  deliverabilityRecovery: () => db.getDeliverabilityRecoveryState({
    maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
    hardBounceWindowSize: 50,
    hardBounceMinimumSample: 20,
  }),
}, llm);

app.get("/health", async () => {
  const now = new Date();
  const database = db.checkIntegrity();
  const migration = db.getMigrationStatus();
  const officialEmailVerifiers = configuredOfficialEmailVerifiers();
  const emailChannel = ensureEmailChannelState(config, db);
  const emailDeliverabilityRecovery = db.getDeliverabilityRecoveryState({
    maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
    hardBounceWindowSize: 50,
    hardBounceMinimumSample: 20,
  });
  const sensitiveOperatorConfigured = hasTrustedFeishuRole(config, "SALES_MANAGER");
  return {
    ok: database.ok && migration.currentVersion === migration.latestVersion,
    mode: config.AGENT_MODE,
    outboundEnabled: config.OUTBOUND_ENABLED,
    outboundPaused: db.getSetting("outbound_paused") === "true",
    dailyResearchEnabled: dailyResearch.isEnabled(),
    dailyOperationsReportEnabled: dailyOperations.isEnabled(),
    officialEmailVerificationConfigured: officialEmailVerifiers.length > 0,
    officialEmailVerificationProviders: officialEmailVerifiers,
    gmailPilot: ensureGmailPilotState(config, db),
    emailChannel,
    emailDeliverabilityRecovery,
    emailDomainAuthVerified: config.EMAIL_DOMAIN_AUTH_VERIFIED,
    enterpriseDomainSender: !isConsumerMailbox(config.EMAIL_FROM_ADDRESS),
    feishuConnected: feishu.isConnected(),
    sensitiveOperatorConfigured,
    emailInboundEnabled: config.EMAIL_INBOUND_ENABLED,
    imapRuntimeHealth: emailListener.getHealth(),
    imapMessageFailures: db.getImapFailureSummary(),
    notificationOutbox: db.getNotificationOutboxSummary(now),
    database,
    schemaVersion: migration.currentVersion,
    latestSchemaVersion: migration.latestVersion,
    timestamp: now.toISOString(),
  };
});

app.get("/metrics", async (_request, reply) => {
  const foundation = db.getAcquisitionFoundationSummary();
  const imapHealth = emailListener.getHealth();
  const imapFailures = db.getImapFailureSummary();
  const notificationOutbox = db.getNotificationOutboxSummary();
  const emailChannel = ensureEmailChannelState(config, db);
  const deliverability = currentDeliverabilityPolicy(config, db);
  const deliverabilityRecovery = db.getDeliverabilityRecoveryState({
    maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
    hardBounceWindowSize: 50,
    hardBounceMinimumSample: 20,
  });
  const metrics = {
    ...db.getMetrics(),
    acquisitionAccounts: foundation.accounts,
    acquisitionPlayEnrollments: foundation.playEnrollments,
    acquisitionInquiryIntakes: foundation.inquiryIntakes,
    acquisitionQuarantinedIntakes: foundation.quarantinedIntakes,
    acquisitionOpportunities: foundation.opportunities,
    acquisitionOpenSalesTasks: foundation.openSalesTasks,
    imapRuntimeReady: imapHealth.sendReady ? 1 : 0,
    imapConsecutiveFailures: imapHealth.consecutiveFailures,
    imapLastSuccessAgeSeconds: imapHealth.ageSeconds ?? -1,
    imapRetryPendingMessages: imapFailures.retryPending,
    imapQuarantinedMessages: imapFailures.quarantined,
    imapUnreplayableMessages: imapFailures.unreplayable,
    notificationPending: notificationOutbox.pendingCount,
    notificationDue: notificationOutbox.dueCount,
    notificationOldestPendingAgeSeconds: notificationOutbox.oldestPendingAgeSeconds ?? -1,
    notificationDeadLetter: notificationOutbox.deadLetterCount,
    outboundPaused: db.getSetting("outbound_paused") === "true" ? 1 : 0,
    emailDomainAuthVerified: config.EMAIL_DOMAIN_AUTH_VERIFIED ? 1 : 0,
    sensitiveOperatorConfigured: hasTrustedFeishuRole(config, "SALES_MANAGER") ? 1 : 0,
    emailChannelSelfTestPassed: emailChannel.selfTestPassed ? 1 : 0,
    emailWarmupComplete: config.EMAIL_WARMUP_COMPLETE ? 1 : 0,
    emailDailyTarget: deliverability.dailyTarget,
    emailHourlyCeiling: deliverability.hourlyCeiling,
    emailMinimumIntervalSeconds: deliverability.minimumIntervalSeconds,
    emailHardBounceRate: deliverabilityRecovery.bounceStats.rate,
    emailHardBounceCount: deliverabilityRecovery.bounceStats.bounced,
    emailRecoveryRemainingMessages: deliverabilityRecovery.remainingMessages,
  };
  const lines = Object.entries(metrics).map(
    ([key, value]) => `export_agent_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} ${value}`,
  );
  return reply.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
});

app.get("/readiness", async () => {
  const database = db.checkIntegrity();
  const migration = db.getMigrationStatus();
  const bitableSchema = bitable.isConfigured()
    ? await withTimeout(
      bitable.validateSchema(),
      10_000,
      "Feishu Bitable schema validation timed out",
    ).catch((error) => ({
      ok: false,
      missing: [error instanceof Error && error.message.includes("timed out")
        ? "Feishu Bitable schema validation timed out"
        : "Feishu Bitable schema validation is temporarily unavailable"],
      fields: [],
    }))
    : { ok: false, missing: ["Feishu Bitable not configured"], fields: [] };
  const searchConfigured = Boolean(
    config.SERPER_API_KEY || config.EXA_API_KEY || config.SEARXNG_BASE_URL,
  );
  const strictResearchConfigured = Boolean(
    config.SEARCH_PROVIDER === "searxng" &&
      config.SEARXNG_BASE_URL &&
      config.ACQ_SEARXNG_V2_ENABLED &&
      config.SEARXNG_LOCAL_ENDPOINT_ALLOWED &&
      config.ACQ_LOCAL_PUBLIC_WEB_ENABLED,
  );
  const officialEmailVerificationProviders = configuredOfficialEmailVerifiers();
  const officialEmailVerificationConfigured = officialEmailVerificationProviders.length > 0;
  const tierBOfficialMailboxReady = strictResearchConfigured;
  const tierANamedContactReady = strictResearchConfigured && officialEmailVerificationConfigured;
  const deepEmailVerificationConfigured = Boolean(
    config.REACHER_BASE_URL || officialEmailVerificationConfigured,
  );
  const feishuBotConfigured = feishu.isEnabled();
  const sensitiveOperatorConfigured = hasTrustedFeishuRole(config, "SALES_MANAGER");
  const inquiryAlertDestinationConfigured = feishu.hasAlertDestinations();
  const baseEmailConfigured = Boolean(
    config.EMAIL_OUTREACH_ENABLED &&
      config.EMAIL_INBOUND_ENABLED &&
      config.SMTP_HOST &&
      config.SMTP_USER &&
      config.SMTP_PASSWORD &&
      config.IMAP_HOST &&
      config.IMAP_USER &&
      config.IMAP_PASSWORD &&
      config.EMAIL_FROM_ADDRESS &&
      config.EMAIL_UNSUBSCRIBE_TEXT &&
      config.COMPANY_POSTAL_ADDRESS,
  );
  const gmailPilotMode = isGmailPilotMode(config);
  const gmailPilotState = ensureGmailPilotState(config, db);
  const gmailPilotConfigured = Boolean(
    gmailPilotMode &&
      baseEmailConfigured &&
      config.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND &&
      config.OUTREACH_APPROVAL_REQUIRED &&
      !config.AUTO_FOLLOWUP_ENABLED &&
      config.EMAIL_DAILY_LIMIT <= GMAIL_PILOT_DAILY_LIMIT &&
      config.EMAIL_HOURLY_LIMIT <= GMAIL_PILOT_HOURLY_LIMIT &&
      config.EMAIL_MIN_INTERVAL_SECONDS >= GMAIL_PILOT_MIN_INTERVAL_SECONDS,
  );
  const emailConfigured = Boolean(
    baseEmailConfigured &&
      config.EMAIL_DOMAIN_AUTH_VERIFIED &&
      !isConsumerMailbox(config.EMAIL_FROM_ADDRESS),
  );
  const emailChannelState = ensureEmailChannelState(config, db);
  const imapRuntimeHealth = emailListener.getHealth();
  const emailDeliverability = currentDeliverabilityPolicy(config, db);
  const emailDeliverabilityRecovery = db.getDeliverabilityRecoveryState({
    maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
    hardBounceWindowSize: 50,
    hardBounceMinimumSample: 20,
  });
  const whatsappConfigured = Boolean(
    config.WHATSAPP_BUSINESS_API_ENABLED &&
      config.WHATSAPP_PHONE_NUMBER_ID &&
      config.WHATSAPP_ACCESS_TOKEN &&
      config.WHATSAPP_APP_SECRET &&
      config.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  );
  const inquiryFormWebhookConfigured = Boolean(
    config.INQUIRY_FORM_WEBHOOK_ENABLED && config.INQUIRY_FORM_HMAC_SECRET,
  );
  const productionBlockers: string[] = [];
  if (!database.ok) productionBlockers.push("database integrity check failed");
  if (migration.currentVersion !== migration.latestVersion) {
    productionBlockers.push("database migration is not current");
  }
  if (!searchConfigured) productionBlockers.push("search provider is not configured");
  if (!strictResearchConfigured) productionBlockers.push("strict campaign research runtime is not configured");
  if (!feishuBotConfigured) productionBlockers.push("Feishu bot is not configured");
  if (!sensitiveOperatorConfigured) {
    productionBlockers.push("Feishu sales-manager role is not configured");
  }
  if (!bitableSchema.ok) productionBlockers.push(...bitableSchema.missing);
  if (!inquiryAlertDestinationConfigured) {
    productionBlockers.push("inquiry alert destination is not configured");
  }
  if (!baseEmailConfigured) {
    productionBlockers.push("production SMTP/IMAP channel is not configured");
  } else {
    if (!config.EMAIL_DOMAIN_AUTH_VERIFIED) {
      productionBlockers.push("email domain authentication (SPF/DKIM/DMARC) is not verified");
    }
    if (isConsumerMailbox(config.EMAIL_FROM_ADDRESS)) {
      productionBlockers.push("production sender is not an enterprise-domain mailbox");
    }
  }
  const productionWarnings = !strictResearchConfigured
    ? ["tier A named contacts and tier B official role mailboxes are unavailable until strict public research is configured"]
    : !officialEmailVerificationConfigured
      ? ["tier B official role mailboxes are available; tier A named contacts remain blocked until an official verifier is configured"]
      : [];
  const productionSendBlockers = [...productionBlockers];
  if (config.AGENT_MODE !== "production") productionSendBlockers.push("AGENT_MODE is not production");
  if (!config.OUTBOUND_ENABLED) productionSendBlockers.push("OUTBOUND_ENABLED is false");
  if (!emailChannelState.selfTestPassed) {
    productionSendBlockers.push("enterprise mailbox send/receive self-test has not passed");
  }
  if (!imapRuntimeHealth.sendReady) {
    productionSendBlockers.push(`IMAP runtime reply monitoring is not healthy (${imapRuntimeHealth.state})`);
  }
  if (db.getSetting("outbound_paused") === "true") {
    productionSendBlockers.push("global outbound pause is active");
  }
  if (db.listUnknownDeliveryReconciliations(1).length > 0) {
    productionSendBlockers.push("email delivery reconciliation is required");
  }
  const pilotBlockers: string[] = [];
  if (!database.ok) pilotBlockers.push("database integrity check failed");
  if (migration.currentVersion !== migration.latestVersion) pilotBlockers.push("database migration is not current");
  if (!searchConfigured) pilotBlockers.push("search provider is not configured");
  if (!strictResearchConfigured) pilotBlockers.push("strict campaign research runtime is not configured");
  if (!feishuBotConfigured) pilotBlockers.push("Feishu bot is not configured");
  if (!sensitiveOperatorConfigured) pilotBlockers.push("Feishu sales-manager role is not configured");
  if (!bitableSchema.ok) pilotBlockers.push(...bitableSchema.missing);
  if (!inquiryAlertDestinationConfigured) pilotBlockers.push("inquiry alert destination is not configured");
  if (!config.CONSUMER_EMAIL_PILOT_ENABLED) pilotBlockers.push("CONSUMER_EMAIL_PILOT_ENABLED is false");
  if (!isGmailMailbox(config.EMAIL_FROM_ADDRESS)) pilotBlockers.push("pilot sender must be a Gmail mailbox");
  if (!gmailPilotConfigured) pilotBlockers.push("Gmail SMTP/IMAP pilot channel is not safely configured");
  if (config.AGENT_MODE !== "production") pilotBlockers.push("AGENT_MODE is not production");
  if (!config.OUTBOUND_ENABLED) pilotBlockers.push("OUTBOUND_ENABLED is false");
  if (!gmailPilotState.selfTestPassed) pilotBlockers.push("Gmail self-test has not passed");
  if (!gmailPilotState.activated) pilotBlockers.push("Gmail pilot has not been explicitly activated");
  if (!imapRuntimeHealth.sendReady) {
    pilotBlockers.push(`IMAP runtime reply monitoring is not healthy (${imapRuntimeHealth.state})`);
  }
  if (db.getSetting("outbound_paused") === "true") pilotBlockers.push("global outbound pause is active");
  return {
    ok: database.ok && migration.currentVersion === migration.latestVersion,
    dryRunSafe:
      config.AGENT_MODE === "dry_run" ||
      !config.OUTBOUND_ENABLED ||
      db.getSetting("outbound_paused") === "true" ||
      (gmailPilotMode && !gmailPilotState.activated),
    productionReady: productionBlockers.length === 0,
    productionBlockers,
    productionWarnings,
    productionSendReady: productionSendBlockers.length === 0,
    productionSendBlockers,
    pilotReady: pilotBlockers.length === 0,
    pilotBlockers,
    database,
    migration,
    searchConfigured,
    strictResearchConfigured,
    tierBOfficialMailboxReady,
    tierANamedContactReady,
    deepEmailVerificationConfigured,
    officialEmailVerificationConfigured,
    officialEmailVerificationProviders,
    feishuBotConfigured,
    sensitiveOperatorConfigured,
    inquiryAlertDestinationConfigured,
    baseEmailConfigured,
    emailDomainAuthVerified: config.EMAIL_DOMAIN_AUTH_VERIFIED,
    enterpriseDomainSender: !isConsumerMailbox(config.EMAIL_FROM_ADDRESS),
    emailConfigured,
    emailChannelState,
    imapRuntimeHealth,
    imapMessageFailures: db.getImapFailureSummary(),
    emailWarmupComplete: config.EMAIL_WARMUP_COMPLETE,
    emailDeliverability,
    emailDeliverabilityRecovery,
    gmailPilotMode,
    gmailPilotConfigured,
    gmailPilotState,
    bitableSchema,
    whatsappConfigured,
    inquiryFormWebhookConfigured,
    dailyOperationsReportEnabled: dailyOperations.isEnabled(),
    acquisitionFoundation: db.getAcquisitionFoundationSummary(),
  };
});

let dispatchTimer: NodeJS.Timeout | null = null;
let dispatchInFlight: Promise<void> | null = null;
let notificationTimer: NodeJS.Timeout | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationInFlight: Promise<void> | null = null;
let imapHealthTimer: NodeJS.Timeout | null = null;
let stopPromise: Promise<void> | null = null;

async function runDeliveryReconciliationWatchdog(): Promise<void> {
  const staleSeconds = Math.max(60, config.OUTBOUND_SENDING_STALE_SECONDS);
  const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const quarantined = db.quarantineStaleSendingMessages(cutoff, "delivery_watchdog");
  const outstanding = db.listUnknownDeliveryReconciliations(10_000);
  for (const message of outstanding) feishu.stageDeliveryReconciliation({ message });
  if (quarantined.length > 0) {
    logger.error(
      { count: quarantined.length, messageIds: quarantined.map((message) => message.id) },
      "Uncertain outbound deliveries were quarantined and all outbound was paused",
    );
  }
  await feishu.flushPendingNotifications();
}

function scheduleDeliveryReconciliationWatchdog(): void {
  if (reconciliationInFlight) return;
  reconciliationInFlight = runDeliveryReconciliationWatchdog()
    .catch((error) => logger.error({ error }, "Delivery reconciliation watchdog failed"))
    .finally(() => {
      reconciliationInFlight = null;
    });
}

async function start(): Promise<void> {
  await runDeliveryReconciliationWatchdog();
  await app.listen({ host: config.AGENT_HTTP_HOST, port: config.AGENT_HTTP_PORT });
  logger.info(
    { host: config.AGENT_HTTP_HOST, port: config.AGENT_HTTP_PORT, mode: config.AGENT_MODE },
    "Agent HTTP service started",
  );
  await feishu.start(
    (input) => commands.handleText(input),
    (input) => commands.handleAction(input),
  );
  await emailListener.start();
  jobs.start();
  dailyResearch.start();
  dailyOperations.start();
  notificationTimer = setInterval(
    () => void feishu.flushPendingNotifications().catch((error) => logger.error({ error }, "Notification retry failed")),
    30_000,
  );
  reconciliationTimer = setInterval(scheduleDeliveryReconciliationWatchdog, 60_000);
  if (config.EMAIL_INBOUND_ENABLED) {
    imapHealthTimer = setInterval(
      () => emailListener.enforceHealthGate(),
      Math.min(30, Math.max(15, config.EMAIL_POLL_SECONDS)) * 1000,
    );
  }
  if (config.OUTBOUND_ENABLED) {
    dispatchTimer = setInterval(
      () => {
        if (dispatchInFlight) return;
        dispatchInFlight = dispatcher.runOnce()
          .then((result) => {
            if (result.unknown > 0) scheduleDeliveryReconciliationWatchdog();
          })
          .catch((error) => logger.error({ error }, "Outbound dispatcher failed"))
          .finally(() => {
            dispatchInFlight = null;
          });
      },
      60_000,
    );
  }
}

function stop(signal: string): Promise<void> {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    logger.info({ signal }, "Agent service stopping");
    if (dispatchTimer) clearInterval(dispatchTimer);
    if (notificationTimer) clearInterval(notificationTimer);
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    if (imapHealthTimer) clearInterval(imapHealthTimer);
    dailyResearch.stop();
    dailyOperations.stop();
    await jobs.stop();
    await dispatchInFlight;
    await reconciliationInFlight;
    await emailListener.stop();
    await feishu.stop();
    await app.close();
    dispatcher.close();
    db.close();
  })();
  return stopPromise;
}

process.once("SIGINT", () => void stop("SIGINT").finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop("SIGTERM").finally(() => process.exit(0)));

start().catch(async (error) => {
  logger.fatal({ error: safeError(error, [config.FEISHU_APP_SECRET]) }, "Agent service failed to start");
  await stop("STARTUP_FAILURE").catch((shutdownError) => {
    logger.error({ error: shutdownError }, "Agent service shutdown after startup failure was incomplete");
  });
  process.exit(1);
});
