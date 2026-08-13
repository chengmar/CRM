import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadBusinessContextStrict } from "../src/business-context.js";
import { loadConfig } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-strict-"));
  tempDirs.push(value);
  return value;
}

describe("strict business context", () => {
  it("blocks a missing brief instead of returning an empty object", () => {
    const dir = directory();
    expect(() => loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })))
      .toThrow(/BUSINESS_CONTEXT_NOT_READY.*missing/i);
  });

  it("blocks malformed YAML and JSON explicitly", () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, "input_brief.yaml"), "company: [unterminated", "utf8");
    expect(() => loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })))
      .toThrow(/INVALID_YAML/);

    fs.writeFileSync(path.join(dir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: Fixture Seller",
      "  website: https://seller.example",
      "product:",
      "  name_en: sample products",
      "  models_or_specs:",
      "    - Configurable unit",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(dir, "case_patterns.json"), "{bad-json", "utf8");
    expect(() => loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })))
      .toThrow(/INVALID_JSON/);
  });

  it("requires seller identity and a concrete product specification", () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: ''",
      "  website: not-a-url",
      "product:",
      "  name_en: sample products",
      "  models_or_specs: []",
    ].join("\n"), "utf8");
    expect(() => loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })))
      .toThrow(/BUSINESS_CONTEXT_NOT_READY/);
  });

  it("loads a valid minimal brief without inventing optional facts", () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: Fixture Seller",
      "  website: https://seller.example",
      "product:",
      "  name_en: sample products",
      "  models_or_specs:",
      "    - Configurable unit",
    ].join("\n"), "utf8");
    expect(loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir }))).toEqual({
      brief: {
        company: { legal_name_en: "Fixture Seller", website: "https://seller.example" },
        product: { name_en: "sample products", models_or_specs: ["Configurable unit"] },
      },
      casePatterns: [],
      seedLeads: [],
    });
  });

  it("retains existing product inspection capabilities", () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, "input_brief.yaml"), [
      "company:",
      "  legal_name_en: Fixture Seller",
      "  website: https://seller.example",
      "product:",
      "  name_en: sample products",
      "  models_or_specs:",
      "    - Configurable unit",
      "  inspection_capabilities:",
      '    - "Factory inspection: dimensional and appearance checks"',
      "    - Pre-shipment functional test",
    ].join("\n"), "utf8");

    expect(loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })).brief.product)
      .toMatchObject({
        inspection_capabilities: [
          "Factory inspection: dimensional and appearance checks",
          "Pre-shipment functional test",
        ],
      });
  });

  it("rejects customer briefs that relax private-case or initial-send gates", () => {
    const dir = directory();
    const safeBrief = {
      company: { legal_name_en: "Fixture Seller", website: "https://seller.example" },
      product: {
        name_en: "sample products",
        models_or_specs: ["Configurable unit"],
        public_case_references_allowed: false,
      },
      compliance: {
        use_public_data_only: true,
        require_source_url_for_company_facts: true,
        require_human_approval_before_send: true,
        public_case_references_allowed: false,
        external_outreach_must_not_cite_private_cases: true,
        forbidden_markets: [],
      },
      output: {
        daily_candidate_target: 50,
        high_score_target: 10,
        write_to_feishu: false,
        send_email: false,
        generate_email_drafts: true,
        generate_whatsapp_openers: true,
        owner: "Fixture Owner",
      },
    };
    const unsafeBriefs = [
      { ...safeBrief, product: { ...safeBrief.product, public_case_references_allowed: true } },
      {
        ...safeBrief,
        compliance: { ...safeBrief.compliance, external_outreach_must_not_cite_private_cases: false },
      },
      { ...safeBrief, output: { ...safeBrief.output, send_email: true } },
    ];

    for (const brief of unsafeBriefs) {
      fs.writeFileSync(path.join(dir, "input_brief.yaml"), YAML.stringify(brief), "utf8");
      expect(() => loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: dir })))
        .toThrow(/BUSINESS_CONTEXT_NOT_READY/);
    }
  });
});
