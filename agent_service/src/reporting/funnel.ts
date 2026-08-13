import type { AgentDatabase } from "../db.js";
import type { SQLInputValue } from "node:sqlite";

export type FunnelDimension = "campaign" | "market" | "sourceType";

export interface FunnelReportOptions {
  /** Lead/candidate creation time, inclusive. Downstream outcomes are cumulative. */
  startAt?: string | Date | null;
  /** Lead/candidate creation time, exclusive. Downstream outcomes are cumulative. */
  endAt?: string | Date | null;
  campaignId?: string | null;
  market?: string | null;
  sourceType?: string | null;
  generatedAt?: string | Date;
}

export interface FunnelCounts {
  candidates: number;
  companyPassed: number;
  namedEmploymentVerified: number;
  validEmail: number;
  riskyEmail: number;
  verifiedEmail: number;
  ready: number;
  approved: number;
  sent: number;
  hardBounce: number;
  humanReply: number;
  p1: number;
  p2: number;
}

export interface FunnelRates {
  candidateToCompany: number;
  companyToNamedContact: number;
  namedContactToVerifiedEmail: number;
  namedContactToValidEmail: number;
  namedContactToRiskyEmail: number;
  verifiedEmailToReady: number;
  readyToApproved: number;
  approvedToSent: number;
  sentToHardBounce: number;
  sentToHumanReply: number;
  humanReplyToP1: number;
  humanReplyToP2: number;
  sentToP1: number;
  sentToP2: number;
}

export interface FunnelSlice {
  key: string;
  label: string;
  counts: FunnelCounts;
  rates: FunnelRates;
}

export interface FunnelReport {
  generatedAt: string;
  cohort: {
    basis: "created_at";
    startAt: string | null;
    endAt: string | null;
    downstreamOutcomes: "cumulative_through_generated_at";
  };
  filters: {
    campaignId: string | null;
    market: string | null;
    sourceType: string | null;
  };
  overall: FunnelSlice;
  byCampaign: FunnelSlice[];
  byMarket: FunnelSlice[];
  bySourceType: FunnelSlice[];
  notes: string[];
}

interface NormalizedOptions {
  startAt: string | null;
  endAt: string | null;
  campaignId: string | null;
  market: string | null;
  sourceType: string | null;
  generatedAt: string;
}

interface AggregateRow {
  group_key: string;
  group_label: string;
  company_passed: number;
  named_employment_verified: number;
  valid_email: number;
  risky_email: number;
  verified_email: number;
  ready: number;
  approved: number;
  sent: number;
  hard_bounce: number;
  human_reply: number;
  p1: number;
  p2: number;
}

interface CandidateRow {
  group_key: string;
  group_label: string;
  candidates: number;
}

const EMPTY_COUNTS: FunnelCounts = {
  candidates: 0,
  companyPassed: 0,
  namedEmploymentVerified: 0,
  validEmail: 0,
  riskyEmail: 0,
  verifiedEmail: 0,
  ready: 0,
  approved: 0,
  sent: 0,
  hardBounce: 0,
  humanReply: 0,
  p1: 0,
  p2: 0,
};

function normalizeDate(value: string | Date | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date.toISOString();
}

function cleanFilter(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function normalizeOptions(options: FunnelReportOptions): NormalizedOptions {
  const startAt = normalizeDate(options.startAt, "startAt");
  const endAt = normalizeDate(options.endAt, "endAt");
  if (startAt && endAt && startAt >= endAt) {
    throw new Error("endAt must be later than startAt");
  }
  return {
    startAt,
    endAt,
    campaignId: cleanFilter(options.campaignId),
    market: cleanFilter(options.market),
    sourceType: cleanFilter(options.sourceType),
    generatedAt: normalizeDate(options.generatedAt ?? new Date(), "generatedAt") as string,
  };
}

function leadCohortSql(options: NormalizedOptions): { sql: string; params: SQLInputValue[] } {
  const conditions: string[] = ["l.status <> 'REJECTED'"];
  const params: SQLInputValue[] = [];
  if (options.startAt) {
    conditions.push("l.created_at >= ?");
    params.push(options.startAt);
  }
  if (options.endAt) {
    conditions.push("l.created_at < ?");
    params.push(options.endAt);
  }
  if (options.campaignId) {
    conditions.push("l.campaign_id = ?");
    params.push(options.campaignId);
  }
  if (options.market) {
    conditions.push("cmp.market = ? COLLATE NOCASE");
    params.push(options.market);
  }
  if (options.sourceType) {
    conditions.push(
      "EXISTS (SELECT 1 FROM lead_sources filter_source WHERE filter_source.lead_id=l.id AND filter_source.source_type=?)",
    );
    params.push(options.sourceType);
  }
  return {
    sql: `
      SELECT l.id, l.campaign_id, l.domain, l.status,
             COALESCE(cmp.name, l.campaign_id, '未归属活动') AS campaign_name,
             COALESCE(NULLIF(cmp.market, ''), NULLIF(l.country, ''), '未归属市场') AS market
      FROM leads l
      LEFT JOIN campaigns cmp ON cmp.id=l.campaign_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
    `,
    params,
  };
}

function groupedLeadSql(
  dimension: FunnelDimension | "overall",
  options: NormalizedOptions,
): { sql: string; params: SQLInputValue[] } {
  const cohort = leadCohortSql(options);
  if (dimension === "sourceType") {
    const sourceFilter = options.sourceType ? "WHERE sources.source_type=?" : "";
    return {
      sql: `
        SELECT cohort.*, sources.source_type AS group_key, sources.source_type AS group_label
        FROM lead_cohort cohort
        JOIN (SELECT DISTINCT lead_id, source_type FROM lead_sources) sources
          ON sources.lead_id=cohort.id
        ${sourceFilter}
      `,
      params: [...cohort.params, ...(options.sourceType ? [options.sourceType] : [])],
    };
  }
  const group = dimension === "campaign"
    ? {
        key: "COALESCE(cohort.campaign_id, 'unassigned')",
        label: "cohort.campaign_name",
      }
    : dimension === "market"
      ? { key: "cohort.market", label: "cohort.market" }
      : { key: "'all'", label: "'总计'" };
  return {
    sql: `SELECT cohort.*, ${group.key} AS group_key, ${group.label} AS group_label FROM lead_cohort cohort`,
    params: cohort.params,
  };
}

function aggregateRows(
  db: AgentDatabase,
  dimension: FunnelDimension | "overall",
  options: NormalizedOptions,
): AggregateRow[] {
  const cohort = leadCohortSql(options);
  const grouped = groupedLeadSql(dimension, options);
  const ready = `(
    grouped.status='READY_FOR_REVIEW'
    OR EXISTS (
      SELECT 1 FROM events ready_event
      WHERE ready_event.entity_type='lead' AND ready_event.entity_id=grouped.id
        AND ready_event.event_type='LEAD_STATUS_CHANGED'
        AND json_valid(ready_event.payload_json)=1
        AND json_extract(ready_event.payload_json, '$.to')='READY_FOR_REVIEW'
    )
    OR EXISTS (
      SELECT 1 FROM events approval_event
      WHERE approval_event.entity_type='lead' AND approval_event.entity_id=grouped.id
        AND approval_event.event_type='OUTREACH_SEQUENCE_APPROVED'
    )
    OR EXISTS (SELECT 1 FROM outbound_messages sent_message WHERE sent_message.lead_id=grouped.id AND sent_message.sent_at IS NOT NULL)
  )`;
  const approved = `(
    grouped.status='APPROVED'
    OR EXISTS (
      SELECT 1 FROM events approval_event
      WHERE approval_event.entity_type='lead' AND approval_event.entity_id=grouped.id
        AND approval_event.event_type='OUTREACH_SEQUENCE_APPROVED'
    )
    OR EXISTS (
      SELECT 1 FROM outbound_messages approved_message
      WHERE approved_message.lead_id=grouped.id
        AND (approved_message.approved_at IS NOT NULL OR approved_message.sent_at IS NOT NULL)
    )
  )`;
  const sql = `
    WITH lead_cohort AS (${cohort.sql}),
    grouped AS (${grouped.sql})
    SELECT group_key, group_label,
      COUNT(*) AS company_passed,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM contacts named_contact
        WHERE named_contact.lead_id=grouped.id
          AND (
            (NULLIF(trim(named_contact.name), '') IS NOT NULL
              AND named_contact.employment_verified_at IS NOT NULL)
            OR named_contact.recipient_tier='B'
          )
      ) THEN 1 ELSE 0 END) AS named_employment_verified,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM contacts valid_contact
        WHERE valid_contact.lead_id=grouped.id
          AND valid_contact.email IS NOT NULL AND valid_contact.email_status='VALID'
      ) THEN 1 ELSE 0 END) AS valid_email,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM contacts risky_contact
        WHERE risky_contact.lead_id=grouped.id
          AND risky_contact.email IS NOT NULL AND risky_contact.email_status='RISKY'
      ) THEN 1 ELSE 0 END) AS risky_email,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM contacts verified_contact
        WHERE verified_contact.lead_id=grouped.id
          AND verified_contact.email IS NOT NULL AND verified_contact.email_status IN ('VALID','RISKY')
      ) THEN 1 ELSE 0 END) AS verified_email,
      SUM(CASE WHEN ${ready} THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN ${approved} THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM outbound_messages sent_message
        WHERE sent_message.lead_id=grouped.id AND sent_message.sent_at IS NOT NULL
      ) THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM inbound_messages bounce
        WHERE bounce.lead_id=grouped.id AND bounce.channel='email' AND bounce.classification='BOUNCE'
      ) THEN 1 ELSE 0 END) AS hard_bounce,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM inbound_messages reply
        WHERE reply.lead_id=grouped.id
          AND reply.classification IN ('P1_INQUIRY','P2_INTEREST','OTHER_REPLY','NEGATIVE','UNSUBSCRIBE')
      ) THEN 1 ELSE 0 END) AS human_reply,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM inbound_messages p1
        WHERE p1.lead_id=grouped.id AND p1.classification='P1_INQUIRY'
      ) THEN 1 ELSE 0 END) AS p1,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM inbound_messages p2
        WHERE p2.lead_id=grouped.id AND p2.classification='P2_INTEREST'
      ) THEN 1 ELSE 0 END) AS p2
    FROM grouped
    GROUP BY group_key, group_label
  `;
  return db.db.prepare(sql).all(...grouped.params) as unknown as AggregateRow[];
}

function candidateRows(
  db: AgentDatabase,
  dimension: "campaign" | "market" | "overall",
  options: NormalizedOptions,
): CandidateRow[] {
  const candidateConditions: string[] = [];
  const candidateParams: SQLInputValue[] = [];
  if (options.startAt) {
    candidateConditions.push("dc.created_at >= ?");
    candidateParams.push(options.startAt);
  }
  if (options.endAt) {
    candidateConditions.push("dc.created_at < ?");
    candidateParams.push(options.endAt);
  }
  if (options.campaignId) {
    candidateConditions.push("dc.campaign_id = ?");
    candidateParams.push(options.campaignId);
  }
  if (options.market) {
    candidateConditions.push("candidate_campaign.market = ? COLLATE NOCASE");
    candidateParams.push(options.market);
  }
  const lead = leadCohortSql(options);
  const group = dimension === "campaign"
    ? {
        key: "COALESCE(campaign_id, 'unassigned')",
        label: "campaign_name",
      }
    : dimension === "market"
      ? { key: "market", label: "market" }
      : { key: "'all'", label: "'总计'" };
  const sql = `
    WITH lead_cohort AS (${lead.sql}),
    candidate_cohort AS (
      SELECT
        COALESCE(dc.campaign_id, '') || ':' || lower(dc.domain) AS candidate_key,
        dc.campaign_id,
        COALESCE(candidate_campaign.name, dc.campaign_id, '未归属活动') AS campaign_name,
        COALESCE(NULLIF(candidate_campaign.market, ''), '未归属市场') AS market
      FROM discovery_candidates dc
      LEFT JOIN campaigns candidate_campaign ON candidate_campaign.id=dc.campaign_id
      ${candidateConditions.length > 0 ? `WHERE ${candidateConditions.join(" AND ")}` : ""}
      UNION
      SELECT
        COALESCE(lead_cohort.campaign_id, '') || ':' || lower(lead_cohort.domain) AS candidate_key,
        lead_cohort.campaign_id,
        lead_cohort.campaign_name,
        lead_cohort.market
      FROM lead_cohort
    )
    SELECT ${group.key} AS group_key, ${group.label} AS group_label,
           COUNT(DISTINCT candidate_key) AS candidates
    FROM candidate_cohort
    GROUP BY group_key, group_label
  `;
  return db.db.prepare(sql).all(...lead.params, ...candidateParams) as unknown as CandidateRow[];
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function rates(counts: FunnelCounts): FunnelRates {
  return {
    candidateToCompany: safeRate(counts.companyPassed, counts.candidates),
    companyToNamedContact: safeRate(counts.namedEmploymentVerified, counts.companyPassed),
    namedContactToVerifiedEmail: safeRate(counts.verifiedEmail, counts.namedEmploymentVerified),
    namedContactToValidEmail: safeRate(counts.validEmail, counts.namedEmploymentVerified),
    namedContactToRiskyEmail: safeRate(counts.riskyEmail, counts.namedEmploymentVerified),
    verifiedEmailToReady: safeRate(counts.ready, counts.verifiedEmail),
    readyToApproved: safeRate(counts.approved, counts.ready),
    approvedToSent: safeRate(counts.sent, counts.approved),
    sentToHardBounce: safeRate(counts.hardBounce, counts.sent),
    sentToHumanReply: safeRate(counts.humanReply, counts.sent),
    humanReplyToP1: safeRate(counts.p1, counts.humanReply),
    humanReplyToP2: safeRate(counts.p2, counts.humanReply),
    sentToP1: safeRate(counts.p1, counts.sent),
    sentToP2: safeRate(counts.p2, counts.sent),
  };
}

function toCounts(row?: AggregateRow, candidates = 0): FunnelCounts {
  if (!row) return { ...EMPTY_COUNTS, candidates };
  return {
    candidates,
    companyPassed: Number(row.company_passed),
    namedEmploymentVerified: Number(row.named_employment_verified),
    validEmail: Number(row.valid_email),
    riskyEmail: Number(row.risky_email),
    verifiedEmail: Number(row.verified_email),
    ready: Number(row.ready),
    approved: Number(row.approved),
    sent: Number(row.sent),
    hardBounce: Number(row.hard_bounce),
    humanReply: Number(row.human_reply),
    p1: Number(row.p1),
    p2: Number(row.p2),
  };
}

function slices(
  aggregate: AggregateRow[],
  candidates: CandidateRow[],
  sourceAttribution: boolean,
): FunnelSlice[] {
  const aggregateByKey = new Map(aggregate.map((row) => [row.group_key, row]));
  const candidateByKey = new Map(candidates.map((row) => [row.group_key, row]));
  const keys = new Set([...aggregateByKey.keys(), ...candidateByKey.keys()]);
  const result = [...keys].map((key) => {
    const aggregateRow = aggregateByKey.get(key);
    const candidateRow = candidateByKey.get(key);
    const candidateCount = sourceAttribution
      ? Number(aggregateRow?.company_passed ?? 0)
      : Number(candidateRow?.candidates ?? 0);
    const counts = toCounts(aggregateRow, candidateCount);
    return {
      key,
      label: aggregateRow?.group_label ?? candidateRow?.group_label ?? key,
      counts,
      rates: rates(counts),
    };
  });
  return result.sort((left, right) =>
    right.counts.candidates - left.counts.candidates || left.label.localeCompare(right.label),
  );
}

/**
 * Builds a read-only cohort report. startAt/endAt select candidate and lead creation
 * time; contact, review, approval, send and inbound stages are cumulative as of the
 * query so a lead remains in every stage it has historically reached.
 */
export function buildFunnelReport(
  db: AgentDatabase,
  input: FunnelReportOptions = {},
): FunnelReport {
  const options = normalizeOptions(input);
  const sourceAttribution = Boolean(options.sourceType);
  const overallAggregates = aggregateRows(db, "overall", options);
  const campaignAggregates = aggregateRows(db, "campaign", options);
  const marketAggregates = aggregateRows(db, "market", options);
  const sourceAggregates = aggregateRows(db, "sourceType", options);

  const overallCandidates = sourceAttribution ? [] : candidateRows(db, "overall", options);
  const campaignCandidates = sourceAttribution ? [] : candidateRows(db, "campaign", options);
  const marketCandidates = sourceAttribution ? [] : candidateRows(db, "market", options);

  const overall = slices(overallAggregates, overallCandidates, sourceAttribution)[0] ?? {
    key: "all",
    label: "总计",
    counts: { ...EMPTY_COUNTS },
    rates: rates(EMPTY_COUNTS),
  };
  const notes = [
    "时间窗按 candidate/lead.created_at cohort；联系人、审核、批准、发送和入站结果累计至报告生成时。",
    "每项均按独立 lead（候选按 campaign+domain）去重；同一 lead 的多 URL、多消息和多回复不重复计数。",
    "来源拆分是多重归因，跨来源不可相加；来源维度的候选仅从已有 lead_sources 归因的 lead 母集开始。",
  ];
  if (sourceAttribution) {
    notes.push("已应用 sourceType 筛选，因此总计/活动/市场的候选数也只覆盖可归因 lead，不含未转为 lead 的候选。");
  }
  return {
    generatedAt: options.generatedAt,
    cohort: {
      basis: "created_at",
      startAt: options.startAt,
      endAt: options.endAt,
      downstreamOutcomes: "cumulative_through_generated_at",
    },
    filters: {
      campaignId: options.campaignId,
      market: options.market,
      sourceType: options.sourceType,
    },
    overall,
    byCampaign: slices(campaignAggregates, campaignCandidates, sourceAttribution),
    byMarket: slices(marketAggregates, marketCandidates, sourceAttribution),
    bySourceType: slices(sourceAggregates, [], true),
    notes,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function compactSlice(slice: FunnelSlice): string {
  const { counts: c, rates: r } = slice;
  return [
    `候选 ${c.candidates}`,
    `公司 ${c.companyPassed} (${percent(r.candidateToCompany)})`,
    `联系人 ${c.namedEmploymentVerified} (${percent(r.companyToNamedContact)})`,
    `邮箱 ${c.verifiedEmail} (${percent(r.namedContactToVerifiedEmail)}; VALID ${c.validEmail} / RISKY ${c.riskyEmail})`,
    `READY ${c.ready} (${percent(r.verifiedEmailToReady)})`,
    `APPROVED ${c.approved} (${percent(r.readyToApproved)})`,
    `发送 ${c.sent} (${percent(r.approvedToSent)})`,
  ].join(" -> ");
}

export interface FunnelFormatOptions {
  includeCampaigns?: boolean;
  includeMarkets?: boolean;
  includeSources?: boolean;
  maxGroupsPerDimension?: number;
}

/** Compact plain/Markdown-safe text suitable for command cards and daily reports. */
export function formatFunnelReport(
  report: FunnelReport,
  options: FunnelFormatOptions = {},
): string {
  const maxGroups = Math.max(0, options.maxGroupsPerDimension ?? 8);
  const start = report.cohort.startAt ?? "不限";
  const end = report.cohort.endAt ?? "不限";
  const { counts: c, rates: r } = report.overall;
  const lines = [
    `口径：created_at cohort [${start}, ${end})；下游结果累计至 ${report.generatedAt}`,
    "去重与归因：每项按独立 lead；候选按 campaign+domain；来源候选仅含已有 lead_sources 归因的 lead，跨来源不可相加。",
    compactSlice(report.overall),
    `结果：硬退信 ${c.hardBounce} (${percent(r.sentToHardBounce)} / 已发送) | 人工回复 ${c.humanReply} (${percent(r.sentToHumanReply)} / 已发送) | P1 ${c.p1} (${percent(r.humanReplyToP1)} / 回复) | P2 ${c.p2} (${percent(r.humanReplyToP2)} / 回复)`,
  ];
  const append = (title: string, values: FunnelSlice[]): void => {
    if (values.length === 0 || maxGroups === 0) return;
    lines.push(`**${title}**`);
    for (const slice of values.slice(0, maxGroups)) {
      lines.push(`- ${slice.label}: ${compactSlice(slice)}`);
    }
    if (values.length > maxGroups) lines.push(`- 其余 ${values.length - maxGroups} 组已省略`);
  };
  if (options.includeCampaigns) append("按活动", report.byCampaign);
  if (options.includeMarkets ?? true) append("按市场", report.byMarket);
  if (options.includeSources ?? true) append("按来源（多重归因，不可相加）", report.bySourceType);
  return lines.join("\n");
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInTimeZone(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsInTimeZone(new Date(guess), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = target - represented;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}

export function localDayUtcWindow(
  now: Date,
  timeZone: string,
): { localDate: string; startAt: string; endAt: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const parts = partsInTimeZone(now, timeZone);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const start = localMidnightUtc(parts.year, parts.month, parts.day, timeZone);
  const end = localMidnightUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    timeZone,
  );
  return {
    localDate: [parts.year, String(parts.month).padStart(2, "0"), String(parts.day).padStart(2, "0")].join("-"),
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  };
}
