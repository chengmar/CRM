import { describe, expect, it } from "vitest";
import type { EvidenceFact } from "../src/acquisition/models.js";
import { collapseIndependentPublishers } from "../src/acquisition/qualification.js";

function source(
  id: string,
  publisherDomain: string,
  independenceKey: string,
  originalDocumentKey: string | null = null,
  overrides: Partial<EvidenceFact> = {},
): EvidenceFact {
  return {
    id,
    subjectEntityId: "account-1",
    claimType: "ACCOUNT_IDENTITY",
    signalType: null,
    publisherDomain,
    independenceKey,
    originalDocumentKey,
    authorityClass: "OTHER",
    authorityAllowlisted: false,
    sourceKind: "PUBLIC_WEB",
    subjectRole: "BUYER",
    exactQuote: "A directly attributable source quote.",
    entityBound: true,
    effectiveAt: null,
    observedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    status: "CURRENT",
    confidence: 0.9,
    humanReview: "UNREVIEWED",
    allowedQualificationUses: ["ICP_IDENTITY"],
    allowedForOutreach: true,
    ...overrides,
  };
}

describe("publisher and underlying-source independence", () => {
  it("counts multiple pages and source kinds from the same publisher once", () => {
    const groups = collapseIndependentPublishers([
      source("homepage", "buyer.example.com", "home", null, { sourceKind: "OFFICIAL_WEBSITE" }),
      source("news", "news.buyer.example.com", "news-42", null, { sourceKind: "MEDIA" }),
      source("directory-feed", "buyer.example.com", "directory-copy", null, { sourceKind: "DIRECTORY" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.publisherDomains).toEqual(["example.com"]);
    expect(groups[0]?.factIds).toEqual(["directory-feed", "homepage", "news"]);
  });

  it("counts a syndicated original only once across different publishers", () => {
    const groups = collapseIndependentPublishers([
      source("original", "project-owner.example", "owner-release", "release-sha256-abc"),
      source("repost-a", "trade-news.example", "article-a", "release-sha256-abc"),
      source("repost-b", "regional-news.example", "article-b", "release-sha256-abc"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "underlying:release-sha256-abc",
      publisherDomains: ["project-owner.example", "regional-news.example", "trade-news.example"],
    });
  });

  it("collapses transitive publisher and underlying-document relationships", () => {
    const groups = collapseIndependentPublishers([
      source("a-original", "publisher-a.example", "a", "document-a"),
      source("a-second", "publisher-a.example", "b", "document-b"),
      source("b-repost", "publisher-b.example", "c", "document-b"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.factIds).toEqual(["a-original", "a-second", "b-repost"]);
  });

  it("counts genuinely independent publishers and underlying documents separately", () => {
    const groups = collapseIndependentPublishers([
      source("official", "buyer.example", "buyer-profile"),
      source("registry", "industry-registry.example", "registry-record"),
      source("authority", "permits.gov.example", "permit-record"),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.key)).toEqual([
      "underlying:buyer-profile",
      "underlying:permit-record",
      "underlying:registry-record",
    ]);
  });

  it("treats separate tenants on a private suffix as separate publishers", () => {
    const groups = collapseIndependentPublishers([
      source("tenant-a", "manufacturer-a.github.io", "document-a"),
      source("tenant-b", "manufacturer-b.github.io", "document-b"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.publisherDomains)).toEqual([
      "manufacturer-a.github.io",
      "manufacturer-b.github.io",
    ]);
  });

  it("produces deterministic groups regardless of input order", () => {
    const facts = [
      source("z", "z.example", "z-source"),
      source("a", "a.example", "a-source"),
      source("a-copy", "news.a.example", "different-page"),
    ];

    expect(collapseIndependentPublishers(facts)).toEqual(collapseIndependentPublishers([...facts].reverse()));
  });

  it("strictly rejects unknown source fields instead of silently counting them", () => {
    const unsafe = { ...source("unsafe", "source.example", "source-key"), providerSaysIndependent: true };
    expect(() => collapseIndependentPublishers([unsafe])).toThrow();
  });
});
