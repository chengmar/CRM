import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { verifyContactEmail, type ContactCandidate } from "../src/search/discovery.js";
import { verifyEmail } from "../src/search/email-verifier.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("email verification", () => {
  const publicContact: ContactCandidate = {
    name: "Jane Buyer",
    title: "Procurement Manager",
    email: "jane@buyer.example",
    emailSourceUrl: "https://buyer.example/team",
    sourceScopeId: "scope-employment",
    emailScopeId: "scope-email",
    linkedin: null,
    sourceUrl: "https://buyer.example/team",
    evidence: "public company team page",
    employmentVerified: true,
  };

  it("keeps an MX-only mailbox risky when no deep verifier is configured", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);

    await expect(verifyEmail("jane@buyer.example", loadConfig({}))).resolves.toMatchObject({
      status: "RISKY",
      catchAll: false,
      reason: "MX valid; deep mailbox verification not configured",
    });
  });

  it("keeps a strict campaign UNKNOWN when its official verifier is unavailable", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);
    const verifier = { verify: vi.fn(async () => null) };

    await expect(verifyContactEmail(
      publicContact,
      "buyer.example",
      loadConfig({}),
      verifier,
    )).resolves.toMatchObject({
      verification: {
        status: "UNKNOWN",
        reason: expect.stringContaining("official verifier unavailable"),
      },
      provenance: null,
    });
  });

  it("does not upgrade an official UNKNOWN verdict with the local MX result", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);
    const verifier = {
      verify: vi.fn(async () => ({
        status: "UNKNOWN" as const,
        reason: "official verifier returned unknown",
        catchAll: false,
        disposable: false,
        roleMailbox: false,
        discoverySourceKey: "LOCAL_PUBLIC_WEB" as const,
        verifierSourceKey: "BOUNCER" as const,
        independentlyVerified: true as const,
        discoveryAssertionId: "discovery-1",
        verificationAssertionId: "verification-1",
        providerRunId: "provider-run-1",
        emailHash: "a".repeat(64),
        providerMailboxVerdict: "UNKNOWN_ASSERTION" as const,
        confidence: 0,
        rawPayloadHash: "b".repeat(64),
        observedAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-07-21T00:00:00.000Z",
        creditUnits: 1,
        estimatedCostMicros: 50_000,
        discoverySourceUrl: "https://buyer.example/team",
        discoveryEvidenceHash: "c".repeat(64),
      })),
    };

    await expect(verifyContactEmail(
      publicContact,
      "buyer.example",
      loadConfig({}),
      verifier,
    )).resolves.toMatchObject({
      verification: { status: "UNKNOWN", reason: "official verifier returned unknown" },
      provenance: { providerMailboxVerdict: "UNKNOWN_ASSERTION" },
    });
  });

  it("treats a Null MX response as permanently invalid", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 0, exchange: "." }]);

    await expect(verifyEmail("jane@buyer.example", loadConfig({}))).resolves.toMatchObject({
      status: "INVALID",
      mxHosts: [],
    });
  });

  it("distinguishes an absent MX record from a transient DNS failure", async () => {
    const resolver = vi.spyOn(dns, "resolveMx");
    resolver.mockRejectedValueOnce(Object.assign(new Error("no data"), { code: "ENODATA" }));
    await expect(verifyEmail("jane@buyer.example", loadConfig({}))).resolves.toMatchObject({
      status: "INVALID",
      reason: "domain has no MX records",
    });

    resolver.mockRejectedValueOnce(Object.assign(new Error("temporary failure"), { code: "EAI_AGAIN" }));
    await expect(verifyEmail("jane@buyer.example", loadConfig({}))).resolves.toMatchObject({
      status: "UNKNOWN",
      reason: "MX lookup temporarily unavailable",
    });
  });

  it("blocks a nested Reacher catch-all result", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      is_reachable: "safe",
      catch_all: false,
      smtp: { is_catch_all: true },
    }), { status: 200 })));

    await expect(verifyEmail(
      "jane@buyer.example",
      loadConfig({ REACHER_BASE_URL: "http://127.0.0.1:8081" }),
    )).resolves.toMatchObject({
      status: "RISKY",
      catchAll: true,
      reason: expect.stringContaining("catch-all domain"),
    });
  });

  it("preserves an explicit Reacher invalid verdict", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      is_reachable: "invalid",
      smtp: { is_catch_all: false },
    }), { status: 200 })));

    await expect(verifyEmail(
      "jane@buyer.example",
      loadConfig({ REACHER_BASE_URL: "http://127.0.0.1:8081" }),
    )).resolves.toMatchObject({
      status: "INVALID",
      catchAll: false,
    });
  });

  it("honors nested Reacher role and disposable flags", async () => {
    vi.spyOn(dns, "resolveMx").mockResolvedValue([{ priority: 10, exchange: "mx.buyer.example" }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      is_reachable: "safe",
      misc: { is_role_account: true, is_disposable: true },
    }), { status: 200 })));

    await expect(verifyEmail(
      "buyer@new-disposable.example",
      loadConfig({ REACHER_BASE_URL: "http://127.0.0.1:8081" }),
    )).resolves.toMatchObject({
      status: "INVALID",
      roleAddress: true,
      disposableAddress: true,
    });
  });
});
