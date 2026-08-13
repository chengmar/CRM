import { loadBusinessContextStrict, type SellerBrief } from "../business-context.js";
import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { AgentLlm } from "../llm.js";
import { logger } from "../logger.js";
import { HermesResearchClient } from "../search/hermes-research.js";
import { outreachQualificationSatisfied } from "../acquisition/recipient-tier.js";
import { emailDraftPolicyBlockers, isGmailPilotMode } from "./email-policy.js";
import { z } from "zod";

export type { SellerBrief } from "../business-context.js";

const DraftItemSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
}).strict();

const DraftSequenceSchema = z.object({
  messages: z.array(DraftItemSchema).min(1).max(4),
}).strict();

type DraftItem = z.infer<typeof DraftItemSchema>;
type DraftSequence = z.infer<typeof DraftSequenceSchema>;

export function fallbackSequence(
  lead: Record<string, unknown>,
  contact: Record<string, unknown>,
  config: AgentConfig,
  brief: SellerBrief,
): DraftItem[] {
  const company = String(lead.company ?? "your company");
  const name = String(contact.name ?? "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const sellerName = brief.company?.legal_name_en?.trim() || "our company";
  const sellerWebsite = brief.company?.website?.trim() || "";
  const productName = brief.product?.name_en?.trim() || config.DEFAULT_PRODUCT;
  const productScope = (brief.product?.models_or_specs ?? []).slice(0, 5).join(", ");
  const buyerContext = String(lead.buyer_type ?? lead.buyerType ?? "your market");
  const scopeSentence = productScope ? ` Our scope includes ${productScope}.` : "";
  const signature = [
    "Best regards,",
    config.EMAIL_FROM_NAME,
    sellerName,
    sellerWebsite,
  ].filter(Boolean).join("\n");
  return [
    {
      subject: `${productName} supply for ${company}`,
      body: `${greeting}\n\nI noticed ${company} appears relevant to ${buyerContext}. ${sellerName} supplies ${productName}.${scopeSentence}\n\nWho handles sourcing or technical evaluation for this product category at ${company}?\n\n${signature}`,
    },
    {
      subject: `Re: ${productName} supply for ${company}`,
      body: `${greeting}\n\nFollowing up in case ${productName} is relevant to a current sourcing or project requirement. I can send a concise technical scope after confirming the right contact.\n\n${signature}`,
    },
    {
      subject: `Re: ${productName} supply for ${company}`,
      body: `${greeting}\n\nWould standard supply, OEM support, or a customized specification be more relevant for ${company}?\n\n${signature}`,
    },
    {
      subject: `Re: ${productName} supply for ${company}`,
      body: `${greeting}\n\nI will close this thread for now. If ${productName} becomes relevant later, I would be glad to provide technical matching based on your application and specifications.\n\n${signature}`,
    },
  ];
}

export class MessageBuilder {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly llm: AgentLlm,
    private readonly hermes = new HermesResearchClient(config),
  ) {}

  async buildEmailSequence(leadId: string, contactId: string): Promise<string[]> {
    const lead = this.db.getLeadDetails(leadId);
    const contact = this.db.getContact(contactId);
    if (!lead || !contact) throw new Error("Lead or contact not found");
    if (String(contact.lead_id) !== leadId) {
      throw new Error("Contact does not belong to the requested lead");
    }
    if (!lead.send_eligible) throw new Error("Lead does not satisfy the quality gate");
    if (!outreachQualificationSatisfied(lead)) {
      throw new Error("Lead does not satisfy a current outreach qualification lane");
    }
    const policyBlockers = emailDraftPolicyBlockers(this.config, lead, contact);
    if (policyBlockers.length > 0) throw new Error(policyBlockers.join("; "));
    if (this.db.hasOutboundSequence(leadId, contactId, "email")) {
      throw new Error("Email sequence already exists for this contact");
    }
    const sources = this.db.listLeadSources(leadId).map((source) => ({
      url: source.source_url,
      type: source.source_type,
      evidence: source.evidence,
    }));
    const businessContext = loadBusinessContextStrict(this.config);
    const brief = businessContext.brief;
    const fallback = fallbackSequence(lead, contact, this.config, brief);
    const gmailPilot = isGmailPilotMode(this.config);
    const requestedMessages = gmailPilot ? 1 : 4;
    let sequence = fallback.slice(0, requestedMessages);
    let generationMode: "GENERIC_FALLBACK" | "HERMES_UNGROUNDED" | "LLM_UNGROUNDED" = "GENERIC_FALLBACK";

    const instruction = [
      `Write a ${requestedMessages === 1 ? "single-message" : "four-message"} one-to-one B2B email sequence in English.`,
      "Use only the supplied company brief and public evidence.",
      "Internal case patterns may guide application matching but must never be cited as customer identities, results or performance claims.",
      "Do not invent certifications, customer facts, prices or technical results.",
      "The first email asks for the correct sourcing or engineering contact.",
      requestedMessages === 1
        ? "This Gmail pilot permits only the first email and no automated follow-up."
        : "Follow-ups are concise and non-repetitive. The fourth politely closes the loop.",
      `Return JSON only as {messages:[{subject,body}, ... exactly ${requestedMessages} item${requestedMessages === 1 ? "" : "s"}]}.`,
    ].join(" ");
    const evidence = JSON.stringify({
      seller: brief,
      internal_case_patterns: businessContext.casePatterns,
      buyer: lead,
      contact,
      public_sources: sources,
    });
    const acceptGenerated = (generated: unknown): DraftSequence | null => {
      const parsed = DraftSequenceSchema.safeParse(generated);
      return parsed.success && parsed.data.messages.length === requestedMessages ? parsed.data : null;
    };

    if (this.hermes.isEnabled()) {
      try {
        const generated = await this.hermes.json<unknown>(
          ["personalized-email"],
          [instruction, evidence].join("\n"),
        );
        const accepted = acceptGenerated(generated);
        if (accepted) {
          sequence = accepted.messages;
          generationMode = "HERMES_UNGROUNDED";
        }
      } catch (error) {
        logger.warn({ error, leadId }, "Hermes personalized-email generation failed; direct model fallback engaged");
      }
    }

    if (generationMode !== "HERMES_UNGROUNDED" && this.llm.isConfigured()) {
      try {
        const generated = await this.llm.json<unknown>(
          "personalized_outreach_sequence",
          instruction,
          evidence,
          this.config.OPENAI_RESEARCH_MODEL || this.config.OPENAI_MODEL,
        );
        const accepted = acceptGenerated(generated);
        if (accepted) {
          sequence = accepted.messages;
          generationMode = "LLM_UNGROUNDED";
        }
      } catch {
        sequence = fallback;
        generationMode = "GENERIC_FALLBACK";
      }
    }

    const campaignId = lead.campaign_id ? String(lead.campaign_id) : null;
    const ids: string[] = [];
    const approvalTime = new Date();
    for (let index = 0; index < sequence.length; index += 1) {
      const delayDays = index === 0 ? 0 : this.config.followupDays[index - 1] ?? 14;
      const scheduledAt = new Date(approvalTime.getTime() + delayDays * 86_400_000).toISOString();
      const messageId = this.db.createOutboundMessage({
          campaignId,
          leadId,
          contactId,
          channel: "email",
          destination: String(contact.email),
          subject: sequence[index]?.subject ?? fallback[index]?.subject ?? "Follow-up",
          body: sequence[index]?.body ?? fallback[index]?.body ?? "",
          sequenceIndex: index,
          scheduledAt,
          status: "DRAFT",
        });
      this.db.recordEvent("outbound_message", messageId, "MESSAGE_DRAFT_NEEDS_GROUNDING", "system", {
        generationMode,
        blocker: "PERSONALIZATION_PLAN_AND_GROUNDED_LINT_REQUIRED",
      });
      ids.push(messageId);
    }
    return ids;
  }
}
