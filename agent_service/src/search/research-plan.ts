import type { BusinessContext, CasePattern } from "../business-context.js";
import type { AgentConfig } from "../config.js";
import type { AgentLlm } from "../llm.js";
import { logger } from "../logger.js";
import type { HermesResearchClient } from "./hermes-research.js";

export interface ResearchCampaignInput {
  market: string;
  product: string;
  buyerType: string;
  targetCount: number;
}

export interface ResearchSegment {
  industry: string;
  matchedProducts: string[];
  buyerTypes: string[];
  demandSignals: string[];
  pains: string[];
}

export interface MarketResearchPlan {
  market: string;
  marketSummary: string;
  languages: string[];
  cities: string[];
  productTerms: string[];
  buyerTerms: string[];
  negativeTerms: string[];
  segments: ResearchSegment[];
  queries: string[];
  source: "hermes" | "llm" | "fallback";
}

export interface CallBudget {
  tryTake(): boolean;
}

const marketAliases: Record<string, string> = {
  马来西亚: "Malaysia",
  越南: "Vietnam",
  菲律宾: "Philippines",
  印度尼西亚: "Indonesia",
  印尼: "Indonesia",
  墨西哥: "Mexico",
};

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function englishMarket(raw: string): string {
  return marketAliases[raw.trim()] ?? raw.trim();
}

function relevantPatterns(patterns: CasePattern[], market: string): CasePattern[] {
  const normalized = englishMarket(market).toLowerCase();
  return patterns.filter((pattern) => {
    const value = pattern.market.toLowerCase();
    return value === "global" || value === normalized;
  });
}

function asciiTerm(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value);
}

function fallbackPlan(
  campaign: ResearchCampaignInput,
  context: BusinessContext,
): MarketResearchPlan {
  const market = englishMarket(campaign.market);
  const marketBrief = (context.brief.markets ?? []).find(
    (item) => englishMarket(item.country ?? "").toLowerCase() === market.toLowerCase(),
  );
  const patterns = relevantPatterns(context.casePatterns, market);
  const productTerms = unique([
    ...(context.brief.product?.models_or_specs ?? []),
    ...(patterns.flatMap((pattern) => pattern.products)),
    context.brief.product?.name_en,
    ...(asciiTerm(campaign.product) ? [campaign.product] : []),
  ]).slice(0, 18);
  const buyerTerms = unique([
    ...(context.brief.buyer_types ?? []),
    ...(patterns.flatMap((pattern) => pattern.industries)),
    ...(asciiTerm(campaign.buyerType) ? [campaign.buyerType] : []),
    "system integrator",
    "project contractor",
    "engineering company",
    "product distributor",
  ]).slice(0, 20);
  const negativeTerms = unique([
    ...(context.brief.negative_keywords ?? []),
    "jobs",
    "career",
    "household",
    "residential",
  ]);
  const segments: ResearchSegment[] = patterns.map((pattern) => ({
    industry: pattern.industries.slice(0, 3).join(" / "),
    matchedProducts: pattern.products.slice(0, 5),
    buyerTypes: buyerTerms.slice(0, 5),
    demandSignals: pattern.buyerSignals.slice(0, 6),
    pains: pattern.pains.slice(0, 6),
  }));
  const coreProducts = productTerms.slice(0, 8);
  const coreBuyers = buyerTerms.slice(0, 6);
  const queries: string[] = [];
  for (const product of coreProducts.slice(0, 4)) {
    queries.push(`"${product}" ${market} supplier distributor integrator`);
    queries.push(`"${product}" ${market} project installation contractor`);
  }
  for (const [index, buyer] of coreBuyers.slice(0, 4).entries()) {
    const product = coreProducts[index % Math.max(1, coreProducts.length)] ?? campaign.product;
    queries.push(`"${product}" ${market} "${buyer}"`);
  }
  for (const industry of patterns.flatMap((pattern) => pattern.industries).slice(0, 5)) {
    const product = coreProducts[0] ?? campaign.product;
    queries.push(`"${industry}" "${product}" ${market}`);
  }
  for (const product of coreProducts.slice(0, 3)) {
    queries.push(`"${product}" exhibitor ${market}`);
    queries.push(`"${product}" tender project ${market}`);
    queries.push(`"${product}" replacement supplier ${market}`);
  }
  return {
    market,
    marketSummary: `Research ${market} for buyers with public evidence related to the approved product terms and campaign criteria.`,
    languages: unique(["English", marketBrief?.local_language]),
    cities: marketBrief?.cities ?? [],
    productTerms,
    buyerTerms,
    negativeTerms,
    segments,
    queries: unique(queries).slice(0, 32),
    source: "fallback",
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const query = record.query ?? record.value ?? record.term;
    return typeof query === "string" ? [query] : [];
  }));
}

export function normalizeResearchPlan(
  raw: unknown,
  fallback: MarketResearchPlan,
  source: MarketResearchPlan["source"],
): MarketResearchPlan {
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const rawSegments = Array.isArray(record.segments) ? record.segments : [];
  const segments = rawSegments.flatMap((item): ResearchSegment[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const industry = String(value.industry ?? "").trim();
    if (!industry) return [];
    return [{
      industry,
      matchedProducts: stringArray(value.matchedProducts ?? value.matched_products),
      buyerTypes: stringArray(value.buyerTypes ?? value.buyer_types),
      demandSignals: stringArray(value.demandSignals ?? value.demand_signals),
      pains: stringArray(value.pains),
    }];
  });
  const queries = stringArray(record.queries).filter((query) => query.length >= 5 && query.length <= 500);
  return {
    market: String(record.market ?? fallback.market).trim() || fallback.market,
    marketSummary: String(record.marketSummary ?? record.market_summary ?? fallback.marketSummary).trim(),
    languages: unique([...fallback.languages, ...stringArray(record.languages)]),
    cities: unique([...fallback.cities, ...stringArray(record.cities)]),
    productTerms: unique([
      ...fallback.productTerms,
      ...stringArray(record.productTerms ?? record.product_terms),
    ]).slice(0, 24),
    buyerTerms: unique([
      ...fallback.buyerTerms,
      ...stringArray(record.buyerTerms ?? record.buyer_terms),
    ]).slice(0, 24),
    negativeTerms: unique([
      ...fallback.negativeTerms,
      ...stringArray(record.negativeTerms ?? record.negative_terms),
    ]).slice(0, 20),
    segments: segments.length > 0 ? segments.slice(0, 12) : fallback.segments,
    // Deterministic product-first queries are proven fallbacks and must not be
    // displaced by verbose model-generated queries when an upstream engine
    // gives disproportionate weight to the first terms.
    queries: unique([...fallback.queries, ...queries]).slice(0, 40),
    source,
  };
}

function planningPrompt(
  campaign: ResearchCampaignInput,
  context: BusinessContext,
  fallback: MarketResearchPlan,
): string {
  return [
    "You are the market-research captain for a B2B export sales team.",
    "Use the b2b-search-keywords and competitor-intel-pro methods.",
    "Do not send messages, log into social accounts, or invent demand facts.",
    "Build an evidence-oriented market plan and a multilingual search matrix.",
    "Queries MUST be plain strings, never objects. Split compound products into concrete product terms.",
    "Return JSON only with market, marketSummary, languages, cities, productTerms, buyerTerms, negativeTerms, segments and queries.",
    "Each segment must contain industry, matchedProducts, buyerTypes, demandSignals and pains.",
    JSON.stringify({ campaign, seller: context.brief, internal_case_patterns: context.casePatterns, fallback }),
  ].join("\n");
}

export async function buildMarketResearchPlan(input: {
  campaign: ResearchCampaignInput;
  context: BusinessContext;
  config: AgentConfig;
  llm: AgentLlm;
  hermes: HermesResearchClient;
  budget: CallBudget;
}): Promise<{ plan: MarketResearchPlan; hermesCalls: number }> {
  const fallback = fallbackPlan(input.campaign, input.context);
  const prompt = planningPrompt(input.campaign, input.context, fallback);
  if (input.hermes.isEnabled()) {
    try {
      const raw = await input.hermes.json<unknown>(
        ["b2b-search-keywords", "competitor-intel-pro", "export-customer-research"],
        prompt,
      );
      return { plan: normalizeResearchPlan(raw, fallback, "hermes"), hermesCalls: 1 };
    } catch (error) {
      logger.error({ error }, "Hermes market research failed; direct model fallback engaged");
      // The direct model path keeps discovery available when Hermes is temporarily unavailable.
    }
  }
  if (input.llm.isConfigured() && input.budget.tryTake()) {
    try {
      const raw = await input.llm.json<unknown>(
        "market_research_plan",
        "Create a rigorous B2B market plan. Return JSON only and keep every query as a plain string.",
        prompt,
        input.config.OPENAI_RESEARCH_MODEL || input.config.OPENAI_MODEL,
      );
      return { plan: normalizeResearchPlan(raw, fallback, "llm"), hermesCalls: 0 };
    } catch {
      // Fall back to the deterministic product and case matrix.
    }
  }
  return { plan: fallback, hermesCalls: 0 };
}

export function buildDefaultResearchQueries(
  campaign: ResearchCampaignInput,
  context: BusinessContext = { brief: {}, casePatterns: [], seedLeads: [] },
): string[] {
  return fallbackPlan(campaign, context).queries;
}
