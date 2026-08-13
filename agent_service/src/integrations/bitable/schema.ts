type BitableUiType =
  | "Text"
  | "Number"
  | "SingleSelect"
  | "DateTime"
  | "Checkbox"
  | "Phone"
  | "Url"
  | "Email";

export interface BitableFieldDefinition {
  field_name: string;
  type: number;
  ui_type: BitableUiType;
  property?: {
    options?: Array<{ name: string; color?: number }>;
    formatter?: string;
    date_formatter?: string;
  };
  description?: { text: string; disable_sync?: boolean };
}

const textField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 1,
  ui_type: "Text",
  description: { text: description },
});

const numberField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 2,
  ui_type: "Number",
  property: { formatter: "0" },
  description: { text: description },
});

const selectField = (
  field_name: string,
  values: string[],
  description: string,
): BitableFieldDefinition => ({
  field_name,
  type: 3,
  ui_type: "SingleSelect",
  property: {
    options: values.map((name, index) => ({ name, color: index % 10 })),
  },
  description: { text: description },
});

const dateField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 5,
  ui_type: "DateTime",
  property: { date_formatter: "yyyy-MM-dd HH:mm" },
  description: { text: description },
});

const checkboxField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 7,
  ui_type: "Checkbox",
  description: { text: description },
});

const phoneField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 13,
  ui_type: "Phone",
  description: { text: description },
});

const urlField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 15,
  ui_type: "Url",
  description: { text: description },
});

const emailField = (field_name: string, description: string): BitableFieldDefinition => ({
  field_name,
  type: 1,
  ui_type: "Email",
  description: { text: description },
});

export const LEADS_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("lead_id", "Agent immutable lead identifier"),
  textField("campaign_id", "Discovery campaign identifier"),
  textField("company", "Company name"),
  textField("domain", "Normalized company domain"),
  urlField("website", "Official company website"),
  textField("country", "Target market or country"),
  textField("buyer_type", "Matched buyer profile"),
  textField("product", "Product or solution promoted in this campaign"),
  numberField("fit_score", "Product and buyer profile fit, maximum 30"),
  numberField("intent_score", "Recent purchase or project intent, maximum 25"),
  numberField("activity_score", "Recent company activity, maximum 20"),
  numberField("contact_score", "Named contact quality, maximum 20"),
  numberField("channel_score", "Contact channel reliability, maximum 5"),
  numberField("score", "Total quality score, maximum 100"),
  selectField("grade", ["GOLD", "SILVER", "BRONZE", "REJECT"], "Quality grade"),
  selectField(
    "status",
    [
      "NEW",
      "VERIFYING",
      "ENRICHING",
      "ENRICHMENT_EXHAUSTED",
      "REJECTED",
      "READY_FOR_REVIEW",
      "APPROVED",
      "CONTACTED",
      "REPLIED",
      "INQUIRY_RECEIVED",
      "HUMAN_TAKEOVER",
      "DO_NOT_CONTACT",
    ],
    "Agent lead state",
  ),
  dateField("last_activity_at", "Most recent public activity evidence"),
  dateField("last_verified_at", "Most recent Agent verification"),
  checkboxField("send_eligible", "Passed every production outreach quality gate"),
  textField("eligibility_reasons", "Quality gate failures or review notes"),
  textField("contact_id", "Primary named contact identifier"),
  textField("contact_name", "Primary named contact"),
  textField("title", "Current contact title"),
  emailField("email", "Validated business email"),
  selectField("email_status", ["VALID", "RISKY", "INVALID", "UNKNOWN"], "Mailbox verification result"),
  phoneField("whatsapp", "WhatsApp number, only used with documented opt-in"),
  urlField("linkedin", "Public professional profile used for employment verification"),
  urlField("contact_source_url", "Public source supporting the contact identity"),
  numberField("source_count", "Independent company evidence source count"),
  checkboxField("human_takeover", "Automation is permanently stopped for manual handling"),
  textField("owner", "Human sales owner"),
  dateField("created_at", "Lead creation time"),
  dateField("updated_at", "Last Agent update time"),
];

export const EVENTS_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("event_id", "Immutable Agent audit event identifier"),
  textField("entity_type", "Entity category"),
  textField("entity_id", "Entity identifier"),
  textField("event_type", "Audit event type"),
  textField("actor", "User, integration, or system actor"),
  textField("payload_json", "Immutable event payload JSON"),
  dateField("created_at", "Event creation time"),
];

export const CAMPAIGN_BRIEFS_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("brief_id", "Immutable Campaign Brief identifier"),
  textField("version_id", "Current immutable brief version"),
  numberField("version_number", "Current brief version number"),
  selectField("status", ["PLAN_DRAFT", "PLAN_NEEDS_INPUT", "PLAN_APPROVED", "BUDGET_PENDING", "BUDGET_APPROVED", "QUEUED", "RESEARCHING", "SHADOW_COMPLETE", "READY_FOR_SEND_EXPERIMENT", "CANCELLED"], "Campaign planning status"),
  textField("market", "Approved target market"),
  textField("product_family", "Approved product family"),
  textField("buyer_types", "Approved buyer types"),
  textField("industries", "Approved target industries"),
  textField("role_families", "Approved contact role families"),
  textField("qualification_tracks", "Approved qualification tracks"),
  textField("required_signals", "Public signals required by the qualification plan"),
  textField("exclusions", "Explicit account, relationship, and policy exclusions"),
  textField("target_metric", "Exact campaign target metric"),
  numberField("target_count", "Exact campaign target count"),
  textField("provider_budget", "Exact provider budget JSON bound to approval"),
  textField("research_budget", "Exact LLM and research budget JSON bound to approval"),
  textField("offer_ids", "Approved offer identifiers"),
  textField("transport", "Planned transport; not an activation authorization"),
  dateField("deadline", "Campaign planning deadline"),
  textField("hypothesis", "Testable campaign hypothesis"),
  textField("brief_hash", "Hash of complete current brief"),
  textField("provider_budget_hash", "Hash of the exact provider and LLM budget snapshot"),
  checkboxField("shadow_authorized", "Explicit shadow-plan approval recorded"),
  checkboxField("provider_budget_authorized", "Exact provider budget separately approved"),
  checkboxField("external_send_authorized", "External sending separately approved"),
  checkboxField("content_publish_authorized", "Content publication separately approved"),
  dateField("updated_at", "Last local brief update"),
];

export const MARKET_ALLOCATIONS_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("allocation_id", "Immutable allocation suggestion identifier"),
  textField("play_id", "Play receiving the suggestion"),
  textField("country", "Market country code"),
  textField("policy_version", "Allocation policy version"),
  numberField("recommended_units", "Suggested research units"),
  numberField("recommended_share", "Suggested portfolio share"),
  selectField("recommendation", ["EXPLORE", "HOLD_EVIDENCE", "HOLD", "INCREASE", "REDUCE_REVIEW"], "Evidence-backed recommendation"),
  textField("reasons", "Structured recommendation reasons"),
  checkboxField("applied", "Whether a human-approved allocation was applied"),
  checkboxField("requires_human_approval", "Suggestion cannot be applied automatically"),
  dateField("created_at", "Suggestion creation time"),
];

export const SALES_TASKS_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("task_id", "Immutable local sales task identifier"),
  textField("account_id", "Canonical account identifier"),
  textField("person_id", "Canonical person identifier"),
  textField("play_id", "Associated play identifier"),
  textField("enrollment_id", "Associated account-play enrollment identifier"),
  textField("opportunity_id", "Associated commercial opportunity identifier"),
  selectField("task_type", ["CALL", "LINKEDIN_REVIEW", "CONTACT_RESEARCH", "EMPLOYMENT_REVERIFY", "ACCOUNT_RESEARCH", "DRAFT_REVIEW", "INQUIRY_FOLLOWUP", "TECHNICAL_REVIEW", "QUOTE_FOLLOWUP"], "Manual or local task type"),
  selectField("status", ["OPEN", "IN_PROGRESS", "DONE", "SNOOZED", "CANCELLED"], "Task status"),
  textField("owner", "Authorized human task owner"),
  dateField("due_at", "Task due time"),
  textField("source_signal", "Evidence or signal that created the task"),
  textField("outcome", "Human-recorded task outcome"),
  dateField("updated_at", "Last local task update"),
];

export const COMMERCIAL_REPORT_TABLE_FIELDS: BitableFieldDefinition[] = [
  textField("report_row_id", "Stable dimensional report row identifier"),
  textField("period", "Measurement window"),
  selectField("row_kind", ["FUNNEL_COUNTS", "CURRENCY_MONEY"], "Separates non-additive funnel counts from currency-specific money"),
  textField("dimension", "Overall or the single descriptive dimension represented by this row"),
  textField("dimension_key", "Stable local key for the represented report slice"),
  textField("currency", "Currency for this row; currencies are never converted or combined"),
  textField("market", "Market dimension"),
  textField("play", "Play dimension"),
  textField("qualification_track", "Qualification-track dimension"),
  textField("provider", "Provider dimension"),
  textField("channel", "Channel dimension"),
  textField("offer", "Offer dimension"),
  textField("experiment", "Experiment arm dimension"),
  numberField("delivered", "Distinct delivered-account cohort denominator"),
  numberField("delivered_messages", "Messages with stored delivery evidence"),
  numberField("positive_replies", "Sum of P1, P2, and referral account-class counts; classes may overlap"),
  numberField("p1_accounts", "Delivered accounts with a P1 inquiry"),
  numberField("p2_accounts", "Delivered accounts with P2 interest"),
  numberField("referral_accounts", "Delivered accounts with a referral"),
  numberField("inquiries", "Qualified inquiries in the delivered cohort"),
  numberField("quotes", "Human-authorized quotes"),
  numberField("wins", "Human-authorized wins"),
  numberField("revenue_minor", "Revenue in minor currency units"),
  numberField("gross_margin_minor", "Gross margin in minor currency units"),
  numberField("cost_minor", "Legacy compatibility field; exact provider costs use cost_micros"),
  numberField("cost_micros", "Attributed provider cost in millionths of the currency unit"),
  textField("attribution_mode", "Descriptive first, last, and assist attribution only"),
  dateField("generated_at", "Local report generation time"),
];

export const ACQUISITION_CONTROL_TABLE_SCHEMAS = Object.freeze({
  campaignBriefs: CAMPAIGN_BRIEFS_TABLE_FIELDS,
  marketAllocations: MARKET_ALLOCATIONS_TABLE_FIELDS,
  salesTasks: SALES_TASKS_TABLE_FIELDS,
  commercialReport: COMMERCIAL_REPORT_TABLE_FIELDS,
});
