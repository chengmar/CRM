import { getDomain } from "tldts";
import {
  DEMAND_POLICY_VERSION,
  type SearchResult,
  type WebsiteAssessment,
} from "../types.js";

export const demandStages = [
  "INDUSTRY_FIT",
  "LATENT_NEED",
  "CURRENT_PROJECT",
  "RECENT_PROCUREMENT",
  "SUPPLIER_REPLACEMENT",
] as const;

export type DemandStage = (typeof demandStages)[number];
export type DemandSourceKind = "SEARCH_SNIPPET" | "OFFICIAL_PAGE";

export interface DemandEvidence {
  id: string;
  stage: DemandStage;
  sourceUrl: string;
  publisherDomain: string;
  sourceDate: string | null;
  quote: string;
  score: number;
  sourceKind: DemandSourceKind;
  reviewEligible: boolean;
}

export interface DemandAssessment {
  policyVersion: string;
  stage: DemandStage;
  score: number;
  buyingLikelihood: "HIGH" | "MEDIUM" | "LOW";
  demandEvidenceQualified: boolean;
  evidence: DemandEvidence[];
  reasons: string[];
}

interface EvidenceDocument {
  url: string;
  text: string;
  sourceDate: string | null;
  sourceKind: DemandSourceKind;
}

const procurementPattern = /\b(?:rfq|request for quotation|request for proposal|invitation to bid|invitation for bids?|call for tender|tender notice|procurement notice|purchase requirement|seeking (?:a |an |qualified )?(?:supplier|vendor))\b/i;
const replacementPattern = /\b(?:replace (?:the |our )?(?:existing )?(?:supplier|vendor|equipment)|alternative supplier|new supplier required|second source|dual sourc(?:e|ing)|supplier change|vendor change|replacement supplier)\b/i;
const currentProjectPattern = /\b(?:project (?:is )?(?:underway|ongoing|announced|commenced)|new (?:plant|factory|production line)|plant expansion|capacity expansion|facility upgrade|installation project|commissioning project|compliance project)\b/i;
const latentPattern = /\b(?:need|requirement|require|project|expansion|upgrade|procurement|sourcing)\b/i;
const historicalPattern = /\b(?:case study|portfolio|reference project|completed in|successfully delivered|was completed|was commissioned)\b/i;
const tradeShowPattern = /\b(?:exhibitor|exhibition|expo|trade show|trade fair|booth|stand no\.?|conference speaker)\b/i;
const providerSidePattern = /\b(?:contract (?:was )?awarded to|project (?:was )?awarded to|selected as (?:the )?(?:supplier|vendor|contractor)|won (?:the )?(?:contract|tender)|we (?:manufacture|supplied|supply|delivered|installed|commissioned)|will supply|for supply to|to (?:its|our|the) (?:client|customer)|our (?:client|customer)|supplier of|manufacturer of|we are (?:a |an )?(?:supplier|manufacturer|contractor))\b/i;
const providerAdvisoryPattern = /\b(?:(?:we|the company|[\p{L}\p{N}]+ engineering) (?:help|helps|support|supports|assist|assists|advise|advises|enable|enables|provide|provides|offer|offers)\b.{0,120}\b(?:customers?|clients?|buyers?)\b|(?:our )?(?:engineering|consulting|advisory) services?\b|provides? (?:engineering )?consulting\b)\b/iu;
const inactiveDemandPattern = /\b(?:cancelled|canceled|withdrawn|closed for submissions?|no longer (?:open|accepting)|expired|deadline (?:has )?passed|procurement (?:was )?completed|tender (?:was )?awarded)\b/i;
const hiringPattern = /\b(?:job opening|job vacancy|vacancy|career opportunity|we are hiring|apply now|position available|procurement (?:manager|officer|specialist|engineer) (?:job|role|position))\b/i;
const sellerCtaPattern = /\b(?:contact (?:our )?sales(?: team)?|talk to (?:our )?sales|sales (?:inquiry|enquiry)|get (?:a |your )?quote|request (?:a |your )?quote|add to cart|buy now)\b/i;
const ambiguousRequestPattern = /\b(?:rfq|request for quotation|request for proposal)\b/i;
const buyerProcurementContextPattern = /\b(?:invites? (?:bids?|quotations?|proposals?|suppliers?|vendors?)|issued? (?:an? )?(?:rfq|rfp|tender)|procurement|purchasing|sourcing|tender|bid(?:der|ding)?|submit (?:a |the |your )?(?:bid|quotation|proposal|tender response|offer)|submission (?:deadline|due date|closing date|instructions?)|deadline|closing date|qualified (?:supplier|vendor)|seeking (?:a |an )?(?:supplier|vendor))\b/i;
const editorialPattern = /\b(?:guide|checklist|how[- ]to|what (?:buyers?|you) should|what to (?:consider|compare)|definitions?|selection criteria|buyer's guide|tips|best practices|explained|overview|frequently asked questions?|faq)\b/i;
const formalProcurementActionPattern = /\b(?:tender notice|procurement notice|invites? (?:bids?|quotations?|proposals?|suppliers?|vendors?)|issued? (?:an? )?(?:rfq|rfp|tender)|submission (?:deadline|due date|closing date|instructions?)|closing date|seeking (?:a |an |qualified )?(?:supplier|vendor))\b/i;
const untrustedPublisherPattern = /(?:linkedin|facebook|instagram|youtube|yellowpages|kompass|europages|cylex)\./i;
const genericProductWords = new Set([
  "and",
  "for",
  "industrial",
  "equipment",
  "machine",
  "product",
  "solution",
  "system",
  "with",
]);

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function productTokenGroups(productTerms: string[]): string[][] {
  return productTerms.map((term) => [...new Set(
    term
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3 && !genericProductWords.has(token)),
  )]).filter((tokens) => tokens.length > 0);
}

function textTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function mentionsProduct(text: string, terms: string[], tokenGroups: string[][]): boolean {
  const lower = text.toLowerCase();
  if (terms.some((term) => {
    const normalized = normalizeText(term).toLowerCase();
    return normalized.length >= 4 && lower.includes(normalized);
  })) return true;
  const tokens = textTokens(lower);
  return tokenGroups.some((group) => {
    const matches = group.filter((token) => tokens.has(token)).length;
    return matches >= (group.length <= 2 ? group.length : Math.ceil(group.length * 0.67));
  });
}

const monthNumbers: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function strictDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

function parseDate(value: string | null | undefined): Date | null {
  const raw = value?.trim();
  if (!raw) return null;
  const iso = raw.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return strictDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const monthFirst = raw.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (monthFirst) {
    return strictDate(Number(monthFirst[3]), monthNumbers[monthFirst[1]!.toLowerCase()] ?? 0, Number(monthFirst[2]));
  }
  const dayFirst = raw.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (dayFirst) {
    return strictDate(Number(dayFirst[3]), monthNumbers[dayFirst[2]!.toLowerCase()] ?? 0, Number(dayFirst[1]));
  }
  return null;
}

function dateNearSignal(text: string, signalIndex: number): { date: Date | null; found: boolean } {
  const windowStart = Math.max(0, signalIndex - 180);
  const nearby = text.slice(windowStart, signalIndex + 360);
  const localSignalIndex = signalIndex - windowStart;
  const candidates = [
    ...nearby.matchAll(/\b20\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:[0-2]?\d|3[01])\b/g),
    ...nearby.matchAll(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/gi),
    ...nearby.matchAll(/\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/gi),
  ];
  const relevant = candidates.filter((match) => {
    const index = match.index ?? 0;
    const context = nearby.slice(Math.max(0, index - 40), index + match[0].length + 40);
    return !/\b(?:copyright|page (?:last )?updated|last updated|board meeting|next meeting)\b/i.test(context);
  });
  const parsed = relevant
    .flatMap((match) => {
      const date = parseDate(match[0]);
      return date && match.index !== undefined
        ? [{ date, distance: Math.abs(match.index + match[0].length / 2 - localSignalIndex) }]
        : [];
    })
    .sort((left, right) => left.distance - right.distance)[0]?.date ?? null;
  return { date: parsed, found: relevant.length > 0 };
}

function deadlineNearSignal(text: string, signalIndex: number): { date: Date | null; found: boolean } {
  const windowStart = Math.max(0, signalIndex - 120);
  const nearby = text.slice(windowStart, signalIndex + 480);
  const localSignalIndex = signalIndex - windowStart;
  const marker = /\b(?:submission deadline|closing date|bid deadline|tender deadline|deadline|submissions? (?:close|due)|submit (?:the )?(?:bid|proposal|quotation) by)\b/ig;
  const candidates: Array<{ date: Date | null; distance: number }> = [];
  for (const match of nearby.matchAll(marker)) {
    if (match.index === undefined) continue;
    const segment = nearby.slice(match.index, match.index + 150);
    const candidate = dateNearSignal(segment, 0);
    if (candidate.found) {
      candidates.push({
        date: candidate.date,
        distance: Math.abs(match.index - localSignalIndex),
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return { date: candidates[0]?.date ?? null, found: candidates.length > 0 };
}

function recentDate(
  date: Date | null,
  now: Date,
  maxAgeDays: number,
  maxFutureDays = 0,
): string | null {
  if (!date) return null;
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays < -maxFutureDays || ageDays > maxAgeDays) return null;
  return date.toISOString();
}

function quoteAround(text: string, index: number, matchLength: number): string {
  return normalizeText(text.slice(Math.max(0, index - 140), index + matchLength + 220)).slice(0, 420);
}

function actionSentence(text: string, index: number, matchLength: number): string {
  const before = text.slice(Math.max(0, index - 220), index);
  const boundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
  const start = Math.max(0, index - 220) + boundary + 1;
  const after = text.slice(index + matchLength, index + matchLength + 260);
  const endBoundary = after.search(/[.!?]/);
  const end = endBoundary >= 0 ? index + matchLength + endBoundary + 1 : index + matchLength + 260;
  return normalizeText(text.slice(start, end));
}

function candidateIsActionSubject(sentence: string, companyName: string, trigger: string): boolean {
  const triggerIndex = sentence.toLowerCase().indexOf(trigger.toLowerCase());
  const subjectText = triggerIndex >= 0 ? sentence.slice(Math.max(0, triggerIndex - 160), triggerIndex) : "";
  if (/\b(?:we|our|the company)\b/i.test(subjectText)) return true;
  const tokens = textTokens(subjectText);
  const required = companyTokens(companyName);
  return required.length > 0 && required.every((token) => tokens.has(token));
}

function publisherDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function normalizedDomain(value: string): string {
  try {
    const hostname = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname;
    return (getDomain(hostname, { allowPrivateDomains: true }) ?? hostname.replace(/^www\./, "")).toLowerCase();
  } catch {
    return (getDomain(value, { allowPrivateDomains: true }) ?? value.replace(/^www\./, "")).toLowerCase();
  }
}

const companyLegalSuffixes = new Set([
  "berhad", "bhd", "company", "corp", "corporation", "inc", "limited", "ltd", "private", "pte", "sdn",
]);

function companyTokens(companyName: string): string[] {
  return [...textTokens(companyName)].filter((token) => token.length >= 3 && !companyLegalSuffixes.has(token));
}

function connectedToCandidate(
  text: string,
  sourceUrl: string,
  companyName: string,
  companyDomain: string,
): boolean {
  const publisher = publisherDomain(sourceUrl).toLowerCase();
  const normalizedCompanyDomain = normalizedDomain(companyDomain);
  if (publisher === normalizedCompanyDomain) return true;
  if (untrustedPublisherPattern.test(publisher)) return false;
  const tokens = textTokens(text);
  const required = companyTokens(companyName);
  return required.length > 0 && required.every((token) => tokens.has(token));
}

function documents(
  results: SearchResult[],
  pages: WebsiteAssessment["pages"],
): EvidenceDocument[] {
  const sourceDatesByUrl = new Map(
    results
      .filter((result) => result.sourceDate)
      .map((result) => [result.url, result.sourceDate ?? null]),
  );
  const searchDocuments = results.map((result) => ({
    url: result.url,
    text: normalizeText(`${result.title} ${result.snippet}`),
    sourceDate: result.sourceDate ?? null,
    sourceKind: "SEARCH_SNIPPET" as const,
  }));
  const pageDocuments = pages.map((page) => ({
    url: page.url,
    text: normalizeText(`${page.title} ${page.text}`).slice(0, 30_000),
    sourceDate: sourceDatesByUrl.get(page.url) ?? null,
    sourceKind: "OFFICIAL_PAGE" as const,
  }));
  return [...searchDocuments, ...pageDocuments]
    .filter((document) => document.url && document.text)
    .filter((document, index, all) => all.findIndex(
      (candidate) => candidate.url === document.url && candidate.text === document.text &&
        candidate.sourceKind === document.sourceKind,
    ) === index);
}

function directEvidence(
  document: EvidenceDocument,
  stage: DemandStage,
  pattern: RegExp,
  score: number,
  productTerms: string[],
  tokenGroups: string[][],
  companyName: string,
  companyDomain: string,
  now: Date,
  maxAgeDays: number,
): Omit<DemandEvidence, "id"> | null {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of document.text.matchAll(matcher)) {
    if (match.index === undefined) continue;
    const quote = quoteAround(document.text, match.index, match[0].length);
    const sentence = actionSentence(document.text, match.index, match[0].length);
    if (!mentionsProduct(quote, productTerms, tokenGroups)) continue;
    if (!connectedToCandidate(quote, document.url, companyName, companyDomain)) continue;
    if (
      tradeShowPattern.test(quote) ||
      historicalPattern.test(quote) ||
      providerSidePattern.test(quote) ||
      providerAdvisoryPattern.test(quote) ||
      inactiveDemandPattern.test(quote) ||
      hiringPattern.test(quote) ||
      sellerCtaPattern.test(quote) ||
      editorialPattern.test(quote) ||
      sentence.includes("?")
    ) continue;
    if (
      stage === "RECENT_PROCUREMENT" &&
      ambiguousRequestPattern.test(match[0]) &&
      !buyerProcurementContextPattern.test(quote)
    ) continue;
    const candidateSubject = candidateIsActionSubject(sentence, companyName, match[0]);
    if (stage === "RECENT_PROCUREMENT") {
      if (!candidateSubject && !formalProcurementActionPattern.test(sentence)) continue;
    } else if (!candidateSubject) {
      continue;
    }
    const nearbyDate = dateNearSignal(document.text, match.index);
    if (nearbyDate.found && !nearbyDate.date) continue;
    const publicationDate = parseDate(document.sourceDate);
    if (publicationDate && publicationDate.getTime() > now.getTime() + 86_400_000) continue;

    let maxFutureDays = 0;
    if (stage === "RECENT_PROCUREMENT") {
      const deadline = deadlineNearSignal(document.text, match.index);
      if (deadline.found && !deadline.date) continue;
      if (deadline.date) {
        const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        if (deadline.date.getTime() < today) continue;
        maxFutureDays = 365;
      }
    }

    const date = recentDate(
      nearbyDate.found ? nearbyDate.date : publicationDate,
      now,
      maxAgeDays,
      maxFutureDays,
    );
    if (!date) continue;
    const publisher = publisherDomain(document.url);
    const reviewEligible = document.sourceKind === "OFFICIAL_PAGE" &&
      publisher.toLowerCase() === normalizedDomain(companyDomain);
    return {
      stage,
      sourceUrl: document.url,
      publisherDomain: publisher,
      sourceDate: date,
      quote,
      score: document.sourceKind === "SEARCH_SNIPPET" ? Math.min(12, score) : score,
      sourceKind: document.sourceKind,
      reviewEligible,
    };
  }
  return null;
}

export function assessDemandEvidence(input: {
  results: SearchResult[];
  pages?: WebsiteAssessment["pages"];
  productTerms: string[];
  companyName: string;
  companyDomain: string;
  now?: Date;
  maxAgeDays?: number;
}): DemandAssessment {
  const now = input.now ?? new Date();
  const requestedMaxAgeDays = input.maxAgeDays === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, input.maxAgeDays);
  const terms = input.productTerms.map(normalizeText).filter(Boolean);
  const tokenGroups = productTokenGroups(terms);
  const allDocuments = documents(input.results, input.pages ?? []);
  const direct: Array<Omit<DemandEvidence, "id">> = [];

  for (const document of allDocuments) {
    const evidence =
      directEvidence(document, "RECENT_PROCUREMENT", procurementPattern, 25, terms, tokenGroups, input.companyName, input.companyDomain, now, Math.min(180, requestedMaxAgeDays)) ??
      directEvidence(document, "SUPPLIER_REPLACEMENT", replacementPattern, 22, terms, tokenGroups, input.companyName, input.companyDomain, now, Math.min(180, requestedMaxAgeDays)) ??
      directEvidence(document, "CURRENT_PROJECT", currentProjectPattern, 18, terms, tokenGroups, input.companyName, input.companyDomain, now, Math.min(365, requestedMaxAgeDays));
    if (evidence) direct.push(evidence);
  }

  const deduplicated = direct.filter((item, index, all) => all.findIndex(
    (candidate) => candidate.stage === item.stage && candidate.sourceUrl === item.sourceUrl &&
      candidate.quote === item.quote && candidate.sourceKind === item.sourceKind,
  ) === index);
  deduplicated.sort((left, right) =>
    Number(right.reviewEligible) - Number(left.reviewEligible) ||
    right.score - left.score ||
    left.sourceUrl.localeCompare(right.sourceUrl));

  if (deduplicated.length > 0) {
    const score = deduplicated[0]!.score;
    const evidence = deduplicated.slice(0, 8).map((item, index) => ({ ...item, id: `demand_${index + 1}` }));
    const stage = evidence[0]!.stage;
    const demandEvidenceQualified = evidence.some((item) => item.reviewEligible && item.score >= 18);
    return {
      policyVersion: DEMAND_POLICY_VERSION,
      stage,
      score,
      buyingLikelihood: demandEvidenceQualified && score >= 20 ? "HIGH" : "MEDIUM",
      demandEvidenceQualified,
      evidence,
      reasons: evidence.map((item) => `${item.stage}/${item.sourceKind}: ${item.quote}`),
    };
  }

  const productDocument = allDocuments.find((document) =>
    mentionsProduct(document.text, terms, tokenGroups) &&
    connectedToCandidate(document.text, document.url, input.companyName, input.companyDomain));
  if (!productDocument) {
    return {
      policyVersion: DEMAND_POLICY_VERSION,
      stage: "INDUSTRY_FIT",
      score: 0,
      buyingLikelihood: "LOW",
      demandEvidenceQualified: false,
      evidence: [],
      reasons: ["no direct, dated public demand evidence"],
    };
  }
  const latent = latentPattern.exec(productDocument.text);
  const stage: DemandStage = latent ? "LATENT_NEED" : "INDUSTRY_FIT";
  const quote = quoteAround(
    productDocument.text,
    latent?.index ?? 0,
    latent?.[0]?.length ?? Math.min(productDocument.text.length, 80),
  );
  return {
    policyVersion: DEMAND_POLICY_VERSION,
    stage,
    score: latent ? 4 : 0,
    buyingLikelihood: "LOW",
    demandEvidenceQualified: false,
    evidence: [{
      id: "demand_1",
      stage,
      sourceUrl: productDocument.url,
      publisherDomain: publisherDomain(productDocument.url),
      sourceDate: null,
      quote,
      score: latent ? 4 : 0,
      sourceKind: productDocument.sourceKind,
      reviewEligible: false,
    }],
    reasons: [latent
      ? "only latent or undated need evidence was found"
      : "industry fit is not evidence of an active purchase"],
  };
}
