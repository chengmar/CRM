import { afterEach, describe, expect, it, vi } from "vitest";
import { extractOfficialCompanyMailboxes, normalizeEvidencedContacts } from "../src/search/discovery.js";
import {
  assessWebsite as assessWebsiteWithResolver,
  type WebsiteAddressResolver,
} from "../src/search/website.js";

afterEach(() => vi.unstubAllGlobals());

const publicResolver: WebsiteAddressResolver = async () => [{ address: "8.8.8.8", family: 4 }];

function assessWebsite(rawUrl: string, userAgent?: string, maxPages?: number) {
  return assessWebsiteWithResolver(rawUrl, userAgent, maxPages, publicResolver);
}

function htmlResponse(url: string, html: string): Response {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => html,
  } as Response;
}

function stubWebsite(pages: Record<string, string>) {
  const fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const html = pages[url];
    if (html === undefined) throw new Error(`Unexpected page request: ${url}`);
    return htmlResponse(url, html);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("website activity evidence", () => {
  it("does not derive last activity from copyright or an ordinary current-year mention", async () => {
    const year = new Date().getUTCFullYear();
    stubWebsite({
      "https://buyer.example/": `
        <html><head><title>Buyer Engineering</title></head><body>
          <p>${year} product catalogue</p>
          <footer>Copyright ${year}. All rights reserved.</footer>
          <footer>© Copyright notice updated: ${year}-07-01 Buyer Engineering</footer>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.reachable).toBe(true);
    expect(assessment.recentActivityAt).toBeNull();
    expect(assessment.activitySignals).not.toContain("recent activity marker");
  });

  it("retains a real full publication date as an activity signal", async () => {
    const publishedAt = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    stubWebsite({
      "https://buyer.example/": `
        <html><head><title>Buyer Engineering News</title></head><body>
          <article>Published ${publishedAt}: new environmental compliance programme.</article>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.recentActivityAt).toBe(`${publishedAt}T00:00:00.000Z`);
    expect(assessment.activitySignals).toContain("recent activity marker");
  });
});

describe("website research page selection", () => {
  it("spends the crawl budget on procurement, expansion and project pages first", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><head><title>Buyer Engineering</title></head><body>
          <a href="/products">Products</a>
          <a href="/about">About</a>
          <a href="/procurement/rfq-42">Request for quotation</a>
          <a href="/tenders/sample-product-bid">Tender notice</a>
          <a href="/news/plant-expansion">Plant expansion</a>
          <a href="/projects/compliance-upgrade">Current project</a>
        </body></html>
      `,
      "https://buyer.example/procurement/rfq-42": "<html><body>RFQ details</body></html>",
      "https://buyer.example/tenders/sample-product-bid": "<html><body>Tender details</body></html>",
      "https://buyer.example/news/plant-expansion": "<html><body>Expansion details</body></html>",
      "https://buyer.example/projects/compliance-upgrade": "<html><body>Project details</body></html>",
    });

    const assessment = await assessWebsite("https://buyer.example/", undefined, 5);

    expect(assessment.pages.map((page) => page.url)).toEqual([
      "https://buyer.example/",
      "https://buyer.example/procurement/rfq-42",
      "https://buyer.example/tenders/sample-product-bid",
      "https://buyer.example/news/plant-expansion",
      "https://buyer.example/projects/compliance-upgrade",
    ]);
  });

  it("reserves a crawl slot for a contact or team page when demand pages fill the budget", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <a href="/procurement/rfq-1">RFQ</a>
          <a href="/tenders/bid-2">Tender</a>
          <a href="/projects/upgrade-1">Project</a>
          <a href="/news/plant-expansion">Expansion</a>
          <a href="/contact">Contact</a>
        </body></html>
      `,
      "https://buyer.example/procurement/rfq-1": "<html><body>RFQ</body></html>",
      "https://buyer.example/tenders/bid-2": "<html><body>Tender</body></html>",
      "https://buyer.example/projects/upgrade-1": "<html><body>Project</body></html>",
      "https://buyer.example/news/plant-expansion": "<html><body>Expansion</body></html>",
      "https://buyer.example/contact": "<html><body>Contact</body></html>",
    });

    const assessment = await assessWebsite("https://buyer.example/", undefined, 5);
    const urls = assessment.pages.map((page) => page.url);

    expect(urls).toContain("https://buyer.example/contact");
    expect(urls).toContain("https://buyer.example/procurement/rfq-1");
    expect(urls).toContain("https://buyer.example/tenders/bid-2");
  });

  it.each(["contact", "enquiry", "inquiry", "sales", "export", "quote"])(
    "prioritizes the /%s business-contact route over a generic product page",
    async (route) => {
      stubWebsite({
        "https://buyer.example/": `
          <html><body>
            <a href="/products">Products</a>
            <a href="/${route}">${route}</a>
          </body></html>
        `,
        "https://buyer.example/products": "<html><body>Products</body></html>",
        [`https://buyer.example/${route}`]: "<html><body>Business contact route</body></html>",
      });

      const assessment = await assessWebsite("https://buyer.example/", undefined, 2);

      expect(assessment.pages.map((page) => page.url)).toContain(`https://buyer.example/${route}`);
    },
  );
});

describe("website email evidence", () => {
  it("retains an encoded mailto-only address on the exact source page", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <a href="/team">Team</a>
        </body></html>
      `,
      "https://buyer.example/team": `
        <html><body>
          <p>Jane Buyer, Procurement Manager</p>
          <a href="mailto:jane.buyer%40buyer.example">Email Jane</a>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/", undefined, 2);
    const teamPage = assessment.pages.find((page) => page.url === "https://buyer.example/team");

    expect(assessment.emails).toContain("jane.buyer@buyer.example");
    expect(teamPage?.emails).toContain("jane.buyer@buyer.example");
    expect(teamPage?.emailEvidence).toContainEqual(expect.objectContaining({
      email: "jane.buyer@buyer.example",
      context: expect.stringContaining("Jane Buyer, Procurement Manager"),
      method: "mailto",
    }));
    expect(teamPage?.contactContexts).toContainEqual(expect.stringContaining("Jane Buyer"));
    expect(teamPage?.text).not.toContain("jane.buyer@buyer.example");

    const scope = teamPage?.evidenceScopes?.find((item) =>
      !item.ambiguous && item.emails.some((email) => email.email === "jane.buyer@buyer.example") &&
      item.text.includes("Procurement Manager"));
    expect(scope).toBeDefined();
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "jane.buyer@buyer.example",
        emailSourceUrl: "https://buyer.example/team",
        sourceScopeId: scope?.id,
        emailScopeId: scope?.id,
        sourceUrl: "https://buyer.example/team",
        evidence: "Official team scope",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });
    expect(contacts[0]).toMatchObject({
      email: "jane.buyer@buyer.example",
      employmentVerified: true,
    });
  });

  it("binds a mailto-only company mailbox into exact tier-B evidence", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body><a href="/contact">Contact</a></body></html>
      `,
      "https://buyer.example/contact": `
        <html><body>
          <p>Export enquiries</p>
          <a href="mailto:export%40buyer.example">Email our export team</a>
        </body></html>
      `,
    });
    const assessment = await assessWebsite("https://buyer.example/", undefined, 2);

    const mailboxes = extractOfficialCompanyMailboxes({
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      maxContacts: 4,
      observedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(mailboxes).toContainEqual(expect.objectContaining({
      email: "export@buyer.example",
      recipientTier: "B",
      officialMailboxEvidence: expect.objectContaining({
        exactText: expect.stringContaining("export@buyer.example"),
      }),
    }));
  });

  it("binds a decoded Cloudflare company mailbox into exact tier-B evidence", async () => {
    const email = "sales@buyer.example";
    const key = 0x12;
    const encoded = [key, ...Buffer.from(email, "utf8")]
      .map((value, index) => (index === 0 ? value : value ^ key).toString(16).padStart(2, "0"))
      .join("");
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <p>Sales enquiries</p>
          <span data-cfemail="${encoded}">Email protected</span>
        </body></html>
      `,
    });
    const assessment = await assessWebsite("https://buyer.example/");

    const mailboxes = extractOfficialCompanyMailboxes({
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      maxContacts: 4,
      observedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(mailboxes).toContainEqual(expect.objectContaining({
      email,
      recipientTier: "B",
      officialMailboxEvidence: expect.objectContaining({
        exactText: expect.stringContaining(email),
      }),
    }));
  });

  it("supports component cards while preventing cross-card email binding", async () => {
    stubWebsite({
      "https://buyer.example/": "<html><body><a href='/team'>Team</a></body></html>",
      "https://buyer.example/team": `
        <html><body>
          <div class="person-card">
            <div>Jane Buyer</div><div>Procurement Manager</div>
            <div><a href="mailto:jane%40buyer.example">Email Jane</a></div>
          </div>
          <div class="person-card">
            <div>John Boss</div><div>Managing Director</div>
            <div><a href="mailto:john%40buyer.example">Email John</a></div>
          </div>
        </body></html>
      `,
    });
    const assessment = await assessWebsite("https://buyer.example/", undefined, 2);
    const teamPage = assessment.pages.find((page) => page.url === "https://buyer.example/team")!;
    const janeScope = teamPage.evidenceScopes?.find((scope) =>
      !scope.ambiguous && scope.text.includes("Jane Buyer") && scope.text.includes("Procurement Manager") &&
      scope.emails.some((email) => email.email === "jane@buyer.example"));
    const johnScope = teamPage.evidenceScopes?.find((scope) =>
      !scope.ambiguous && scope.text.includes("John Boss") &&
      scope.emails.some((email) => email.email === "john@buyer.example"));
    expect(janeScope).toBeDefined();
    expect(johnScope).toBeDefined();

    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "john@buyer.example",
        emailSourceUrl: teamPage.url,
        sourceScopeId: janeScope?.id,
        emailScopeId: johnScope?.id,
        sourceUrl: teamPage.url,
        evidence: "Official team scopes",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });
    expect(contacts[0]).toMatchObject({ employmentVerified: true, email: null });
  });

  it("marks a shared wrapper with multiple people as ambiguous and blocks cross-person email binding", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <div class="team">
            <span>Jane Buyer, Procurement Manager.</span>
            <span>John Boss, Managing Director.</span>
            <a href="mailto:john.boss@buyer.example">Email John</a>
          </div>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const page = assessment.pages[0]!;
    const sharedScope = page.evidenceScopes?.find((scope) =>
      scope.text.includes("Jane Buyer") && scope.text.includes("John Boss") &&
      scope.emails.some((email) => email.email === "john.boss@buyer.example"));

    expect(sharedScope).toMatchObject({ ambiguous: true });
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "john.boss@buyer.example",
        emailSourceUrl: page.url,
        sourceScopeId: sharedScope?.id,
        emailScopeId: sharedScope?.id,
        sourceUrl: page.url,
        evidence: "Shared team wrapper",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ employmentVerified: false, email: null });
  });

  it("marks multiple people in one text block as ambiguous and blocks email misbinding", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <p>
            Jane Buyer, Procurement Manager. John Boss, Managing Director.
            <a href="mailto:john.boss@buyer.example">Email John</a>
          </p>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const page = assessment.pages[0]!;
    const sharedScope = page.evidenceScopes?.find((scope) =>
      scope.text.includes("Jane Buyer") && scope.text.includes("John Boss") &&
      scope.emails.some((email) => email.email === "john.boss@buyer.example"));

    expect(sharedScope).toMatchObject({ ambiguous: true });
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "john.boss@buyer.example",
        emailSourceUrl: page.url,
        sourceScopeId: sharedScope?.id,
        emailScopeId: sharedScope?.id,
        sourceUrl: page.url,
        evidence: "Shared contact paragraph",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ employmentVerified: false, email: null });
  });

  it("does not let an adjacent mailto scope bypass a multi-person sibling block", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <div>Jane Buyer, Procurement Manager. John Boss, Managing Director.</div>
          <a href="mailto:john.boss@buyer.example">Email John</a>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const page = assessment.pages[0]!;
    const adjacentScope = page.evidenceScopes?.find((scope) =>
      scope.id.startsWith("adjacent_") && scope.text.includes("Jane Buyer") &&
      scope.text.includes("John Boss") &&
      scope.emails.some((email) => email.email === "john.boss@buyer.example"));

    expect(adjacentScope).toMatchObject({ ambiguous: true });
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "john.boss@buyer.example",
        emailSourceUrl: page.url,
        sourceScopeId: adjacentScope?.id,
        emailScopeId: adjacentScope?.id,
        sourceUrl: page.url,
        evidence: "Adjacent team scope",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ employmentVerified: false, email: null });
  });

  it("marks one email cited by separate person scopes as ambiguous", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <div class="person-card">
            <p>Jane Buyer, Procurement Manager</p>
            <a href="mailto:shared@buyer.example">Email Jane</a>
          </div>
          <div class="person-card">
            <p>John Boss, Managing Director</p>
            <a href="mailto:shared@buyer.example">Email John</a>
          </div>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const sharedScopes = (assessment.pages[0]!.evidenceScopes ?? [])
      .filter((scope) => scope.emails.some((email) => email.email === "shared@buyer.example"));

    expect(sharedScopes.length).toBeGreaterThan(0);
    expect(sharedScopes.every((scope) => scope.ambiguous)).toBe(true);
  });

  it("keeps a single component card usable when its title is split across sibling nodes", async () => {
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          <div class="person-card">
            <div>Jane Buyer</div>
            <div>Supply Chain</div>
            <div>Director</div>
            <div><a href="mailto:jane@buyer.example">Email Jane</a></div>
          </div>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const page = assessment.pages[0]!;
    const janeScope = page.evidenceScopes?.find((scope) =>
      !scope.ambiguous && scope.text.includes("Jane Buyer") &&
      scope.text.includes("Supply Chain") && scope.text.includes("Director") &&
      scope.emails.some((email) => email.email === "jane@buyer.example"));

    expect(janeScope).toBeDefined();
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Supply Chain Director",
        email: "jane@buyer.example",
        emailSourceUrl: page.url,
        sourceScopeId: janeScope?.id,
        emailScopeId: janeScope?.id,
        sourceUrl: page.url,
        evidence: "Component contact card",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ employmentVerified: true, email: "jane@buyer.example" });
  });

  it("deduplicates nested email scopes and retains a later high-priority contact within the quota", async () => {
    const lowerPriorityCards = Array.from({ length: 12 }, (_, index) => `
      <div class="person-card">
        <div class="profile">
          <p>Alex Person${index}, Engineering Director</p>
          <a href="mailto:alex${index}@buyer.example">Email Alex</a>
        </div>
        <span>Regional engineering biography ${index}</span>
      </div>
    `).join("");
    stubWebsite({
      "https://buyer.example/": `
        <html><body>
          ${lowerPriorityCards}
          <div class="person-card">
            <div>Zachary Buyer</div><div>Procurement Manager</div>
            <div><a href="mailto:zachary@buyer.example">Email Zachary</a></div>
          </div>
        </body></html>
      `,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const scopes = assessment.pages[0]!.evidenceScopes ?? [];
    const scopedEmails = scopes.flatMap((scope) => scope.emails.map((email) => email.email));

    expect(scopes).toHaveLength(12);
    expect(scopes.some((scope) =>
      !scope.ambiguous && scope.text.includes("Zachary Buyer") &&
      scope.emails.some((email) => email.email === "zachary@buyer.example"))).toBe(true);
    expect(new Set(scopedEmails).size).toBe(scopedEmails.length);
    expect(scopes.reduce((sum, scope) => sum + scope.text.length, 0)).toBeLessThanOrEqual(4_000);
  });

  it("keeps DOM block text separated and bounds evidence scope input", async () => {
    const cards = Array.from({ length: 40 }, (_, index) =>
      `<p>Buyer ${index}, Procurement Manager, buyer${index}@buyer.example</p>`).join("");
    stubWebsite({
      "https://buyer.example/": `<html><body>${cards}</body></html>`,
    });

    const assessment = await assessWebsite("https://buyer.example/");
    const page = assessment.pages[0]!;

    expect(page.text).toContain("buyer0@buyer.example Buyer 1");
    expect(page.evidenceScopes?.length).toBeLessThanOrEqual(12);
    expect((page.evidenceScopes ?? []).reduce((sum, scope) => sum + scope.text.length, 0)).toBeLessThanOrEqual(4_000);
    expect(page.emailEvidence?.some((item) => item.email === "buyer0@buyer.examplejohn")).toBe(false);
  });

  it("rejects a cross-domain redirect as official website evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return htmlResponse(
        "https://unrelated.example/landing",
        "<html><body>Jane Buyer Procurement Manager jane@buyer.example</body></html>",
      );
    }));

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.reachable).toBe(false);
    expect(assessment.pages).toEqual([]);
    expect(assessment.emails).toEqual([]);
    expect(assessment.activitySignals).toEqual(["cross-domain redirect rejected"]);
  });

  it("rejects a cross-domain redirect before requesting the target page", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === "https://buyer.example/robots.txt") return new Response("", { status: 404 });
      if (url === "https://buyer.example/") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://unrelated.example/landing" },
        });
      }
      throw new Error(`Redirect target must not be requested: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.activitySignals).toEqual(["cross-domain redirect rejected"]);
    expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain("https://unrelated.example/landing");
  });

  it("checks redirect-target robots rules before requesting the target page", async () => {
    const targetUrl = "https://www.buyer.example/private/team";
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === "https://buyer.example/robots.txt") return new Response("", { status: 404 });
      if (url === "https://buyer.example/") {
        return new Response(null, { status: 302, headers: { Location: targetUrl } });
      }
      if (url === "https://www.buyer.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private", { status: 200 });
      }
      throw new Error(`Redirect target must not be requested: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.activitySignals).toEqual(["redirect target robots.txt disallows crawling"]);
    expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain(targetUrl);
  });
});

describe("website network boundary", () => {
  it.each([
    "http://127.0.0.1/internal",
    "http://127.1/internal",
    "http://2130706433/internal",
    "http://0x7f000001/internal",
    "http://0177.0.0.1/internal",
    "http://169.254.169.254/latest/meta-data",
    "http://[::ffff:127.0.0.1]/internal",
    "http://[::ffff:0:127.0.0.1]/internal",
    "http://[64:ff9b::127.0.0.1]/internal",
  ])("rejects an unsafe literal target before any request: %s", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsiteWithResolver(url, undefined, 1, publicResolver);

    expect(assessment.reachable).toBe(false);
    expect(assessment.activitySignals).toEqual(["unsafe target address rejected"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a hostname resolving to a private address before any request", async () => {
    const fetch = vi.fn();
    const privateResolver: WebsiteAddressResolver = async () => [{ address: "10.0.0.8", family: 4 }];
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsiteWithResolver(
      "https://buyer.example/",
      undefined,
      1,
      privateResolver,
    );

    expect(assessment.activitySignals).toEqual(["unsafe target address rejected"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a hostname when DNS returns both public and private addresses", async () => {
    const fetch = vi.fn();
    const mixedResolver: WebsiteAddressResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ];
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsiteWithResolver(
      "https://buyer.example/",
      undefined,
      1,
      mixedResolver,
    );

    expect(assessment.activitySignals).toEqual(["unsafe target address rejected"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a robots redirect whose same-domain target resolves privately before requesting it", async () => {
    const privateRobotsUrl = "https://private.buyer.example/robots.txt";
    const resolver: WebsiteAddressResolver = async (hostname) => hostname === "buyer.example"
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "192.168.1.20", family: 4 }];
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === "https://buyer.example/robots.txt") {
        return new Response(null, { status: 302, headers: { Location: privateRobotsUrl } });
      }
      throw new Error(`Unsafe robots target must not be requested: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsiteWithResolver("https://buyer.example/", undefined, 1, resolver);

    expect(assessment.activitySignals).toEqual(["unsafe target address rejected"]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://buyer.example/robots.txt",
    ]);
    expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain(privateRobotsUrl);
  });

  it("pins each allowed request and closes every dispatcher after consuming the response", async () => {
    const dispatchers: Array<{ closed: boolean }> = [];
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const dispatcher = (init as RequestInit & { dispatcher?: { closed: boolean } } | undefined)?.dispatcher;
      if (dispatcher) dispatchers.push(dispatcher);
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("<html><body>Public company page</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.reachable).toBe(true);
    expect(dispatchers).toHaveLength(2);
    expect(dispatchers.every((dispatcher) => dispatcher.closed)).toBe(true);
  });

  it("cancels page and robots streams at their byte limits", async () => {
    const encoder = new TextEncoder();
    const pageCancel = vi.fn();
    const robotsCancel = vi.fn();
    const boundedResponse = (prefix: string, fillerBytes: number, cancel: () => void) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(prefix));
          controller.enqueue(encoder.encode("x".repeat(fillerBytes)));
        },
        cancel,
      }),
      { status: 200, headers: { "content-type": "text/html" } },
    );
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return url.endsWith("/robots.txt")
        ? boundedResponse("User-agent: *\nAllow: /\n", 500_000, robotsCancel)
        : boundedResponse("<html><body>Public company page ", 1_000_000, pageCancel);
    });
    vi.stubGlobal("fetch", fetch);

    const assessment = await assessWebsite("https://buyer.example/");

    expect(assessment.reachable).toBe(true);
    expect(robotsCancel).toHaveBeenCalledTimes(1);
    expect(pageCancel).toHaveBeenCalledTimes(1);
  });
});
