import { z } from "zod";

export const inquiryFactFields = [
  "COMPANY",
  "COUNTRY",
  "INDUSTRY",
  "APPLICATION",
  "REQUIREMENT",
  "SPECIFICATION",
  "QUANTITY",
  "PROJECT_STAGE",
  "LEAD_TIME",
  "DELIVERY_LOCATION",
  "DRAWING_OR_PHOTO",
  "PRICE_OR_QUOTE",
  "MOQ",
  "PAYMENT",
] as const;

export type InquiryFactField = (typeof inquiryFactFields)[number];

export const inquiryFactSchema = z.object({
  field: z.enum(inquiryFactFields),
  value: z.string().min(1).max(1_000),
  unit: z.string().max(50).nullable(),
  evidenceSpan: z.string().min(1).max(1_000),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
}).strict();

export type InquiryFact = z.infer<typeof inquiryFactSchema>;

export interface ProductInquiryExtraction {
  facts: InquiryFact[];
  missingFields: InquiryFactField[];
  commercialQuestionFields: InquiryFactField[];
  extractionVersion: "product-inquiry-v1";
}

export interface InquiryDecision {
  classification:
    | "P1_INQUIRY"
    | "P2_INTEREST"
    | "REFERRAL"
    | "WRONG_PERSON"
    | "NEEDS_INFO"
    | "AMBIGUOUS";
  confidence: number;
  reason: string;
  shouldTakeover: boolean;
}

interface PatternDefinition {
  field: InquiryFactField;
  pattern: RegExp;
  confidence: number;
}

// These patterns intentionally cover only product-neutral commercial facts.
// Product attributes and technical vocabulary must be supplied at runtime for
// each newly approved product line instead of being embedded in source code.
const patterns: PatternDefinition[] = [
  { field: "PRICE_OR_QUOTE", pattern: /\b(?:price|pricing|quote|quotation|rfq|request for quotation)\b|报价|价格/giu, confidence: 0.99 },
  { field: "MOQ", pattern: /\bMOQ\b|minimum order(?: quantity)?|最低起订量/giu, confidence: 0.99 },
  { field: "PAYMENT", pattern: /\bpayment terms?\b|付款条款/giu, confidence: 0.98 },
  { field: "LEAD_TIME", pattern: /\blead time\b|delivery (?:time|schedule)|交期|交货时间/giu, confidence: 0.98 },
  { field: "QUANTITY", pattern: /\b\d[\d,.]*\s*(?:pcs?|pieces?|units?|sets?)\b|\d+\s*(?:件|台|套)/giu, confidence: 0.96 },
  { field: "DRAWING_OR_PHOTO", pattern: /\b(?:drawing|drawings|photo|photos|layout|datasheet|blueprint)\b|图纸|照片/giu, confidence: 0.97 },
  { field: "PROJECT_STAGE", pattern: /\b(?:new project|expansion|replacement|retrofit|tender|planning stage|installation)\b|新项目|扩产|改造|更换|招标/giu, confidence: 0.9 },
  { field: "DELIVERY_LOCATION", pattern: /\b(?:deliver(?:y|ed)? to|ship(?:ment)? to|destination)\b[^\r\n,.]{0,120}|交付地点|收货地址/giu, confidence: 0.85 },
];

const requiredFields: InquiryFactField[] = ["REQUIREMENT", "QUANTITY", "PROJECT_STAGE", "LEAD_TIME"];

const commercialFields = new Set<InquiryFactField>([
  "PRICE_OR_QUOTE",
  "MOQ",
  "PAYMENT",
  "LEAD_TIME",
  "QUANTITY",
  "DRAWING_OR_PHOTO",
]);

export function extractProductInquiry(input: { subject: string; body: string }): ProductInquiryExtraction {
  const text = `${input.subject}\n${input.body}`.slice(0, 100_000);
  const facts: InquiryFact[] = [];
  const seen = new Set<string>();
  for (const definition of patterns) {
    definition.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = definition.pattern.exec(text)) !== null) {
      const key = `${definition.field}:${match.index}:${match[0].toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.push(inquiryFactSchema.parse({
          field: definition.field,
          value: match[0].trim(),
          unit: null,
          evidenceSpan: match[0],
          start: match.index,
          end: match.index + match[0].length,
          confidence: definition.confidence,
        }));
      }
      if (match[0].length === 0) definition.pattern.lastIndex += 1;
    }
  }
  const found = new Set(facts.map((fact) => fact.field));
  return {
    facts,
    missingFields: requiredFields.filter((field) => !found.has(field)),
    commercialQuestionFields: [...found].filter((field) => commercialFields.has(field)),
    extractionVersion: "product-inquiry-v1",
  };
}

const referralPattern = /\b(?:please\s+contact|speak\s+(?:with|to)|forwarded|referral|our\s+(?:buyer|procurement|purchasing)\s+(?:manager|contact))\b/iu;
const wrongPersonPattern = /\bwrong person\b|\bnot the right person\b|\bnot responsible for\b/iu;
const interestPattern = /\b(?:interested|catalog(?:ue)?|brochure|more information|send details|discuss)\b|感兴趣|目录|资料/iu;

export function evaluateProductInquiry(
  input: { subject: string; body: string },
  extraction = extractProductInquiry(input),
): InquiryDecision {
  const text = `${input.subject}\n${input.body}`;
  if (extraction.commercialQuestionFields.length > 0) {
    return {
      classification: "P1_INQUIRY",
      confidence: 0.98,
      reason: `commercial evidence: ${extraction.commercialQuestionFields.join(", ")}`,
      shouldTakeover: true,
    };
  }
  if (referralPattern.test(text)) {
    return { classification: "REFERRAL", confidence: 0.94, reason: "responsible-contact referral", shouldTakeover: true };
  }
  if (wrongPersonPattern.test(text)) {
    return { classification: "WRONG_PERSON", confidence: 0.95, reason: "wrong person without opt-out", shouldTakeover: false };
  }
  if (interestPattern.test(text)) {
    return { classification: "P2_INTEREST", confidence: 0.9, reason: "explicit business interest", shouldTakeover: true };
  }
  if (text.trim()) {
    return { classification: "AMBIGUOUS", confidence: 0.4, reason: "human review required", shouldTakeover: false };
  }
  return { classification: "NEEDS_INFO", confidence: 0.2, reason: "empty inquiry", shouldTakeover: false };
}
