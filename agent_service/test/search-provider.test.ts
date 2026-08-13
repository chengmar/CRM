import { afterEach, describe, expect, it, vi } from "vitest";
import { SEARCH_RESULT_LIMITS, SearxngProvider } from "../src/search/provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("SearXNG resilience", () => {
  it("retries an engine outage instead of treating it as a zero-lead market", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [],
        unresponsive_engines: [["google", "too many requests"]],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ title: "Buyer", url: "https://buyer.example", content: "sample products integrator" }],
        unresponsive_engines: [],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const results = await new SearxngProvider("http://127.0.0.1:8888", 2, 1)
      .search("sample products Malaysia", 10);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      expect.objectContaining({ url: "https://buyer.example/", query: "sample products Malaysia" }),
    ]);
  });

  it("fails after bounded retries when every upstream engine remains unavailable", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [],
      unresponsive_engines: [["duckduckgo", "timeout"]],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      new SearxngProvider("http://127.0.0.1:8888", 2, 1).search("sample products Malaysia", 10),
    ).rejects.toThrow("SearXNG engines unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds untrusted result fields before returning them downstream", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Unsupported", url: "ftp://buyer.example/file", content: "ignored" },
        null,
        { title: "Overlong URL", url: `https://buyer.example/${"x".repeat(2_100)}`, content: "ignored" },
        {
          title: `  ${"t".repeat(600)}  `,
          url: "https://buyer.example/long-result",
          content: `  ${"s".repeat(2_000)}  `,
          publishedDate: "d".repeat(200),
        },
      ],
      unresponsive_engines: [],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const results = await new SearxngProvider("http://127.0.0.1:8888", 1, 1)
      .search("q".repeat(1_000), 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toHaveLength(SEARCH_RESULT_LIMITS.title);
    expect(results[0]?.snippet).toHaveLength(SEARCH_RESULT_LIMITS.snippet);
    expect(results[0]?.query).toHaveLength(SEARCH_RESULT_LIMITS.query);
    expect(results[0]?.sourceDate).toHaveLength(SEARCH_RESULT_LIMITS.sourceDate);
  });

  it("preserves the complete query and drops a generic first-term-only result", async () => {
    const fetch = vi.fn(async (target: string | URL | Request) => {
      const endpoint = new URL(String(target));
      expect(endpoint.searchParams.get("q")).toBe("sample products Malaysia");
      expect(endpoint.searchParams.get("categories")).toBe("general");
      expect(endpoint.searchParams.get("safesearch")).toBe("0");
      return new Response(JSON.stringify({
        query: "sample products Malaysia",
        results: [
          {
            title: "Industrial property news",
            url: "https://noise.example/property",
            content: "Industrial land and office leasing.",
          },
          {
            title: "Industrial Sample Product A supplier",
            url: "https://synonym.example/sample-product",
            content: "Sample Product A sample application systems.",
          },
          {
            title: "sample products manufacturer",
            url: "https://buyer.example/sample-product-catalog",
            content: "sample products equipment.",
          },
        ],
        unresponsive_engines: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const results = await new SearxngProvider("http://127.0.0.1:8888", 1, 1)
      .search("sample products Malaysia", 10);

    expect(results.map((item) => item.url)).toEqual([
      "https://synonym.example/sample-product",
      "https://buyer.example/sample-product-catalog",
    ]);
  });

  it("fails instead of accepting results for a truncated echoed query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      query: "industrial",
      results: [{ title: "Noise", url: "https://noise.example", content: "industrial" }],
      unresponsive_engines: [],
    }), { status: 200 })));

    await expect(
      new SearxngProvider("http://127.0.0.1:8888", 1, 1)
        .search("sample products Malaysia", 10),
    ).rejects.toThrow("did not preserve the complete search query");
  });
});
