import {
  extractProductInquiry,
  type ProductInquiryExtraction,
} from "../acquisition/product-inquiry.js";
import type { ProductInquiryExtractor } from "./intake.js";

export class DeterministicProductInquiryExtractor implements ProductInquiryExtractor {
  async extract(input: {
    subject: string;
    body: string;
    locale?: string;
  }): Promise<ProductInquiryExtraction> {
    return extractProductInquiry(input);
  }
}
