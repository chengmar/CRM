import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { loadBusinessContextStrict } from "../../agent_service/src/business-context.js";
import { loadConfig } from "../../agent_service/src/config.js";
import { defaultInstallerConfig } from "../src/shared/defaults.js";
import { buildCustomerPayload, verifyBasePayload } from "../src/main/runtime/customer-payload.js";
import { buildRemoteEnv } from "../src/main/runtime/env-builder.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-installer-payload-"));
  tempDirs.push(dir);
  return dir;
}

function addV18RuntimeContract(zip: AdmZip): void {
  zip.addFile("deployment-manifest.json", Buffer.from(JSON.stringify({
    manifestSchemaVersion: 1,
    databaseSchemaVersion: 18,
    productVersion: "1.0.0",
    createdAt: new Date().toISOString(),
  })));
  zip.addFile("agent_service/src/acquisition/manual-research-launch.ts", Buffer.from("export {};\n"));
  zip.addFile("agent_service/src/db.ts", Buffer.from("export const LATEST_SCHEMA_VERSION = 18;\n"));
  zip.addFile("agent_service/src/inbound/email-health.ts", Buffer.from("export {};\n"));
  zip.addFile("agent_service/src/inbound/email-listener.ts", Buffer.from("export {};\n"));
  zip.addFile("agent_service/src/integrations/feishu/cards.ts", Buffer.from("export {};\n"));
  zip.addFile("agent_service/src/outreach/dispatcher.ts", Buffer.from("export {};\n"));
  zip.addFile("scripts/run-fresh-install-acceptance.ps1", Buffer.from("$ExpectedSchemaVersion = 18\n"));
}

function config() {
  const value = structuredClone(defaultInstallerConfig);
  value.business = {
    legalName: "Example Manufacturing Co., Ltd.",
    brandName: "Example",
    website: "https://example.com",
    country: "China",
    city: "Shanghai",
    postalAddress: "100 Example Road, Shanghai, China",
    contactName: "Alex Chen",
    contactTitle: "Sales Manager",
    contactEmail: "sales@example.com",
    whatsapp: "+8613800000000",
    introduction: "Example Manufacturing exports configurable products.",
  };
  value.product = {
    name: "Sample Product",
    hsCode: "8421",
    specifications: ["customized system", "OEM components"],
    sellingPoints: ["engineering support"],
    targetMarkets: ["Vietnam", "Malaysia"],
    buyerTypes: ["industrial distributor"],
    moq: "1 unit",
    leadTime: "30 days",
    priceRule: "Quote by application",
  };
  const pilotAddress = ["pilot.sender", "gmail.com"].join("@");
  value.email = {
    ...value.email,
    mode: "gmail_pilot",
    fromAddress: pilotAddress,
    replyTo: pilotAddress,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUser: pilotAddress,
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapUser: pilotAddress,
  };
  return value;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("customer deployment payload", () => {
  it("injects generic customer data and removes private legacy data", async () => {
    const dir = await createTempDir();
    const basePath = path.join(dir, "base.zip");
    const outputPath = path.join(dir, "customer.zip");
    const base = new AdmZip();
    base.addFile("agent_service/package.json", Buffer.from("{}\n"));
    base.addFile("real_leadgen_private_sample/leads.csv", Buffer.from("private\n"));
    base.addFile("case_inputs/private-case.txt", Buffer.from("private\n"));
    base.addFile("outputs/private_campaign/private.xlsx", Buffer.from("private\n"));
    base.writeZip(basePath);

    await buildCustomerPayload(basePath, outputPath, config(), "installation-123");
    const customer = new AdmZip(outputPath);
    const names = customer.getEntries().map((entry) => entry.entryName);
    expect(names).toContain("customer_business_data/input_brief.yaml");
    expect(names).toContain("customer_business_data/leads.csv");
    expect(names.some((name) => name.startsWith("real_leadgen_"))).toBe(false);
    expect(names.some((name) => name.startsWith("case_inputs/"))).toBe(false);
    expect(names.some((name) => name.startsWith("outputs/"))).toBe(false);
    const brief = customer.readAsText("customer_business_data/input_brief.yaml");
    expect(brief).toContain("Example Manufacturing Co., Ltd.");
    expect(brief).toContain("Sample Product");
  });

  it("generates a customer brief accepted by the agent strict loader", async () => {
    const dir = await createTempDir();
    const basePath = path.join(dir, "base.zip");
    const outputPath = path.join(dir, "customer.zip");
    const businessDataDir = path.join(dir, "customer_business_data");
    const base = new AdmZip();
    base.addFile("agent_service/package.json", Buffer.from("{}\n"));
    base.writeZip(basePath);

    await buildCustomerPayload(basePath, outputPath, config(), "installation-contract-test");
    const customer = new AdmZip(outputPath);
    const brief = customer.readFile("customer_business_data/input_brief.yaml");
    expect(brief).not.toBeNull();
    await fs.mkdir(businessDataDir, { recursive: true });
    await fs.writeFile(path.join(businessDataDir, "input_brief.yaml"), brief!);

    const context = loadBusinessContextStrict(loadConfig({ BUSINESS_DATA_DIR: businessDataDir }));
    expect(context.brief.company).toMatchObject({
      legal_name_en: "Example Manufacturing Co., Ltd.",
      contact_email: "sales@example.com",
      whatsapp: "+8613800000000",
      intro_en: "Example Manufacturing exports configurable products.",
    });
    expect(context.brief.product).toMatchObject({
      condition: ["new", "customized"],
      brands: ["Example", "OEM available"],
      models_or_specs: ["customized system", "OEM components"],
      year_range: "new equipment",
      tonnage_range: "customized system; OEM components",
      inventory_count: "Subject to order and stock confirmation",
      price_range: "Quote by application",
      moq: "1 unit",
      lead_time: "30 days",
      payment_terms: "T/T; L/C subject to confirmation",
      warranty: "Subject to product and contract confirmation",
      after_sales_support: "Support available",
      selling_points: ["engineering support"],
      public_case_references_allowed: false,
      internal_case_notes: ["Do not cite private customer cases without explicit written approval."],
    });
    expect(context.brief.compliance).toEqual({
      use_public_data_only: true,
      require_source_url_for_company_facts: true,
      require_human_approval_before_send: true,
      public_case_references_allowed: false,
      external_outreach_must_not_cite_private_cases: true,
      forbidden_markets: [],
    });
    expect(context.brief.output).toEqual({
      daily_candidate_target: 50,
      high_score_target: 10,
      write_to_feishu: false,
      send_email: false,
      generate_email_drafts: true,
      generate_whatsapp_openers: true,
      owner: "Alex Chen",
    });
  });

  it("verifies the base payload checksum and rejects unsafe manifest filenames", async () => {
    const dir = await createTempDir();
    const zipPath = path.join(dir, "deployment.zip");
    const zip = new AdmZip();
    zip.addFile("agent_service/package.json", Buffer.from("{}\n"));
    addV18RuntimeContract(zip);
    zip.writeZip(zipPath);
    const digest = crypto.createHash("sha256").update(await fs.readFile(zipPath)).digest("hex");
    await fs.writeFile(
      path.join(dir, "payload-manifest.json"),
      JSON.stringify({ schemaVersion: 1, databaseSchemaVersion: 18, productVersion: "0.1.0", file: "deployment.zip", sha256: digest, createdAt: new Date().toISOString() }),
    );
    await expect(verifyBasePayload(dir)).resolves.toMatchObject({ zipPath });

    await fs.writeFile(
      path.join(dir, "payload-manifest.json"),
      JSON.stringify({ schemaVersion: 1, databaseSchemaVersion: 17, productVersion: "0.1.0", file: "deployment.zip", sha256: digest, createdAt: new Date().toISOString() }),
    );
    await expect(verifyBasePayload(dir)).rejects.toThrow("manifest is invalid");

    await fs.writeFile(
      path.join(dir, "payload-manifest.json"),
      JSON.stringify({ schemaVersion: 1, databaseSchemaVersion: 18, productVersion: "0.1.0", file: "../deployment.zip", sha256: digest, createdAt: new Date().toISOString() }),
    );
    await expect(verifyBasePayload(dir)).rejects.toThrow("filename is unsafe");
  });

  it("makes Gmail pilot send-capable while retaining approval and runtime pause gates", () => {
    const env = buildRemoteEnv(config(), { email_password: "abcd efgh ijkl mnop" });
    expect(env).toContain("BUSINESS_DATA_DIR=customer_business_data");
    expect(env).toContain("OUTBOUND_ENABLED=true");
    expect(env).toContain("CONSUMER_EMAIL_PILOT_ENABLED=true");
    expect(env).toContain("AUTO_FOLLOWUP_ENABLED=false");
    expect(env).toContain("REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true");
    expect(env).toContain("MAX_PAGES_PER_CAMPAIGN=1600");
    expect(env).toContain("SMTP_PASSWORD=abcdefghijklmnop");
    expect(env).toContain("IMAP_PASSWORD=abcdefghijklmnop");
    expect(env).not.toContain("real_leadgen_private_sample");
  });
});
