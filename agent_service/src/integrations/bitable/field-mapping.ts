import { normalizePublicHttpUrl } from "../../http-url.js";
import { logger } from "../../logger.js";
import type {
  CommercialDimension,
  CommercialFunnelReport,
  CommercialSlice,
} from "../../reporting/commercial-funnel.js";

export const BITABLE_URL_FIELD_NAMES = ["website", "linkedin", "contact_source_url"] as const;

export function normalizePhoneField(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const candidate = raw.match(/(?:\+|00)?\d[\d\s().-]{6,}\d/)?.[0] ?? "";
  if (!candidate) return undefined;
  const leadingPlus = candidate.trim().startsWith("+") || candidate.trim().startsWith("00");
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return undefined;
  return `${leadingPlus ? "+" : ""}${leadingPlus && candidate.trim().startsWith("00") ? digits.slice(2) : digits}`;
}

function dateValue(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonListText(value: unknown): string {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => scalarText(item)).filter(Boolean).join("; ") : "";
  } catch {
    return scalarText(value);
  }
}

function jsonValueText(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function setDateField(fields: Record<string, unknown>, name: string, value: unknown): void {
  const date = dateValue(value);
  if (date !== undefined) fields[name] = date;
}

export function scalarText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => scalarText(item)).filter(Boolean).join("");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return scalarText(item.text ?? item.name ?? item.link ?? item.url ?? "");
  }
  return String(value ?? "").trim();
}

export function fieldsForLead(lead: Record<string, unknown>): Record<string, unknown> {
  let reasons = "";
  try {
    reasons = (JSON.parse(String(lead.eligibility_reasons_json ?? "[]")) as string[]).join("; ");
  } catch {
    reasons = String(lead.eligibility_reasons_json ?? "");
  }
  const rawUrls = {
    website: String(lead.website ?? "").trim(),
    linkedin: String(lead.linkedin ?? "").trim(),
    contact_source_url: String(lead.contact_source_url ?? "").trim(),
  };
  const normalizedUrls = {
    website: normalizePublicHttpUrl(rawUrls.website),
    linkedin: normalizePublicHttpUrl(rawUrls.linkedin),
    contact_source_url: normalizePublicHttpUrl(rawUrls.contact_source_url),
  };
  const invalidUrlFields = Object.entries(rawUrls)
    .filter(([field, value]) => value && !normalizedUrls[field as keyof typeof normalizedUrls])
    .map(([field]) => field);
  if (invalidUrlFields.length > 0) {
    logger.warn(
      { leadId: String(lead.id ?? ""), invalidUrlFields },
      "Invalid lead URL fields omitted from Feishu Bitable sync",
    );
  }
  const fields: Record<string, unknown> = {
    lead_id: String(lead.id ?? ""),
    campaign_id: String(lead.campaign_id ?? ""),
    company: String(lead.company ?? ""),
    domain: String(lead.domain ?? ""),
    country: String(lead.country ?? ""),
    buyer_type: String(lead.buyer_type ?? ""),
    product: String(lead.product ?? ""),
    fit_score: Number(lead.fit_score ?? 0),
    intent_score: Number(lead.intent_score ?? 0),
    activity_score: Number(lead.activity_score ?? 0),
    contact_score: Number(lead.contact_score ?? 0),
    channel_score: Number(lead.channel_score ?? 0),
    score: Number(lead.total_score ?? 0),
    grade: String(lead.grade ?? ""),
    status: String(lead.status ?? ""),
    send_eligible: booleanValue(lead.send_eligible),
    eligibility_reasons: reasons,
    contact_id: String(lead.contact_id ?? ""),
    contact_name: String(lead.contact_name ?? ""),
    title: String(lead.contact_title ?? ""),
    email: String(lead.email ?? ""),
    email_status: String(lead.email_status ?? "UNKNOWN"),
    source_count: Number(lead.source_count ?? 0),
    human_takeover: booleanValue(lead.human_takeover),
    owner: String(lead.owner ?? ""),
  };
  const whatsapp = normalizePhoneField(lead.whatsapp);
  if (whatsapp) fields.whatsapp = whatsapp;
  for (const field of BITABLE_URL_FIELD_NAMES) {
    const url = normalizedUrls[field];
    if (url) fields[field] = { link: url, text: url };
  }
  for (const [field, value] of [
    ["last_activity_at", dateValue(lead.last_activity_at)],
    ["last_verified_at", dateValue(lead.last_verified_at)],
    ["created_at", dateValue(lead.created_at)],
    ["updated_at", dateValue(lead.updated_at)],
  ] as const) {
    if (value !== undefined) fields[field] = value;
  }
  return fields;
}

export function fieldsForEvent(event: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    event_id: String(event.id ?? ""),
    entity_type: String(event.entity_type ?? ""),
    entity_id: String(event.entity_id ?? ""),
    event_type: String(event.event_type ?? ""),
    actor: String(event.actor ?? ""),
    payload_json: String(event.payload_json ?? "{}").slice(0, 100_000),
  };
  const createdAt = dateValue(event.created_at);
  if (createdAt !== undefined) fields.created_at = createdAt;
  return fields;
}

export function fieldsForCampaignBrief(row: Record<string, unknown>): Record<string, unknown> {
  const brief = jsonRecord(row.brief_json);
  const fields: Record<string, unknown> = {
    brief_id: scalarText(row.brief_id),
    version_id: scalarText(row.version_id),
    version_number: Number(row.version_number ?? 0),
    status: scalarText(row.status),
    market: scalarText(brief.market),
    product_family: scalarText(brief.productFamily),
    buyer_types: Array.isArray(brief.buyerTypes)
      ? brief.buyerTypes.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.buyerTypes),
    industries: Array.isArray(brief.industries)
      ? brief.industries.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.industries),
    role_families: Array.isArray(brief.roleFamilies)
      ? brief.roleFamilies.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.roleFamilies),
    qualification_tracks: Array.isArray(brief.qualificationTracks)
      ? brief.qualificationTracks.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.qualificationTracks),
    required_signals: Array.isArray(brief.requiredSignals)
      ? brief.requiredSignals.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.requiredSignals),
    exclusions: Array.isArray(brief.exclusions)
      ? brief.exclusions.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.exclusions),
    target_metric: scalarText(brief.targetMetric),
    target_count: null,
    provider_budget: jsonValueText(brief.providerBudget),
    research_budget: jsonValueText(brief.researchBudget ?? brief.llmBudget),
    offer_ids: Array.isArray(brief.offerIds)
      ? brief.offerIds.map((item) => scalarText(item)).filter(Boolean).join("; ")
      : scalarText(brief.offerIds),
    transport: scalarText(brief.transport),
    deadline: null,
    hypothesis: scalarText(brief.hypothesis),
    brief_hash: scalarText(row.brief_hash),
    provider_budget_hash: scalarText(row.provider_budget_hash),
    shadow_authorized: booleanValue(row.shadow_authorized),
    provider_budget_authorized: booleanValue(row.provider_budget_authorized),
    external_send_authorized: booleanValue(row.external_send_authorized),
    content_publish_authorized: booleanValue(row.content_publish_authorized),
  };
  const targetCount = Number(brief.targetCount);
  if (brief.targetCount !== null && brief.targetCount !== undefined &&
    scalarText(brief.targetCount) && Number.isFinite(targetCount)) {
    fields.target_count = targetCount;
  }
  setDateField(fields, "deadline", brief.deadline);
  setDateField(fields, "updated_at", row.updated_at);
  return fields;
}

export function fieldsForMarketAllocation(row: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    allocation_id: scalarText(row.allocation_id),
    play_id: scalarText(row.play_id),
    country: scalarText(row.country),
    policy_version: scalarText(row.policy_version),
    recommended_units: Number(row.recommended_units ?? 0),
    recommended_share: Number(row.recommended_share ?? 0),
    recommendation: scalarText(row.recommendation),
    reasons: jsonListText(row.reasons_json),
    applied: booleanValue(row.applied),
    requires_human_approval: booleanValue(row.requires_human_approval),
  };
  setDateField(fields, "created_at", row.created_at);
  return fields;
}

export function fieldsForSalesTask(row: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    task_id: scalarText(row.task_id),
    account_id: scalarText(row.account_id),
    person_id: scalarText(row.person_id),
    play_id: scalarText(row.play_id),
    enrollment_id: scalarText(row.enrollment_id),
    opportunity_id: scalarText(row.opportunity_id),
    task_type: scalarText(row.task_type),
    status: scalarText(row.status),
    owner: scalarText(row.owner),
    source_signal: scalarText(row.source_signal),
    outcome: scalarText(row.outcome),
  };
  setDateField(fields, "due_at", row.due_at);
  setDateField(fields, "updated_at", row.updated_at);
  return fields;
}

export interface CommercialReportBitableRecord {
  key: string;
  fields: Record<string, unknown>;
}

const COMMERCIAL_DIMENSION_FIELDS: Record<CommercialDimension, string> = {
  market: "market",
  play: "play",
  qualificationTrack: "qualification_track",
  provider: "provider",
  channel: "channel",
  offer: "offer",
  experiment: "experiment",
};

function commercialCurrencies(slice: CommercialSlice): string[] {
  const currencies = new Set([
    ...Object.keys(slice.money.revenueMinorByCurrency),
    ...Object.keys(slice.money.grossMarginMinorByCurrency),
    ...Object.keys(slice.money.costMicrosByCurrency),
  ]);
  return currencies.size > 0 ? [...currencies].sort() : [""];
}

function commercialDimensionValues(
  dimension: CommercialDimension | "overall",
  slice: CommercialSlice,
): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.values(COMMERCIAL_DIMENSION_FIELDS).map((field) => [field, ""]),
  );
  if (dimension !== "overall") fields[COMMERCIAL_DIMENSION_FIELDS[dimension]] = slice.label;
  return fields;
}

function commercialCountRecord(
  report: CommercialFunnelReport,
  period: string,
  dimension: CommercialDimension | "overall",
  slice: CommercialSlice,
): CommercialReportBitableRecord {
  const key = [period, "counts", dimension, slice.key].join(":");
  const fields: Record<string, unknown> = {
    report_row_id: key,
    period,
    row_kind: "FUNNEL_COUNTS",
    dimension,
    dimension_key: slice.key,
    currency: "",
    ...commercialDimensionValues(dimension, slice),
    delivered: slice.counts.deliveredAccounts,
    delivered_messages: slice.counts.deliveredMessages,
    positive_replies: slice.counts.p1Accounts + slice.counts.p2Accounts + slice.counts.referralAccounts,
    p1_accounts: slice.counts.p1Accounts,
    p2_accounts: slice.counts.p2Accounts,
    referral_accounts: slice.counts.referralAccounts,
    inquiries: slice.counts.inquiries,
    quotes: slice.counts.quoteOpportunities,
    wins: slice.counts.deals,
    revenue_minor: null,
    gross_margin_minor: null,
    cost_minor: null,
    cost_micros: null,
    attribution_mode: "DESCRIPTIVE_FIRST_LAST_ASSIST",
  };
  setDateField(fields, "generated_at", report.generatedAt);
  return { key, fields };
}

function commercialMoneyRecord(
  report: CommercialFunnelReport,
  period: string,
  dimension: CommercialDimension | "overall",
  slice: CommercialSlice,
  currency: string,
): CommercialReportBitableRecord {
  const key = [period, "money", dimension, slice.key, currency].join(":");
  const fields: Record<string, unknown> = {
    report_row_id: key,
    period,
    row_kind: "CURRENCY_MONEY",
    dimension,
    dimension_key: slice.key,
    currency,
    ...commercialDimensionValues(dimension, slice),
    delivered: null,
    delivered_messages: null,
    positive_replies: null,
    p1_accounts: null,
    p2_accounts: null,
    referral_accounts: null,
    inquiries: null,
    quotes: null,
    wins: null,
    revenue_minor: slice.money.revenueMinorByCurrency[currency] ?? 0,
    gross_margin_minor: slice.money.grossMarginMinorByCurrency[currency] ?? 0,
    cost_minor: null,
    cost_micros: slice.money.costMicrosByCurrency[currency] ?? 0,
    attribution_mode: "DESCRIPTIVE_FIRST_LAST_ASSIST",
  };
  setDateField(fields, "generated_at", report.generatedAt);
  return { key, fields };
}

export function recordsForCommercialReport(
  report: CommercialFunnelReport,
): CommercialReportBitableRecord[] {
  const period = `${report.cohort.startAt ?? "BEGIN"}..${report.cohort.endAt ?? "OPEN"}`;
  const records: CommercialReportBitableRecord[] = [];
  records.push(commercialCountRecord(report, period, "overall", report.overall));
  for (const currency of commercialCurrencies(report.overall)) {
    if (currency) records.push(commercialMoneyRecord(report, period, "overall", report.overall, currency));
  }
  for (const [dimension, slices] of Object.entries(report.byDimension) as Array<
    [CommercialDimension, CommercialSlice[]]
  >) {
    for (const slice of slices) {
      records.push(commercialCountRecord(report, period, dimension, slice));
      for (const currency of commercialCurrencies(slice)) {
        if (currency) records.push(commercialMoneyRecord(report, period, dimension, slice, currency));
      }
    }
  }
  return records;
}
