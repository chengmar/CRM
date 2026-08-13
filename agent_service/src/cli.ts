import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "./config.js";
import { AgentDatabase } from "./db.js";
import { upsertEnvFile } from "./env-file.js";
import { FeishuBitableSync } from "./integrations/bitable.js";
import { FeishuIntegration } from "./integrations/feishu.js";
import { InboundProcessor } from "./inbound/processor.js";
import { classifyInbound } from "./inbound/classifier.js";
import { AgentLlm } from "./llm.js";
import { OutboundDispatcher } from "./outreach/dispatcher.js";
import { activateGmailPilot, ensureGmailPilotState } from "./outreach/gmail-pilot.js";
import { verifyEmail } from "./search/email-verifier.js";
import { DEMAND_POLICY_VERSION } from "./types.js";
import { getDomain } from "tldts";
import { runAcquisitionFoundationShadow } from "./acquisition/foundation-shadow.js";
import { runCrawlRoutingShadow } from "./acquisition/crawl-shadow.js";
import { runProviderShadowBakeoff } from "./acquisition/providers/provider-shadow.js";
import { runMarketAllocationShadow } from "./acquisition/market-shadow.js";
import { runPausedTransportShadow } from "./outreach/transports/paused-shadow.js";
import { runManualChannelShadow } from "./acquisition/manual-channel.js";
import { runExperimentSystemShadow } from "./acquisition/experiment-system.js";
import { runSignalMonitoringShadow } from "./acquisition/signal-monitoring.js";
import { runContentPilotShadow } from "./acquisition/content-pilot-catalog.js";
import { runCommercialFunnelOperator } from "./reporting/commercial-funnel.js";
import {
  launchAutonomousPilot,
  parseAutonomousPilotLaunchCliArgs,
  readAutonomousPilotLaunchSpec,
} from "./acquisition/autonomous-pilot-launch.js";
import {
  launchAutonomousResearch,
  parseAutonomousResearchLaunchCliArgs,
  readAutonomousResearchLaunchSpec,
} from "./acquisition/autonomous-research-launch.js";
import { replayAuthorizedAutonomousCampaignMessages } from "./acquisition/autonomous-discovery-message-bridge.js";
import {
  parseRefreshTierBEvidenceCliArgs,
  refreshTierBEvidence,
} from "./acquisition/refresh-tier-b-evidence.js";
import { scheduleContinuousAcquisition } from "./acquisition/continuous-operations.js";

const requestedCommand = process.argv[2] ?? "status";
const db = new AgentDatabase(config.AGENT_DB_PATH, {
  readOnly: requestedCommand === "commercial-funnel",
});
const llm = new AgentLlm(config, db);
const feishu = new FeishuIntegration(config, db);
const processor = new InboundProcessor(config, db, feishu);
const dispatcher = new OutboundDispatcher(config, db);
const bitable = new FeishuBitableSync(config, db);

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function field(row: Record<string, string>, name: string): string {
  return row[name]?.trim() ?? "";
}

function argumentValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(3).find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

async function importLegacy(): Promise<void> {
  const csvPath = path.join(
    config.businessDataDir,
    "crm_import.csv",
  );
  const rows = parse(fs.readFileSync(csvPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  }) as Array<Record<string, string>>;
  let campaignId = db.getSetting("legacy_campaign_id");
  if (!campaignId) {
    const markets = [...new Set(rows.map((row) => field(row, "country")).filter(Boolean))].join(", ") || "unspecified";
    campaignId = db.createCampaign({
      name: "initial-crm-import",
      market: markets,
      product: config.DEFAULT_PRODUCT,
      buyerType: config.DEFAULT_BUYER_TYPE,
      targetCount: rows.length,
      createdBy: "legacy_import",
      dailyLimit: config.EMAIL_DAILY_LIMIT,
      hourlyLimit: config.EMAIL_HOURLY_LIMIT,
      followupDays: config.followupDays,
    });
    db.setSetting("legacy_campaign_id", campaignId);
  }
  if (!campaignId) throw new Error("Legacy campaign could not be created");

  let imported = 0;
  for (const row of rows) {
    const website = field(row, "website") || field(row, "source_url");
    if (!website) continue;
    const domain = getDomain(website) ?? new URL(website).hostname.replace(/^www\./, "");
    const rawScore = Number.parseInt(field(row, "score") || "0", 10) || 0;
    const fitScore = Math.min(30, Math.round(rawScore * 0.3));
    const leadId = db.upsertLead({
      campaignId,
      company: field(row, "company"),
      domain,
      website,
      country: field(row, "country"),
      buyerType: field(row, "buyer_type"),
      product: field(row, "product"),
      fitScore,
      intentScore: 0,
      activityScore: 0,
      contactScore: 0,
      channelScore: 0,
      totalScore: fitScore,
      grade: field(row, "grade") || "BRONZE",
      demandEvidenceQualified: false,
      demandPolicyVersion: "",
      demandStage: "INDUSTRY_FIT",
      demandEvidence: [],
      sendEligible: false,
      eligibilityReasons: [
        "legacy company-level lead",
        "no verified recent activity",
        "no named current decision maker",
        "no deeply verified mailbox",
      ],
    });
    db.addLeadSource(
      leadId,
      field(row, "source_url") || website,
      "official_website",
      null,
      field(row, "match_reason") || "legacy source",
    );
    const current = db.getLead(leadId);
    if (current?.status === "NEW") {
      db.transitionLead(leadId, "VERIFYING", "legacy_import", "legacy verification audit");
      db.transitionLead(leadId, "REJECTED", "legacy_import", "does not meet production send gate");
    }
    const contactName = field(row, "contact_name");
    const email = field(row, "email");
    const generic = /official|team|route|unknown|sales inquiry/i.test(contactName);
    if (email && !generic) {
      const verification = await verifyEmail(email, config);
      db.upsertContact({
        leadId,
        name: contactName,
        title: field(row, "title"),
        email: verification.email,
        sourceUrl: field(row, "source_url") || website,
        emailStatus: verification.status,
        emailRisk: verification.reason,
        roleAddress: verification.roleAddress,
        disposableAddress: verification.disposableAddress,
        catchAll: verification.catchAll,
      });
    }
    imported += 1;
  }
  print({ imported, campaignId, metrics: db.getMetrics() });
}

async function simulateInquiry(): Promise<void> {
  if (config.AGENT_MODE !== "dry_run" || config.OUTBOUND_ENABLED) {
    throw new Error("simulate-inquiry is restricted to dry_run with outbound disabled");
  }
  const simulationId = crypto.randomUUID();
  const domain = `simulation-${simulationId}.invalid`;
  const recipient = `buyer@${domain}`;
  const submissionReference = `<simulation-${simulationId}@${domain}>`;
  const observedAt = new Date().toISOString();
  const campaignId = db.createCampaign({
    name: `simulation-${simulationId}`,
    market: "Test",
    product: "Sample Product",
    buyerType: "test integrator",
    targetCount: 1,
    createdBy: "acceptance",
    dailyLimit: 3,
    hourlyLimit: 1,
    followupDays: [3, 7, 14],
  });
  const leadId = db.upsertLead({
    campaignId,
    company: "INQUIRY_SIMULATION_DO_NOT_CONTACT",
    domain,
    website: `https://${domain}`,
    country: "Test",
    buyerType: "test integrator",
    product: "Sample Product",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: observedAt,
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{
      id: "simulation-demand",
      stage: "RECENT_PROCUREMENT",
      sourceUrl: `https://${domain}/simulation-rfq`,
      publisherDomain: domain,
      sourceDate: observedAt,
      quote: "Acceptance simulation only",
      score: 25,
      sourceKind: "OFFICIAL_PAGE",
      reviewEligible: true,
    }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.transitionLead(leadId, "VERIFYING", "acceptance", "simulation");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "acceptance", "simulation quality gate");
  const contactId = db.upsertContact({
    leadId,
    name: "Test Buyer",
    title: "Procurement Manager",
    email: recipient,
    sourceUrl: `https://${domain}/team`,
    employmentVerifiedAt: observedAt,
    emailStatus: "VALID",
    emailRisk: "simulation",
    roleAddress: false,
    disposableAddress: false,
    catchAll: false,
  });
  const initialId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination: recipient,
    subject: "Simulation",
    body: "Simulation",
    sequenceIndex: 0,
    scheduledAt: new Date().toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination: recipient,
    subject: "Re: Simulation",
    body: "Follow-up that must be cancelled",
    sequenceIndex: 1,
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "acceptance", db.getSequenceReviewHash(leadId));
  const recipientTier = db.db.prepare(
    "SELECT recipient_tier FROM contacts WHERE id=?",
  ).get(contactId) as { recipient_tier: string } | undefined;
  if (recipientTier?.recipient_tier !== "A") {
    throw new Error(`Inquiry simulation fixture must be tier A, received ${recipientTier?.recipient_tier ?? "missing"}`);
  }
  const previousOutboundPause = db.getSetting("outbound_paused") ?? "true";
  try {
    db.setSetting("outbound_paused", "false");
    db.markMessageSending(initialId);
    db.markMessageSent(initialId, submissionReference);
  } finally {
    db.setSetting("outbound_paused", previousOutboundPause);
  }
  const classification = await classifyInbound(
    {
      from: recipient,
      subject: "Re: Simulation",
      body: "Please quote 500 sample components and confirm MOQ and lead time.",
    },
    llm,
    config,
  );
  await processor.process(
    {
      channel: "email",
      providerId: `simulation-inbound-${Date.now()}`,
      threadId: submissionReference,
      fromAddress: recipient,
      subject: "Re: Simulation",
      bodyText: "Please quote 500 sample components and confirm MOQ and lead time.",
      receivedAt: new Date().toISOString(),
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
    },
    classification,
  );
  const lead = db.getLead(leadId);
  const messages = db.listOutboundMessagesForLead(leadId);
  const inquiryNotification = db.listPendingNotifications(100)
    .find((notification) => notification.event_type === "INQUIRY_ALERT");
  if (classification.classification !== "P1_INQUIRY") {
    throw new Error(`Inquiry simulation classification was ${classification.classification}`);
  }
  if (lead?.status !== "HUMAN_TAKEOVER" || Number(lead.human_takeover) !== 1) {
    throw new Error("Inquiry simulation did not enter HUMAN_TAKEOVER");
  }
  if (messages.find((message) => Number(message.sequence_index) === 1)?.status !== "CANCELLED") {
    throw new Error("Inquiry simulation did not cancel the scheduled follow-up");
  }
  if (!inquiryNotification) {
    throw new Error("Inquiry simulation did not persist the inquiry notification outbox entry");
  }
  print({
    passed: true,
    classification,
    lead,
    messages,
    notification: {
      eventType: inquiryNotification.event_type,
      status: inquiryNotification.status,
    },
  });
}

async function main(): Promise<void> {
  const command = requestedCommand;
  if (command === "init") print({ ok: true, database: config.AGENT_DB_PATH });
  else if (command === "db-status") print({
    database: config.AGENT_DB_PATH,
    migration: db.getMigrationStatus(),
    integrity: db.checkIntegrity(),
  });
  else if (command === "acquisition-foundation") print({
    ok: db.checkIntegrity().ok,
    database: config.AGENT_DB_PATH,
    foundation: db.getAcquisitionFoundationSummary(),
    externalActionsAttempted: false,
  });
  else if (command === "acquisition-shadow") print(runAcquisitionFoundationShadow());
  else if (command === "crawl-shadow") print(await runCrawlRoutingShadow());
  else if (command === "provider-shadow") print(runProviderShadowBakeoff());
  else if (command === "market-shadow") print(runMarketAllocationShadow());
  else if (command === "transport-shadow") print(runPausedTransportShadow());
  else if (command === "manual-channel-shadow") print(runManualChannelShadow());
  else if (command === "experiment-shadow") print(await runExperimentSystemShadow());
  else if (command === "signal-shadow") print(runSignalMonitoringShadow());
  else if (command === "content-shadow") print(runContentPilotShadow());
  else if (command === "commercial-funnel") {
    print(runCommercialFunnelOperator(db, process.argv.slice(3)));
  }
  else if (command === "launch-autonomous-pilot") {
    const options = parseAutonomousPilotLaunchCliArgs(process.argv.slice(3));
    const spec = readAutonomousPilotLaunchSpec(options.specPath);
    print(launchAutonomousPilot(db, spec));
  }
  else if (command === "launch-autonomous-research") {
    const options = parseAutonomousResearchLaunchCliArgs(process.argv.slice(3));
    const spec = readAutonomousResearchLaunchSpec(options.specPath);
    print(launchAutonomousResearch(db, spec));
  }
  else if (command === "replay-autonomous-messages") {
    if (!process.argv.slice(3).includes("--confirm-enqueue")) {
      throw new Error("replay-autonomous-messages requires --confirm-enqueue");
    }
    const campaignIds = process.argv.slice(3)
      .filter((argument) => argument.startsWith("--campaign="))
      .map((argument) => argument.slice("--campaign=".length));
    print(replayAuthorizedAutonomousCampaignMessages({ db, campaignIds }));
  }
  else if (command === "schedule-continuous-acquisition") {
    print(scheduleContinuousAcquisition(db));
  }
  else if (command === "refresh-tier-b-evidence") {
    const options = parseRefreshTierBEvidenceCliArgs(process.argv.slice(3));
    print(await refreshTierBEvidence(db, options));
  }
  else if (command === "gmail-pilot-self-test") {
    if (!process.argv.slice(3).includes("--confirm-send-to-self")) {
      throw new Error("gmail-pilot-self-test requires --confirm-send-to-self");
    }
    const result = await dispatcher.testGmailPilot("codex-deployment");
    const state = ensureGmailPilotState(config, db);
    print({
      sent: result.sent,
      selfTestPassed: state.selfTestPassed,
      passedAt: state.selfTestPassedAt,
      outboundPaused: db.getSetting("outbound_paused") === "true",
    });
  }
  else if (command === "gmail-pilot-activate") {
    if (!process.argv.slice(3).includes("--confirm-activate")) {
      throw new Error("gmail-pilot-activate requires --confirm-activate");
    }
    const state = activateGmailPilot(config, db, "codex-deployment");
    print({
      activated: state.activated,
      activatedAt: state.activatedAt,
      outboundPaused: db.getSetting("outbound_paused") === "true",
    });
  }
  else if (command === "verify-db") {
    const migration = db.getMigrationStatus();
    const integrity = db.checkIntegrity();
    if (!integrity.ok || migration.currentVersion !== migration.latestVersion) {
      throw new Error(`Database verification failed: ${JSON.stringify({ migration, integrity })}`);
    }
    print({ database: config.AGENT_DB_PATH, migration, integrity });
  }
  else if (command === "backup-db") {
    const destination = process.argv[3];
    if (!destination) throw new Error("backup-db requires a destination path");
    print(db.backupTo(destination));
  }
  else if (command === "enqueue-persistence-probe") {
    const jobId = db.enqueueJob(
      "PERSISTENCE_PROBE",
      { createdAt: new Date().toISOString() },
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    print({ jobId, job: db.getJob(jobId) });
  }
  else if (command === "get-persistence-probe") {
    const jobId = process.argv[3];
    if (!jobId) throw new Error("get-persistence-probe requires a job ID");
    const job = db.getJob(jobId);
    if (!job || job.job_type !== "PERSISTENCE_PROBE") {
      throw new Error(`Persistence probe not found: ${jobId}`);
    }
    print({ jobId, job });
  }
  else if (command === "delete-persistence-probe") {
    const jobId = process.argv[3];
    if (!jobId) throw new Error("delete-persistence-probe requires a job ID");
    print({ jobId, deleted: db.deleteJob(jobId) });
  }
  else if (command === "status") print({ config: {
    mode: config.AGENT_MODE,
    outboundEnabled: config.OUTBOUND_ENABLED,
    feishuBotEnabled: config.FEISHU_BOT_ENABLED,
    feishuAlertDestinationConfigured: feishu.hasAlertDestinations(),
    feishuAuthorizedUserCount: feishu.authorizedUserCount(),
    feishuAuthorizedChatCount: feishu.authorizedChatCount(),
    emailInboundEnabled: config.EMAIL_INBOUND_ENABLED,
    searchConfigured: Boolean(config.SERPER_API_KEY || config.EXA_API_KEY || config.SEARXNG_BASE_URL),
    reacherConfigured: Boolean(config.REACHER_BASE_URL),
    bitableConfigured: bitable.isConfigured(),
    whatsappConfigured: Boolean(config.WHATSAPP_BUSINESS_API_ENABLED && config.WHATSAPP_ACCESS_TOKEN),
  }, metrics: db.getMetrics(), dispatchPlan: dispatcher.plan(10) });
  else if (command === "bootstrap-bitable") {
    const args = process.argv.slice(3);
    const name = args.find((arg) => !arg.startsWith("--")) ?? "外贸获客CRM-生产版";
    const result = await bitable.bootstrapProductionBase(name, {
      pruneGeneratedDefaultFields: args.includes("--prune-generated-default-fields"),
    });
    const writeEnv = !args.includes("--no-write-env");
    if (writeEnv) {
      upsertEnvFile(path.join(config.workspaceRoot, ".env"), {
        FEISHU_BITABLE_APP_TOKEN: result.appToken,
        FEISHU_BITABLE_LEADS_TABLE_ID: result.leadsTableId,
        FEISHU_BITABLE_EVENTS_TABLE_ID: result.eventsTableId,
      });
    }
    print({
      ok: result.schema.ok,
      name,
      appUrl: result.appUrl || "Open Feishu and search the Bitable name",
      createdApp: result.createdApp,
      configurationWritten: writeEnv,
      leadsFields: result.schema.tables.Leads.fields.length,
      eventsFields: result.schema.tables.Events.fields.length,
    });
  }
  else if (command === "validate-bitable") print(await bitable.validateSchema());
  else if (command === "sync-bitable") print(await bitable.syncAll());
  else if (command === "bounce-incidents") {
    print({ incidents: db.listEmailBounceIncidents(100) });
  }
  else if (command === "review-bounce-incident") {
    if (!process.argv.slice(3).includes("--confirm-review")) {
      throw new Error("review-bounce-incident requires --confirm-review");
    }
    print(db.reviewEmailBounceIncident({
      incidentId: argumentValue("incident"),
      disposition: argumentValue("disposition") as Parameters<typeof db.reviewEmailBounceIncident>[0]["disposition"],
      reviewedBy: argumentValue("actor"),
      reason: argumentValue("reason"),
    }));
  }
  else if (command === "authorize-deliverability-recovery") {
    if (!process.argv.slice(3).includes("--confirm-authorize")) {
      throw new Error("authorize-deliverability-recovery requires --confirm-authorize");
    }
    const expiresHours = Math.max(1, Math.min(168, Math.trunc(Number(argumentValue("expires-hours") || "72"))));
    print(db.authorizeDeliverabilityRecovery({
      incidentReviewId: argumentValue("review"),
      authorizedBy: argumentValue("actor"),
      reason: argumentValue("reason"),
      maxMessages: Number(argumentValue("max-messages")),
      expiresAt: new Date(Date.now() + expiresHours * 60 * 60_000).toISOString(),
      maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
      hardBounceWindowSize: 50,
      hardBounceMinimumSample: 20,
    }));
  }
  else if (command === "generate-feishu-pairing") {
    const pairingCode = crypto.randomBytes(12).toString("base64url");
    upsertEnvFile(path.join(config.workspaceRoot, ".env"), {
      AGENT_MODE: "dry_run",
      OUTBOUND_ENABLED: "false",
      FEISHU_BOT_ENABLED: "true",
      FEISHU_PAIRING_CODE: pairingCode,
    });
    print({
      ok: true,
      pairingCode,
      usage: ["绑定 <配对码>", "绑定群 <配对码>"],
      outboundEnabled: false,
    });
  }
  else if (command === "import-legacy") await importLegacy();
  else if (command === "simulate-inquiry") await simulateInquiry();
  else if (command === "dispatch-plan") print(dispatcher.plan(50));
  else throw new Error(`Unknown CLI command: ${command}`);
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      dispatcher.close();
    } finally {
      db.close();
    }
  });
