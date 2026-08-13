import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { fallbackSequence, type SellerBrief } from "../src/outreach/message-builder.js";
import { buildDefaultQueries } from "../src/search/discovery.js";

describe("customer-specific fallbacks", () => {
  it("builds fallback outreach only from the installed customer brief", () => {
    const brief: SellerBrief = {
      company: {
        legal_name_en: "Example Manufacturing Co., Ltd.",
        website: "https://example-manufacturing.test",
      },
      product: {
        name_en: "Sample Product A",
        models_or_specs: ["Sample Model 100", "Sample Model 200"],
      },
    };
    const messages = fallbackSequence(
      { company: "Target Engineering", buyer_type: "system integrator" },
      { name: "Jordan" },
      {
        DEFAULT_PRODUCT: "Sample Product A",
        EMAIL_FROM_NAME: "Alex Chen",
      } as AgentConfig,
      brief,
    );
    const text = JSON.stringify(messages);
    expect(text).toContain("Example Manufacturing Co., Ltd.");
    expect(text).toContain("Sample Product A");
    expect(text).toContain("https://example-manufacturing.test");
    expect(text).not.toMatch(/Legacy Seller Co\.|Legacy Contact|legacy-specific-product/i);
  });

  it("derives discovery queries from the campaign product and buyer type", () => {
    const queries = buildDefaultQueries({
      id: "campaign-1",
      market: "Chile",
      product: "Sample Product A",
      buyerType: "sample distributor",
      targetCount: 20,
    });
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.every((query) => query.includes("Chile"))).toBe(true);
    expect(queries.some((query) => query.includes("Sample Product A"))).toBe(true);
    expect(queries.join(" ")).not.toMatch(/legacy-specific-product|Legacy Seller Co\./i);
  });
});
