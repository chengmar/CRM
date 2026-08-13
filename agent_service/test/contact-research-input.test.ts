import { describe, expect, it } from "vitest";
import {
  buildContactResearchPrompt,
  CONTACT_RESEARCH_PROMPT_MAX_BYTES,
  normalizeEvidencedContacts,
} from "../src/search/discovery.js";
import type { SearchResult, WebsiteAssessment } from "../src/types.js";

describe("contact research prompt bounds", () => {
  it("keeps the combined UTF-8 model message content below the hard limit", () => {
    const assessment: WebsiteAssessment = {
      url: "https://buyer.example/",
      domain: "buyer.example",
      reachable: true,
      parked: false,
      title: "Buyer",
      text: "",
      emails: [],
      phones: [],
      activitySignals: [],
      activityScore: 10,
      pages: Array.from({ length: 30 }, (_, pageIndex) => ({
        url: `https://buyer.example/team/${pageIndex}`,
        title: "T".repeat(600),
        text: "\u4e70".repeat(10_000),
        evidenceScopes: Array.from({ length: 20 }, (_, scopeIndex) => ({
          id: `scope_${pageIndex}_${scopeIndex}`,
          text: `Jane Buyer Procurement Manager ${"x".repeat(2_000)}`,
          ambiguous: false,
          emails: Array.from({ length: 8 }, (_, emailIndex) => ({
            email: `jane${emailIndex}@buyer.example`,
            method: "text" as const,
          })),
        })),
      })),
    };
    const evidenceResults: SearchResult[] = Array.from({ length: 40 }, (_, index) => ({
      title: "E".repeat(600),
      url: `https://conference.example/speaker/${index}`,
      snippet: "\u8bc1".repeat(2_000),
      sourceType: "search",
      sourceDate: null,
      query: "fixture",
    }));

    const prompt = buildContactResearchPrompt(
      { company: "Buyer Engineering", website: "https://buyer.example/" },
      assessment,
      evidenceResults,
      4,
    );
    const payload = JSON.parse(prompt.user) as {
      website_pages: Array<{ title: string; text: string; evidenceScopes: unknown[] }>;
      public_evidence: Array<{ title: string; snippet: string }>;
    };

    expect(Buffer.byteLength(prompt.system, "utf8") + Buffer.byteLength(prompt.user, "utf8"))
      .toBeLessThanOrEqual(CONTACT_RESEARCH_PROMPT_MAX_BYTES);
    expect(payload.website_pages.length).toBeGreaterThan(0);
    expect(payload.public_evidence.length).toBeGreaterThan(0);
    expect(payload.website_pages[0]?.title.length).toBeLessThanOrEqual(300);
    expect(payload.website_pages[0]?.text.length).toBeLessThanOrEqual(6_000);
    expect(payload.website_pages[0]?.evidenceScopes.length).toBeLessThanOrEqual(12);
    expect(payload.public_evidence[0]?.title.length).toBeLessThanOrEqual(300);
    expect(payload.public_evidence[0]?.snippet.length).toBeLessThanOrEqual(1_200);
  });

  it("uses only evidence that was actually sent as the response allowlist", () => {
    const pages: WebsiteAssessment["pages"] = Array.from({ length: 13 }, (_, index) => ({
      url: `https://buyer.example/team/${index}`,
      title: "Team",
      text: index === 12 ? "Jane Buyer Procurement Manager" : `Person ${index} Engineering Director`,
      emails: index === 12 ? ["jane@buyer.example"] : [],
      evidenceScopes: [{
        id: `scope_${index}`,
        text: index === 12
          ? "Jane Buyer Procurement Manager jane@buyer.example"
          : `Person ${index} Engineering Director`,
        ambiguous: false,
        emails: index === 12 ? [{ email: "jane@buyer.example", method: "text" }] : [],
      }],
    }));
    const assessment: WebsiteAssessment = {
      url: "https://buyer.example/",
      domain: "buyer.example",
      reachable: true,
      parked: false,
      title: "Buyer",
      text: "",
      emails: ["jane@buyer.example"],
      phones: [],
      activitySignals: [],
      activityScore: 10,
      pages,
    };
    const prompt = buildContactResearchPrompt(
      { company: "Buyer Engineering", website: "https://buyer.example/" },
      assessment,
      [],
      4,
    );
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "jane@buyer.example",
        emailSourceUrl: pages[12]?.url,
        sourceScopeId: "scope_12",
        emailScopeId: "scope_12",
        sourceUrl: pages[12]?.url,
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment: prompt.assessment,
      evidenceResults: prompt.evidenceResults,
      maxContacts: 4,
    });

    expect(prompt.assessment.pages).toHaveLength(12);
    expect(contacts).toEqual([]);
  });
});
