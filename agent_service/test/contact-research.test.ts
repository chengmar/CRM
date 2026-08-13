import { describe, expect, it } from "vitest";
import {
  type ContactCandidate,
  hasCurrentEmploymentEvidence,
  mergeContactCandidatesForInventory,
  normalizeEvidencedContacts,
  normalizeContactResearchQueries,
} from "../src/search/discovery.js";
import type { WebsiteAssessment } from "../src/types.js";

describe("Hermes contact research query normalization", () => {
  it("accepts plain and object-shaped queries without leaking object stringification", () => {
    const queries = normalizeContactResearchQueries({
      queries: [
        'site:linkedin.com/in "Airbond Engineering" procurement Malaysia',
        { query: '"Airbond Engineering" "managing director"' },
        { search_query: 'site:airbond.com.my filetype:pdf director' },
        { invalid: true },
      ],
    });

    expect(queries).toHaveLength(3);
    expect(queries.join(" ")).not.toContain("[object Object]");
  });
});

describe("current-employment evidence", () => {
  it("accepts name and role evidence on the official company domain", () => {
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Leadership: Jane Buyer - Procurement Manager",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering Sdn Bhd",
      contactName: "Jane Buyer",
      contactTitle: "Procurement Manager",
    })).toBe(true);
  });

  it("accepts a third-party source only when it also names the company", () => {
    const base = {
      sourceUrl: "https://conference.example/speakers/jane-buyer",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering Sdn Bhd",
      contactName: "Jane Buyer",
      contactTitle: "Engineering Director",
    };
    expect(hasCurrentEmploymentEvidence({
      ...base,
      sourceText: "Jane Buyer, Engineering Director at Buyer Engineering",
    })).toBe(true);
    expect(hasCurrentEmploymentEvidence({
      ...base,
      sourceText: "Jane Buyer, Engineering Director at Another Company",
    })).toBe(false);
  });

  it("rejects a source that does not co-locate the contact role evidence", () => {
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Jane Buyer attended the event. The page also discusses procurement teams.",
      sourceUrl: "https://conference.example/event",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering Sdn Bhd",
      contactName: "Jane Buyer",
      contactTitle: "Managing Director",
    })).toBe(false);
  });

  it("does not borrow another person's role from the same team page", () => {
    const input = {
      sourceText: "Ann Buyer, Sales Manager. John Boss, Procurement Manager.",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering Sdn Bhd",
      contactName: "Ann Buyer",
      contactTitle: "Procurement Manager",
    };

    expect(hasCurrentEmploymentEvidence(input)).toBe(false);
    expect(hasCurrentEmploymentEvidence({
      ...input,
      sourceText: "Ann Buyer Sales Manager John Boss Procurement Manager",
      sourceContexts: ["Ann Buyer Sales Manager", "John Boss Procurement Manager"],
    })).toBe(false);
  });

  it("uses exact name and complete title tokens", () => {
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Joann Lee, Procurement Manager",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering",
      contactName: "Ann Lee",
      contactTitle: "Procurement Manager",
    })).toBe(false);
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Jane Buyer, Supply Chain Analyst",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering",
      contactName: "Jane Buyer",
      contactTitle: "Supply Chain Director",
    })).toBe(false);
  });

  it.each(["Procurement", "Manager"])(
    "rejects role token %s as a named person",
    (contactName) => {
      expect(hasCurrentEmploymentEvidence({
        sourceText: "Contact Procurement Manager for current projects",
        sourceUrl: "https://buyer.example/team",
        companyDomain: "buyer.example",
        companyName: "Buyer Engineering",
        contactName,
        contactTitle: "Procurement Manager",
      })).toBe(false);
    },
  );

  it("retains a legitimate single-token personal name", () => {
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Sukarno, Procurement Manager",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering",
      contactName: "Sukarno",
      contactTitle: "Procurement Manager",
    })).toBe(true);
  });

  it("does not assemble a title from separate semantic role references", () => {
    expect(hasCurrentEmploymentEvidence({
      sourceText: "Jane Buyer is a Procurement Analyst who reports to the Director.",
      sourceUrl: "https://buyer.example/team",
      companyDomain: "buyer.example",
      companyName: "Buyer Engineering",
      contactName: "Jane Buyer",
      contactTitle: "Procurement Director",
    })).toBe(false);
  });
});

function contactAssessment(): WebsiteAssessment {
  return {
    url: "https://buyer.example/",
    domain: "buyer.example",
    reachable: true,
    parked: false,
    title: "Buyer Engineering",
    text: "Jane Buyer Procurement Manager",
    emails: ["jane.buyer@buyer.example"],
    phones: [],
    activitySignals: [],
    activityScore: 10,
    pages: [{
      url: "https://buyer.example/team",
      title: "Leadership",
      text: "Jane Buyer, Procurement Manager",
      emails: ["jane.buyer@buyer.example"],
      emailEvidence: [{
        email: "jane.buyer@buyer.example",
        context: "Jane Buyer, Procurement Manager Email Jane",
      }],
      contactContexts: ["Jane Buyer, Procurement Manager Email Jane"],
      evidenceScopes: [{
        id: "scope_jane",
        text: "Jane Buyer, Procurement Manager Email Jane",
        ambiguous: false,
        emails: [{ email: "jane.buyer@buyer.example", method: "mailto" }],
      }],
    }],
  };
}

function normalizeEmail(email: string, emailSourceUrl = "https://buyer.example/team") {
  return normalizeEvidencedContacts({
    rawContacts: [{
      name: "Jane Buyer",
      title: "Procurement Manager",
      email,
      emailSourceUrl,
      sourceScopeId: "scope_jane",
      emailScopeId: "scope_jane",
      sourceUrl: "https://buyer.example/team",
      evidence: "Official leadership page",
      employmentVerified: true,
    }],
    candidate: { company: "Buyer Engineering Sdn Bhd", domain: "buyer.example" },
    assessment: contactAssessment(),
    evidenceResults: [],
    maxContacts: 4,
  })[0];
}

describe("public contact email evidence", () => {
  it("accepts an exact same-domain page email linked to a verified current role", () => {
    expect(normalizeEmail("jane.buyer@buyer.example")).toMatchObject({
      email: "jane.buyer@buyer.example",
      emailSourceUrl: "https://buyer.example/team",
      employmentVerified: true,
    });
  });

  it("drops invented and cross-domain addresses without dropping the evidenced person", () => {
    expect(normalizeEmail("invented@buyer.example")).toMatchObject({ email: null });
    expect(normalizeEmail("jane.buyer@unrelated.example")).toMatchObject({ email: null });
    expect(normalizeEmail("ane.buyer@buyer.example")).toMatchObject({ email: null });
  });

  it("does not bind another person's email from the same team page", () => {
    const assessment = contactAssessment();
    assessment.pages[0] = {
      url: "https://buyer.example/team",
      title: "Leadership",
      text: "Jane Buyer, Procurement Manager. John Boss, Managing Director.",
      emails: ["jane.buyer@buyer.example", "john.boss@buyer.example"],
      emailEvidence: [
        { email: "jane.buyer@buyer.example", context: "Jane Buyer, Procurement Manager Email Jane" },
        { email: "john.boss@buyer.example", context: "John Boss, Managing Director Email John" },
      ],
      contactContexts: [
        "Jane Buyer, Procurement Manager Email Jane",
        "John Boss, Managing Director Email John",
      ],
      evidenceScopes: [
        {
          id: "scope_jane",
          text: "Jane Buyer, Procurement Manager Email Jane",
          ambiguous: false,
          emails: [{ email: "jane.buyer@buyer.example", method: "mailto" }],
        },
        {
          id: "scope_john",
          text: "John Boss, Managing Director Email John",
          ambiguous: false,
          emails: [{ email: "john.boss@buyer.example", method: "mailto" }],
        },
      ],
    };
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "john.boss@buyer.example",
        emailSourceUrl: "https://buyer.example/team",
        sourceScopeId: "scope_jane",
        emailScopeId: "scope_john",
        sourceUrl: "https://buyer.example/team",
        evidence: "Official team page",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering Sdn Bhd", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ email: null, employmentVerified: true });
  });

  it("keeps different private-suffix tenants isolated", () => {
    const assessment: WebsiteAssessment = {
      ...contactAssessment(),
      url: "https://buyer.github.io/",
      domain: "buyer.github.io",
      emails: ["jane@other.github.io"],
      pages: [{
        url: "https://buyer.github.io/team",
        title: "Leadership",
        text: "Jane Buyer, Procurement Manager",
        emails: ["jane@other.github.io"],
        emailEvidence: [{
          email: "jane@other.github.io",
          context: "Jane Buyer, Procurement Manager",
        }],
        contactContexts: ["Jane Buyer, Procurement Manager"],
        evidenceScopes: [{
          id: "scope_jane",
          text: "Jane Buyer, Procurement Manager",
          ambiguous: false,
          emails: [{ email: "jane@other.github.io", method: "text" }],
        }],
      }],
    };
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "jane@other.github.io",
        emailSourceUrl: "https://buyer.github.io/team",
        sourceScopeId: "scope_jane",
        emailScopeId: "scope_jane",
        sourceUrl: "https://buyer.github.io/team",
        evidence: "Official team page",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.github.io" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ email: null, employmentVerified: true });
  });

  it("requires a separate email source page to name the contact", () => {
    const assessment = contactAssessment();
    assessment.pages.push({
      url: "https://buyer.example/contact",
      title: "Contact",
      text: "General contact route",
      emails: ["jane.buyer@buyer.example"],
      emailEvidence: [{
        email: "jane.buyer@buyer.example",
        context: "General contact route",
      }],
      contactContexts: ["General contact route"],
      evidenceScopes: [{
        id: "scope_contact",
        text: "General contact route",
        ambiguous: false,
        emails: [{ email: "jane.buyer@buyer.example", method: "text" }],
      }],
    });
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "jane.buyer@buyer.example",
        emailSourceUrl: "https://buyer.example/contact",
        sourceScopeId: "scope_jane",
        emailScopeId: "scope_contact",
        sourceUrl: "https://buyer.example/team",
        evidence: "Official pages",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering Sdn Bhd", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ email: null, employmentVerified: true });
  });

  it("never accepts an email found only in a search snippet", () => {
    const assessment = contactAssessment();
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        email: "jane.buyer@buyer.example",
        emailSourceUrl: "https://conference.example/speaker/jane",
        sourceUrl: "https://conference.example/speaker/jane",
        evidence: "Search result",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering Sdn Bhd", domain: "buyer.example" },
      assessment,
      evidenceResults: [{
        title: "Jane Buyer - Buyer Engineering",
        url: "https://conference.example/speaker/jane",
        snippet: "Jane Buyer, Procurement Manager at Buyer Engineering. jane.buyer@buyer.example",
        sourceType: "search",
        sourceDate: null,
        query: "fixture",
      }],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ employmentVerified: true, email: null });
  });

  it("keeps only a LinkedIn profile URL present in the supplied evidence", () => {
    const rawContact = {
      name: "Jane Buyer",
      title: "Procurement Manager",
      sourceScopeId: "scope_jane",
      sourceUrl: "https://buyer.example/team",
      employmentVerified: true,
    };
    const invented = normalizeEvidencedContacts({
      rawContacts: [{ ...rawContact, linkedin: "https://www.linkedin.com/in/invented-jane" }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment: contactAssessment(),
      evidenceResults: [],
      maxContacts: 4,
    });
    const evidencedUrl = "https://www.linkedin.com/in/jane-buyer";
    const evidenced = normalizeEvidencedContacts({
      rawContacts: [{ ...rawContact, linkedin: evidencedUrl }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment: contactAssessment(),
      evidenceResults: [{
        title: "Jane Buyer | LinkedIn",
        url: evidencedUrl,
        snippet: "Jane Buyer, Procurement Manager at Buyer Engineering",
        sourceType: "search",
        sourceDate: null,
        query: "fixture",
      }],
      maxContacts: 4,
    });

    expect(invented[0]).toMatchObject({ linkedin: null });
    expect(evidenced[0]).toMatchObject({ linkedin: evidencedUrl });
  });

  it("rejects an allowed LinkedIn profile whose evidence names another contact", () => {
    const johnUrl = "https://www.linkedin.com/in/john-boss";
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Procurement Manager",
        sourceScopeId: "scope_jane",
        sourceUrl: "https://buyer.example/team",
        linkedin: johnUrl,
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment: contactAssessment(),
      evidenceResults: [{
        title: "John Boss | LinkedIn",
        url: johnUrl,
        snippet: "John Boss, Engineering Director at Buyer Engineering",
        sourceType: "search",
        sourceDate: null,
        query: "fixture",
      }],
      maxContacts: 4,
    });

    expect(contacts[0]).toMatchObject({ linkedin: null });
  });

  it("rejects title substrings such as directory", () => {
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title: "Company Directory",
        sourceUrl: "https://buyer.example/team",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering", domain: "buyer.example" },
      assessment: contactAssessment(),
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts).toEqual([]);
  });

  it.each([
    "Product Manager",
    "EHS Manager",
    "Maintenance Manager",
    "Plant Operations Manager",
    "Reliability Manager",
    "Production Manager",
  ])("retains the existing downstream target role %s", (title) => {
    const assessment = contactAssessment();
    const scopeText = `Jane Buyer, ${title}`;
    assessment.text = scopeText;
    assessment.pages[0] = {
      ...assessment.pages[0]!,
      text: scopeText,
      emails: [],
      emailEvidence: [],
      contactContexts: [scopeText],
      evidenceScopes: [{ id: "scope_jane", text: scopeText, ambiguous: false, emails: [] }],
    };
    const contacts = normalizeEvidencedContacts({
      rawContacts: [{
        name: "Jane Buyer",
        title,
        sourceScopeId: "scope_jane",
        sourceUrl: "https://buyer.example/team",
        employmentVerified: true,
      }],
      candidate: { company: "Buyer Engineering Sdn Bhd", domain: "buyer.example" },
      assessment,
      evidenceResults: [],
      maxContacts: 4,
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ title, employmentVerified: true });
  });
});

function inventoryContact(input: Partial<ContactCandidate> & Pick<ContactCandidate, "name" | "title">): ContactCandidate {
  return {
    name: input.name,
    title: input.title,
    email: null,
    emailSourceUrl: null,
    sourceScopeId: "scope",
    emailScopeId: null,
    linkedin: null,
    sourceUrl: "https://buyer.example/team",
    evidence: "public evidence",
    employmentVerified: true,
    recipientTier: "A",
    officialMailboxEvidence: null,
    ...input,
  };
}

describe("contact inventory merging", () => {
  it("keeps the official tier-B record when a person candidate claims the same role mailbox", () => {
    const people = [inventoryContact({
      name: "Jane Buyer",
      title: "Sales Manager",
      email: "sales@buyer.example",
      emailSourceUrl: "https://buyer.example/contact",
      emailScopeId: "scope_sales",
    })];
    const companyMailboxes = [inventoryContact({
      name: "Buyer Engineering team",
      title: "Company mailbox",
      email: "sales@buyer.example",
      emailSourceUrl: "https://buyer.example/contact",
      emailScopeId: "scope_sales",
      recipientTier: "B",
      employmentVerified: false,
      officialMailboxEvidence: {
        sourceUrl: "https://buyer.example/contact",
        exactText: "Sales: sales@buyer.example",
        observedAt: "2026-07-22T00:00:00.000Z",
      },
    })];

    const merged = mergeContactCandidatesForInventory({ people, companyMailboxes, maxContacts: 4 });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      email: "sales@buyer.example",
      recipientTier: "B",
      officialMailboxEvidence: expect.objectContaining({ sourceUrl: "https://buyer.example/contact" }),
    });
  });

  it("keeps distinct evidenced people that do not yet have email addresses", () => {
    const people = [
      inventoryContact({ name: "Jane Buyer", title: "Procurement Manager" }),
      inventoryContact({ name: "John Boss", title: "Managing Director" }),
    ];

    const merged = mergeContactCandidatesForInventory({ people, companyMailboxes: [], maxContacts: 4 });

    expect(merged.map((contact) => contact.name)).toEqual(["Jane Buyer", "John Boss"]);
  });
});
