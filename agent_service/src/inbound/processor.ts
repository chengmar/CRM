import type { AgentConfig } from "../config.js";
import type {
  AgentDatabase,
  CanonicalInboundContext,
  InboundCorrelation,
  InboundMessageInput,
} from "../db.js";
import { extractProductInquiry } from "../acquisition/product-inquiry.js";
import { isGmailPilotMode } from "../outreach/email-policy.js";
import type { InboundClassification } from "../types.js";

export type RawInboundMessageInput = Omit<
  InboundMessageInput,
  "classification" | "confidence" | "reason"
>;

export interface PreparedInboundIntake {
  intakeId: string;
  intakeInserted: boolean;
  match: InboundCorrelation | null;
  canonical: CanonicalInboundContext | null;
}

export interface InboundProcessResult {
  inserted: boolean;
  leadId: string | null;
  ignored: boolean;
  intakeId: string;
  quarantined: boolean;
  opportunityId: string | null;
}

export interface InquiryNotifier {
  notifyInquiry(input: {
    lead: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): Promise<void>;
  notifyReply(input: {
    lead: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): Promise<void>;
  notifySafetyPause(input: {
    lead: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): Promise<void>;
  notifyHardBounce?(input: {
    lead: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): Promise<void>;
  notifyQuarantinedIntake?(input: {
    intake: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): Promise<void>;
  stageInquiryNotification?(input: {
    lead: Record<string, unknown>;
    inbound: InboundMessageInput;
    classification: InboundClassification;
  }): void;
  flushPendingNotifications?(): Promise<void>;
}

export class InboundProcessor {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly notifier: InquiryNotifier,
  ) {}

  prepare(input: RawInboundMessageInput): PreparedInboundIntake {
    const referenceMatch = input.outboundMessageId
      ? this.db.findLeadByOutboundMessageId(input.outboundMessageId)
      : input.threadId
        ? this.db.findLeadByProviderReference(input.threadId)
        : null;
    let match = referenceMatch ?? (input.leadId && input.contactId && (!input.threadId || input.channel !== "email")
      ? {
          leadId: input.leadId,
          contactId: input.contactId,
          outboundMessageId: null,
          correlationMethod: "explicit_legacy_ids" as const,
        }
      : null);
    if (!match) {
      match = this.db.findInboundMatch(input.threadId, input.fromAddress, {
        allowAddressFallback: input.channel !== "email",
      });
    }
    const canonical = match
      ? this.db.resolveLegacyInboundContext(match.leadId, match.contactId)
      : null;
    const rawMessageId = input.rawHeaders?.messageId;
    const persisted = this.db.upsertInquiryIntake({
      source: input.channel === "email"
        ? "EMAIL"
        : input.channel === "whatsapp"
          ? "WHATSAPP"
          : "WEB_FORM",
      providerEventId: input.providerId,
      messageId: typeof rawMessageId === "string" ? rawMessageId : null,
      sender: input.fromAddress,
      recipient: input.toAddress ?? null,
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      receivedAt: input.receivedAt,
      accountId: canonical?.accountId ?? null,
      personId: canonical?.personId ?? null,
      contactPointId: canonical?.contactPointId ?? null,
      leadId: match?.leadId ?? null,
      outboundMessageId: match?.outboundMessageId ?? null,
      correlationMethod: match?.correlationMethod ?? null,
      correlationConfidence: match?.correlationMethod === "exact_provider_reference"
        ? 1
        : match?.correlationMethod === "thread_reference"
          ? 0.95
          : match?.correlationMethod === "explicit_legacy_ids"
            ? 0.9
            : match ? 0.85 : null,
      rawHeaders: input.rawHeaders ?? null,
    });
    return {
      intakeId: persisted.id,
      intakeInserted: persisted.inserted,
      match,
      canonical,
    };
  }

  async process(
    input: InboundMessageInput,
    classification: InboundClassification,
    prepared?: PreparedInboundIntake,
  ): Promise<InboundProcessResult> {
    const intake = prepared ?? this.prepare(input);
    const match = intake.match;
    if (!match) {
      const existing = this.db.getInquiryIntake(intake.intakeId);
      if (!intake.intakeInserted && existing?.intake_status === "QUARANTINED") {
        return {
          inserted: false,
          leadId: null,
          ignored: false,
          intakeId: intake.intakeId,
          quarantined: true,
          opportunityId: null,
        };
      }
      this.db.quarantineInquiryIntake(
        intake.intakeId,
        `unmatched ${input.channel} inbound requires human correlation`,
        classification.classification,
      );
      const saved = this.db.getInquiryIntake(intake.intakeId);
      if (
        saved &&
        classification.confidence >= 0.8 &&
        ["P1_INQUIRY", "P2_INTEREST", "REFERRAL"].includes(classification.classification)
      ) {
        await this.notifier.notifyQuarantinedIntake?.({ intake: saved, inbound: input, classification });
      }
      return {
        inserted: intake.intakeInserted,
        leadId: null,
        ignored: false,
        intakeId: intake.intakeId,
        quarantined: true,
        opportunityId: null,
      };
    }

    const enriched: InboundMessageInput = {
      ...input,
      leadId: match?.leadId ?? null,
      contactId: match?.contactId ?? null,
      classification: classification.classification,
      confidence: classification.confidence,
      reason: classification.reason,
      outboundMessageId: match.outboundMessageId,
    };
    const { leadId, contactId } = match;
    let opportunityId: string | null = null;
    let inquiryNotificationStaged = false;
    const processed = this.db.processInboundAtomically(enriched, (inboundId) => {
      let safetyPaused = false;
      const markCorrelatedOutbound = (status: "REPLIED" | "BOUNCED"): void => {
        if (input.channel === "form") return;
        this.db.markOutboundFromInbound(match.outboundMessageId, status);
      };
      if (classification.classification === "BOUNCE") {
        markCorrelatedOutbound("BOUNCED");
        if (input.channel === "email") {
          if (match.outboundMessageId) {
            this.db.recordEmailBounceIncident({
              inboundMessageId: inboundId,
              outboundMessageId: match.outboundMessageId,
              leadId,
              contactId,
              diagnosticSource: `${input.bodyText}\n${classification.reason}`,
              createdAt: input.receivedAt,
            });
          }
          this.db.recordSourceOutcome(leadId, "bounce");
          this.db.markContactEmailInvalid(contactId, classification.reason);
          this.db.stopAutomationForReply(leadId, "inbound", classification.reason);
          if (isGmailPilotMode(this.config)) {
            this.db.setSetting("outbound_paused", "true");
            this.db.recordEvent("system", "outbound", "GMAIL_PILOT_PAUSED_ON_HARD_BOUNCE", "inbound", {
              leadId,
              contactId,
              reason: classification.reason,
            });
            safetyPaused = true;
          }
        }
      } else if (classification.classification === "UNSUBSCRIBE") {
        this.db.recordSourceOutcome(leadId, "reply");
        markCorrelatedOutbound("REPLIED");
        this.db.addDnc(input.channel, input.fromAddress, classification.reason, "inbound");
        this.db.markLeadDoNotContact(leadId, "inbound", classification.reason);
      } else if (classification.classification === "NEGATIVE") {
        this.db.recordSourceOutcome(leadId, "reply");
        markCorrelatedOutbound("REPLIED");
        this.db.stopAutomationForReply(leadId, "inbound", classification.reason);
      } else if (classification.shouldTakeover) {
        this.db.recordSourceOutcome(leadId, "reply");
        this.db.recordSourceOutcome(leadId, "inquiry");
        markCorrelatedOutbound("REPLIED");
        this.db.setHumanTakeover(leadId, "inbound", classification.reason);
        const opportunity = this.db.createOrGetOpportunity({
          idempotencyKey: `inquiry-intake:${intake.intakeId}`,
          source: input.channel.toUpperCase(),
          accountId: intake.canonical?.accountId ?? null,
          personId: intake.canonical?.personId ?? null,
          intakeId: intake.intakeId,
          stage: "INQUIRY_QUALIFIED",
          owner: "unassigned",
          firstResponseDueAt: new Date(Date.parse(input.receivedAt) + 15 * 60_000).toISOString(),
        });
        opportunityId = opportunity.id;
        this.db.createOrGetSalesTask({
          idempotencyKey: `inquiry-intake:${intake.intakeId}:followup`,
          taskType: "INQUIRY_FOLLOWUP",
          owner: "unassigned",
          dueAt: new Date(Date.parse(input.receivedAt) + 15 * 60_000).toISOString(),
          accountId: intake.canonical?.accountId ?? null,
          personId: intake.canonical?.personId ?? null,
          opportunityId: opportunity.id,
          sourceSignal: classification.classification,
          payload: { intakeId: intake.intakeId, channel: input.channel },
        });
      } else if (classification.classification === "WRONG_PERSON") {
        this.db.recordSourceOutcome(leadId, "reply");
        markCorrelatedOutbound("REPLIED");
        this.db.stopAutomationForReply(leadId, "inbound", classification.reason);
        if (intake.canonical?.accountId) {
          this.db.createOrGetSalesTask({
            idempotencyKey: `inquiry-intake:${intake.intakeId}:contact-research`,
            taskType: "CONTACT_RESEARCH",
            owner: "unassigned",
            dueAt: new Date(Date.parse(input.receivedAt) + 24 * 60 * 60_000).toISOString(),
            accountId: intake.canonical.accountId,
            personId: intake.canonical.personId,
            sourceSignal: "WRONG_PERSON",
            payload: { intakeId: intake.intakeId, channel: input.channel },
          });
        }
      } else if (classification.shouldStopAutomation) {
        this.db.recordSourceOutcome(leadId, "reply");
        markCorrelatedOutbound("REPLIED");
        this.db.stopAutomationForReply(leadId, "inbound", classification.reason);
      }
      const extraction = extractProductInquiry({
        subject: input.subject ?? "",
        body: input.bodyText,
      });
      this.db.recordInquiryFacts(
        intake.intakeId,
        extraction.facts.map((fact) => ({
          fieldName: fact.field,
          normalizedValue: fact.value,
          unit: fact.unit,
          exactEvidenceSpan: fact.evidenceSpan,
          confidence: fact.confidence,
          extractionVersion: extraction.extractionVersion,
        })),
      );
      const intakeStatus = classification.shouldTakeover
        ? "QUALIFIED"
        : ["SPAM", "NOT_FIT"].includes(classification.classification)
          ? "REJECTED"
          : "PROCESSED";
      this.db.updateInquiryIntakeClassification(
        intake.intakeId,
        classification.classification,
        intakeStatus,
      );
      if (classification.shouldTakeover && this.notifier.stageInquiryNotification) {
        const lead = this.db.getLeadDetails(leadId);
        if (lead) {
          this.notifier.stageInquiryNotification({ lead, inbound: enriched, classification });
          inquiryNotificationStaged = true;
        }
      }
      return { safetyPaused };
    });
    if (!processed.processed) {
      return {
        inserted: false,
        leadId,
        ignored: false,
        intakeId: intake.intakeId,
        quarantined: false,
        opportunityId,
      };
    }

    const lead = this.db.getLeadDetails(leadId);
    if (lead && processed.result?.safetyPaused) {
      await this.notifier.notifySafetyPause({ lead, inbound: enriched, classification });
    } else if (
      lead &&
      input.channel === "email" &&
      classification.classification === "BOUNCE"
    ) {
      await this.notifier.notifyHardBounce?.({ lead, inbound: enriched, classification });
    } else if (lead && classification.shouldTakeover) {
      if (inquiryNotificationStaged) await this.notifier.flushPendingNotifications?.();
      else await this.notifier.notifyInquiry({ lead, inbound: enriched, classification });
    } else if (lead && classification.shouldNotify) {
      await this.notifier.notifyReply({ lead, inbound: enriched, classification });
    }
    return {
      inserted: processed.inserted,
      leadId,
      ignored: false,
      intakeId: intake.intakeId,
      quarantined: false,
      opportunityId,
    };
  }
}
