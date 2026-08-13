import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabase } from "../src/db.js";
import {
  parseRefreshTierBEvidenceCliArgs,
  refreshTierBEvidence,
  type RefreshTierBEvidenceCliOptions,
} from "../src/acquisition/refresh-tier-b-evidence.js";
import { classifyRecipientTier } from "../src/acquisition/recipient-tier.js";
import { DEMAND_POLICY_VERSION, type WebsiteAssessment } from "../src/types.js";

const directories: string[] = [];
const databases = new Set<AgentDatabase>();
const NOW = new Date("2026-07-23T06:30:00.000Z");
const OLD_OBSERVED_AT = "2026-07-20T06:30:00.000Z";
const manager = {
  actor: "sales-manager",
  actorType: "HUMAN" as const,
  roles: ["SALES_MANAGER" as const],
};

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  databases.clear();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function database(): AgentDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-tier-b-evidence-"));
  directories.push(directory);
  const db = new AgentDatabase(path.join(directory, "agent.db"));
  databases.add(db);
  return db;
}

function campaign(db: AgentDatabase, suffix: string, authorized = true): string {
  const market = "Malaysia";
  const campaignId = db.createCampaign({
    name: `Evidence refresh ${suffix}`,
    market,
    product: "sample product application",
    buyerType: "system integrator",
    targetCount: 500,
    createdBy: "fixture",
    dailyLimit: 10,
    hourlyLimit: 5,
    followupDays: [],
  });
  if (!authorized) return campaignId;
  const draft = db.saveCampaignDraft({
    briefKey: `evidence-refresh:${suffix}`,
    brief: { market, transport: "SMTP" },
    createdBy: "fixture",
  });
  const approval = db.saveCampaignScopedApproval({
    briefId: draft.briefId,
    versionId: draft.versionId,
    scope: "EXTERNAL_SEND",
    actionId: `evidence-refresh-approval:${suffix}`,
    authorizationSource: "TEST_EXPLICIT_AUTHORIZATION",
  }, manager);
  db.saveCampaignSendAuthorization({
    campaignApprovalId: approval.id,
    briefId: draft.briefId,
    versionId: draft.versionId,
    briefHash: draft.briefHash,
    campaignId,
    market,
    transport: "SMTP",
    totalLimit: 500,
    dailyLimit: 10,
    hourlyLimit: 5,
    maximumSequenceIndex: 0,
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    policyVersion: "campaign-autonomous-pilot-v1",
    actionId: `evidence-refresh-send:${suffix}`,
    authorizationSource: "TEST_EXPLICIT_AUTHORIZATION",
  }, manager);
  return campaignId;
}

function leadWithMailbox(input: {
  db: AgentDatabase;
  campaignId: string;
  suffix: string;
  localPart?: string;
  leadId?: string;
  url?: string;
}): { leadId: string; contactId: string; email: string; url: string; domain: string } {
  const domain = `buyer-${input.suffix}.com`;
  const url = input.url ?? `https://${domain}/contact`;
  const leadId = input.leadId ?? input.db.upsertLead({
    campaignId: input.campaignId,
    company: `Sensitive Buyer ${input.suffix}`,
    domain,
    website: `https://${domain}/`,
    country: "Malaysia",
    buyerType: "system integrator",
    product: "sample product application",
    fitScore: 30,
    intentScore: 20,
    activityScore: 15,
    contactScore: 10,
    channelScore: 5,
    totalScore: 80,
    grade: "GOLD",
    demandEvidenceQualified: false,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "ICP_FIT",
    demandEvidence: [],
    sendEligible: true,
    eligibilityReasons: [],
  });
  const storedLead = input.db.getLead(leadId)!;
  const actualDomain = String(storedLead.domain);
  const actualUrl = input.url ?? `https://${actualDomain}/contact`;
  const email = `${input.localPart ?? "sales"}@${actualDomain}`;
  const contactId = input.db.upsertContact({
    leadId,
    name: `${String(storedLead.company)} team`,
    title: "Company mailbox",
    email,
    sourceUrl: actualUrl,
    emailStatus: "UNKNOWN",
    emailRisk: "fixture",
    roleAddress: true,
    disposableAddress: false,
    catchAll: false,
    officialMailboxEvidence: {
      sourceUrl: actualUrl,
      exactText: `Previously observed address: ${email}`,
      observedAt: OLD_OBSERVED_AT,
    },
  });
  expect(input.db.getContact(contactId)?.recipient_tier).toBe("B");
  return { leadId, contactId, email, url: actualUrl, domain: actualDomain };
}

function assessment(url: string, emails: string[]): WebsiteAssessment {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return {
    url,
    domain,
    reachable: true,
    parked: false,
    title: "Contact",
    text: emails.join(" "),
    emails,
    phones: [],
    activitySignals: ["website reachable"],
    activityScore: 8,
    pages: [{
      url,
      title: "Contact",
      text: emails.join(" "),
      evidenceScopes: emails.map((email, index) => ({
        id: `mailbox-${index + 1}`,
        text: `Sales enquiries: ${email}`,
        ambiguous: false,
        emails: [{ email, method: "mailto" }],
      })),
    }],
  };
}

function options(overrides: Partial<RefreshTierBEvidenceCliOptions> = {}): RefreshTierBEvidenceCliOptions {
  return {
    confirmed: true,
    campaignIds: [],
    limit: 500,
    concurrency: 4,
    ...overrides,
  };
}

describe("refresh tier B public evidence CLI", () => {
  it("requires explicit confirmation and parses bounded filters", () => {
    expect(() => parseRefreshTierBEvidenceCliArgs([])).toThrow(/confirm-refresh-public-evidence/);
    expect(parseRefreshTierBEvidenceCliArgs(["--confirm-refresh-public-evidence"]).limit).toBe(500);
    expect(() => parseRefreshTierBEvidenceCliArgs([
      "--confirm-refresh-public-evidence",
      "--confirm-refresh-public-evidence",
    ])).toThrow(/exactly one/);
    expect(parseRefreshTierBEvidenceCliArgs([
      "--confirm-refresh-public-evidence",
      "--campaign=campaign-one",
      "--campaign=campaign-one",
      "--limit=500",
      "--concurrency=8",
    ])).toEqual({
      confirmed: true,
      campaignIds: ["campaign-one"],
      limit: 500,
      concurrency: 8,
    });
  });

  it("atomically refreshes all exact mailboxes on one page with the final merged hash", async () => {
    const db = database();
    const campaignId = campaign(db, "same-page");
    const sales = leadWithMailbox({ db, campaignId, suffix: "same-page", localPart: "sales" });
    const info = leadWithMailbox({
      db,
      campaignId,
      suffix: "same-page",
      localPart: "info",
      leadId: sales.leadId,
      url: sales.url,
    });
    const authorizationBefore = db.db.prepare(
      "SELECT * FROM campaign_send_authorizations WHERE campaign_id=?",
    ).get(campaignId);
    const assessor = vi.fn(async () => assessment(sales.url, [sales.email, info.email]));

    const result = await refreshTierBEvidence(db, options(), { assessor, now: () => NOW });

    expect(result).toMatchObject({
      authorizedCampaignCount: 1,
      tierBContactCount: 2,
      candidateCount: 2,
      selectedCount: 2,
      refreshedCount: 2,
      failedCount: 0,
      errorCounts: [],
    });
    expect(assessor).toHaveBeenCalledTimes(1);
    expect(assessor.mock.calls[0]?.[2]).toBe(1);
    const source = db.listLeadSources(sales.leadId).find((row) => row.source_type === "official_website")!;
    expect(String(source.evidence)).toContain(sales.email);
    expect(String(source.evidence)).toContain(info.email);
    for (const item of [sales, info]) {
      const contact = db.getContact(item.contactId)!;
      const expected = classifyRecipientTier({
        accountDomain: item.domain,
        email: item.email,
        name: String(contact.name),
        title: String(contact.title),
        employmentVerifiedAt: null,
        emailStatus: "UNKNOWN",
        roleAddress: true,
        disposableAddress: false,
        catchAll: false,
        officialMailboxEvidence: {
          sourceUrl: String(source.source_url),
          exactText: String(source.evidence),
          observedAt: String(source.created_at),
        },
        asOf: NOW,
      });
      expect(contact.email).toBe(item.email);
      expect(contact.recipient_evidence_hash).toBe(expected.evidenceHash);
      expect(contact.recipient_evidence_observed_at).toBe(NOW.toISOString());
    }
    expect(db.db.prepare(
      "SELECT * FROM campaign_send_authorizations WHERE campaign_id=?",
    ).get(campaignId)).toEqual(authorizationBefore);
    expect(db.db.prepare("SELECT count(*) AS count FROM outbound_messages").get()).toEqual({ count: 0 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sales.email);
    expect(serialized).not.toContain(sales.url);
    expect(serialized).not.toContain("Sensitive Buyer");

    const second = await refreshTierBEvidence(db, options(), { assessor, now: () => NOW });
    expect(second).toMatchObject({ candidateCount: 0, attemptedCount: 0, refreshedCount: 0 });
    expect(assessor).toHaveBeenCalledTimes(1);
  });

  it("does not persist when the page does not contain the exact mailbox", async () => {
    const db = database();
    const campaignId = campaign(db, "missing");
    const contact = leadWithMailbox({ db, campaignId, suffix: "missing" });
    const result = await refreshTierBEvidence(db, options(), {
      assessor: async () => assessment(contact.url, ["info@unrelated-domain.com"]),
      now: () => NOW,
    });
    expect(result).toMatchObject({ refreshedCount: 0, failedCount: 1 });
    expect(result.errorCounts).toEqual([{ code: "EXACT_EMAIL_NOT_FOUND", count: 1 }]);
    expect(db.listLeadSources(contact.leadId)).toHaveLength(0);
  });

  it("rejects invalid and cross-domain evidence URLs before any fetch", async () => {
    const db = database();
    const campaignId = campaign(db, "bad-url");
    const invalid = leadWithMailbox({ db, campaignId, suffix: "invalid-url" });
    const crossDomain = leadWithMailbox({ db, campaignId, suffix: "cross-domain" });
    db.db.prepare("UPDATE contacts SET recipient_evidence_url='not a public URL' WHERE id=?")
      .run(invalid.contactId);
    db.db.prepare("UPDATE contacts SET recipient_evidence_url='https://different-company.com/contact' WHERE id=?")
      .run(crossDomain.contactId);
    const assessor = vi.fn(async () => assessment(invalid.url, [invalid.email]));
    const result = await refreshTierBEvidence(db, options(), { assessor, now: () => NOW });
    expect(result).toMatchObject({ candidateCount: 2, refreshedCount: 0, failedCount: 2 });
    expect(result.errorCounts).toEqual([
      { code: "EVIDENCE_URL_DOMAIN_MISMATCH", count: 1 },
      { code: "EVIDENCE_URL_INVALID", count: 1 },
    ]);
    expect(assessor).not.toHaveBeenCalled();
  });

  it("ignores contacts outside current autonomous authorization and honors campaign filters", async () => {
    const db = database();
    const authorizedCampaign = campaign(db, "authorized");
    const unauthorizedCampaign = campaign(db, "unauthorized", false);
    const authorized = leadWithMailbox({ db, campaignId: authorizedCampaign, suffix: "authorized" });
    leadWithMailbox({ db, campaignId: unauthorizedCampaign, suffix: "unauthorized" });
    const assessor = vi.fn(async () => assessment(authorized.url, [authorized.email]));
    const filteredOut = await refreshTierBEvidence(
      db,
      options({ campaignIds: [unauthorizedCampaign] }),
      { assessor, now: () => NOW },
    );
    expect(filteredOut).toMatchObject({
      authorizedCampaignCount: 0,
      tierBContactCount: 0,
      attemptedCount: 0,
    });
    const result = await refreshTierBEvidence(db, options(), { assessor, now: () => NOW });
    expect(result).toMatchObject({
      authorizedCampaignCount: 1,
      tierBContactCount: 1,
      refreshedCount: 1,
    });
    expect(assessor).toHaveBeenCalledTimes(1);
  });

  it("processes 113 eligible contacts in one confirmed limit-500 run", async () => {
    const db = database();
    const campaignId = campaign(db, "batch-113");
    const assessments = new Map<string, WebsiteAssessment>();
    for (let index = 0; index < 113; index += 1) {
      const contact = leadWithMailbox({ db, campaignId, suffix: `batch-${index}` });
      assessments.set(contact.url, assessment(contact.url, [contact.email]));
    }
    const assessor = vi.fn(async (url: string) => {
      const found = assessments.get(url);
      if (!found) throw new Error("fixture assessment missing");
      return found;
    });
    const result = await refreshTierBEvidence(db, options({ limit: 500, concurrency: 8 }), {
      assessor,
      now: () => NOW,
    });
    expect(result).toMatchObject({
      candidateCount: 113,
      selectedCount: 113,
      deferredByLimitCount: 0,
      attemptedCount: 113,
      refreshedCount: 113,
      failedCount: 0,
    });
    expect(assessor).toHaveBeenCalledTimes(113);
  });
});
