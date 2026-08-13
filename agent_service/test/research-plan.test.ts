import { describe, expect, it } from "vitest";
import {
  buildDefaultResearchQueries,
  normalizeResearchPlan,
  type MarketResearchPlan,
} from "../src/search/research-plan.js";

const fallback: MarketResearchPlan = {
  market: "Malaysia",
  marketSummary: "Fallback",
  languages: ["English"],
  cities: ["Selangor"],
  productTerms: ["Sample Product A"],
  buyerTerms: ["sample product application integrator"],
  negativeTerms: ["jobs"],
  segments: [],
  queries: ["Sample Product A Malaysia integrator"],
  source: "fallback",
};

describe("market research planning", () => {
  it("normalizes object-shaped model queries into plain strings", () => {
    const plan = normalizeResearchPlan(
      {
        market: "Malaysia",
        queries: [
          { layer: "official", query: "site:.my sample products Malaysia" },
          { layer: "local", query: "pembekal produk contoh Malaysia" },
          "sample application contractor Malaysia",
          { layer: "invalid" },
        ],
      },
      fallback,
      "llm",
    );
    expect(plan.queries[0]).toBe("Sample Product A Malaysia integrator");
    expect(plan.queries).toContain("site:.my sample products Malaysia");
    expect(plan.queries).toContain("pembekal produk contoh Malaysia");
    expect(plan.queries.every((query) => typeof query === "string")).toBe(true);
    expect(plan.queries.join(" ")).not.toContain("[object Object]");
  });

  it("splits a business brief into concrete market queries", () => {
    const queries = buildDefaultResearchQueries(
      {
        market: "马来西亚",
        product: "示例产品",
        buyerType: "工业示例系统集成商",
        targetCount: 15,
      },
      {
        brief: {
          product: { models_or_specs: ["Sample Product A", "sample components"] },
          buyer_types: ["sample product application system integrator"],
          markets: [{ country: "Malaysia", cities: ["Selangor"], local_language: "English / Malay" }],
        },
        casePatterns: [],
        seedLeads: [],
      },
    );
    expect(queries.some((query) => query.includes("Sample Product A"))).toBe(true);
    expect(queries.some((query) => query.includes("Malaysia"))).toBe(true);
    expect(queries.some((query) =>
      query.startsWith('"Sample Product A" Malaysia') &&
      query.includes('"sample product application system integrator"'))).toBe(true);
    expect(queries.join(" ")).not.toContain("示例产品");
  });
});
