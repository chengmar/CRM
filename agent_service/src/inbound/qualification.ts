import {
  evaluateProductInquiry,
  type ProductInquiryExtraction,
  type InquiryDecision,
} from "../acquisition/product-inquiry.js";
import type {
  InquiryQualificationPolicy,
  NormalizedInboundIntake,
} from "./intake.js";

export class DeterministicInquiryQualificationPolicy implements InquiryQualificationPolicy {
  evaluate(
    intake: NormalizedInboundIntake,
    extraction: ProductInquiryExtraction,
  ): InquiryDecision {
    return evaluateProductInquiry(
      { subject: intake.subject, body: intake.body },
      extraction,
    );
  }
}
