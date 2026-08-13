import fs from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import YAML from "yaml";
import { z } from "zod";
import type { AgentConfig } from "./config.js";

export interface SellerBrief {
  company?: {
    legal_name_en?: string;
    brand_name_en?: string;
    website?: string;
    country?: string;
    city?: string;
    address_en?: string;
    contact_person?: string;
    contact_title?: string;
    contact_email?: string;
    whatsapp?: string;
    intro_en?: string;
  };
  product?: {
    name_cn?: string;
    name_en?: string;
    hs_code?: string;
    condition?: string[];
    brands?: string[];
    models_or_specs?: string[];
    year_range?: string;
    tonnage_range?: string;
    inventory_count?: string;
    price_range?: string;
    selling_points?: string[];
    materials?: string[];
    technical_options?: string[];
    performance_range?: string;
    moq?: string;
    lead_time?: string;
    payment_terms?: string;
    warranty?: string;
    after_sales_support?: string;
    export_capabilities?: string[];
    inspection_capabilities?: string[];
    public_case_references_allowed?: false;
    internal_case_notes?: string[];
  };
  markets?: Array<{
    country?: string;
    cities?: string[];
    local_language?: string;
    priority?: string;
  }>;
  buyer_types?: string[];
  competitors_or_reference_brands?: string[];
  negative_keywords?: string[];
  compliance?: {
    use_public_data_only: true;
    require_source_url_for_company_facts: true;
    require_human_approval_before_send: true;
    public_case_references_allowed: false;
    external_outreach_must_not_cite_private_cases: true;
    forbidden_markets: string[];
  };
  output?: {
    daily_candidate_target: number;
    high_score_target: number;
    write_to_feishu: boolean;
    send_email: false;
    generate_email_drafts: boolean;
    generate_whatsapp_openers: boolean;
    owner: string;
  };
}

export interface CasePattern {
  market: string;
  industries: string[];
  products: string[];
  applications: string[];
  pains: string[];
  buyerSignals: string[];
}

export interface SeedLead {
  company: string;
  country: string;
  city: string;
  buyerType: string;
  website: string;
  productMatch: string;
  sourceUrls: string[];
  notes: string;
}

export interface BusinessContext {
  brief: SellerBrief;
  casePatterns: CasePattern[];
  seedLeads: SeedLead[];
}

const SellerBriefSchema = z.object({
  company: z.object({
    legal_name_en: z.string().trim().min(1).max(300),
    brand_name_en: z.string().trim().max(300).optional(),
    website: z.string().url(),
    country: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    address_en: z.string().trim().max(500).optional(),
    contact_person: z.string().trim().max(200).optional(),
    contact_title: z.string().trim().max(200).optional(),
    contact_email: z.email().max(320).optional(),
    whatsapp: z.string().trim().max(100).optional(),
    intro_en: z.string().trim().max(10_000).optional(),
  }).strict(),
  product: z.object({
    name_cn: z.string().trim().max(300).optional(),
    name_en: z.string().trim().min(1).max(300),
    hs_code: z.string().trim().max(50).optional(),
    condition: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    brands: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
    models_or_specs: z.array(z.string().trim().min(1).max(500)).min(1).max(200),
    year_range: z.string().trim().max(300).optional(),
    tonnage_range: z.string().trim().max(10_000).optional(),
    inventory_count: z.string().trim().max(1_000).optional(),
    price_range: z.string().trim().max(1_000).optional(),
    selling_points: z.array(z.string().trim().min(1).max(1_000)).max(200).optional(),
    materials: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
    technical_options: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
    performance_range: z.string().trim().max(300).optional(),
    moq: z.string().trim().max(300).optional(),
    lead_time: z.string().trim().max(300).optional(),
    payment_terms: z.string().trim().max(1_000).optional(),
    warranty: z.string().trim().max(1_000).optional(),
    after_sales_support: z.string().trim().max(2_000).optional(),
    export_capabilities: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
    inspection_capabilities: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
    public_case_references_allowed: z.literal(false).optional(),
    internal_case_notes: z.array(z.string().trim().min(1).max(2_000)).max(200).optional(),
  }).strict(),
  markets: z.array(z.object({
    country: z.string().trim().max(120).optional(),
    cities: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    local_language: z.string().trim().max(120).optional(),
    priority: z.string().trim().max(80).optional(),
  }).strict()).max(200).optional(),
  buyer_types: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  competitors_or_reference_brands: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  negative_keywords: z.array(z.string().trim().min(1).max(300)).max(500).optional(),
  compliance: z.object({
    use_public_data_only: z.literal(true),
    require_source_url_for_company_facts: z.literal(true),
    require_human_approval_before_send: z.literal(true),
    public_case_references_allowed: z.literal(false),
    external_outreach_must_not_cite_private_cases: z.literal(true),
    forbidden_markets: z.array(z.string().trim().min(1).max(120)).max(200),
  }).strict().optional(),
  output: z.object({
    daily_candidate_target: z.number().int().min(1).max(100_000),
    high_score_target: z.number().int().min(0).max(100_000),
    write_to_feishu: z.boolean(),
    send_email: z.literal(false),
    generate_email_drafts: z.boolean(),
    generate_whatsapp_openers: z.boolean(),
    owner: z.string().trim().min(1).max(200),
  }).strict().optional(),
}).strict();

const CasePatternSchema = z.object({
  market: z.string().max(120),
  industries: z.array(z.string().max(300)),
  products: z.array(z.string().max(300)),
  applications: z.array(z.string().max(500)),
  pains: z.array(z.string().max(500)),
  buyerSignals: z.array(z.string().max(500)),
}).strict();

const SeedLeadSchema = z.object({
  company: z.string().trim().min(1).max(300),
  country: z.string().max(120),
  city: z.string().max(120),
  buyerType: z.string().max(300),
  website: z.string().url(),
  productMatch: z.string().max(500),
  sourceUrls: z.array(z.string().url()).min(1).max(100),
  notes: z.string().max(2_000),
}).strict();

export const BusinessContextSchema = z.object({
  brief: SellerBriefSchema,
  casePatterns: z.array(CasePatternSchema).max(10_000),
  seedLeads: z.array(SeedLeadSchema).max(100_000),
}).strict();

function readYaml<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return YAML.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function field(row: Record<string, unknown>, name: string): string {
  return String(row[name] ?? "").trim();
}

function readSeedLeads(filePath: string): SeedLead[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    }) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const company = field(row, "Company Name");
      const website = field(row, "Website");
      if (!company || !website) return [];
      const sourceUrls = field(row, "Source URLs")
        .split(/[|;,\s]+/)
        .map((value) => value.trim())
        .filter((value) => /^https?:\/\//i.test(value));
      return [{
        company,
        country: field(row, "Country"),
        city: field(row, "City"),
        buyerType: field(row, "Buyer Type"),
        website,
        productMatch: field(row, "Product Match"),
        sourceUrls: sourceUrls.length > 0 ? sourceUrls : [website],
        notes: field(row, "Notes"),
      }];
    });
  } catch {
    return [];
  }
}

export function loadBusinessContext(config: AgentConfig): BusinessContext {
  const brief = readYaml<SellerBrief>(path.join(config.businessDataDir, "input_brief.yaml"), {});
  const casePatterns = readJson<CasePattern[]>(
    path.join(config.businessDataDir, "case_patterns.json"),
    [],
  );
  const seedLeads = readSeedLeads(path.join(config.businessDataDir, "leads.csv"));
  return { brief, casePatterns, seedLeads };
}

export function loadBusinessContextStrict(config: AgentConfig): BusinessContext {
  const briefPath = path.join(config.businessDataDir, "input_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    throw new Error(`BUSINESS_CONTEXT_NOT_READY: missing ${briefPath}`);
  }
  let brief: unknown;
  try {
    brief = YAML.parse(fs.readFileSync(briefPath, "utf8")) as unknown;
  } catch {
    throw new Error("BUSINESS_CONTEXT_INVALID_YAML: input_brief.yaml could not be parsed");
  }
  const patternsPath = path.join(config.businessDataDir, "case_patterns.json");
  let casePatterns: unknown = [];
  if (fs.existsSync(patternsPath)) {
    try {
      casePatterns = JSON.parse(fs.readFileSync(patternsPath, "utf8")) as unknown;
    } catch {
      throw new Error("BUSINESS_CONTEXT_INVALID_JSON: case_patterns.json could not be parsed");
    }
  }
  const seedLeads = readSeedLeads(path.join(config.businessDataDir, "leads.csv"));
  const parsed = BusinessContextSchema.safeParse({ brief, casePatterns, seedLeads });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$root"}:${issue.message}`)
      .join("; ");
    throw new Error(`BUSINESS_CONTEXT_NOT_READY: ${issues}`);
  }
  return parsed.data;
}
