import { describe, expect, it } from "vitest";
import {
  evaluateProductInquiry,
  extractProductInquiry,
} from "../src/acquisition/product-inquiry.js";

const commercialTemplates = [
  "Please quote 20 units and confirm MOQ.",
  "Please confirm price and lead time for Sample Model A.",
  "The required capacity is 120 units per hour.",
  "We attached a drawing and need payment terms.",
  "Please confirm the delivery location and expected schedule.",
  "Please quote a configurable product for this application.",
  "We need a replacement unit; please confirm availability.",
  "RFQ: please review the attached specification and provide pricing.",
  "Can you review our photos and quote the project?",
  "Please confirm delivery time for the attached datasheet.",
];

describe("product inquiry extraction", () => {
  it("detects synthetic commercial fixtures with exact evidence spans", () => {
    const fixtures = Array.from({ length: 100 }, (_, index) => ({
      subject: `Fixture RFQ ${index + 1}`,
      body: `${commercialTemplates[index % commercialTemplates.length]} Reference ${index + 1}.`,
    }));

    let p1 = 0;
    for (const fixture of fixtures) {
      const extraction = extractProductInquiry(fixture);
      const decision = evaluateProductInquiry(fixture, extraction);
      if (decision.classification === "P1_INQUIRY") p1 += 1;
      const combined = `${fixture.subject}\n${fixture.body}`;
      expect(extraction.facts.length).toBeGreaterThan(0);
      for (const fact of extraction.facts) {
        expect(combined.slice(fact.start, fact.end)).toBe(fact.evidenceSpan);
      }
    }

    expect(p1).toBe(100);
  });

  it("keeps referral, wrong-person, and ambiguous messages distinct", () => {
    expect(evaluateProductInquiry({
      subject: "Responsible person",
      body: "Please contact Maria, our procurement manager.",
    }).classification).toBe("REFERRAL");
    expect(evaluateProductInquiry({
      subject: "Re: product",
      body: "I am not the right person for this topic.",
    }).classification).toBe("WRONG_PERSON");
    expect(evaluateProductInquiry({
      subject: "Hello",
      body: "Can we discuss this next week?",
    }).classification).toBe("P2_INTEREST");
    expect(evaluateProductInquiry({
      subject: "Re: message",
      body: "Thank you for your note.",
    }).classification).toBe("AMBIGUOUS");
  });
});
