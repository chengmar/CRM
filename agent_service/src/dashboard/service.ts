import type { AgentConfig } from "../config.js";
import type { AgentDatabase, DeliverabilityRecoveryState } from "../db.js";
import type { DeliverabilityPolicy } from "../outreach/deliverability-policy.js";

export interface DashboardRuntimeState {
  feishuConnected: () => boolean;
  imapHealth: () => object;
  dailyResearchEnabled: () => boolean;
  dispatchPlan: (limit: number) => Array<{
    messageId: string;
    allowed: boolean;
    blockers: string[];
  }>;
  deliverabilityPolicy: () => DeliverabilityPolicy;
  deliverabilityRecovery: () => DeliverabilityRecoveryState;
}

const DATABASE_HEALTH_CACHE_MS = 5 * 60_000;
const HUMAN_REPLY_CLASSIFICATIONS = [
  "P1_INQUIRY",
  "P2_INTEREST",
  "OTHER_REPLY",
  "NEGATIVE",
  "UNSUBSCRIBE",
  "REFERRAL",
  "WRONG_PERSON",
  "NEEDS_INFO",
  "NOT_FIT",
] as const;
const INQUIRY_CLASSIFICATIONS = ["P1_INQUIRY", "P2_INTEREST"] as const;
const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(",");
const databaseHealthCache = new WeakMap<AgentDatabase, {
  checkedAt: number;
  value: ReturnType<AgentDatabase["checkIntegrity"]>;
}>();

function cachedDatabaseHealth(db: AgentDatabase, now: Date): ReturnType<AgentDatabase["checkIntegrity"]> {
  const cached = databaseHealthCache.get(db);
  if (cached && now.getTime() - cached.checkedAt < DATABASE_HEALTH_CACHE_MS) return cached.value;
  const value = db.checkIntegrity();
  databaseHealthCache.set(db, { checkedAt: now.getTime(), value });
  return value;
}

function safeError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, (_match, local: string, domain: string) =>
      `${local.slice(0, 1)}***@${domain.toLowerCase()}`)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[server-redacted]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=REDACTED")
    .slice(0, 800);
}

function startOfTodayInShanghai(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = `${values.year}-${values.month}-${values.day}`;
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}

function groupedCounts(
  db: AgentDatabase,
  sql: string,
): Record<string, number> {
  const rows = db.db.prepare(sql).all() as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.count)]));
}

export function buildOperationsDashboardSnapshot(
  config: AgentConfig,
  db: AgentDatabase,
  runtime: DashboardRuntimeState,
): Record<string, unknown> {
  const generatedAt = new Date();
  const todayStart = startOfTodayInShanghai(generatedAt);
  const currentMailbox = config.EMAIL_FROM_ADDRESS.trim().toLowerCase();
  const currentMailboxDomain = currentMailbox.split("@").at(-1) ?? "";
  const currentMailboxPredicate = (alias: string): string =>
    `instr(',' || replace(lower(coalesce(${alias}.to_address, '')), ' ', '') || ',', ',' || ? || ',') > 0`;
  const messageStatuses = groupedCounts(
    db,
    `SELECT status AS key, count(*) AS count
     FROM outbound_messages WHERE channel='email' GROUP BY status ORDER BY status`,
  );
  const leadStatuses = groupedCounts(
    db,
    "SELECT status AS key, count(*) AS count FROM leads GROUP BY status ORDER BY status",
  );
  const jobStatuses = groupedCounts(
    db,
    "SELECT status AS key, count(*) AS count FROM jobs GROUP BY status ORDER BY status",
  );
  const jobTypes = db.db.prepare(
    `SELECT job_type, status, count(*) AS count
     FROM jobs GROUP BY job_type, status ORDER BY job_type, status`,
  ).all() as Array<Record<string, unknown>>;
  const summary = db.db.prepare(
    `SELECT
       (SELECT count(*) FROM campaigns) AS campaigns,
       (SELECT count(*) FROM leads) AS leads,
       (SELECT count(*) FROM contacts) AS contacts,
       (SELECT count(*) FROM outbound_messages WHERE channel='email') AS messages,
       (SELECT count(*) FROM campaign_message_authorizations) AS message_authorizations,
       (SELECT count(*) FROM opportunities) AS opportunities`,
  ).get() as Record<string, unknown>;
  const today = db.db.prepare(
    `SELECT
       sum(CASE WHEN channel='email' AND sent_at>=? AND status IN ('SENT','DELIVERED','REPLIED','BOUNCED') THEN 1 ELSE 0 END) AS sent,
       sum(CASE WHEN channel='email' AND sent_at>=? AND status='BOUNCED' THEN 1 ELSE 0 END) AS bounced
     FROM outbound_messages`,
  ).get(todayStart, todayStart) as Record<string, unknown>;

  const inboundMessages = db.db.prepare(
    `SELECT inbound.id, inbound.provider_id, inbound.thread_id, inbound.lead_id,
            inbound.contact_id, inbound.from_address, inbound.to_address,
            inbound.subject, substr(inbound.body_text, 1, 16000) AS body_text,
            length(inbound.body_text)>16000 AS body_truncated,
            inbound.received_at, inbound.classification, inbound.confidence,
            inbound.reason, inbound.processed_at,
            intake.id AS intake_id, intake.intake_status, intake.outbound_message_id,
            intake.correlation_method, intake.correlation_confidence,
            lead.company, lead.country, lead.buyer_type, lead.product,
            lead.total_score, lead.grade, lead.demand_stage, lead.demand_evidence_json,
            contact.name AS contact_name, contact.title, contact.email,
            contact.whatsapp, contact.linkedin, contact.source_url,
            outbound.subject AS outbound_subject, outbound.body AS outbound_body,
            outbound.sent_at AS outbound_sent_at,
            opportunity.id AS opportunity_id, opportunity.stage AS opportunity_stage
     FROM inbound_messages inbound
     LEFT JOIN inquiry_intakes intake
       ON intake.source='EMAIL' AND intake.provider_event_id=inbound.provider_id
     LEFT JOIN leads lead ON lead.id=inbound.lead_id
     LEFT JOIN contacts contact ON contact.id=inbound.contact_id
     LEFT JOIN outbound_messages outbound ON outbound.id=intake.outbound_message_id
     LEFT JOIN opportunities opportunity ON opportunity.intake_id=intake.id
     WHERE inbound.channel='email'
       AND ${currentMailboxPredicate("inbound")}
     ORDER BY inbound.received_at DESC, inbound.id DESC LIMIT 120`,
  ).all(currentMailbox) as Array<Record<string, unknown>>;

  const replyMetricsRow = db.db.prepare(
    `SELECT
       count(*) AS inbox_total,
       (SELECT count(*) FROM inbound_messages WHERE channel='email') AS stored_inbound_total,
       sum(CASE WHEN lead_id IS NOT NULL THEN 1 ELSE 0 END) AS matched_inbound,
       sum(CASE WHEN lead_id IS NULL THEN 1 ELSE 0 END) AS unmatched_inbound,
       sum(CASE WHEN lead_id IS NOT NULL
         AND classification IN (${sqlList(HUMAN_REPLY_CLASSIFICATIONS)}) THEN 1 ELSE 0 END) AS confirmed_replies,
       sum(CASE WHEN lead_id IS NULL
         AND classification IN (${sqlList(HUMAN_REPLY_CLASSIFICATIONS)}) THEN 1 ELSE 0 END) AS reply_review_queue,
       sum(CASE WHEN lead_id IS NOT NULL
         AND classification IN (${sqlList(INQUIRY_CLASSIFICATIONS)}) THEN 1 ELSE 0 END) AS confirmed_inquiries,
       sum(CASE WHEN lead_id IS NULL
         AND classification IN (${sqlList(INQUIRY_CLASSIFICATIONS)}) THEN 1 ELSE 0 END) AS inquiry_review_queue,
       sum(CASE WHEN classification='AUTO_REPLY' THEN 1 ELSE 0 END) AS auto_replies,
       sum(CASE WHEN classification='UNSUBSCRIBE' THEN 1 ELSE 0 END) AS unsubscribes,
       sum(CASE WHEN classification='BOUNCE' THEN 1 ELSE 0 END) AS bounces
     FROM inbound_messages inbound
     WHERE channel='email' AND ${currentMailboxPredicate("inbound")}`,
  ).get(currentMailbox) as Record<string, unknown>;
  replyMetricsRow.historical_other_mailboxes = Math.max(
    0,
    Number(replyMetricsRow.stored_inbound_total ?? 0) - Number(replyMetricsRow.inbox_total ?? 0),
  );

  const messages = db.db.prepare(
    `SELECT message.id, message.status, message.subject, message.body, message.sent_at,
            message.created_at, message.updated_at, message.sequence_index,
            campaign.name AS campaign_name, campaign.market, campaign.product,
            lead.id AS lead_id, lead.company, lead.country, lead.domain, lead.website,
            lead.buyer_type, lead.product AS lead_product, lead.total_score, lead.grade,
            lead.demand_stage, lead.demand_evidence_json, lead.outreach_qualification_track,
            contact.id AS contact_id, contact.name AS contact_name, contact.title,
            contact.email, contact.whatsapp, contact.linkedin, contact.source_url,
            contact.recipient_tier, contact.recipient_evidence_url,
            contact.recipient_evidence_observed_at, contact.email_status,
            contact.verification_notes
     FROM outbound_messages message
     JOIN leads lead ON lead.id=message.lead_id
     JOIN contacts contact ON contact.id=message.contact_id
     LEFT JOIN campaigns campaign ON campaign.id=message.campaign_id
     WHERE message.channel='email'
       AND message.status IN ('SENT','DELIVERED','REPLIED','BOUNCED')
     ORDER BY message.sent_at DESC, message.id DESC LIMIT 100`,
  ).all() as Array<Record<string, unknown>>;
  const leadIds = [...new Set(messages.map((message) => String(message.lead_id)))];
  const sources = new Map<string, Array<Record<string, unknown>>>();
  if (leadIds.length > 0) {
    const placeholders = leadIds.map(() => "?").join(",");
    const rows = db.db.prepare(
      `SELECT lead_id, source_type, source_url, source_date, evidence
       FROM lead_sources WHERE lead_id IN (${placeholders})
       ORDER BY CASE lower(source_type) WHEN 'official_website' THEN 0 ELSE 1 END, created_at DESC`,
    ).all(...leadIds) as Array<Record<string, unknown>>;
    for (const source of rows) {
      const leadId = String(source.lead_id);
      const list = sources.get(leadId) ?? [];
      if (list.length < 5) list.push(source);
      sources.set(leadId, list);
    }
  }
  const messageView = messages.map((message) => ({
    ...message,
    acquisition_sources: sources.get(String(message.lead_id)) ?? [],
    ...(() => {
      const related = inboundMessages.filter((inbound) =>
        String(inbound.outbound_message_id ?? "") === String(message.id) ||
        (inbound.lead_id && String(inbound.lead_id) === String(message.lead_id))
      );
      const humanReplies = related.filter((inbound) =>
        HUMAN_REPLY_CLASSIFICATIONS.includes(String(inbound.classification) as typeof HUMAN_REPLY_CLASSIFICATIONS[number])
      );
      const inquiries = humanReplies.filter((inbound) =>
        INQUIRY_CLASSIFICATIONS.includes(String(inbound.classification) as typeof INQUIRY_CLASSIFICATIONS[number])
      );
      return {
        related_inbound_ids: related.map((inbound) => String(inbound.id)),
        reply_count: humanReplies.length,
        inquiry_count: inquiries.length,
        latest_reply_at: humanReplies[0]?.received_at ?? null,
        reply_classifications: [...new Set(humanReplies.map((inbound) => String(inbound.classification)))],
      };
    })(),
  }));

  const sourcePerformance = db.db.prepare(
    `WITH sources AS (
       SELECT DISTINCT source_type, lead_id FROM lead_sources
     )
     SELECT sources.source_type,
            count(DISTINCT sources.lead_id) AS leads,
            count(DISTINCT CASE WHEN outcome.outcome='reply' THEN sources.lead_id END) AS replies,
            count(DISTINCT CASE WHEN outcome.outcome='inquiry' THEN sources.lead_id END) AS inquiries,
            count(DISTINCT CASE WHEN outcome.outcome='bounce' THEN sources.lead_id END) AS bounces
     FROM sources
     LEFT JOIN source_outcomes outcome
       ON outcome.source_type=sources.source_type AND outcome.lead_id=sources.lead_id
     GROUP BY sources.source_type
     ORDER BY leads DESC, sources.source_type`,
  ).all() as Array<Record<string, unknown>>;
  const contactSourcePerformance = db.db.prepare(
    `SELECT coalesce(contact.recipient_tier, 'UNSET') AS recipient_tier,
            count(*) AS contacts,
            sum(CASE WHEN contact.email IS NOT NULL AND trim(contact.email)<>'' THEN 1 ELSE 0 END) AS email_contacts,
            sum(CASE WHEN EXISTS(
              SELECT 1 FROM outbound_messages message
              WHERE message.contact_id=contact.id AND message.channel='email' AND message.sent_at IS NOT NULL
            ) THEN 1 ELSE 0 END) AS reached_contacts,
            sum(CASE WHEN EXISTS(
              SELECT 1 FROM outbound_messages message
              WHERE message.contact_id=contact.id AND message.channel='email' AND message.status='BOUNCED'
            ) THEN 1 ELSE 0 END) AS bounced_contacts,
            sum(CASE WHEN EXISTS(
              SELECT 1 FROM inbound_messages inbound
              WHERE inbound.contact_id=contact.id
                AND inbound.classification IN (${sqlList(HUMAN_REPLY_CLASSIFICATIONS)})
                AND ${currentMailboxPredicate("inbound")}
            ) THEN 1 ELSE 0 END) AS replied_contacts
     FROM contacts contact
     GROUP BY coalesce(contact.recipient_tier, 'UNSET')
     ORDER BY contacts DESC`,
  ).all(currentMailbox) as Array<Record<string, unknown>>;
  const evidenceCoverage = db.db.prepare(
    `SELECT
       count(*) AS contacts,
       sum(CASE WHEN email IS NOT NULL AND trim(email)<>'' THEN 1 ELSE 0 END) AS email,
       sum(CASE WHEN recipient_tier='A' THEN 1 ELSE 0 END) AS tier_a,
       sum(CASE WHEN recipient_tier='B' THEN 1 ELSE 0 END) AS tier_b,
       sum(CASE WHEN name IS NOT NULL AND trim(name)<>'' THEN 1 ELSE 0 END) AS named,
       sum(CASE WHEN title IS NOT NULL AND trim(title)<>'' THEN 1 ELSE 0 END) AS titled,
       sum(CASE WHEN linkedin IS NOT NULL AND trim(linkedin)<>'' THEN 1 ELSE 0 END) AS linkedin,
       sum(CASE WHEN whatsapp IS NOT NULL AND trim(whatsapp)<>'' THEN 1 ELSE 0 END) AS whatsapp,
       sum(CASE WHEN recipient_evidence_url IS NOT NULL AND trim(recipient_evidence_url)<>'' THEN 1 ELSE 0 END) AS exact_evidence
     FROM contacts`,
  ).get() as Record<string, unknown>;

  const recentJobs = (db.db.prepare(
    `SELECT id, job_type, status, attempts, max_attempts, run_after,
            locked_at, last_error, created_at, updated_at
     FROM jobs ORDER BY updated_at DESC, id DESC LIMIT 40`,
  ).all() as Array<Record<string, unknown>>).map((job) => ({
    ...job,
    last_error: safeError(job.last_error),
  }));
  const recentEvents = (db.db.prepare(
    `SELECT entity_type, entity_id, event_type, actor, payload_json, created_at
     FROM events
     WHERE event_type NOT IN (
       'PROVIDER_RUN_STARTED','PROVIDER_RUN_SUCCEEDED','PROVIDER_RUN_FAILED',
       'CRAWL_STRICT_AUDIT','PROVIDER_STRICT_AUDIT'
     )
     ORDER BY created_at DESC, id DESC LIMIT 40`,
  ).all() as Array<Record<string, unknown>>).map((event) => ({
    ...event,
    payload_json: safeError(event.payload_json),
  }));
  const rolloverMarker = db.db.prepare(
    "SELECT value FROM settings WHERE key LIKE 'bitable-events-active:v1:%' ORDER BY updated_at DESC LIMIT 1",
  ).get() as { value: string } | undefined;
  let rollover: Record<string, unknown> | null = null;
  if (rolloverMarker?.value) {
    try {
      const marker = JSON.parse(rolloverMarker.value) as Record<string, unknown>;
      rollover = { active: true, createdAt: marker.createdAt ?? null, policy: "operational-events-v1" };
    } catch {
      rollover = { active: false, markerInvalid: true };
    }
  }
  const syncSummary = db.db.prepare(
    `SELECT
       sum(CASE WHEN status='QUEUED' THEN 1 ELSE 0 END) AS queued,
       sum(CASE WHEN status='RUNNING' THEN 1 ELSE 0 END) AS running,
       sum(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
       sum(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
       sum(CASE WHEN status='SUPERSEDED' THEN 1 ELSE 0 END) AS superseded,
       max(updated_at) AS last_updated_at
     FROM jobs WHERE job_type='SYNC_BITABLE'`,
  ).get() as Record<string, unknown>;
  const latestSyncError = db.db.prepare(
    `SELECT last_error, updated_at FROM jobs
     WHERE job_type='SYNC_BITABLE' AND last_error IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
  ).get() as Record<string, unknown> | undefined;
  const deliverability = runtime.deliverabilityPolicy();
  const recovery = runtime.deliverabilityRecovery();
  const dispatchPlan = runtime.dispatchPlan(12).map((item) => ({
    messageId: item.messageId,
    allowed: item.allowed,
    blockers: item.blockers,
  }));

  return {
    generatedAt: generatedAt.toISOString(),
    timezone: "Asia/Shanghai",
    summary: {
      ...summary,
      inbound_messages: Number(replyMetricsRow.inbox_total ?? 0),
      matched_inbound: Number(replyMetricsRow.matched_inbound ?? 0),
      unmatched_inbound: Number(replyMetricsRow.unmatched_inbound ?? 0),
      confirmed_replies: Number(replyMetricsRow.confirmed_replies ?? 0),
      reply_review_queue: Number(replyMetricsRow.reply_review_queue ?? 0),
      confirmed_inquiries: Number(replyMetricsRow.confirmed_inquiries ?? 0),
      inquiry_review_queue: Number(replyMetricsRow.inquiry_review_queue ?? 0),
      sent: Number(messageStatuses.SENT ?? 0),
      bounced: Number(messageStatuses.BOUNCED ?? 0),
      replied: Number(messageStatuses.REPLIED ?? 0),
      approved: Number(messageStatuses.APPROVED ?? 0),
      todaySent: Number(today.sent ?? 0),
      todayBounced: Number(today.bounced ?? 0),
      outboundAttempts: Number(messageStatuses.SENT ?? 0) + Number(messageStatuses.DELIVERED ?? 0) +
        Number(messageStatuses.REPLIED ?? 0) + Number(messageStatuses.BOUNCED ?? 0),
    },
    runtime: {
      mode: config.AGENT_MODE,
      outboundEnabled: config.OUTBOUND_ENABLED,
      outboundPaused: db.getSetting("outbound_paused") === "true",
      dailyResearchEnabled: runtime.dailyResearchEnabled(),
      feishuConnected: runtime.feishuConnected(),
      imap: runtime.imapHealth(),
      database: cachedDatabaseHealth(db, generatedAt),
      schema: db.getMigrationStatus(),
    },
    pipeline: { messageStatuses, leadStatuses },
    deliverability: {
      policy: deliverability,
      recovery,
      maxHardBounceRate: config.EMAIL_MAX_HARD_BOUNCE_RATE,
      hardBounceWindowSize: 50,
      hardBounceMinimumSample: 20,
      warmupComplete: config.EMAIL_WARMUP_COMPLETE,
      dispatchPlan,
    },
    crm: {
      configured: Boolean(
        config.FEISHU_BITABLE_APP_TOKEN &&
        config.FEISHU_BITABLE_LEADS_TABLE_ID &&
        config.FEISHU_BITABLE_EVENTS_TABLE_ID
      ),
      sync: syncSummary,
      latestError: latestSyncError ? {
        error: safeError(latestSyncError.last_error),
        updatedAt: latestSyncError.updated_at,
      } : null,
      rollover,
    },
    inbox: {
      metrics: {
        ...replyMetricsRow,
        mailbox_domain: currentMailboxDomain,
        replyRate: Number(replyMetricsRow.confirmed_replies ?? 0) /
          Math.max(1, Number(messageStatuses.SENT ?? 0) + Number(messageStatuses.DELIVERED ?? 0) +
            Number(messageStatuses.REPLIED ?? 0) + Number(messageStatuses.BOUNCED ?? 0)),
        inquiryRate: Number(replyMetricsRow.confirmed_inquiries ?? 0) /
          Math.max(1, Number(messageStatuses.SENT ?? 0) + Number(messageStatuses.DELIVERED ?? 0) +
            Number(messageStatuses.REPLIED ?? 0) + Number(messageStatuses.BOUNCED ?? 0)),
      },
      messages: inboundMessages,
    },
    sources: {
      performance: sourcePerformance,
      contactMethods: contactSourcePerformance,
      evidenceCoverage,
      channels: {
        emailOutbound: config.EMAIL_OUTREACH_ENABLED && config.OUTBOUND_ENABLED,
        emailInbound: config.EMAIL_INBOUND_ENABLED,
        whatsappBusiness: config.WHATSAPP_BUSINESS_API_ENABLED,
        whatsappOutbound: config.WHATSAPP_OUTREACH_ENABLED,
        inquiryForm: config.INQUIRY_FORM_WEBHOOK_ENABLED,
      },
    },
    jobs: { statuses: jobStatuses, byType: jobTypes, recent: recentJobs },
    bounceIncidents: db.listEmailBounceIncidents(20),
    messages: messageView,
    recentEvents,
  };
}
