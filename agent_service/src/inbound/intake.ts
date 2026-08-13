import type {
  ProductInquiryExtraction,
  InquiryDecision,
} from "../acquisition/product-inquiry.js";
import type { NormalizedInboundIntake } from "../acquisition/inbound-intake.js";

export interface InboundIntakeAdapter {
  readonly source: NormalizedInboundIntake["source"];
  normalize(input: unknown): Promise<NormalizedInboundIntake>;
}

export interface ProductInquiryExtractor {
  extract(input: {
    subject: string;
    body: string;
    locale?: string;
  }): Promise<ProductInquiryExtraction>;
}

export interface InquiryQualificationPolicy {
  evaluate(
    intake: NormalizedInboundIntake,
    extraction: ProductInquiryExtraction,
  ): InquiryDecision;
}

export {
  normalizeInboundIntake,
  normalizedInboundIntakeSchema,
  verifyInquiryWebhook,
} from "../acquisition/inbound-intake.js";
export type { NormalizedInboundIntake } from "../acquisition/inbound-intake.js";
