const booleanQueryTokens = new Set(["and", "or", "not"]);

// Broad leading words are product-neutral. The actual product vocabulary is
// always taken from the campaign query and is never embedded in this module.
const genericLeadingTokens = new Set([
  "company",
  "contractor",
  "equipment",
  "exporter",
  "factory",
  "industrial",
  "industry",
  "installation",
  "integrator",
  "manufacturer",
  "product",
  "project",
  "service",
  "solution",
  "solutions",
  "supplier",
  "system",
  "systems",
]);

function tokens(value: unknown): string[] {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function queryParts(query: string): { tokens: string[]; siteHost: string | null } {
  const site = query.match(/(?:^|\s)site:([^\s"']+)/iu)?.[1]?.trim().toLowerCase() ?? null;
  const withoutModifiers = query.replace(/(?:^|\s)(?:site|inurl|intitle|filetype):[^\s"']+/giu, " ");
  return {
    tokens: unique(tokens(withoutModifiers).filter((token) => !booleanQueryTokens.has(token))),
    siteHost: site?.replace(/^www\./, "").replace(/\.$/, "") || null,
  };
}

function resultText(input: { title?: unknown; url?: unknown; content?: unknown }): {
  tokens: Set<string>;
  host: string | null;
} {
  let decodedUrl = String(input.url ?? "");
  let host: string | null = null;
  try {
    const url = new URL(decodedUrl);
    host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    decodedUrl = decodeURIComponent(decodedUrl);
  } catch {
    // URL validity is enforced separately by each provider adapter.
  }
  return {
    tokens: new Set(tokens(`${String(input.title ?? "")} ${String(input.content ?? "")} ${decodedUrl}`)),
    host,
  };
}

function tokenMatches(queryToken: string, resultTokens: Set<string>): boolean {
  if (resultTokens.has(queryToken)) return true;
  if (!/^[a-z0-9]+$/i.test(queryToken) || queryToken.length < 5) return false;
  if (queryToken.endsWith("s")) return resultTokens.has(queryToken.slice(0, -1));
  return resultTokens.has(`${queryToken}s`);
}

export function normalizeSearxngQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function searxngEchoMatches(requested: string, echoed: string): boolean {
  return tokens(normalizeSearxngQuery(requested)).join("\u0000") ===
    tokens(normalizeSearxngQuery(echoed)).join("\u0000");
}

/**
 * Reject the proven broad-query failure mode without assuming any product
 * family: a multi-word query whose result repeats only its broad first term.
 */
export function isSearxngResultRelevant(
  query: string,
  input: { title?: unknown; url?: unknown; content?: unknown },
): boolean {
  const parsedQuery = queryParts(query);
  if (parsedQuery.tokens.length < 2) return true;

  const result = resultText(input);
  if (parsedQuery.siteHost && result.host &&
    (result.host === parsedQuery.siteHost || result.host.endsWith(`.${parsedQuery.siteHost}`))) {
    return true;
  }

  const matched = parsedQuery.tokens.filter((token) => tokenMatches(token, result.tokens));
  if (matched.length === 0) return false;
  if (matched.length > 1) return true;

  const leading = parsedQuery.tokens[0]!;
  return matched[0] !== leading || !genericLeadingTokens.has(leading);
}
