import { describe, expect, it } from "vitest";
import { assessDemandEvidence } from "../src/search/demand-evidence.js";
import type { SearchResult } from "../src/types.js";

const now = new Date("2026-07-19T00:00:00.000Z");
const productTerms = ["Sample Product A", "sample components", "Sample Product C"];

function result(
  text: string,
  options: { url?: string; sourceDate?: string | null; title?: string } = {},
): SearchResult {
  return {
    title: options.title ?? "Public evidence",
    url: options.url ?? "https://buyer.example/news/item",
    snippet: text,
    sourceType: "search",
    sourceDate: options.sourceDate ?? null,
    query: "fixture",
  };
}

function assess(...results: SearchResult[]) {
  return assessDemandEvidence({
    results,
    productTerms,
    companyName: "Buyer Engineering Sdn Bhd",
    companyDomain: "buyer.example",
    now,
  });
}

function assessOfficial(
  text: string,
  options: { url?: string; sourceDate?: string | null; title?: string } = {},
) {
  const source = result(text, {
    ...options,
    url: options.url ?? "https://buyer.example/procurement/item",
  });
  return assessDemandEvidence({
    results: [source],
    pages: [{ url: source.url, title: source.title, text }],
    productTerms,
    companyName: "Buyer Engineering Sdn Bhd",
    companyDomain: "buyer.example",
    now,
  });
}

describe("deterministic demand evidence", () => {
  it("does not turn an ordinary product page into purchase intent", () => {
    const value = assess(result(
      "We supply Sample Product A systems and replacement sample components.",
      { url: "https://buyer.example/products/sample-product" },
    ));
    expect(value).toMatchObject({ stage: "INDUSTRY_FIT", score: 0, buyingLikelihood: "LOW" });
  });

  it("does not use a current copyright year as demand evidence", () => {
    const value = assess(result(
      "Sample Product A products. Copyright 2026 Buyer Engineering.",
      { url: "https://buyer.example" },
    ));
    expect(value.score).toBe(0);
  });

  it("keeps a recent exhibition listing at latent-or-lower intent", () => {
    const value = assess(result(
      "Exhibitor booth for Sample Product A and Sample Product C at Industrial Expo.",
      { url: "https://expo.example/exhibitors/buyer", sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.buyingLikelihood).toBe("LOW");
  });

  it("does not score intent from a project-shaped URL alone", () => {
    const value = assess(result(
      "Sample Product A technical specifications and product dimensions.",
      { url: "https://buyer.example/project/tender/sample-product", sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBe(0);
  });

  it("rejects an old completed project", () => {
    const value = assess(result(
      "The Sample Product A project was completed in 2021 and is shown as a case study.",
      { sourceDate: "2021-05-10" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("rejects an undated active-project phrase", () => {
    const value = assess(result(
      "Our facility upgrade project is underway and includes a Sample Product A.",
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("scores a recent, product-linked ongoing project deterministically", () => {
    const value = assessOfficial(
      "Our facility upgrade project is underway and includes a new Sample Product A.",
      { sourceDate: "2026-05-12" },
    );
    expect(value).toMatchObject({ stage: "CURRENT_PROJECT", score: 18, buyingLikelihood: "MEDIUM" });
    expect(value.demandEvidenceQualified).toBe(true);
    expect(value.evidence[0]).toMatchObject({ sourceDate: "2026-05-12T00:00:00.000Z" });
  });

  it("scores a recent tender as procurement evidence", () => {
    const value = assessOfficial(
      "Buyer Engineering tender notice: request for quotation for a Sample Product A and sample components.",
      { url: "https://buyer.example/tenders/42", sourceDate: "2026-07-01" },
    );
    expect(value).toMatchObject({ stage: "RECENT_PROCUREMENT", score: 25, buyingLikelihood: "HIGH" });
    expect(value.demandEvidenceQualified).toBe(true);
  });

  it("supports a dated RFQ abbreviation", () => {
    const value = assessOfficial(
      "RFQ for Sample Product C, submission deadline 31 July 2026.",
      { url: "https://buyer.example/rfq/88", sourceDate: "2026-07-03" },
    );
    expect(value.stage).toBe("RECENT_PROCUREMENT");
    expect(value.score).toBe(25);
  });

  it("scores a recent supplier replacement signal below direct procurement", () => {
    const value = assessOfficial(
      "We are seeking an alternative supplier for replacement sample components under our vendor change program.",
      { sourceDate: "2026-04-05" },
    );
    expect(value).toMatchObject({ stage: "SUPPLIER_REPLACEMENT", score: 22, buyingLikelihood: "HIGH" });
  });

  it("does not accept a malformed or future-far date", () => {
    const malformed = assess(result(
      "Request for quotation for Sample Product A equipment.",
      { sourceDate: "recently" },
    ));
    const farFuture = assess(result(
      "Request for quotation for Sample Product A equipment.",
      { sourceDate: "2030-01-01" },
    ));
    expect(malformed.score).toBeLessThanOrEqual(4);
    expect(farFuture.score).toBeLessThanOrEqual(4);
  });

  it("rejects relative publication dates without a fixed observation timestamp", () => {
    const value = assess(result(
      "Procurement notice seeking qualified supplier for Sample Product A equipment.",
      { sourceDate: "2 months ago" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("requires product evidence in the same quote as the procurement signal", () => {
    const value = assess(result(
      `Procurement notice seeking a catering vendor. ${"Unrelated corporate information. ".repeat(20)} Elsewhere we describe Sample Product A products.`,
      { sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("rejects a third-party procurement snippet that does not name the candidate", () => {
    const value = assess(result(
      "Request for quotation for a Sample Product A and sample components.",
      { url: "https://procurement.example/tenders/99", sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("rejects supplier-side contract announcements", () => {
    const value = assess(result(
      "We supplied a Sample Product A after the contract was awarded to Buyer Engineering under the project RFQ.",
      { sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("does not accept a year-only publication date", () => {
    const value = assess(result(
      "Request for quotation for Sample Product A equipment.",
      { sourceDate: "2026" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("uses an old event date near the signal instead of a recent article date", () => {
    const value = assess(result(
      "On 2021-04-10 our facility upgrade project was underway for a Sample Product A.",
      { sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("does not combine loose tokens from different product terms", () => {
    const value = assess(result(
      "Procurement notice seeking supplier for product specification and wet process chemicals.",
      { sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("continues past an irrelevant first trigger to a later valid one", () => {
    const value = assessOfficial(
      `Procurement notice seeking a catering vendor. ${"Unrelated details. ".repeat(30)} Buyer Engineering invites suppliers to submit a request for quotation for a Sample Product A.`,
      { sourceDate: "2026-06-01" },
    );
    expect(value.stage).toBe("RECENT_PROCUREMENT");
    expect(value.score).toBe(25);
  });

  it("rejects a future publication date even within the event look-ahead window", () => {
    const value = assess(result(
      "Request for quotation for Sample Product A equipment.",
      { sourceDate: "2026-12-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    const value = assess(result(
      "Request for quotation for Sample Product A equipment.",
      { sourceDate: "2026-02-31" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("does not treat a supplier registration page as an active purchase", () => {
    const value = assess(result(
      "Supplier registration. We manufacture Sample Product A systems and sample components.",
      { sourceDate: "2026-06-01" },
    ));
    expect(value.score).toBeLessThanOrEqual(4);
  });

  it("rejects project awards where the candidate is supplying the customer", () => {
    const official = assess(result(
      "Project awarded: Buyer Engineering will supply a Sample Product A to its customer.",
      { sourceDate: "2026-06-01" },
    ));
    const thirdParty = assess(result(
      "Project awarded to Buyer Engineering for supply of a Sample Product A to the customer.",
      { url: "https://news.example/award", sourceDate: "2026-06-01" },
    ));
    expect(official.score).toBeLessThanOrEqual(4);
    expect(thirdParty.score).toBeLessThanOrEqual(4);
  });

  it("never makes a search snippet send-eligible even when it names the buyer", () => {
    const value = assess(result(
      "Buyer Engineering invites bids: RFQ for a Sample Product A and sample components.",
      { url: "https://buyer.example/rfq/summary", sourceDate: "2026-07-01" },
    ));

    expect(value).toMatchObject({ stage: "RECENT_PROCUREMENT", score: 12, buyingLikelihood: "MEDIUM" });
    expect(value.demandEvidenceQualified).toBe(false);
    expect(value.evidence[0]).toMatchObject({ sourceKind: "SEARCH_SNIPPET", reviewEligible: false });
  });

  it("rejects a seller-side request-for-quotation call to action", () => {
    const value = assessOfficial(
      "Sample Product A systems. Request for quotation and contact our sales team today.",
      { sourceDate: "2026-07-01", url: "https://buyer.example/products/sample-product" },
    );

    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("does not treat an isolated RFQ label on an official product page as buyer action", () => {
    const value = assessOfficial(
      "Sample Product A technical details. Request for quotation.",
      { sourceDate: "2026-07-01", url: "https://buyer.example/products/sample-product" },
    );

    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("does not treat seller-side requirement submission as buyer procurement", () => {
    const quoteRequest = assessOfficial(
      "Request for quotation. Submit your requirements for our Sample Product A sales team.",
      { sourceDate: "2026-07-01", url: "https://buyer.example/products/quote" },
    );
    const proposalRequest = assessOfficial(
      "Request for proposal. Submit your application needs so our engineering team can propose a Sample Product C.",
      { sourceDate: "2026-07-01", url: "https://buyer.example/products/proposal" },
    );

    for (const value of [quoteRequest, proposalRequest]) {
      expect(value.score).toBeLessThanOrEqual(4);
      expect(value.demandEvidenceQualified).toBe(false);
    }
  });

  it("binds the date nearest the demand action instead of a newer unrelated page date", () => {
    const value = assessOfficial(
      "On 2021-04-10 Buyer Engineering published a procurement notice for a Sample Product A. Page updated 2026-07-01 for the next board meeting.",
      { sourceDate: "2026-07-01" },
    );

    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("rejects editorial and SEO content that merely discusses demand signals", () => {
    const fixtures = [
      "Seeking a supplier for a Sample Product A? This guide explains the process.",
      "Alternative supplier for replacement sample components: what buyers should compare.",
      "Planning a new factory? Read our Sample Product A design guide.",
      "Procurement notice guide: Sample Product A definitions and examples.",
      "Purchase requirement checklist for a Sample Product A.",
    ];

    for (const text of fixtures) {
      const value = assessOfficial(text, { sourceDate: "2026-07-01" });
      expect(value.score).toBeLessThanOrEqual(4);
      expect(value.demandEvidenceQualified).toBe(false);
    }
  });

  it("rejects service-provider language even when the candidate appears before the trigger", () => {
    const fixtures = [
      "We help customers plan a facility upgrade with a Sample Product A.",
      "Our engineering services support plant expansion projects using Sample Product A.",
      "Buyer Engineering provides consulting for facility upgrade projects with Sample Product C.",
      "We help industrial buyers find an alternative supplier for replacement sample components.",
      "We help customers issue a procurement notice for a Sample Product A project.",
    ];

    for (const text of fixtures) {
      const value = assessOfficial(text, { sourceDate: "2026-07-01" });
      expect(value.score).toBeLessThanOrEqual(4);
      expect(value.demandEvidenceQualified).toBe(false);
    }
  });

  it("does not combine reposting domains into HIGH demand", () => {
    const text = "Buyer Engineering facility upgrade project is underway for a Sample Product A.";
    const value = assess(
      result(text, { url: "https://news-one.example/project", sourceDate: "2026-06-01" }),
      result(text, { url: "https://news-two.example/repost", sourceDate: "2026-06-02" }),
    );

    expect(value.score).toBe(12);
    expect(value.buyingLikelihood).toBe("MEDIUM");
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("does not treat an eighteen-month-old tender as recent procurement", () => {
    const value = assessOfficial(
      "Buyer Engineering request for quotation for a Sample Product A.",
      { sourceDate: "2025-03-01" },
    );

    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("blocks cancelled, expired, and hiring-page procurement language", () => {
    const cancelled = assessOfficial(
      "Cancelled tender: request for quotation for a Sample Product A.",
      { sourceDate: "2026-07-01" },
    );
    const expired = assessOfficial(
      "Request for quotation for a Sample Product A. Submission deadline 1 June 2026.",
      { sourceDate: "2026-05-01" },
    );
    const job = assessOfficial(
      "Job opening: procurement manager role for our Sample Product A project. Apply now.",
      { sourceDate: "2026-07-01" },
    );

    for (const value of [cancelled, expired, job]) {
      expect(value.score).toBeLessThanOrEqual(4);
      expect(value.demandEvidenceQualified).toBe(false);
    }
  });

  it("does not let an unrelated future deadline revive an expired tender", () => {
    const value = assessOfficial(
      `Buyer Engineering issued a tender notice for a Sample Product A. Submission deadline 1 June 2026. ${"Other information. ".repeat(4)} Separate office furniture tender deadline 31 August 2026.`,
      { sourceDate: "2026-05-01" },
    );

    expect(value.score).toBeLessThanOrEqual(4);
    expect(value.demandEvidenceQualified).toBe(false);
  });

  it("does not treat a different private-suffix tenant as the candidate's official page", () => {
    const text = "Buyer Engineering issued a procurement notice for a Sample Product A on 2026-07-01.";
    const source = result(text, {
      url: "https://other.github.io/procurement/item",
      sourceDate: "2026-07-01",
    });
    const value = assessDemandEvidence({
      results: [source],
      pages: [{ url: source.url, title: source.title, text }],
      productTerms,
      companyName: "Buyer Engineering Sdn Bhd",
      companyDomain: "buyer.github.io",
      now,
    });

    expect(value.demandEvidenceQualified).toBe(false);
  });
});
