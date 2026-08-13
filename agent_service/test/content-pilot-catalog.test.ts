import { describe, expect, it } from "vitest";
import {
  ContentPilotCatalogSchema,
  auditContentPilotCatalog,
  buildContentPilotCatalog,
  runContentPilotShadow,
  type ContentPilotCatalog,
} from "../src/acquisition/content-pilot-catalog.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

describe("product-neutral content pilot catalog", () => {
  it("ships with no markets, products, assets, or publication authorization", () => {
    const catalog = buildContentPilotCatalog(NOW);
    const result = auditContentPilotCatalog({ catalog, claims: [], privateCases: [], now: NOW });

    expect(result).toMatchObject({
      accepted: true,
      blockers: [],
      counts: { markets: 0, coreLandingPages: 0, technicalAssets: 0, rfqChecklists: 0 },
    });
    expect(catalog.marketPackages).toEqual([]);
    expect(catalog.artifacts).toEqual([]);
    expect(catalog).toMatchObject({
      status: "DRAFT",
      publicationState: "NOT_PUBLISHED",
      externalReady: false,
      publicationAuthorized: false,
      executionSafety: {
        networkCalls: 0,
        paidApiCalls: 0,
        externalWrites: 0,
        messagesSent: 0,
        websitesPublished: 0,
      },
    });
  });

  it("uses a strict schema and rejects unknown fields or publication attempts", () => {
    const unknownField = structuredClone(buildContentPilotCatalog(NOW)) as ContentPilotCatalog & { unexpected?: boolean };
    unknownField.unexpected = true;
    expect(ContentPilotCatalogSchema.safeParse(unknownField).success).toBe(false);

    const published = structuredClone(buildContentPilotCatalog(NOW)) as ContentPilotCatalog & {
      publicationAuthorized: boolean;
    };
    published.publicationAuthorized = true;
    expect(ContentPilotCatalogSchema.safeParse(published).success).toBe(false);
  });

  it("keeps the empty shadow run fail-closed", () => {
    expect(runContentPilotShadow()).toMatchObject({
      fixtureSet: "content-pilot-empty-v2",
      accepted: true,
      counts: { markets: 0, coreLandingPages: 0, technicalAssets: 0, rfqChecklists: 0 },
      states: { draft: 0, notPublished: 0, publicationAuthorized: 0 },
      verdict: "HOLD",
    });
  });
});
