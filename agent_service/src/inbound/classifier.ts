import type { AgentConfig } from "../config.js";
import type { AgentLlm } from "../llm.js";
import { inboundClasses, type InboundClass, type InboundClassification } from "../types.js";

const deliveryNoticePattern = /mailer-daemon|mail delivery subsystem|delivery status notification|undeliverable|delivery failed|returned mail|final-recipient|original-recipient/i;
const hardBouncePattern = /\b(?:550|551|552|553|554)\b|\bstatus:\s*5\.\d\.\d\b|5\.1\.1|address not found|user unknown|mailbox (?:does not exist|unavailable)|permanent(?:ly)? fail/i;
const softBouncePattern = /\bstatus:\s*4\.\d\.\d\b|\b4\.\d\.\d\b|delivery status notification \(delay\)|temporar(?:y|ily)|try again later|mailbox full|delivery delayed/i;
const autoReplyPattern = /automatic reply|auto.?reply|out of office|away from the office|vacation reply|autoreply/i;
const unsubscribePattern = /unsubscribe|remove me|stop emailing|do not contact|opt.?out|please delete my (email|address)/i;
const referralPattern = /\b(?:please|kindly)?\s*(?:contact|reach out to|speak (?:with|to))\s+[A-Z][\p{L}'-]+|\b(?:forwarded|forwarding|referred|referral)\b|\b(?:our|the)\s+(?:buyer|procurement|purchasing|engineering)\s+(?:contact|manager|team)\s+(?:is|handles|can help)\b/iu;
const wrongPersonPattern = /\bwrong person\b|\bnot the right person\b|\b(?:i|we)\s+(?:do not|don't)\s+(?:handle|manage|cover)\b|\bnot responsible for\b/i;
const negativePattern = /not interested|no need|not required|we do not need|do not have demand|not relevant/i;
const p1Pattern = /\b(quote|quotation|price|pricing|rfq|request for quotation|moq|lead time|delivery time|payment terms|drawing|datasheet|specification|technical data|model|variant|quantity|delivery location)\b/i;
const p2Pattern = /\b(interested|catalog|catalogue|brochure|more information|send details|product list|introduce|forwarded|procurement contact|purchasing contact|let us discuss|call me)\b/i;

function result(
  classification: InboundClass,
  confidence: number,
  reason: string,
): InboundClassification {
  const shouldTakeover = ["P1_INQUIRY", "P2_INTEREST", "REFERRAL"].includes(classification);
  const humanReply = !["AUTO_REPLY", "BOUNCE", "SOFT_BOUNCE", "SPAM", "UNKNOWN"].includes(classification);
  return {
    classification,
    confidence,
    reason,
    shouldNotify: shouldTakeover || ["WRONG_PERSON", "NEEDS_INFO", "AMBIGUOUS", "OTHER_REPLY"].includes(classification),
    shouldTakeover,
    shouldStopAutomation:
      humanReply || classification === "BOUNCE" || classification === "UNSUBSCRIBE",
  };
}

export async function classifyInbound(
  input: {
    from: string;
    subject: string;
    body: string;
    headers?: Record<string, unknown>;
  },
  llm: AgentLlm,
  config: AgentConfig,
): Promise<InboundClassification> {
  const text = `${input.from}\n${input.subject}\n${input.body}`.slice(0, 30_000);
  if (deliveryNoticePattern.test(text)) {
    if (hardBouncePattern.test(text) && !softBouncePattern.test(text)) {
      return result("BOUNCE", 0.99, "permanent delivery failure pattern");
    }
    return result("SOFT_BOUNCE", 0.97, "temporary or unconfirmed delivery failure pattern");
  }
  if (unsubscribePattern.test(text)) return result("UNSUBSCRIBE", 0.99, "explicit opt-out pattern");
  if (autoReplyPattern.test(text)) return result("AUTO_REPLY", 0.97, "automatic reply pattern");
  if (p1Pattern.test(text)) return result("P1_INQUIRY", 0.94, "commercial or technical inquiry pattern");
  if (referralPattern.test(text)) return result("REFERRAL", 0.94, "referral or responsible-contact pattern");
  if (wrongPersonPattern.test(text)) return result("WRONG_PERSON", 0.97, "wrong-person pattern");
  if (p2Pattern.test(text)) return result("P2_INTEREST", 0.9, "positive interest pattern");
  if (negativePattern.test(text)) return result("NEGATIVE", 0.94, "negative intent pattern");
  if (
    input.headers?.matchedInbound === true &&
    (input.headers?.hasNonTextContent === true || input.body.trim().length === 0)
  ) {
    return result("OTHER_REPLY", 0.85, "matched contact sent a non-text or empty-body reply");
  }

  if (llm.isConfigured()) {
    try {
      const classified = await llm.json<{
        classification: InboundClass;
        confidence: number;
        reason: string;
      }>(
        "inbound_reply_classification",
        [
          "Classify an inbound B2B sales reply.",
          `Allowed classes: ${inboundClasses.join(", ")}.`,
          "P1 includes price, quotation, MOQ, lead time or technical purchasing questions.",
          "P2 includes catalog requests or clear interest. REFERRAL names or directs us to another responsible person. WRONG_PERSON means this person is not responsible without an explicit opt-out.",
          "Never classify a possible commercial inquiry as SPAM or NOT_FIT when the evidence is ambiguous.",
          "Return JSON only with classification, confidence 0..1, and concise reason.",
        ].join(" "),
        JSON.stringify(input),
        config.OPENAI_CLASSIFIER_MODEL || config.OPENAI_MODEL,
      );
      if ((inboundClasses as readonly string[]).includes(classified.classification)) {
        return result(
          classified.classification,
          Math.max(0, Math.min(1, Number(classified.confidence) || 0.5)),
          classified.reason || "model classification",
        );
      }
    } catch {
      // Fall through to conservative human-reply handling.
    }
  }

  if (input.body.trim().length > 0) {
    return result("OTHER_REPLY", 0.55, "unclassified human reply; automation stopped conservatively");
  }
  return result("UNKNOWN", 0.2, "empty or unsupported message");
}
