import { promises as dns } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { getDomain } from "tldts";
import { Agent } from "undici";
import type { CrawlResolutionEvidence, CrawlRobotsDecision } from "../acquisition/crawl-contracts.js";
import { validateCrawlTarget } from "../acquisition/crawl-router.js";
import type {
  PublicEmailExtractionMethod,
  WebsiteAssessment,
  WebsiteEvidenceScope,
} from "../types.js";

const defaultUserAgent = "Export-Research-Agent/1.0";
const createRobotsParser = robotsParser as unknown as (
  url: string,
  contents: string,
) => { isAllowed(url: string, userAgent?: string): boolean | undefined };
export interface WebsiteResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type WebsiteAddressResolver = (hostname: string) => Promise<WebsiteResolvedAddress[]>;

const unsafeIpv4BlockList = new BlockList();
const unsafeIpv6BlockList = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unsafeIpv4BlockList.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  unsafeIpv6BlockList.addSubnet(network, prefix, "ipv6");
}

const defaultAddressResolver: WebsiteAddressResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((item): WebsiteResolvedAddress[] =>
    item.family === 4 || item.family === 6
      ? [{ address: item.address, family: item.family }]
      : []);
};
const parkedMarkers = [
  "domain is for sale",
  "buy this domain",
  "sedo domain parking",
  "this domain has expired",
  "coming soon",
  "website suspended",
];

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return `https://${value}`;
  return value;
}

export class WebsiteFetchPolicyError extends Error {}

function registrableDomain(url: URL): string {
  return (getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname).toLowerCase();
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  if (isIP(normalized) !== family) return false;
  return family === 4
    ? !unsafeIpv4BlockList.check(normalized, "ipv4")
    : !unsafeIpv6BlockList.check(normalized, "ipv6");
}

async function resolvePublicAddresses(
  url: URL,
  resolver: WebsiteAddressResolver,
): Promise<WebsiteResolvedAddress[]> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  let resolved: WebsiteResolvedAddress[];
  try {
    resolved = literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await resolver(hostname);
  } catch {
    throw new WebsiteFetchPolicyError("target address resolution failed");
  }

  const uniqueAddresses = [...new Map(resolved.map((item) => [
    `${item.family}:${item.address.toLowerCase()}`,
    item,
  ])).values()];
  if (uniqueAddresses.length === 0 ||
    uniqueAddresses.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new WebsiteFetchPolicyError("unsafe target address rejected");
  }
  return uniqueAddresses;
}

function pinnedAgent(addresses: WebsiteResolvedAddress[]): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : null;
    const eligible = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      const error = Object.assign(new Error("No validated address for requested family"), { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, eligible.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, eligible[0]!.address, eligible[0]!.family);
  };
  return new Agent({ connect: { lookup } });
}

async function fetchPinned(
  url: URL,
  resolver: WebsiteAddressResolver,
  init: RequestInit,
): Promise<{ response: Response; dispatcher: Agent }> {
  const addresses = await resolvePublicAddresses(url, resolver);
  const dispatcher = pinnedAgent(addresses);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    return { response, dispatcher };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

async function releasePinnedResponse(response: Response, dispatcher: Agent): Promise<void> {
  try {
    if (response.body && !response.bodyUsed) await response.body.cancel();
  } finally {
    await dispatcher.close();
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let text = "";
  let finished = false;
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        text += decoder.decode();
        return text;
      }
      if (!chunk.value || chunk.value.byteLength === 0) continue;

      const accepted = chunk.value.byteLength <= remaining
        ? chunk.value
        : chunk.value.subarray(0, remaining);
      text += decoder.decode(accepted, { stream: true });
      remaining -= accepted.byteLength;
    }

    await reader.cancel("response body byte limit reached");
    finished = true;
    return text + decoder.decode();
  } finally {
    if (!finished) {
      try {
        await reader.cancel("response body read aborted");
      } catch {
        // Preserve the original read failure.
      }
    }
    reader.releaseLock();
  }
}

async function getText(
  url: string,
  userAgent: string,
  expectedDomain: string,
  resolver: WebsiteAddressResolver,
  timeoutMs = 15_000,
  parentSignal?: AbortSignal,
): Promise<{ url: string; html: string }> {
  let currentUrl = new URL(url);
  const visited = new Set<string>([currentUrl.toString()]);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const { response, dispatcher } = await fetchPinned(currentUrl, resolver, {
      signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    try {
      if (redirectStatuses.has(response.status)) {
        if (redirectCount >= 5) throw new Error("Too many redirects");
        const location = response.headers.get("location");
        if (!location) throw new Error(`HTTP ${response.status} redirect missing Location`);
        const nextUrl = new URL(location, currentUrl);
        if (!["http:", "https:"].includes(nextUrl.protocol)) {
          throw new WebsiteFetchPolicyError("unsupported redirect protocol rejected");
        }
        if (registrableDomain(nextUrl) !== expectedDomain.toLowerCase()) {
          throw new WebsiteFetchPolicyError("cross-domain redirect rejected");
        }
        if (visited.has(nextUrl.toString())) throw new Error("Redirect loop detected");
        if (!(await allowedByRobots(nextUrl, userAgent, expectedDomain, resolver, parentSignal))) {
          throw new WebsiteFetchPolicyError("redirect target robots.txt disallows crawling");
        }
        visited.add(nextUrl.toString());
        currentUrl = nextUrl;
        continue;
      }

      const responseUrl = new URL(response.url || currentUrl.toString());
      if (registrableDomain(responseUrl) !== expectedDomain.toLowerCase()) {
        throw new WebsiteFetchPolicyError("cross-domain redirect rejected");
      }
      if (responseUrl.toString() !== currentUrl.toString()) {
        throw new WebsiteFetchPolicyError("unexpected automatic redirect rejected");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }
      const html = await readBoundedResponseText(response, 1_000_000);
      return { url: responseUrl.toString(), html };
    } finally {
      await releasePinnedResponse(response, dispatcher);
    }
  }
  throw new Error("Too many redirects");
}

async function allowedByRobots(
  url: URL,
  userAgent: string,
  expectedDomain: string,
  resolver: WebsiteAddressResolver,
  parentSignal?: AbortSignal,
): Promise<boolean> {
  const robotsUrl = new URL(`${url.protocol}//${url.host}/robots.txt`);
  let currentUrl = robotsUrl;
  const visited = new Set<string>([currentUrl.toString()]);
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      if (registrableDomain(currentUrl) !== expectedDomain.toLowerCase()) {
        throw new WebsiteFetchPolicyError("cross-domain robots.txt redirect rejected");
      }
      const { response, dispatcher } = await fetchPinned(currentUrl, resolver, {
        signal: parentSignal
          ? AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)])
          : AbortSignal.timeout(8_000),
        headers: { "User-Agent": userAgent },
      });
      try {
        const responseUrl = new URL(response.url || currentUrl.toString());
        if (responseUrl.toString() !== currentUrl.toString()) {
          throw new WebsiteFetchPolicyError("unexpected automatic robots.txt redirect rejected");
        }
        if (redirectStatuses.has(response.status)) {
          if (redirectCount >= 5) {
            throw new WebsiteFetchPolicyError("robots.txt redirect limit exceeded");
          }
          const location = response.headers.get("location");
          if (!location) return false;
          const nextUrl = new URL(location, currentUrl);
          if (!["http:", "https:"].includes(nextUrl.protocol)) {
            throw new WebsiteFetchPolicyError("unsupported robots.txt redirect protocol rejected");
          }
          if (registrableDomain(nextUrl) !== expectedDomain.toLowerCase()) {
            throw new WebsiteFetchPolicyError("cross-domain robots.txt redirect rejected");
          }
          if (visited.has(nextUrl.toString())) return false;
          visited.add(nextUrl.toString());
          currentUrl = nextUrl;
          continue;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return true;
        if (!response.ok) return false;
        const parser = createRobotsParser(
          robotsUrl.toString(),
          await readBoundedResponseText(response, 500_000),
        );
        return parser.isAllowed(url.toString(), userAgent) !== false;
      } finally {
        await releasePinnedResponse(response, dispatcher);
      }
    }
    return false;
  } catch (error) {
    if (error instanceof WebsiteFetchPolicyError) throw error;
    return false;
  }
}

export async function prepareWebsiteCrawlPreflight(
  rawUrl: string,
  userAgent = defaultUserAgent,
  resolver: WebsiteAddressResolver = defaultAddressResolver,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<{
  normalizedUrl: string;
  resolution: CrawlResolutionEvidence;
  robots: CrawlRobotsDecision;
}> {
  const normalizedUrl = normalizeUrl(rawUrl);
  const target = validateCrawlTarget(normalizedUrl);
  if (!target.ok) throw new WebsiteFetchPolicyError(target.reason);
  const addresses = await resolvePublicAddresses(target.url, resolver);
  const checkedAt = now().toISOString();
  const allowed = await allowedByRobots(
    target.url,
    userAgent,
    target.registrableDomain,
    resolver,
    signal,
  );
  return {
    normalizedUrl: target.normalizedUrl,
    resolution: {
      hostname: target.hostname,
      addresses,
      checkedAt,
    },
    robots: {
      status: allowed ? "ALLOWED" : "DISALLOWED",
      checkedUrl: new URL(`${target.url.protocol}//${target.url.host}/robots.txt`).toString(),
      checkedAt,
    },
  };
}

function extractRecentDate(text: string, now = new Date()): string | null {
  const candidates: Date[] = [];
  const isoPattern = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.]([0-2]?\d|3[01])\b/g;
  for (const match of text.matchAll(isoPattern)) {
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - 40), index);
    if (/(?:copyright|©)[^\d]{0,24}$/i.test(prefix)) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    const isStrictCalendarDate = date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
    if (isStrictCalendarDate && date <= now) candidates.push(date);
  }
  candidates.sort((a, b) => b.getTime() - a.getTime());
  return candidates[0]?.toISOString() ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractEmailAddresses(value: string): string[] {
  return [...value.matchAll(
    /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}(?![A-Z0-9.-])/gi,
  )]
    .map((match) => match[0].toLowerCase())
    .filter((email) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email));
}

function extractMailtoEmails(links: string[]): string[] {
  return links.flatMap((href) => {
    if (!href.toLowerCase().startsWith("mailto:")) return [];
    const encodedRecipients = href.slice("mailto:".length).split("?", 1)[0] ?? "";
    let recipients = encodedRecipients;
    try {
      recipients = decodeURIComponent(encodedRecipients);
    } catch {
      // Keep the literal value when a site publishes malformed encoding.
    }
    return recipients.split(/[;,]/).flatMap(extractEmailAddresses);
  });
}

function decodeCloudflareEmail(encoded: string): string | null {
  const value = encoded.trim();
  if (!/^[0-9a-f]+$/i.test(value) || value.length < 4 || value.length % 2 !== 0) return null;
  const key = Number.parseInt(value.slice(0, 2), 16);
  const decoded: number[] = [];
  for (let index = 2; index < value.length; index += 2) {
    decoded.push(Number.parseInt(value.slice(index, index + 2), 16) ^ key);
  }
  const email = String.fromCharCode(...decoded).trim().toLowerCase();
  return extractEmailAddresses(email)[0] ?? null;
}

function compactContext(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 800);
}

function visibleTextFromHtml(html: string, maxLength = 800): string {
  const spaced = html.replace(/<[^>]+>/g, " ");
  return load(`<body>${spaced}</body>`)("body").text().replace(/\s+/g, " ").trim().slice(0, maxLength);
}

const contactRoleSignal = /\b(?:procurement|purchasing|sourcing|supply chain|engineering|engineer|project|technical|operations|business development|managing director|director|owner|founder|general manager|manager|chief|head|lead|president)\b/i;
const contactIdentityNoise = new Set([
  "and", "at", "business", "chain", "chief", "contact", "development", "director",
  "email", "engineer", "engineering", "founder", "general", "head", "lead", "manager",
  "managing", "member", "of", "operations", "owner", "people", "person", "president",
  "procurement", "profile", "project", "purchasing", "sourcing", "staff", "supply",
  "team", "technical", "the",
]);

function contextTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function looksLikeNamedRoleContext(value: string): boolean {
  if (!contactRoleSignal.test(value)) return false;
  const withoutEmails = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const identityTokens = contextTokens(withoutEmails)
    .filter((token) => token.length >= 2 && !contactIdentityNoise.has(token));
  return identityTokens.length >= 2;
}

function hasMultipleNamedRoleContexts(value: string): boolean {
  const levelMatches = [...value.matchAll(
    /\b(?:manager|director|owner|founder|chief|head|lead|president|engineer)\b/gi,
  )];
  return levelMatches.some((match, index) => {
    const next = levelMatches[index + 1];
    if (!next) return false;
    const between = value.slice((match.index ?? 0) + match[0].length, next.index ?? 0);
    const identityTokens = contextTokens(between)
      .filter((token) => token.length >= 2 && !contactIdentityNoise.has(token));
    return identityTokens.length >= 2;
  });
}

function contactRolePriority(value: string): number {
  if (/\b(?:procurement|purchasing|sourcing|supply chain)\b/i.test(value)) return 4;
  if (/\b(?:managing director|owner|founder|general manager|chief|president)\b/i.test(value)) return 3;
  if (/\b(?:engineering|engineer|project|technical|operations)\b/i.test(value)) return 2;
  if (/\bbusiness development\b/i.test(value)) return 1;
  return 0;
}

function normalizedScopeText(value: string): string {
  return contextTokens(value).join(" ");
}

function scopeContainsTokenSequence(container: string, candidate: string): boolean {
  const containerTokens = contextTokens(container);
  const candidateTokens = contextTokens(candidate);
  if (candidateTokens.length === 0 || candidateTokens.length > containerTokens.length) return false;
  return containerTokens.some((_, index) =>
    candidateTokens.every((token, offset) => containerTokens[index + offset] === token));
}

function extractPage(page: { url: string; html: string }): {
  url: string;
  title: string;
  text: string;
  emails: string[];
  emailEvidence: Array<{
    email: string;
    context: string;
    method: PublicEmailExtractionMethod;
    scopeId: string;
  }>;
  contactContexts: string[];
  evidenceScopes: WebsiteEvidenceScope[];
  phones: string[];
  links: string[];
} {
  const $ = load(page.html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const links = $("a[href]")
    .map((_, element) => String($(element).attr("href") ?? ""))
    .get();
  $("script,style,noscript,svg").remove();
  const bodyHtml = $("body").html() ?? "";
  const text = visibleTextFromHtml(bodyHtml, 120_000);
  const scopeSelector = "p,li,tr,article,section,div,td,a[href^='mailto:'],[data-cfemail]";
  const rawScopes: WebsiteEvidenceScope[] = [];

  $(scopeSelector).each((index, element) => {
    const node = $(element);
    const fragmentHtml = node.html() ?? node.text();
    const scopeText = visibleTextFromHtml(fragmentHtml);
    if (scopeText.length < 5 || scopeText.length > 800) return;

    const methods = new Map<string, PublicEmailExtractionMethod>();
    for (const email of extractEmailAddresses(fragmentHtml)) methods.set(email, "text");
    const hrefs = [
      ...(node.is("a[href]") ? [String(node.attr("href") ?? "")] : []),
      ...node.find("a[href]").map((_, link) => String($(link).attr("href") ?? "")).get(),
    ];
    for (const email of extractMailtoEmails(hrefs)) methods.set(email, "mailto");
    const protectedValues = [
      ...(node.is("[data-cfemail]") ? [String(node.attr("data-cfemail") ?? "")] : []),
      ...node.find("[data-cfemail]").map((_, protectedNode) =>
        String($(protectedNode).attr("data-cfemail") ?? "")).get(),
    ];
    for (const encoded of protectedValues) {
      const email = decodeCloudflareEmail(encoded);
      if (email) methods.set(email, "cloudflare");
    }
    const emails = [...methods].map(([email, method]) => ({ email, method }));
    const semanticMarker = `${node.attr("class") ?? ""} ${node.attr("id") ?? ""}`;
    if (emails.length === 0 && !contactRoleSignal.test(scopeText) &&
      !/\b(?:contact|person|people|member|staff|team|leader|profile|employee|bio|card)\b/i.test(semanticMarker)) {
      return;
    }

    const nestedNamedRoleBlocks = node.find("*")
      .toArray()
      .filter((child) => {
        const childNode = $(child);
        const childText = visibleTextFromHtml(childNode.html() ?? childNode.text());
        if (!looksLikeNamedRoleContext(childText)) return false;
        return !childNode.find("*")
          .toArray()
          .some((grandchild) => looksLikeNamedRoleContext(
            visibleTextFromHtml($(grandchild).html() ?? $(grandchild).text()),
          ));
      });
    rawScopes.push({
      id: `scope_${index + 1}`,
      text: scopeText,
      ambiguous: emails.length > 1 || nestedNamedRoleBlocks.length > 1 ||
        hasMultipleNamedRoleContexts(scopeText),
      emails,
    });
  });

  $("a[href^='mailto:'],[data-cfemail]").each((index, element) => {
    const node = $(element);
    const previousText = visibleTextFromHtml(node.prev().html() ?? node.prev().text());
    const ownText = visibleTextFromHtml(node.html() ?? node.text());
    const scopeText = compactContext(`${previousText} ${ownText}`);
    if (!previousText || scopeText.length < 5) return;
    const methods = new Map<string, PublicEmailExtractionMethod>();
    for (const email of extractMailtoEmails([String(node.attr("href") ?? "")])) methods.set(email, "mailto");
    const protectedEmail = decodeCloudflareEmail(String(node.attr("data-cfemail") ?? ""));
    if (protectedEmail) methods.set(protectedEmail, "cloudflare");
    if (methods.size === 0) return;
    rawScopes.push({
      id: `adjacent_${index + 1}`,
      text: scopeText,
      ambiguous: methods.size > 1 || hasMultipleNamedRoleContexts(scopeText),
      emails: [...methods].map(([email, method]) => ({ email, method })),
    });
  });

  const uniqueScopes = rawScopes
    .filter((scope, index, all) => all.findIndex((candidate) =>
      candidate.text === scope.text && JSON.stringify(candidate.emails) === JSON.stringify(scope.emails),
    ) === index);
  const scopesByEmail = new Map<string, WebsiteEvidenceScope[]>();
  for (const scope of uniqueScopes) {
    for (const { email } of scope.emails) {
      const scopes = scopesByEmail.get(email) ?? [];
      scopes.push(scope);
      scopesByEmail.set(email, scopes);
    }
  }
  for (const scopes of scopesByEmail.values()) {
    const ownershipScopes: WebsiteEvidenceScope[] = [];
    for (const scope of scopes.filter((candidate) =>
      !candidate.ambiguous && looksLikeNamedRoleContext(candidate.text))) {
      if (ownershipScopes.some((candidate) =>
        scopeContainsTokenSequence(candidate.text, scope.text) ||
        scopeContainsTokenSequence(scope.text, candidate.text))) continue;
      ownershipScopes.push(scope);
    }
    if (ownershipScopes.length > 1) {
      for (const scope of scopes) scope.ambiguous = true;
    }
  }
  const documentOrder = new Map(uniqueScopes.map((scope, index) => [scope.id, index]));
  const compareScopes = (left: WebsiteEvidenceScope, right: WebsiteEvidenceScope): number =>
      Number(left.ambiguous) - Number(right.ambiguous) ||
      Number(!looksLikeNamedRoleContext(left.text)) - Number(!looksLikeNamedRoleContext(right.text)) ||
      contactRolePriority(right.text) - contactRolePriority(left.text) ||
      Number(right.emails.length > 0) - Number(left.emails.length > 0) ||
      left.text.length - right.text.length ||
      (documentOrder.get(left.id) ?? 0) - (documentOrder.get(right.id) ?? 0);

  const bestScopeByEmail = new Map<string, WebsiteEvidenceScope>();
  for (const scope of uniqueScopes) {
    for (const { email } of scope.emails) {
      const current = bestScopeByEmail.get(email);
      if (!current || compareScopes(scope, current) < 0) bestScopeByEmail.set(email, scope);
    }
  }
  const selectedEmailScopes = [...new Set(bestScopeByEmail.values())];

  const roleOnlyScopes: WebsiteEvidenceScope[] = [];
  for (const scope of uniqueScopes
    .filter((candidate) => candidate.emails.length === 0 && looksLikeNamedRoleContext(candidate.text))
    .sort(compareScopes)) {
    const normalized = normalizedScopeText(scope.text);
    if (selectedEmailScopes.some((candidate) =>
      scopeContainsTokenSequence(candidate.text, normalized))) continue;
    if (roleOnlyScopes.some((candidate) => {
      const existing = normalizedScopeText(candidate.text);
      return scopeContainsTokenSequence(normalized, existing) ||
        scopeContainsTokenSequence(existing, normalized);
    })) continue;
    roleOnlyScopes.push(scope);
  }

  const usefulScopes = [...new Set([...selectedEmailScopes, ...roleOnlyScopes])]
    .sort(compareScopes);
  const usefulScopeIds = new Set(usefulScopes.map((scope) => scope.id));
  const supplementalAmbiguousScopes = uniqueScopes
    .filter((scope) => scope.ambiguous && !usefulScopeIds.has(scope.id))
    .sort(compareScopes);
  const rankedScopes = [...usefulScopes, ...supplementalAmbiguousScopes];
  const evidenceScopes: WebsiteEvidenceScope[] = [];
  let scopeCharacters = 0;
  for (const scope of rankedScopes) {
    if (evidenceScopes.length >= 12) break;
    if (scopeCharacters + scope.text.length > 4_000) continue;
    evidenceScopes.push(scope);
    scopeCharacters += scope.text.length;
  }
  const contactContexts = evidenceScopes
    .filter((scope) => !scope.ambiguous)
    .map((scope) => scope.text);
  const emailEvidence = evidenceScopes.flatMap((scope) =>
    scope.emails.map((item) => ({
      ...item,
      context: scope.text,
      scopeId: scope.id,
    })),
  );
  const emails = unique(
    [
      ...extractEmailAddresses(page.html),
      ...extractMailtoEmails(links),
      ...emailEvidence.map((item) => item.email),
    ],
  );
  const phones = unique(
    [...text.matchAll(/(?:\+|00)?\d[\d\s().-]{7,}\d/g)].map((match) => match[0]),
  ).slice(0, 20);
  return {
    url: page.url,
    title,
    text,
    emails,
    emailEvidence,
    contactContexts,
    evidenceScopes,
    phones,
    links,
  };
}

const businessContactRoute = /(?:^|[-_/ .])(?:contact(?:-us)?|enquir(?:y|ies)|inquir(?:y|ies)|sales|export|quotes?|quotation|rfq)(?:[-_/ .]|$)/i;

function selectResearchLinks(baseUrl: string, domain: string, links: string[], limit: number): string[] {
  const scored: Array<{ url: string; score: number; contactPage: boolean }> = [];
  for (const href of links) {
    try {
      const url = new URL(href, baseUrl);
      if (!new Set(["http:", "https:"]).has(url.protocol)) continue;
      if ((getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname) !== domain) continue;
      url.hash = "";
      const value = url.toString();
      let lower = `${url.pathname} ${url.search}`.toLowerCase();
      try {
        lower = decodeURIComponent(lower);
      } catch {
        // Keep the encoded URL text when a site publishes malformed escapes.
      }
      let score = 0;
      if (/\b(?:procurement|purchasing|sourcing|rfqs?|rfps?|request[-_/ ]for[-_/ ](?:quotation|proposal)|quotations?|tenders?|bids?|bidding|supplier[-_/ ]registration|vendor[-_/ ]registration)\b|采购|招标|投标|询价|供应商征集/.test(lower)) score += 20;
      if (/\b(?:projects?|expansion|capacity[-_/ ]increase|facility[-_/ ]upgrade|plant[-_/ ]upgrade|moderni[sz]ation|new[-_/ ]plant|construction|investment)\b|扩建|扩产|技改|升级|项目/.test(lower)) score += 14;
      if (/product|solution|system|equipment|application|industry|service/.test(lower)) score += 8;
      if (/case|portfolio|reference|customer/.test(lower)) score += 7;
      if (/about|company|profile|management|team|leadership/.test(lower)) score += 6;
      if (/news|event|exhibition|blog|update/.test(lower)) score += 5;
      if (businessContactRoute.test(lower)) score += 18;
      if (score > 0) {
        const contactPage = businessContactRoute.test(lower) ||
          /(?:^|[-_/ .])(?:team|management|leadership|people|staff|directory)(?:[-_/ .]|$)/i.test(lower);
        scored.push({ url: value, score, contactPage });
      }
    } catch {
      // Ignore malformed links from the public page.
    }
  }
  const ranked = [...new Map(
    scored.sort((a, b) => b.score - a.score).map((item) => [item.url, item]),
  ).values()];
  const selected = ranked.slice(0, limit);
  if (limit >= 2) {
    const contactPage = ranked.find((item) => item.contactPage);
    if (contactPage && !selected.some((item) => item.url === contactPage.url)) {
      selected[selected.length - 1] = contactPage;
    }
  }
  return selected.map((item) => item.url);
}

export async function assessWebsite(
  rawUrl: string,
  userAgent = defaultUserAgent,
  maxPages = 1,
  resolver: WebsiteAddressResolver = defaultAddressResolver,
  signal?: AbortSignal,
): Promise<WebsiteAssessment> {
  const normalized = normalizeUrl(rawUrl);
  const initialUrl = new URL(normalized);
  const domain = getDomain(initialUrl.hostname, { allowPrivateDomains: true }) ?? initialUrl.hostname;
  const base: WebsiteAssessment = {
    url: normalized,
    domain,
    reachable: false,
    parked: false,
    title: "",
    text: "",
    emails: [],
    phones: [],
    activitySignals: [],
    activityScore: 0,
    pages: [],
  };

  try {
    if (!(await allowedByRobots(initialUrl, userAgent, domain, resolver, signal))) {
      return { ...base, activitySignals: ["robots.txt disallows crawling"] };
    }
  } catch (error) {
    if (error instanceof WebsiteFetchPolicyError) {
      return { ...base, activitySignals: [error.message] };
    }
    return { ...base, activitySignals: ["robots.txt policy check failed"] };
  }

  let page: { url: string; html: string };
  try {
    page = await getText(normalized, userAgent, domain, resolver, 15_000, signal);
  } catch (firstError) {
    if (firstError instanceof WebsiteFetchPolicyError) {
      return { ...base, activitySignals: [firstError.message] };
    }
    if (initialUrl.protocol === "https:") {
      const fallbackUrl = new URL(normalized.replace(/^https:/i, "http:"));
      try {
        if (!(await allowedByRobots(fallbackUrl, userAgent, domain, resolver, signal))) {
          return { ...base, activitySignals: ["robots.txt disallows crawling"] };
        }
      } catch (error) {
        if (error instanceof WebsiteFetchPolicyError) {
          return { ...base, activitySignals: [error.message] };
        }
        return { ...base, activitySignals: ["robots.txt policy check failed"] };
      }
      try {
        page = await getText(fallbackUrl.toString(), userAgent, domain, resolver, 15_000, signal);
      } catch (fallbackError) {
        if (fallbackError instanceof WebsiteFetchPolicyError) {
          return { ...base, activitySignals: [fallbackError.message] };
        }
        return { ...base, activitySignals: [`unreachable: ${String(firstError)}`] };
      }
    } else {
      return { ...base, activitySignals: [`unreachable: ${String(firstError)}`] };
    }
  }

  const finalUrl = new URL(page.url);
  const finalDomain = getDomain(finalUrl.hostname, { allowPrivateDomains: true }) ?? finalUrl.hostname;
  if (finalDomain.toLowerCase() !== domain.toLowerCase()) {
    return { ...base, activitySignals: ["cross-domain redirect rejected"] };
  }

  const first = extractPage(page);
  const researchUrls = selectResearchLinks(
    first.url,
    domain,
    first.links,
    Math.max(0, maxPages - 1),
  );
  const additional = await Promise.all(
    researchUrls.map(async (url) => {
      try {
        if (!(await allowedByRobots(new URL(url), userAgent, domain, resolver, signal))) return null;
        const fetched = await getText(url, userAgent, domain, resolver, 15_000, signal);
        const fetchedUrl = new URL(fetched.url);
        const fetchedDomain = getDomain(fetchedUrl.hostname, { allowPrivateDomains: true }) ?? fetchedUrl.hostname;
        if (fetchedDomain.toLowerCase() !== domain.toLowerCase()) return null;
        return extractPage(fetched);
      } catch {
        return null;
      }
    }),
  );
  const pages = [first, ...additional.filter((item): item is NonNullable<typeof item> => Boolean(item))];
  const title = first.title;
  const text = pages.map((item) => item.text).join(" \n").slice(0, 300_000);
  const lower = `${title} ${text}`.toLowerCase();
  const parked = parkedMarkers.some((marker) => lower.includes(marker));
  const emails = unique(pages.flatMap((item) => item.emails));
  const phones = unique(pages.flatMap((item) => item.phones)).slice(0, 20);
  const recentActivityAt = extractRecentDate(text);
  const activitySignals: string[] = ["website reachable"];
  let activityScore = 5;

  if (title) {
    activityScore += 2;
    activitySignals.push("page title present");
  }
  if (text.length > 1000) {
    activityScore += 2;
    activitySignals.push("substantive website content");
  }
  if (pages.length > 1) {
    activityScore += Math.min(3, pages.length - 1);
    activitySignals.push(`${pages.length} relevant company pages inspected`);
  }
  if (emails.length > 0 || phones.length > 0) {
    activityScore += 3;
    activitySignals.push("public contact route present");
  }
  if (/contact|about|products|solutions|projects|news/i.test(page.html)) {
    activityScore += 3;
    activitySignals.push("business navigation present");
  }
  if (recentActivityAt) {
    const ageDays = (Date.now() - new Date(recentActivityAt).getTime()) / 86_400_000;
    if (ageDays <= 548) {
      activityScore += 5;
      activitySignals.push("recent activity marker");
    }
  }
  if (parked) {
    activityScore = 0;
    activitySignals.push("parked or inactive domain marker");
  }

  return {
    url: page.url,
    domain,
    reachable: true,
    parked,
    title,
    text,
    emails,
    phones,
    recentActivityAt,
    activitySignals,
    activityScore: Math.min(activityScore, 20),
    pages: pages.map((item) => ({
      url: item.url,
      title: item.title,
      text: item.text,
      emails: item.emails,
      emailEvidence: item.emailEvidence,
      contactContexts: item.contactContexts,
      evidenceScopes: item.evidenceScopes,
    })),
  };
}
