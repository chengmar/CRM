import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  findHunterEmail,
  reconcileHunterVerification,
  verifyHunterEmail,
} from "../src/search/contact-enrichment-provider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Hunter named-contact enrichment", () => {
  it("accepts only a high-confidence Finder result with a supported verifier status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("domain")).toBe("buyer.example");
      expect(url.searchParams.get("full_name")).toBe("Jane Buyer");
      expect(url.searchParams.get("api_key")).toBe("finder-accept-key");
      return new Response(JSON.stringify({
        data: {
          email: "jane@buyer.example",
          score: 92,
          verification: { status: "valid" },
          sources: [
            { uri: "https://buyer.example/team" },
            { uri: "https://buyer.example/team" },
            { uri: "not-a-public-uri" },
          ],
        },
      }), { status: 200 });
    }));
    const config = loadConfig({ HUNTER_API_KEY: "finder-accept-key", HUNTER_MIN_CONFIDENCE: "80" });

    const result = await findHunterEmail("Jane Buyer", "buyer.example", config);
    expect(result).toMatchObject({
      email: "jane@buyer.example",
      confidence: 92,
      verificationStatus: "valid",
      sourceUris: ["https://buyer.example/team"],
    });
    expect(result?.evidence).toContain("https://buyer.example/team");
  });

  it("does not call the provider when no operator key is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "" });
    await expect(findHunterEmail("Jane Buyer", "buyer.example", config)).resolves.toBeNull();
    await expect(verifyHunterEmail("jane@buyer.example", config)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects low-confidence and cross-domain Finder results", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          email: "jane@buyer.example",
          score: 79,
          verification: { status: "valid" },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          email: "jane@unrelated.example",
          score: 99,
          verification: { status: "valid" },
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "finder-reject-key", HUNTER_MIN_CONFIDENCE: "80" });

    await expect(findHunterEmail("Low Confidence", "buyer.example", config)).resolves.toBeNull();
    await expect(findHunterEmail("Cross Domain", "buyer.example", config)).resolves.toBeNull();
  });

  it("rejects Finder results from a different private-suffix tenant", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        email: "jane@other.github.io",
        score: 99,
        verification: { status: "valid" },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "private-suffix-key", HUNTER_MIN_CONFIDENCE: "80" });

    await expect(findHunterEmail("Jane Buyer", "buyer.github.io", config)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never lets Hunter override a hard invalid or unknown mailbox result", () => {
    const hunter = {
      email: "jane@buyer.example",
      confidence: 95,
      verificationStatus: "valid",
      evidence: "Hunter valid",
    };
    const base = {
      email: hunter.email,
      status: "INVALID" as const,
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
      mxHosts: [],
      reason: "domain has no MX records",
    };

    expect(reconcileHunterVerification(base, hunter)).toMatchObject({
      status: "INVALID",
      reason: expect.stringContaining("did not override INVALID"),
    });
    expect(reconcileHunterVerification({ ...base, status: "UNKNOWN" }, hunter)).toMatchObject({
      status: "UNKNOWN",
      reason: expect.stringContaining("did not override UNKNOWN"),
    });
  });

  it("upgrades an MX-only result only with valid evidence and downgrades accept-all", () => {
    const base = {
      email: "jane@buyer.example",
      status: "RISKY" as const,
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
      mxHosts: ["mx.buyer.example"],
      reason: "MX valid; deep mailbox verification not configured",
    };
    const valid = reconcileHunterVerification(base, {
      email: base.email,
      confidence: 95,
      verificationStatus: "valid",
      evidence: "Hunter valid",
    });
    expect(valid.status).toBe("VALID");

    expect(reconcileHunterVerification({ ...base, status: "VALID" }, {
      email: base.email,
      confidence: 95,
      verificationStatus: "accept_all",
      evidence: "Hunter accept-all",
    })).toMatchObject({ status: "RISKY", catchAll: true });

    expect(reconcileHunterVerification({ ...base, roleAddress: true }, {
      email: base.email,
      confidence: 95,
      verificationStatus: "valid",
      evidence: "Hunter valid",
    })).toMatchObject({
      status: "RISKY",
      roleAddress: true,
      reason: expect.stringContaining("local role gate"),
    });

    expect(reconcileHunterVerification({ ...base, status: "VALID", catchAll: true }, {
      email: base.email,
      confidence: 95,
      verificationStatus: "valid",
      evidence: "Hunter valid",
    })).toMatchObject({
      status: "RISKY",
      catchAll: true,
      reason: expect.stringContaining("local catch-all gate"),
    });

    expect(reconcileHunterVerification({ ...base, disposableAddress: true }, {
      email: base.email,
      confidence: 95,
      verificationStatus: "valid",
      evidence: "Hunter valid",
    })).toMatchObject({ status: "INVALID", disposableAddress: true });
  });

  it("verifies an existing public email and returns hard provider findings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain("email-verifier");
      expect(url.searchParams.get("email")).toBe("jane@buyer.example");
      return new Response(JSON.stringify({
        data: {
          email: "jane@buyer.example",
          status: "invalid",
          score: 12,
          accept_all: false,
          disposable: false,
          sources: [{ uri: "https://buyer.example/team/jane" }],
        },
      }), { status: 200 });
    }));
    const config = loadConfig({ HUNTER_API_KEY: "verifier-invalid-key" });

    const hunter = await verifyHunterEmail("Jane@Buyer.Example", config);
    expect(hunter).toMatchObject({
      email: "jane@buyer.example",
      verificationStatus: "invalid",
      sourceUris: ["https://buyer.example/team/jane"],
    });
    expect(hunter?.evidence).toContain("https://buyer.example/team/jane");
    expect(reconcileHunterVerification({
      email: "jane@buyer.example",
      status: "VALID",
      roleAddress: false,
      disposableAddress: false,
      catchAll: false,
      mxHosts: ["mx.buyer.example"],
      reason: "Reacher verdict: safe",
    }, hunter!)).toMatchObject({ status: "INVALID" });
  });

  it("respects Retry-After when it is inside the local wait cap", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          email: "retry@buyer.example",
          status: "valid",
          score: 96,
          accept_all: false,
          disposable: false,
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "retry-after-key" });

    const result = verifyHunterEmail("retry@buyer.example", config);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ verificationStatus: "valid" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])("does not retry HTTP %s before a Retry-After window longer than the local cap", async (status) => {
    const fetch = vi.fn(async () => new Response("rate limited", {
      status,
      headers: { "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: `long-retry-after-key-${status}` });

    await expect(verifyHunterEmail(`wait-${status}@buyer.example`, config)).rejects.toThrow(
      "rate limited beyond the local retry window",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a Verifier response for a different mailbox", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        email: "other@buyer.example",
        status: "valid",
        score: 99,
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "verifier-mailbox-mismatch-key" });

    await expect(verifyHunterEmail("jane@buyer.example", config)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a Verifier response without a mailbox identity", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        status: "valid",
        score: 99,
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "verifier-mailbox-missing-key" });

    await expect(verifyHunterEmail("jane@buyer.example", config)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries temporary 5xx responses and stops after three retries", async () => {
    const successfulFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response("bad gateway", {
        status: 502,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          email: "recover@buyer.example",
          status: "valid",
          score: 91,
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", successfulFetch);
    const successfulConfig = loadConfig({ HUNTER_API_KEY: "retry-5xx-success-key" });

    await expect(verifyHunterEmail("recover@buyer.example", successfulConfig)).resolves.toMatchObject({
      verificationStatus: "valid",
    });
    expect(successfulFetch).toHaveBeenCalledTimes(3);

    const exhaustedFetch = vi.fn(async () => new Response("unavailable", {
      status: 503,
      headers: { "Retry-After": "0" },
    }));
    vi.stubGlobal("fetch", exhaustedFetch);
    const exhaustedConfig = loadConfig({ HUNTER_API_KEY: "retry-5xx-exhausted-key" });

    await expect(verifyHunterEmail("exhausted@buyer.example", exhaustedConfig)).rejects.toThrow(
      "Hunter Email Verifier returned HTTP 503",
    );
    expect(exhaustedFetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry permanent 4xx responses or cache a failed request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          email: "retry-after-failure@buyer.example",
          status: "valid",
          score: 90,
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "permanent-4xx-key" });

    await expect(verifyHunterEmail("retry-after-failure@buyer.example", config)).rejects.toThrow(
      "Hunter Email Verifier returned HTTP 400",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(verifyHunterEmail("retry-after-failure@buyer.example", config)).resolves.toMatchObject({
      verificationStatus: "valid",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces identical Finder calls and serves successful results within the TTL", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        email: "cached@buyer.example",
        score: 94,
        verification: { status: "valid" },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ HUNTER_API_KEY: "finder-cache-key", HUNTER_MIN_CONFIDENCE: "80" });

    const [first, concurrent] = await Promise.all([
      findHunterEmail("Cached Buyer", "buyer.example", config),
      findHunterEmail("Cached Buyer", "buyer.example", config),
    ]);
    expect(first).toEqual(concurrent);
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(findHunterEmail("Cached Buyer", "buyer.example", config)).resolves.toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(findHunterEmail("Cached Buyer", "buyer.example", config)).resolves.toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not merge cache entries for case-sensitive provider paths", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify({
        data: {
          email: url.pathname.startsWith("/V2/") ? "upper@buyer.example" : "lower@buyer.example",
          score: 95,
          verification: { status: "valid" },
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const upper = loadConfig({
      HUNTER_API_KEY: "case-sensitive-base-key",
      HUNTER_BASE_URL: "https://api.hunter.test/V2",
    });
    const lower = loadConfig({
      HUNTER_API_KEY: "case-sensitive-base-key",
      HUNTER_BASE_URL: "https://api.hunter.test/v2",
    });

    await expect(findHunterEmail("Case Path", "buyer.example", upper)).resolves.toMatchObject({
      email: "upper@buyer.example",
    });
    await expect(findHunterEmail("Case Path", "buyer.example", lower)).resolves.toMatchObject({
      email: "lower@buyer.example",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
