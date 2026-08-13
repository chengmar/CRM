import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";

const MailKindSchema = z.enum(["outbound", "inbound"]);
const TranslatedFieldsSchema = z.object({
  country: z.string().max(500).optional(),
  contactTitle: z.string().max(1_000).optional(),
  buyerType: z.string().max(2_000).optional(),
  product: z.string().max(2_000).optional(),
  demandStage: z.string().max(1_000).optional(),
  qualificationTrack: z.string().max(1_000).optional(),
  campaignName: z.string().max(2_000).optional(),
  verificationNotes: z.string().max(4_000).optional(),
  reason: z.string().max(4_000).optional(),
  correlationMethod: z.string().max(1_000).optional(),
  intakeStatus: z.string().max(1_000).optional(),
  opportunityStage: z.string().max(1_000).optional(),
  outboundSubject: z.string().max(2_000).optional(),
  outboundBody: z.string().max(20_000).optional(),
}).strict();
const MailTranslationSchema = z.object({
  subject: z.string().max(2_000),
  body: z.string().max(20_000),
  fields: TranslatedFieldsSchema,
  demandEvidence: z.array(z.string().max(4_000)).max(12),
  sourceEvidence: z.array(z.string().max(4_000)).max(8),
}).strict();
const CachedTranslationSchema = z.object({
  schemaVersion: z.literal("dashboard-mail-translation-v1"),
  kind: MailKindSchema,
  messageId: z.string(),
  sourceHash: z.string().length(64),
  generatedAt: z.string(),
  translation: MailTranslationSchema,
}).strict();

export type DashboardMailKind = z.infer<typeof MailKindSchema>;
export type DashboardMailTranslation = z.infer<typeof MailTranslationSchema>;

export interface DashboardMailTranslationResult {
  kind: DashboardMailKind;
  messageId: string;
  sourceHash: string;
  generatedAt: string;
  cached: boolean;
  translation: DashboardMailTranslation;
}

function text(value: unknown, limit: number): string {
  return String(value ?? "").trim().slice(0, limit);
}

function evidenceText(value: unknown): string {
  if (typeof value === "string") return text(value, 4_000);
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return text(item.exactQuote ?? item.evidence ?? item.summary ?? item.reason ?? item.sourceUrl ?? JSON.stringify(item), 4_000);
}

function parseEvidence(value: unknown): string[] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(evidenceText).filter(Boolean).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export class DashboardMailTranslator {
  private readonly inFlight = new Map<string, Promise<DashboardMailTranslationResult>>();

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm?: Pick<AgentLlm, "isConfigured" | "json">,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.llm?.isConfigured());
  }

  async translate(kindInput: string, messageIdInput: string): Promise<DashboardMailTranslationResult> {
    const kind = MailKindSchema.parse(kindInput);
    const messageId = String(messageIdInput ?? "").trim();
    if (!messageId || messageId.length > 200) throw new Error("MAIL_NOT_FOUND");
    const source = this.loadSource(kind, messageId);
    if (!source) throw new Error("MAIL_NOT_FOUND");
    const sourceHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const cacheKey = `dashboard-mail-translation:v1:${kind}:${messageId}`;
    const cached = this.readCache(cacheKey, sourceHash);
    if (cached) return { ...cached, cached: true };
    if (!this.isAvailable() || !this.llm) throw new Error("TRANSLATION_UNAVAILABLE");

    const flightKey = `${kind}:${messageId}:${sourceHash}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    const pending = this.generate(kind, messageId, sourceHash, cacheKey, source)
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, pending);
    return pending;
  }

  private readCache(cacheKey: string, sourceHash: string): Omit<DashboardMailTranslationResult, "cached"> | null {
    const raw = this.db.getSetting(cacheKey);
    if (!raw) return null;
    try {
      const cached = CachedTranslationSchema.parse(JSON.parse(raw));
      if (cached.sourceHash !== sourceHash) return null;
      return cached;
    } catch {
      return null;
    }
  }

  private async generate(
    kind: DashboardMailKind,
    messageId: string,
    sourceHash: string,
    cacheKey: string,
    source: Record<string, unknown>,
  ): Promise<DashboardMailTranslationResult> {
    const system = [
      "You translate an email-monitoring record into Simplified Chinese for its authenticated operator.",
      "Translate faithfully without adding, removing or strengthening any commercial, technical or customer claim.",
      "Keep company/person names, email addresses, URLs, model numbers, standards, units and numeric values unchanged.",
      "Translate every supplied natural-language field. Preserve paragraph breaks in email bodies.",
      "Return JSON only with exactly: {subject,body,fields,demandEvidence,sourceEvidence}.",
      "The fields object may contain only the keys supplied in source.fields. Keep empty source values empty.",
      "demandEvidence and sourceEvidence must preserve source array order and length.",
    ].join(" ");
    const translated = MailTranslationSchema.parse(await this.llm!.json<unknown>(
      "dashboard_mail_translation_zh_cn",
      system,
      JSON.stringify(source),
      this.config.OPENAI_RESEARCH_MODEL || this.config.OPENAI_MODEL,
    ));
    const generatedAt = new Date().toISOString();
    const cached = {
      schemaVersion: "dashboard-mail-translation-v1" as const,
      kind,
      messageId,
      sourceHash,
      generatedAt,
      translation: translated,
    };
    this.db.setSetting(cacheKey, JSON.stringify(cached));
    return { ...cached, cached: false };
  }

  private loadSource(kind: DashboardMailKind, messageId: string): Record<string, unknown> | null {
    if (kind === "outbound") {
      const row = this.db.db.prepare(
        `SELECT message.subject, message.body,
                campaign.name AS campaign_name,
                lead.country, lead.buyer_type, lead.product, lead.demand_stage,
                lead.demand_evidence_json, lead.outreach_qualification_track,
                contact.title, contact.verification_notes
         FROM outbound_messages message
         JOIN leads lead ON lead.id=message.lead_id
         JOIN contacts contact ON contact.id=message.contact_id
         LEFT JOIN campaigns campaign ON campaign.id=message.campaign_id
         WHERE message.id=? AND message.channel='email'`,
      ).get(messageId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const sourceRows = this.db.db.prepare(
        `SELECT source.evidence
         FROM lead_sources source
         JOIN outbound_messages message ON message.lead_id=source.lead_id
         WHERE message.id=?
         ORDER BY CASE lower(source.source_type) WHEN 'official_website' THEN 0 ELSE 1 END,
                  source.created_at DESC LIMIT 8`,
      ).all(messageId) as Array<{ evidence: unknown }>;
      return {
        subject: text(row.subject, 2_000),
        body: text(row.body, 16_000),
        fields: {
          country: text(row.country, 500),
          contactTitle: text(row.title, 1_000),
          buyerType: text(row.buyer_type, 2_000),
          product: text(row.product, 2_000),
          demandStage: text(row.demand_stage, 1_000),
          qualificationTrack: text(row.outreach_qualification_track, 1_000),
          campaignName: text(row.campaign_name, 2_000),
          verificationNotes: text(row.verification_notes, 4_000),
        },
        demandEvidence: parseEvidence(row.demand_evidence_json),
        sourceEvidence: sourceRows.map((item) => text(item.evidence, 4_000)),
      };
    }

    const row = this.db.db.prepare(
      `SELECT inbound.subject, substr(inbound.body_text, 1, 16000) AS body,
              inbound.reason, intake.intake_status, intake.correlation_method,
              lead.country, lead.buyer_type, lead.product, lead.demand_stage,
              lead.demand_evidence_json, contact.title,
              opportunity.stage AS opportunity_stage,
              outbound.subject AS outbound_subject, outbound.body AS outbound_body
       FROM inbound_messages inbound
       LEFT JOIN inquiry_intakes intake
         ON intake.source='EMAIL' AND intake.provider_event_id=inbound.provider_id
       LEFT JOIN leads lead ON lead.id=inbound.lead_id
       LEFT JOIN contacts contact ON contact.id=inbound.contact_id
       LEFT JOIN opportunities opportunity ON opportunity.intake_id=intake.id
       LEFT JOIN outbound_messages outbound ON outbound.id=intake.outbound_message_id
       WHERE inbound.id=? AND inbound.channel='email'`,
    ).get(messageId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      subject: text(row.subject, 2_000),
      body: text(row.body, 16_000),
      fields: {
        country: text(row.country, 500),
        contactTitle: text(row.title, 1_000),
        buyerType: text(row.buyer_type, 2_000),
        product: text(row.product, 2_000),
        demandStage: text(row.demand_stage, 1_000),
        reason: text(row.reason, 4_000),
        correlationMethod: text(row.correlation_method, 1_000),
        intakeStatus: text(row.intake_status, 1_000),
        opportunityStage: text(row.opportunity_stage, 1_000),
        outboundSubject: text(row.outbound_subject, 2_000),
        outboundBody: text(row.outbound_body, 16_000),
      },
      demandEvidence: parseEvidence(row.demand_evidence_json),
      sourceEvidence: [],
    };
  }
}
