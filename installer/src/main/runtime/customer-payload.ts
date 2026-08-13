import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import YAML from "yaml";
import type { InstallerConfig } from "../../shared/contracts.js";

export interface PayloadManifest {
  schemaVersion: 1;
  databaseSchemaVersion: 18;
  productVersion: string;
  file: string;
  sha256: string;
  createdAt: string;
}

export interface CustomerPayloadResult {
  path: string;
  sha256: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

export async function verifyBasePayload(payloadDir: string): Promise<{ manifest: PayloadManifest; zipPath: string }> {
  const manifestPath = path.join(payloadDir, "payload-manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PayloadManifest;
  if (manifest.schemaVersion !== 1 || manifest.databaseSchemaVersion !== 18 || !manifest.file || !manifest.sha256) {
    throw new Error("Installer payload manifest is invalid.");
  }
  if (path.basename(manifest.file) !== manifest.file || !manifest.file.endsWith(".zip")) {
    throw new Error("Installer payload filename is unsafe.");
  }
  const zipPath = path.join(payloadDir, manifest.file);
  const actual = await sha256File(zipPath);
  if (actual !== manifest.sha256) throw new Error("Installer payload checksum mismatch.");
  const zip = new AdmZip(zipPath);
  const entries = new Set(zip.getEntries().map((entry) => entry.entryName.replaceAll("\\", "/")));
  const required = [
    "deployment-manifest.json",
    "agent_service/src/acquisition/manual-research-launch.ts",
    "agent_service/src/db.ts",
    "agent_service/src/inbound/email-health.ts",
    "agent_service/src/inbound/email-listener.ts",
    "agent_service/src/integrations/feishu/cards.ts",
    "agent_service/src/outreach/dispatcher.ts",
    "scripts/run-fresh-install-acceptance.ps1",
  ];
  const missing = required.filter((entry) => !entries.has(entry));
  if (missing.length > 0) throw new Error(`Installer payload is missing V18 runtime files: ${missing.join(", ")}`);
  const deploymentManifest = JSON.parse(zip.readAsText("deployment-manifest.json").replace(/^\uFEFF/, "")) as {
    manifestSchemaVersion?: unknown;
    databaseSchemaVersion?: unknown;
  };
  if (deploymentManifest.manifestSchemaVersion !== 1 || deploymentManifest.databaseSchemaVersion !== 18) {
    throw new Error("Installer deployment package is not schema 18.");
  }
  if (!/^export const LATEST_SCHEMA_VERSION = 18;\s*$/m.test(zip.readAsText("agent_service/src/db.ts"))) {
    throw new Error("Installer deployment package database source is not schema 18.");
  }
  return { manifest, zipPath };
}

function buildBrief(config: InstallerConfig): string {
  const brief = {
    company: {
      legal_name_en: config.business.legalName,
      brand_name_en: config.business.brandName,
      website: config.business.website,
      country: config.business.country,
      city: config.business.city,
      address_en: config.business.postalAddress,
      contact_person: config.business.contactName,
      contact_title: config.business.contactTitle,
      contact_email: config.business.contactEmail,
      whatsapp: config.business.whatsapp,
      intro_en: config.business.introduction,
    },
    product: {
      name_cn: config.product.name,
      name_en: config.product.name,
      hs_code: config.product.hsCode,
      condition: ["new", "customized"],
      brands: [config.business.brandName, "OEM available"],
      models_or_specs: config.product.specifications,
      year_range: "new equipment",
      tonnage_range: config.product.specifications.join("; "),
      inventory_count: "Subject to order and stock confirmation",
      price_range: config.product.priceRule,
      moq: config.product.moq,
      lead_time: config.product.leadTime,
      payment_terms: "T/T; L/C subject to confirmation",
      warranty: "Subject to product and contract confirmation",
      after_sales_support: "Support available",
      selling_points: config.product.sellingPoints,
      public_case_references_allowed: false,
      internal_case_notes: ["Do not cite private customer cases without explicit written approval."],
    },
    markets: config.product.targetMarkets.map((country) => ({ country, cities: [], local_language: "", priority: "high" })),
    buyer_types: config.product.buyerTypes,
    competitors_or_reference_brands: [],
    negative_keywords: [],
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
      owner: config.business.contactName,
    },
  };
  return YAML.stringify(brief, { lineWidth: 0 });
}

function buildCompanyProfile(config: InstallerConfig): string {
  return `# Company Profile\n\n## Identity\n\n- Legal name: ${config.business.legalName}\n- Brand: ${config.business.brandName}\n- Website: ${config.business.website}\n- Location: ${config.business.city}, ${config.business.country}\n- Contact: ${config.business.contactName}, ${config.business.contactTitle}\n- Email: ${config.business.contactEmail}\n- WhatsApp: ${config.business.whatsapp || "Not configured"}\n\n## Product\n\n- Product: ${config.product.name}\n- HS code: ${config.product.hsCode}\n- Specifications: ${config.product.specifications.join("; ")}\n- MOQ: ${config.product.moq}\n- Lead time: ${config.product.leadTime}\n- Price rule: ${config.product.priceRule}\n\n## External Evidence Rule\n\nUse only public, source-linked company facts. Never cite private cases or invent certifications, customers, prices, or performance claims.\n`;
}

const csvFiles: Record<string, string> = {
  "leads.csv": "created_at,market,product,company,website,country,buyer_type,contact_name,title,email,whatsapp,linkedin,source_url,score,grade,match_reason,recommended_channel,email_draft,whatsapp_opener,status,next_follow_up_at,owner\n",
  "crm_import.csv": "created_at,market,product,company,website,country,buyer_type,contact_name,title,email,whatsapp,linkedin,source_url,score,grade,match_reason,recommended_channel,email_draft,whatsapp_opener,status,next_follow_up_at,owner\n",
  "contacts_enrichment.csv": "company,website,contact_name,title,email,whatsapp,linkedin,source_url,verification_status\n",
  "procurement_contact_validation.csv": "company,contact_name,title,email,source_url,current_employment_verified,decision_role_verified,status\n",
  "manual_verification_queue.csv": "company,website,contact_name,email,source_url,send_status,verification_notes\n",
  "outreach_approval_queue.csv": "company,website,contact_name,email,approval_status,approved_by,approved_at,review_hash,reason\n",
  "outbound_messages.csv": "company,contact_name,email,channel,subject,body,status,scheduled_at,sent_at\n",
  "do_not_contact.csv": "company,domain,email,phone,reason,created_at\n",
};

export async function buildCustomerPayload(
  baseZipPath: string,
  outputPath: string,
  config: InstallerConfig,
  installationId: string,
): Promise<CustomerPayloadResult> {
  const zip = new AdmZip(baseZipPath);
  for (const entry of zip.getEntries()) {
    if (
      entry.entryName.startsWith("real_leadgen_") ||
      entry.entryName.startsWith("case_inputs/") ||
      entry.entryName.startsWith("outputs/")
    ) {
      zip.deleteFile(entry.entryName);
    }
  }
  const root = "customer_business_data";
  zip.addFile(`${root}/input_brief.yaml`, Buffer.from(buildBrief(config), "utf8"));
  zip.addFile(`${root}/company_profile_template.md`, Buffer.from(buildCompanyProfile(config), "utf8"));
  zip.addFile(
    `${root}/outreach_drafts.md`,
    Buffer.from(
      `# Outreach Draft Policy\n\nSeller: ${config.business.legalName}\nProduct: ${config.product.name}\n\nEvery message must use public evidence, require human approval, include an unsubscribe path, and avoid private case references.\n`,
      "utf8",
    ),
  );
  zip.addFile(`${root}/keywords.md`, Buffer.from(config.product.specifications.map((value) => `- ${value}`).join("\n") + "\n", "utf8"));
  zip.addFile(`${root}/scoring_rules.md`, Buffer.from("# Scoring\n\nOnly source-linked, active, named-contact leads may enter review.\n", "utf8"));
  zip.addFile(`${root}/README.md`, Buffer.from("# Customer business data\n\nGenerated by CRM Agent Installer.\n", "utf8"));
  zip.addFile(`${root}/test_report.md`, Buffer.from("# Fresh installation\n\nNo campaign has run yet.\n", "utf8"));
  for (const [name, content] of Object.entries(csvFiles)) {
    zip.addFile(`${root}/${name}`, Buffer.from(content, "utf8"));
  }
  zip.addFile(
    "customer_install_manifest.json",
    Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        installationId,
        generatedAt: new Date().toISOString(),
        company: config.business.legalName,
        product: config.product.name,
      }, null, 2)}\n`,
      "utf8",
    ),
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath) };
}
