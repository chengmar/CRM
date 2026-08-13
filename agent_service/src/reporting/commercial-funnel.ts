import type { SQLInputValue } from "node:sqlite";
import type { AgentDatabase } from "../db.js";

export const COMMERCIAL_DIMENSIONS = [
  "market",
  "play",
  "qualificationTrack",
  "provider",
  "channel",
  "offer",
  "experiment",
] as const;

export type CommercialDimension = (typeof COMMERCIAL_DIMENSIONS)[number];
export type AttributionDimension = "source" | "medium" | "campaign" | "content" | "landing" | "referrer";
export type AttributionPosition = "FIRST" | "LAST" | "ASSIST";

export interface CommercialReportOptions {
  /** Delivery evidence timestamp, inclusive. */
  startAt?: string | Date | null;
  /** Delivery evidence timestamp, exclusive. */
  endAt?: string | Date | null;
  /** Read-only snapshot boundary for downstream records. */
  generatedAt?: string | Date;
}

export interface CommercialCounts {
  deliveredCohorts: number;
  deliveredAccounts: number;
  deliveredMessages: number;
  qualifiedAccounts: number;
  namedCurrentContactAccounts: number;
  validContactAccounts: number;
  readyAccounts: number;
  approvedAccounts: number;
  hardBounceAccounts: number;
  negativeAccounts: number;
  unsubscribeAccounts: number;
  p1Accounts: number;
  p2Accounts: number;
  referralAccounts: number;
  inquiries: number;
  quoteOpportunities: number;
  deals: number;
}

export interface CommercialRates {
  denominator: "delivered_accounts";
  qualifiedAccountRate: number;
  namedCurrentContactRate: number;
  validContactRate: number;
  readyRate: number;
  approvedRate: number;
  deliveredRate: 1 | 0;
  hardBounceRate: number;
  negativeRate: number;
  unsubscribeRate: number;
  p1Rate: number;
  p2Rate: number;
  referralRate: number;
  inquiryRate: number;
  quoteOpportunityRate: number;
  dealRate: number;
}

export interface CommercialMoney {
  /** Won revenue in the currency's minor unit. */
  revenueMinorByCurrency: Record<string, number>;
  /** Won gross margin in the currency's minor unit. */
  grossMarginMinorByCurrency: Record<string, number>;
  /** Provider/resource cost in millionths of the currency unit. */
  costMicrosByCurrency: Record<string, number>;
  costPerValidMicrosByCurrency: Record<string, number>;
  costPerInquiryMicrosByCurrency: Record<string, number>;
  costPerQuoteMicrosByCurrency: Record<string, number>;
  costPerDealMicrosByCurrency: Record<string, number>;
}

export interface CommercialSlice {
  key: string;
  label: string;
  counts: CommercialCounts;
  rates: CommercialRates;
  money: CommercialMoney;
}

export interface TouchpointAttributionSlice {
  key: string;
  label: string;
  touchpoints: number;
  opportunities: number;
  quoteOpportunities: number;
  deals: number;
  associatedRevenueMinorByCurrency: Record<string, number>;
  associatedGrossMarginMinorByCurrency: Record<string, number>;
}

export interface TouchpointPositionReport {
  bySource: TouchpointAttributionSlice[];
  byMedium: TouchpointAttributionSlice[];
  byCampaign: TouchpointAttributionSlice[];
  byContent: TouchpointAttributionSlice[];
  byLanding: TouchpointAttributionSlice[];
  byReferrer: TouchpointAttributionSlice[];
}

export interface CommercialFunnelReport {
  generatedAt: string;
  cohort: {
    basis: "delivered_evidence";
    unit: "account_play_enrollment_or_legacy_lead";
    acceptedEvidence: readonly ["MESSAGE_DELIVERED_EVENT", "DELIVERED_STATUS", "REPLIED_STATUS"];
    explicitlyExcludedStatus: "SENT";
    startAt: string | null;
    endAt: string | null;
  };
  overall: CommercialSlice;
  byDimension: Record<CommercialDimension, CommercialSlice[]>;
  touchpointAttribution: {
    interpretation: "DESCRIPTIVE_ONLY";
    cohortRestriction: "DELIVERED_COHORT_ONLY";
    positionBasis: "STORED_OBSERVED_POSITION";
    first: TouchpointPositionReport;
    last: TouchpointPositionReport;
    assist: TouchpointPositionReport;
    unpositionedTouchpoints: number;
  };
  unresolved: {
    intakes: number;
    opportunities: number;
    resourceUsage: number;
  };
  notes: string[];
}

export interface CommercialFunnelOperatorResult {
  command: "commercial-funnel";
  readOnly: true;
  externalActionsAttempted: false;
  report: CommercialFunnelReport;
}

interface NormalizedOptions {
  startAt: string | null;
  endAt: string | null;
  generatedAt: string;
}

const COMMERCIAL_FUNNEL_CLI_OPTIONS = {
  "--start-at": "startAt",
  "--end-at": "endAt",
  "--generated-at": "generatedAt",
} as const satisfies Record<string, keyof CommercialReportOptions>;

/** Parse the bounded, read-only options accepted by the commercial-funnel CLI command. */
export function parseCommercialFunnelCliOptions(
  args: readonly string[],
): CommercialReportOptions {
  const options: CommercialReportOptions = {};
  const seen = new Set<keyof CommercialReportOptions>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    const key = COMMERCIAL_FUNNEL_CLI_OPTIONS[
      flag as keyof typeof COMMERCIAL_FUNNEL_CLI_OPTIONS
    ];
    if (!key) throw new Error(`Unknown commercial-funnel option: ${flag || argument}`);
    if (seen.has(key)) throw new Error(`Duplicate commercial-funnel option: ${flag}`);

    const inlineValue = separator >= 0 ? argument.slice(separator + 1) : null;
    const nextValue = inlineValue ?? args[index + 1];
    if (!nextValue?.trim() || (inlineValue === null && nextValue.startsWith("--"))) {
      throw new Error(`${flag} requires a date value`);
    }
    if (inlineValue === null) index += 1;
    options[key] = nextValue.trim();
    seen.add(key);
  }

  return options;
}

interface CohortRow {
  cohort_key: string;
  account_id: string | null;
  enrollment_id: string | null;
  play_version_id: string | null;
  play_id: string | null;
  market: string | null;
  play_key: string | null;
  play_name: string | null;
  qualification_track: string | null;
  offer: string | null;
  first_delivered_at: string;
  qualified: number;
  named_current_contact: number;
  valid_contact: number;
  ready: number;
  approved: number;
}

interface MessageRow {
  message_id: string;
  cohort_key: string;
  lead_id: string;
  status: string;
  channel: string;
  is_delivered: number;
}

interface IntakeRow {
  id: string;
  classification: string | null;
  account_id: string | null;
  legacy_lead_id: string | null;
  outbound_message_id: string | null;
}

interface LegacyInboundRow {
  id: string;
  classification: string;
  lead_id: string | null;
  outbound_message_id: string | null;
}

interface OpportunityRow {
  id: string;
  account_id: string | null;
  enrollment_id: string | null;
  intake_id: string | null;
  stage: string;
  quote_opportunity: number;
  revenue_minor: number | null;
  currency: string | null;
  gross_margin_bps: number | null;
}

interface ResourceRow {
  id: string;
  provider_id: string | null;
  provider_key: string | null;
  provider_name: string | null;
  account_id: string | null;
  play_version_id: string | null;
  cost_micros: number;
  currency: string;
}

interface ProviderRunRow {
  provider_id: string;
  provider_key: string;
  provider_name: string;
  account_id: string | null;
  play_version_id: string | null;
}

interface ExperimentRow {
  experiment_id: string;
  experiment_key: string;
  subject_type: string;
  subject_id: string;
  arm: string;
}

interface TouchpointRow {
  id: string;
  opportunity_id: string;
  attribution_position: string;
  source: string;
  medium: string;
  campaign: string | null;
  content: string | null;
  landing: string | null;
  referrer: string | null;
}

interface DimensionValue {
  key: string;
  label: string;
}

interface CostFact {
  id: string;
  providerId: string | null;
  costMicros: number;
  currency: string;
}

interface OpportunityFact {
  id: string;
  accountKey: string;
  quoteOpportunity: boolean;
  won: boolean;
  revenueMinor: number | null;
  currency: string | null;
  grossMarginBps: number | null;
}

interface CohortFact {
  row: CohortRow;
  accountKey: string;
  qualified: boolean;
  namedCurrentContact: boolean;
  validContact: boolean;
  ready: boolean;
  approved: boolean;
  hardBounce: boolean;
  messages: MessageRow[];
  classifications: Set<string>;
  opportunities: Map<string, OpportunityFact>;
  costs: Map<string, CostFact>;
  dimensions: Record<CommercialDimension, DimensionValue[]>;
}

interface AttributionFact {
  row: TouchpointRow;
  opportunity: OpportunityFact;
}

interface CohortSql {
  sql: string;
  params: SQLInputValue[];
}

function normalizeDate(value: string | Date | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date.toISOString();
}

function normalizeOptions(options: CommercialReportOptions): NormalizedOptions {
  const startAt = normalizeDate(options.startAt, "startAt");
  const endAt = normalizeDate(options.endAt, "endAt");
  if (startAt && endAt && startAt >= endAt) throw new Error("endAt must be later than startAt");
  return {
    startAt,
    endAt,
    generatedAt: normalizeDate(options.generatedAt ?? new Date(), "generatedAt") as string,
  };
}

function cohortSql(options: NormalizedOptions): CohortSql {
  const deliveryConditions = ["delivery_evidence=1", "delivered_at IS NOT NULL", "delivered_at<=?"];
  const params: SQLInputValue[] = [options.generatedAt];
  if (options.startAt) {
    deliveryConditions.push("delivered_at>=?");
    params.push(options.startAt);
  }
  if (options.endAt) {
    deliveryConditions.push("delivered_at<?");
    params.push(options.endAt);
  }
  return {
    sql: `
      WITH delivery_events AS (
        SELECT entity_id AS message_id, min(created_at) AS delivered_event_at
        FROM events
        WHERE entity_type='outbound_message' AND event_type='MESSAGE_DELIVERED'
        GROUP BY entity_id
      ),
      message_resolution AS (
        SELECT om.id AS message_id, om.lead_id, om.status, om.channel, om.approved_at,
          om.sent_at, om.updated_at, de.delivered_event_at,
          pe.id AS enrollment_id,
          coalesce(pe.account_id, pp.account_id, lal.account_id) AS account_id,
          coalesce(pe.play_version_id, cpl.play_version_id) AS play_version_id,
          p.id AS play_id,
          coalesce(nullif(p.country, ''), nullif(c.market, ''), nullif(a.country_code, ''),
            nullif(l.country, '')) AS market,
          p.play_key, p.name AS play_name,
          coalesce(pe.qualification_track, pp.qualification_track, p.qualification_track) AS qualification_track,
          p.offer
        FROM outbound_messages om
        JOIN leads l ON l.id=om.lead_id
        LEFT JOIN delivery_events de ON de.message_id=om.id
        LEFT JOIN message_versions mv ON mv.id=(
          SELECT mv2.id FROM message_versions mv2
          WHERE mv2.outbound_message_id=om.id
          ORDER BY mv2.version_number DESC, mv2.created_at DESC LIMIT 1
        )
        LEFT JOIN personalization_plans pp ON pp.id=mv.personalization_plan_id
        LEFT JOIN play_enrollments legacy_pe ON legacy_pe.legacy_lead_id=om.lead_id
        LEFT JOIN play_enrollments pe ON pe.id=coalesce(pp.enrollment_id, legacy_pe.id)
        LEFT JOIN lead_account_links lal ON lal.lead_id=om.lead_id
        LEFT JOIN campaign_play_links cpl ON cpl.campaign_id=om.campaign_id AND cpl.is_primary=1
        LEFT JOIN play_versions pv ON pv.id=coalesce(pe.play_version_id, cpl.play_version_id)
        LEFT JOIN plays p ON p.id=pv.play_id
        LEFT JOIN accounts a ON a.id=coalesce(pe.account_id, pp.account_id, lal.account_id)
        LEFT JOIN campaigns c ON c.id=om.campaign_id
      ),
      message_context AS (
        SELECT mr.*,
          CASE
            WHEN mr.enrollment_id IS NOT NULL THEN 'enrollment:' || mr.enrollment_id
            WHEN mr.account_id IS NOT NULL AND mr.play_version_id IS NOT NULL
              THEN 'account-play:' || mr.account_id || ':' || mr.play_version_id
            ELSE 'legacy-lead:' || mr.lead_id
          END AS cohort_key,
          CASE WHEN mr.delivered_event_at IS NOT NULL OR mr.status IN ('DELIVERED','REPLIED')
            THEN 1 ELSE 0 END AS delivery_evidence,
          coalesce(mr.delivered_event_at,
            CASE WHEN mr.status IN ('DELIVERED','REPLIED') THEN mr.sent_at END) AS delivered_at
        FROM message_resolution mr
      ),
      delivered_messages AS (
        SELECT * FROM message_context WHERE ${deliveryConditions.join(" AND ")}
      ),
      cohort AS (
        SELECT cohort_key, max(account_id) AS account_id, max(enrollment_id) AS enrollment_id,
          max(play_version_id) AS play_version_id, max(play_id) AS play_id,
          max(market) AS market, max(play_key) AS play_key, max(play_name) AS play_name,
          max(qualification_track) AS qualification_track, max(offer) AS offer,
          min(delivered_at) AS first_delivered_at
        FROM delivered_messages
        GROUP BY cohort_key
      )
    `,
    params,
  };
}

function queryRows<T>(
  db: AgentDatabase,
  cohort: CohortSql,
  selectSql: string,
  extraParams: SQLInputValue[] = [],
): T[] {
  return db.db.prepare(`${cohort.sql}\n${selectSql}`).all(...cohort.params, ...extraParams) as unknown as T[];
}

function addToSetMap(map: Map<string, Set<string>>, key: string | null, value: string): void {
  if (!key) return;
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function only(values: Set<string> | undefined): string | null {
  return values?.size === 1 ? [...values][0] ?? null : null;
}

function dimensionValue(prefix: string, raw: string | null | undefined, fallback: string): DimensionValue {
  const label = raw?.trim() || fallback;
  return { key: `${prefix}:${label.toLocaleLowerCase("en-US")}`, label };
}

function pushUnique(values: DimensionValue[], value: DimensionValue): void {
  if (!values.some((candidate) => candidate.key === value.key)) values.push(value);
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function addMoney(target: Record<string, number>, currency: string | null, amount: number | null): void {
  if (!currency || amount === null || !Number.isFinite(amount)) return;
  target[currency] = (target[currency] ?? 0) + amount;
}

function divideMoney(source: Record<string, number>, denominator: number): Record<string, number> {
  return Object.fromEntries(Object.entries(source).map(([currency, amount]) => [
    currency,
    denominator > 0 ? amount / denominator : 0,
  ]));
}

function resolveScopedCohort(
  input: {
    enrollmentId?: string | null;
    accountId?: string | null;
    legacyLeadId?: string | null;
    outboundMessageId?: string | null;
    intakeId?: string | null;
  },
  indexes: {
    enrollment: Map<string, string>;
    account: Map<string, Set<string>>;
    lead: Map<string, Set<string>>;
    message: Map<string, string>;
    intake: Map<string, string>;
  },
): string | null {
  if (input.enrollmentId) {
    const exact = indexes.enrollment.get(input.enrollmentId);
    if (exact) return exact;
  }
  if (input.outboundMessageId) {
    const exact = indexes.message.get(input.outboundMessageId);
    if (exact) return exact;
  }
  if (input.intakeId) {
    const exact = indexes.intake.get(input.intakeId);
    if (exact) return exact;
  }
  if (input.legacyLeadId) {
    const exact = only(indexes.lead.get(input.legacyLeadId));
    if (exact) return exact;
  }
  if (input.accountId) return only(indexes.account.get(input.accountId));
  return null;
}

function aggregateCommercialSlice(
  facts: CohortFact[],
  key: string,
  label: string,
  context?: { dimension: CommercialDimension; value: DimensionValue },
): CommercialSlice {
  const accountKeys = new Set<string>();
  const qualified = new Set<string>();
  const named = new Set<string>();
  const valid = new Set<string>();
  const ready = new Set<string>();
  const approved = new Set<string>();
  const bounced = new Set<string>();
  const negative = new Set<string>();
  const unsubscribe = new Set<string>();
  const p1 = new Set<string>();
  const p2 = new Set<string>();
  const referral = new Set<string>();
  const opportunities = new Map<string, OpportunityFact>();
  const costs = new Map<string, CostFact>();
  let deliveredMessages = 0;

  for (const fact of facts) {
    accountKeys.add(fact.accountKey);
    if (fact.qualified) qualified.add(fact.accountKey);
    if (fact.namedCurrentContact) named.add(fact.accountKey);
    if (fact.validContact) valid.add(fact.accountKey);
    if (fact.ready) ready.add(fact.accountKey);
    if (fact.approved) approved.add(fact.accountKey);
    if (fact.hardBounce) bounced.add(fact.accountKey);
    if (fact.classifications.has("NEGATIVE")) negative.add(fact.accountKey);
    if (fact.classifications.has("UNSUBSCRIBE")) unsubscribe.add(fact.accountKey);
    if (fact.classifications.has("P1_INQUIRY")) p1.add(fact.accountKey);
    if (fact.classifications.has("P2_INTEREST")) p2.add(fact.accountKey);
    if (fact.classifications.has("REFERRAL")) referral.add(fact.accountKey);
    for (const message of fact.messages) {
      if (!message.is_delivered) continue;
      if (context?.dimension === "channel" &&
          dimensionValue("channel", message.channel.toLowerCase(), "Unattributed channel").key !== context.value.key) {
        continue;
      }
      deliveredMessages += 1;
    }
    for (const opportunity of fact.opportunities.values()) opportunities.set(opportunity.id, opportunity);
    for (const cost of fact.costs.values()) {
      if (context?.dimension === "provider" &&
          `provider:${cost.providerId ?? "unattributed"}` !== context.value.key) continue;
      costs.set(cost.id, cost);
    }
  }

  const quoteOpportunities = [...opportunities.values()].filter((value) => value.quoteOpportunity);
  const deals = [...opportunities.values()].filter((value) => value.won);
  const inquiryAccounts = new Set([...opportunities.values()].map((value) => value.accountKey));
  const quoteAccounts = new Set(quoteOpportunities.map((value) => value.accountKey));
  const dealAccounts = new Set(deals.map((value) => value.accountKey));
  const revenueMinorByCurrency: Record<string, number> = {};
  const grossMarginMinorByCurrency: Record<string, number> = {};
  for (const deal of deals) {
    addMoney(revenueMinorByCurrency, deal.currency, deal.revenueMinor);
    const grossMargin = deal.revenueMinor !== null && deal.grossMarginBps !== null
      ? Math.round(deal.revenueMinor * deal.grossMarginBps / 10_000)
      : null;
    addMoney(grossMarginMinorByCurrency, deal.currency, grossMargin);
  }
  const costMicrosByCurrency: Record<string, number> = {};
  for (const cost of costs.values()) addMoney(costMicrosByCurrency, cost.currency, cost.costMicros);

  const counts: CommercialCounts = {
    deliveredCohorts: facts.length,
    deliveredAccounts: accountKeys.size,
    deliveredMessages,
    qualifiedAccounts: qualified.size,
    namedCurrentContactAccounts: named.size,
    validContactAccounts: valid.size,
    readyAccounts: ready.size,
    approvedAccounts: approved.size,
    hardBounceAccounts: bounced.size,
    negativeAccounts: negative.size,
    unsubscribeAccounts: unsubscribe.size,
    p1Accounts: p1.size,
    p2Accounts: p2.size,
    referralAccounts: referral.size,
    inquiries: opportunities.size,
    quoteOpportunities: quoteOpportunities.length,
    deals: deals.length,
  };
  const denominator = counts.deliveredAccounts;
  return {
    key,
    label,
    counts,
    rates: {
      denominator: "delivered_accounts",
      qualifiedAccountRate: safeRate(counts.qualifiedAccounts, denominator),
      namedCurrentContactRate: safeRate(counts.namedCurrentContactAccounts, denominator),
      validContactRate: safeRate(counts.validContactAccounts, denominator),
      readyRate: safeRate(counts.readyAccounts, denominator),
      approvedRate: safeRate(counts.approvedAccounts, denominator),
      deliveredRate: denominator > 0 ? 1 : 0,
      hardBounceRate: safeRate(counts.hardBounceAccounts, denominator),
      negativeRate: safeRate(counts.negativeAccounts, denominator),
      unsubscribeRate: safeRate(counts.unsubscribeAccounts, denominator),
      p1Rate: safeRate(counts.p1Accounts, denominator),
      p2Rate: safeRate(counts.p2Accounts, denominator),
      referralRate: safeRate(counts.referralAccounts, denominator),
      inquiryRate: safeRate(inquiryAccounts.size, denominator),
      quoteOpportunityRate: safeRate(quoteAccounts.size, denominator),
      dealRate: safeRate(dealAccounts.size, denominator),
    },
    money: {
      revenueMinorByCurrency,
      grossMarginMinorByCurrency,
      costMicrosByCurrency,
      costPerValidMicrosByCurrency: divideMoney(costMicrosByCurrency, counts.validContactAccounts),
      costPerInquiryMicrosByCurrency: divideMoney(costMicrosByCurrency, counts.inquiries),
      costPerQuoteMicrosByCurrency: divideMoney(costMicrosByCurrency, counts.quoteOpportunities),
      costPerDealMicrosByCurrency: divideMoney(costMicrosByCurrency, counts.deals),
    },
  };
}

function buildDimensionSlices(
  facts: Map<string, CohortFact>,
  dimension: CommercialDimension,
): CommercialSlice[] {
  const groups = new Map<string, { value: DimensionValue; facts: Map<string, CohortFact> }>();
  for (const [cohortKey, fact] of facts) {
    for (const value of fact.dimensions[dimension]) {
      const group = groups.get(value.key) ?? { value, facts: new Map<string, CohortFact>() };
      group.facts.set(cohortKey, fact);
      groups.set(value.key, group);
    }
  }
  return [...groups.values()]
    .map((group) => aggregateCommercialSlice(
      [...group.facts.values()],
      group.value.key,
      group.value.label,
      { dimension, value: group.value },
    ))
    .sort((left, right) =>
      right.counts.deliveredAccounts - left.counts.deliveredAccounts || left.label.localeCompare(right.label));
}

function attributionSlices(
  facts: AttributionFact[],
  dimension: AttributionDimension,
): TouchpointAttributionSlice[] {
  const groups = new Map<string, {
    value: DimensionValue;
    touchpoints: Set<string>;
    opportunities: Map<string, OpportunityFact>;
  }>();
  for (const fact of facts) {
    const raw = fact.row[dimension];
    const value = dimensionValue(dimension, raw, `Unattributed ${dimension}`);
    const group = groups.get(value.key) ?? {
      value,
      touchpoints: new Set<string>(),
      opportunities: new Map<string, OpportunityFact>(),
    };
    group.touchpoints.add(fact.row.id);
    group.opportunities.set(fact.opportunity.id, fact.opportunity);
    groups.set(value.key, group);
  }
  return [...groups.values()].map((group) => {
    const opportunities = [...group.opportunities.values()];
    const quoteOpportunities = opportunities.filter((value) => value.quoteOpportunity);
    const deals = opportunities.filter((value) => value.won);
    const revenue: Record<string, number> = {};
    const margin: Record<string, number> = {};
    for (const deal of deals) {
      addMoney(revenue, deal.currency, deal.revenueMinor);
      addMoney(
        margin,
        deal.currency,
        deal.revenueMinor !== null && deal.grossMarginBps !== null
          ? Math.round(deal.revenueMinor * deal.grossMarginBps / 10_000)
          : null,
      );
    }
    return {
      key: group.value.key,
      label: group.value.label,
      touchpoints: group.touchpoints.size,
      opportunities: opportunities.length,
      quoteOpportunities: quoteOpportunities.length,
      deals: deals.length,
      associatedRevenueMinorByCurrency: revenue,
      associatedGrossMarginMinorByCurrency: margin,
    };
  }).sort((left, right) =>
    right.opportunities - left.opportunities || right.touchpoints - left.touchpoints ||
    left.label.localeCompare(right.label));
}

function positionReport(facts: AttributionFact[]): TouchpointPositionReport {
  return {
    bySource: attributionSlices(facts, "source"),
    byMedium: attributionSlices(facts, "medium"),
    byCampaign: attributionSlices(facts, "campaign"),
    byContent: attributionSlices(facts, "content"),
    byLanding: attributionSlices(facts, "landing"),
    byReferrer: attributionSlices(facts, "referrer"),
  };
}

/**
 * Builds a read-only commercial report whose population starts at observed delivery.
 * SENT-only messages never enter the cohort. Every multi-value dimension and every
 * touchpoint section is descriptive association; slices must not be added together
 * or interpreted as incremental/causal impact.
 */
export function buildCommercialFunnelReport(
  db: AgentDatabase,
  input: CommercialReportOptions = {},
): CommercialFunnelReport {
  const options = normalizeOptions(input);
  const cte = cohortSql(options);
  const rows = queryRows<CohortRow>(db, cte, `
    SELECT c.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM qualification_runs qr
        WHERE qr.status='COMPLETE' AND qr.decision='QUALIFIED' AND qr.created_at<=?
          AND ((c.enrollment_id IS NOT NULL AND qr.enrollment_id=c.enrollment_id)
            OR (c.account_id IS NOT NULL AND qr.enrollment_id IS NULL AND qr.account_id=c.account_id))
      ) OR EXISTS (
        SELECT 1 FROM play_enrollments pe WHERE pe.id=c.enrollment_id
          AND pe.status IN ('QUALIFIED','READY_FOR_REVIEW','APPROVED','ACTIVE','HUMAN_TAKEOVER','STOPPED')
      ) OR EXISTS (
        SELECT 1 FROM leads l JOIN message_context mc ON mc.lead_id=l.id
        WHERE mc.cohort_key=c.cohort_key AND l.send_eligible=1
      ) THEN 1 ELSE 0 END AS qualified,
      CASE WHEN EXISTS (
        SELECT 1 FROM employments e JOIN people person ON person.id=e.person_id
        WHERE e.account_id=c.account_id AND e.is_current=1 AND e.status='VERIFIED'
          AND nullif(trim(person.display_name), '') IS NOT NULL AND e.created_at<=?
      ) OR EXISTS (
        SELECT 1 FROM contacts legacy_contact JOIN message_context mc ON mc.lead_id=legacy_contact.lead_id
        WHERE mc.cohort_key=c.cohort_key AND nullif(trim(legacy_contact.name), '') IS NOT NULL
          AND legacy_contact.employment_verified_at IS NOT NULL AND legacy_contact.created_at<=?
      ) THEN 1 ELSE 0 END AS named_current_contact,
      CASE WHEN EXISTS (
        SELECT 1 FROM contact_points cp JOIN employments e ON e.person_id=cp.person_id
        WHERE e.account_id=c.account_id AND e.is_current=1 AND e.status='VERIFIED'
          AND cp.kind='EMAIL' AND cp.verification_status='VALID' AND cp.created_at<=?
      ) OR EXISTS (
        SELECT 1 FROM contacts legacy_contact JOIN message_context mc ON mc.lead_id=legacy_contact.lead_id
        WHERE mc.cohort_key=c.cohort_key AND legacy_contact.email_status='VALID'
          AND legacy_contact.email IS NOT NULL AND legacy_contact.created_at<=?
      ) THEN 1 ELSE 0 END AS valid_contact,
      CASE WHEN EXISTS (
        SELECT 1 FROM play_enrollments pe WHERE pe.id=c.enrollment_id
          AND pe.status IN ('READY_FOR_REVIEW','APPROVED','ACTIVE','HUMAN_TAKEOVER','STOPPED')
      ) OR EXISTS (
        SELECT 1 FROM leads l JOIN message_context mc ON mc.lead_id=l.id
        WHERE mc.cohort_key=c.cohort_key
          AND l.status IN ('READY_FOR_REVIEW','APPROVED','CONTACTED','REPLIED','HUMAN_TAKEOVER','STOPPED')
      ) OR EXISTS (
        SELECT 1 FROM events e JOIN message_context mc ON mc.lead_id=e.entity_id
        WHERE mc.cohort_key=c.cohort_key AND e.entity_type='lead' AND e.created_at<=?
          AND e.event_type IN ('OUTREACH_SEQUENCE_APPROVED','LEAD_STATUS_CHANGED')
          AND (e.event_type='OUTREACH_SEQUENCE_APPROVED'
            OR (json_valid(e.payload_json)=1 AND json_extract(e.payload_json, '$.to')='READY_FOR_REVIEW'))
      ) THEN 1 ELSE 0 END AS ready,
      CASE WHEN EXISTS (
        SELECT 1 FROM delivered_messages dm
        WHERE dm.cohort_key=c.cohort_key AND dm.approved_at IS NOT NULL AND dm.approved_at<=?
      ) OR EXISTS (
        SELECT 1 FROM events e JOIN message_context mc ON mc.lead_id=e.entity_id
        WHERE mc.cohort_key=c.cohort_key AND e.entity_type='lead'
          AND e.event_type='OUTREACH_SEQUENCE_APPROVED' AND e.created_at<=?
      ) THEN 1 ELSE 0 END AS approved
    FROM cohort c ORDER BY c.cohort_key
  `, Array(8).fill(options.generatedAt));

  const facts = new Map<string, CohortFact>();
  for (const row of rows) {
    const market = dimensionValue("market", row.market, "Unattributed market");
    const playLabel = row.play_name && row.play_key ? `${row.play_name} (${row.play_key})` : row.play_name ?? row.play_key;
    const play = row.play_id
      ? { key: `play:${row.play_id}`, label: playLabel ?? row.play_id }
      : dimensionValue("play", null, "Unattributed play");
    facts.set(row.cohort_key, {
      row,
      accountKey: row.account_id ?? row.cohort_key,
      qualified: Boolean(row.qualified),
      namedCurrentContact: Boolean(row.named_current_contact),
      validContact: Boolean(row.valid_contact),
      ready: Boolean(row.ready),
      approved: Boolean(row.approved),
      hardBounce: false,
      messages: [],
      classifications: new Set<string>(),
      opportunities: new Map<string, OpportunityFact>(),
      costs: new Map<string, CostFact>(),
      dimensions: {
        market: [market],
        play: [play],
        qualificationTrack: [dimensionValue(
          "qualification-track",
          row.qualification_track,
          "Unattributed qualification track",
        )],
        provider: [],
        channel: [],
        offer: [dimensionValue("offer", row.offer, "Unattributed offer")],
        experiment: [],
      },
    });
  }

  const enrollmentIndex = new Map<string, string>();
  const accountIndex = new Map<string, Set<string>>();
  const leadIndex = new Map<string, Set<string>>();
  const messageIndex = new Map<string, string>();
  const intakeIndex = new Map<string, string>();
  const pairIndex = new Map<string, Set<string>>();
  for (const [cohortKey, fact] of facts) {
    if (fact.row.enrollment_id) enrollmentIndex.set(fact.row.enrollment_id, cohortKey);
    addToSetMap(accountIndex, fact.row.account_id, cohortKey);
    if (fact.row.account_id && fact.row.play_version_id) {
      addToSetMap(pairIndex, `${fact.row.account_id}\0${fact.row.play_version_id}`, cohortKey);
    }
  }

  const messageRows = queryRows<MessageRow>(db, cte, `
    SELECT mc.message_id, mc.cohort_key, mc.lead_id, mc.status, mc.channel,
      CASE WHEN dm.message_id IS NOT NULL THEN 1 ELSE 0 END AS is_delivered
    FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key
    LEFT JOIN delivered_messages dm ON dm.message_id=mc.message_id
    ORDER BY mc.message_id
  `);
  for (const message of messageRows) {
    const fact = facts.get(message.cohort_key);
    if (!fact) continue;
    fact.messages.push(message);
    messageIndex.set(message.message_id, message.cohort_key);
    addToSetMap(leadIndex, message.lead_id, message.cohort_key);
    if (message.status === "BOUNCED") fact.hardBounce = true;
    if (message.is_delivered) {
      pushUnique(
        fact.dimensions.channel,
        dimensionValue("channel", message.channel.toLowerCase(), "Unattributed channel"),
      );
    }
  }

  const indexes = {
    enrollment: enrollmentIndex,
    account: accountIndex,
    lead: leadIndex,
    message: messageIndex,
    intake: intakeIndex,
  };
  let unresolvedIntakes = 0;
  const intakeRows = queryRows<IntakeRow>(db, cte, `
    SELECT ii.id, ii.classification, ii.account_id, ii.legacy_lead_id, ii.outbound_message_id
    FROM inquiry_intakes ii
    WHERE ii.created_at<=? AND (
      ii.outbound_message_id IN (SELECT mc.message_id FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key)
      OR ii.legacy_lead_id IN (SELECT mc.lead_id FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key)
      OR ii.account_id IN (SELECT account_id FROM cohort WHERE account_id IS NOT NULL)
    )
  `, [options.generatedAt]);
  for (const intake of intakeRows) {
    const cohortKey = resolveScopedCohort({
      accountId: intake.account_id,
      legacyLeadId: intake.legacy_lead_id,
      outboundMessageId: intake.outbound_message_id,
    }, indexes);
    if (!cohortKey) {
      unresolvedIntakes += 1;
      continue;
    }
    intakeIndex.set(intake.id, cohortKey);
    if (intake.classification) facts.get(cohortKey)?.classifications.add(intake.classification);
  }

  const legacyInboundRows = queryRows<LegacyInboundRow>(db, cte, `
    SELECT im.id, im.classification, im.lead_id, (
      SELECT link.outbound_message_id FROM inbound_message_links link
      WHERE link.inbound_message_id=im.id AND link.outbound_message_id IS NOT NULL
      ORDER BY link.created_at, link.id LIMIT 1
    ) AS outbound_message_id
    FROM inbound_messages im
    WHERE im.created_at<=? AND (
      EXISTS (
        SELECT 1 FROM inbound_message_links link
        JOIN message_context mc ON mc.message_id=link.outbound_message_id
        JOIN cohort c ON c.cohort_key=mc.cohort_key
        WHERE link.inbound_message_id=im.id
      ) OR im.lead_id IN (
        SELECT mc.lead_id FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key
      )
    )
  `, [options.generatedAt]);
  for (const inbound of legacyInboundRows) {
    const cohortKey = resolveScopedCohort({
      legacyLeadId: inbound.lead_id,
      outboundMessageId: inbound.outbound_message_id,
    }, indexes);
    if (cohortKey) facts.get(cohortKey)?.classifications.add(inbound.classification);
  }

  let unresolvedOpportunities = 0;
  const opportunityRows = queryRows<OpportunityRow>(db, cte, `
    SELECT o.id, o.account_id, o.enrollment_id, o.intake_id, o.stage,
      CASE WHEN o.stage IN ('QUOTE_PENDING','QUOTED','NEGOTIATION','WON')
        OR EXISTS (SELECT 1 FROM quotes q0 WHERE q0.opportunity_id=o.id)
        THEN 1 ELSE 0 END AS quote_opportunity,
      CASE WHEN o.stage='WON' THEN coalesce(o.won_amount_minor, (
        SELECT q1.amount_minor FROM quotes q1 WHERE q1.opportunity_id=o.id AND q1.status='ACCEPTED'
        ORDER BY q1.version_number DESC LIMIT 1
      )) END AS revenue_minor,
      CASE WHEN o.stage='WON' THEN coalesce(o.won_currency, (
        SELECT q2.currency FROM quotes q2 WHERE q2.opportunity_id=o.id AND q2.status='ACCEPTED'
        ORDER BY q2.version_number DESC LIMIT 1
      )) END AS currency,
      CASE WHEN o.stage='WON' THEN coalesce(o.won_gross_margin_bps, (
        SELECT q3.gross_margin_bps FROM quotes q3 WHERE q3.opportunity_id=o.id AND q3.status='ACCEPTED'
        ORDER BY q3.version_number DESC LIMIT 1
      )) END AS gross_margin_bps
    FROM opportunities o
    WHERE o.created_at<=? AND (
      o.enrollment_id IN (SELECT enrollment_id FROM cohort WHERE enrollment_id IS NOT NULL)
      OR o.account_id IN (SELECT account_id FROM cohort WHERE account_id IS NOT NULL)
      OR o.intake_id IN (
        SELECT ii.id FROM inquiry_intakes ii WHERE
          ii.outbound_message_id IN (SELECT mc.message_id FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key)
          OR ii.legacy_lead_id IN (SELECT mc.lead_id FROM message_context mc JOIN cohort c ON c.cohort_key=mc.cohort_key)
          OR ii.account_id IN (SELECT account_id FROM cohort WHERE account_id IS NOT NULL)
      )
    )
  `, [options.generatedAt]);
  const opportunityById = new Map<string, OpportunityFact>();
  for (const opportunity of opportunityRows) {
    const cohortKey = resolveScopedCohort({
      enrollmentId: opportunity.enrollment_id,
      accountId: opportunity.account_id,
      intakeId: opportunity.intake_id,
    }, indexes);
    if (!cohortKey) {
      unresolvedOpportunities += 1;
      continue;
    }
    const fact = facts.get(cohortKey);
    if (!fact) continue;
    const value: OpportunityFact = {
      id: opportunity.id,
      accountKey: fact.accountKey,
      quoteOpportunity: Boolean(opportunity.quote_opportunity),
      won: opportunity.stage === "WON",
      revenueMinor: opportunity.revenue_minor === null ? null : Number(opportunity.revenue_minor),
      currency: opportunity.currency,
      grossMarginBps: opportunity.gross_margin_bps === null ? null : Number(opportunity.gross_margin_bps),
    };
    fact.opportunities.set(value.id, value);
    opportunityById.set(value.id, value);
  }

  const resolveResource = (row: { account_id: string | null; play_version_id: string | null }): string | null => {
    if (row.account_id && row.play_version_id) {
      const exact = only(pairIndex.get(`${row.account_id}\0${row.play_version_id}`));
      if (exact) return exact;
    }
    if (row.account_id) return only(accountIndex.get(row.account_id));
    return null;
  };
  let unresolvedResourceUsage = 0;
  const resourceRows = queryRows<ResourceRow>(db, cte, `
    SELECT ru.id, ru.provider_id, pr.provider_key, pr.display_name AS provider_name,
      ru.account_id, ru.play_version_id, ru.cost_micros, ru.currency
    FROM resource_usage ru LEFT JOIN provider_registry pr ON pr.id=ru.provider_id
    WHERE ru.occurred_at<=? AND (
      ru.account_id IN (SELECT account_id FROM cohort WHERE account_id IS NOT NULL)
      OR ru.play_version_id IN (SELECT play_version_id FROM cohort WHERE play_version_id IS NOT NULL)
    )
  `, [options.generatedAt]);
  for (const resource of resourceRows) {
    const cohortKey = resolveResource(resource);
    if (!cohortKey) {
      unresolvedResourceUsage += 1;
      continue;
    }
    const fact = facts.get(cohortKey);
    if (!fact) continue;
    fact.costs.set(resource.id, {
      id: resource.id,
      providerId: resource.provider_id,
      costMicros: Number(resource.cost_micros),
      currency: resource.currency,
    });
    const providerLabel = resource.provider_name ?? resource.provider_key ?? "Unattributed provider";
    pushUnique(fact.dimensions.provider, {
      key: `provider:${resource.provider_id ?? "unattributed"}`,
      label: providerLabel,
    });
  }

  const providerRuns = queryRows<ProviderRunRow>(db, cte, `
    SELECT DISTINCT pr.provider_id, registry.provider_key, registry.display_name AS provider_name,
      pr.account_id, pr.play_version_id
    FROM provider_runs pr JOIN provider_registry registry ON registry.id=pr.provider_id
    WHERE pr.started_at<=? AND (
      pr.account_id IN (SELECT account_id FROM cohort WHERE account_id IS NOT NULL)
      OR pr.play_version_id IN (SELECT play_version_id FROM cohort WHERE play_version_id IS NOT NULL)
    )
  `, [options.generatedAt]);
  for (const run of providerRuns) {
    const cohortKey = resolveResource(run);
    if (!cohortKey) continue;
    const fact = facts.get(cohortKey);
    if (!fact) continue;
    pushUnique(fact.dimensions.provider, {
      key: `provider:${run.provider_id}`,
      label: run.provider_name ?? run.provider_key,
    });
  }

  const experimentRows = db.db.prepare(`
    SELECT ea.experiment_id, e.experiment_key, ea.subject_type, ea.subject_id, ea.arm
    FROM experiment_assignments ea JOIN experiments e ON e.id=ea.experiment_id
    WHERE ea.created_at<=?
  `).all(options.generatedAt) as unknown as ExperimentRow[];
  for (const assignment of experimentRows) {
    const subjectType = assignment.subject_type.trim().toUpperCase();
    let cohortKey: string | null = null;
    if (["ENROLLMENT", "PLAY_ENROLLMENT"].includes(subjectType)) {
      cohortKey = enrollmentIndex.get(assignment.subject_id) ?? null;
    } else if (subjectType === "ACCOUNT") {
      cohortKey = only(accountIndex.get(assignment.subject_id));
    } else if (["LEAD", "LEGACY_LEAD"].includes(subjectType)) {
      cohortKey = only(leadIndex.get(assignment.subject_id));
    } else if (["MESSAGE", "OUTBOUND_MESSAGE"].includes(subjectType)) {
      cohortKey = messageIndex.get(assignment.subject_id) ?? null;
    }
    if (!cohortKey) continue;
    const fact = facts.get(cohortKey);
    if (!fact) continue;
    pushUnique(fact.dimensions.experiment, {
      key: `experiment:${assignment.experiment_id}:${assignment.arm}`,
      label: `${assignment.experiment_key} / ${assignment.arm}`,
    });
  }

  for (const fact of facts.values()) {
    if (fact.dimensions.channel.length === 0) {
      fact.dimensions.channel.push(dimensionValue("channel", null, "Unattributed channel"));
    }
    if (fact.dimensions.provider.length === 0) {
      fact.dimensions.provider.push({ key: "provider:unattributed", label: "Unattributed provider" });
    }
    if (fact.dimensions.experiment.length === 0) {
      fact.dimensions.experiment.push({ key: "experiment:unassigned", label: "Unassigned experiment" });
    }
  }

  const touchpointRows = db.db.prepare(`
    SELECT id, opportunity_id, attribution_position, source, medium,
      campaign, content, landing, referrer
    FROM touchpoints
    WHERE opportunity_id IS NOT NULL AND occurred_at<=?
  `).all(options.generatedAt) as unknown as TouchpointRow[];
  const attributionFacts: AttributionFact[] = [];
  let unpositionedTouchpoints = 0;
  for (const touchpoint of touchpointRows) {
    const opportunity = opportunityById.get(touchpoint.opportunity_id);
    if (!opportunity) continue;
    if (!["FIRST", "LAST", "ASSIST"].includes(touchpoint.attribution_position)) {
      unpositionedTouchpoints += 1;
      continue;
    }
    attributionFacts.push({ row: touchpoint, opportunity });
  }
  const byPosition = (position: AttributionPosition): TouchpointPositionReport => positionReport(
    attributionFacts.filter((fact) => fact.row.attribution_position === position),
  );

  const dimensionReports = Object.fromEntries(COMMERCIAL_DIMENSIONS.map((dimension) => [
    dimension,
    buildDimensionSlices(facts, dimension),
  ])) as Record<CommercialDimension, CommercialSlice[]>;
  return {
    generatedAt: options.generatedAt,
    cohort: {
      basis: "delivered_evidence",
      unit: "account_play_enrollment_or_legacy_lead",
      acceptedEvidence: ["MESSAGE_DELIVERED_EVENT", "DELIVERED_STATUS", "REPLIED_STATUS"],
      explicitlyExcludedStatus: "SENT",
      startAt: options.startAt,
      endAt: options.endAt,
    },
    overall: aggregateCommercialSlice([...facts.values()], "all", "All delivered cohorts"),
    byDimension: dimensionReports,
    touchpointAttribution: {
      interpretation: "DESCRIPTIVE_ONLY",
      cohortRestriction: "DELIVERED_COHORT_ONLY",
      positionBasis: "STORED_OBSERVED_POSITION",
      first: byPosition("FIRST"),
      last: byPosition("LAST"),
      assist: byPosition("ASSIST"),
      unpositionedTouchpoints,
    },
    unresolved: {
      intakes: unresolvedIntakes,
      opportunities: unresolvedOpportunities,
      resourceUsage: unresolvedResourceUsage,
    },
    notes: [
      "The population starts with delivery evidence. SENT-only messages are excluded.",
      "Rates use distinct delivered accounts as the denominator; deliveredRate is therefore 1 for non-empty slices.",
      "Provider, channel and experiment are multi-value descriptive dimensions, so their slices are not additive.",
      "Opportunity and cost fallback mapping is allowed only when an account has exactly one delivered cohort; ambiguous rows remain unresolved.",
      "FIRST, LAST and ASSIST use stored observable touchpoint positions and are reported separately.",
      "Touchpoint associations and associated revenue are descriptive only; they do not estimate causal or incremental impact.",
      "Money is never converted across currencies: revenue/margin use minor units and provider cost uses micros.",
    ],
  };
}

/** Execute the operator-facing report with SQLite writes disabled for the query window. */
export function runCommercialFunnelOperator(
  db: AgentDatabase,
  args: readonly string[] = [],
): CommercialFunnelOperatorResult {
  const queryOnlyRow = db.db.prepare("PRAGMA query_only").get() as
    | Record<string, unknown>
    | undefined;
  const wasQueryOnly = Number(Object.values(queryOnlyRow ?? {})[0] ?? 0) === 1;
  if (!wasQueryOnly) db.db.exec("PRAGMA query_only = ON");
  try {
    return {
      command: "commercial-funnel",
      readOnly: true,
      externalActionsAttempted: false,
      report: buildCommercialFunnelReport(db, parseCommercialFunnelCliOptions(args)),
    };
  } finally {
    if (!wasQueryOnly) db.db.exec("PRAGMA query_only = OFF");
  }
}
