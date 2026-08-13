import type { AgentConfig } from "../config.js";
import { MAX_PUBLIC_HTTP_URL_LENGTH, normalizePublicHttpUrl } from "../http-url.js";
import type { SearchResult } from "../types.js";
import { isSearxngResultRelevant, searxngEchoMatches } from "./searxng-query-quality.js";

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export const SEARCH_RESULT_LIMITS = Object.freeze({
  title: 300,
  url: MAX_PUBLIC_HTTP_URL_LENGTH,
  snippet: 1_200,
  query: 500,
  sourceDate: 100,
});

function compactField(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedSearchResult(input: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  sourceDate?: unknown;
}, query: string): SearchResult | null {
  const url = normalizePublicHttpUrl(input.url);
  if (!url) return null;
  return {
    title: compactField(input.title, SEARCH_RESULT_LIMITS.title),
    url,
    snippet: compactField(input.snippet, SEARCH_RESULT_LIMITS.snippet),
    sourceType: "search",
    sourceDate: compactField(input.sourceDate, SEARCH_RESULT_LIMITS.sourceDate) || null,
    query: compactField(query, SEARCH_RESULT_LIMITS.query),
  };
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    throw new Error(`Search request failed ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

class SerperProvider implements SearchProvider {
  readonly name = "serper";

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const resultLimit = Math.max(0, Math.trunc(limit));
    const data = await fetchJson<{
      organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string } | null>;
    }>("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": this.apiKey },
      body: JSON.stringify({ q: query, num: Math.min(resultLimit, 20) }),
    });
    return (data.organic ?? [])
      .flatMap((item) => {
        if (!item) return [];
        const result = normalizedSearchResult({
          title: item.title,
          url: item.link,
          snippet: item.snippet,
          sourceDate: item.date,
        }, query);
        return result ? [result] : [];
      })
      .slice(0, resultLimit);
  }
}

class ExaProvider implements SearchProvider {
  readonly name = "exa";

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const resultLimit = Math.max(0, Math.trunc(limit));
    const data = await fetchJson<{
      results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string } | null>;
    }>("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        query,
        numResults: Math.min(resultLimit, 25),
        type: "auto",
        contents: { text: { maxCharacters: 1200 } },
      }),
    });
    return (data.results ?? [])
      .flatMap((item) => {
        if (!item) return [];
        const result = normalizedSearchResult({
          title: item.title,
          url: item.url,
          snippet: item.text,
          sourceDate: item.publishedDate,
        }, query);
        return result ? [result] : [];
      })
      .slice(0, resultLimit);
  }
}

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng";

  constructor(
    private readonly baseUrl: string,
    private readonly retryAttempts = 3,
    private readonly retryBaseDelayMs = 1000,
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const resultLimit = Math.max(0, Math.trunc(limit));
    const attempts = Math.max(1, this.retryAttempts);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const url = new URL("search", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("language", "all");
        url.searchParams.set("categories", "general");
        url.searchParams.set("safesearch", "0");
        const data = await fetchJson<{
          query?: unknown;
          results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string } | null>;
          unresponsive_engines?: Array<[string, string]>;
        }>(url.toString(), { headers: { Accept: "application/json" } });
        if (data.query !== undefined &&
          (typeof data.query !== "string" || !searxngEchoMatches(query, data.query))) {
          throw new Error("SearXNG did not preserve the complete search query");
        }
        const results = (data.results ?? [])
          .flatMap((item) => {
            if (!item || !isSearxngResultRelevant(query, item)) return [];
            const result = normalizedSearchResult({
              title: item.title,
              url: item.url,
              snippet: item.content,
              sourceDate: item.publishedDate,
            }, query);
            return result ? [result] : [];
          })
          .slice(0, resultLimit);
        if (results.length > 0 || (data.unresponsive_engines ?? []).length === 0) return results;
        lastError = new Error(
          `SearXNG engines unavailable: ${(data.unresponsive_engines ?? []).map(([engine, reason]) => `${engine}:${reason}`).join(", ")}`,
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, this.retryBaseDelayMs * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("SearXNG search failed after retries");
  }
}

export function createSearchProvider(config: AgentConfig): SearchProvider {
  const requested = config.SEARCH_PROVIDER;
  if ((requested === "auto" || requested === "serper") && config.SERPER_API_KEY) {
    return new SerperProvider(config.SERPER_API_KEY);
  }
  if ((requested === "auto" || requested === "exa") && config.EXA_API_KEY) {
    return new ExaProvider(config.EXA_API_KEY);
  }
  if ((requested === "auto" || requested === "searxng") && config.SEARXNG_BASE_URL) {
    return new SearxngProvider(
      config.SEARXNG_BASE_URL,
      config.SEARCH_RETRY_ATTEMPTS,
      config.SEARCH_RETRY_BASE_DELAY_MS,
    );
  }
  throw new Error(
    "No search provider configured. Set SERPER_API_KEY, EXA_API_KEY, or SEARXNG_BASE_URL.",
  );
}
