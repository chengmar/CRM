import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import {
  buildFunnelReport,
  formatFunnelReport,
  localDayUtcWindow,
  type FunnelSlice,
} from "../src/reporting/funnel.js";
import { DEMAND_POLICY_VERSION, type EmailVerificationStatus } from "../src/types.js";

const tempDirs: string[] = [];
const cohortCreatedAt = "2026-07-19T08:00:00.000Z";
const oldCreatedAt = "2026-07-18T08:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDatabase(): AgentDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-funnel-"));
  tempDirs.push(dir);
  return new AgentDatabase(path.join(dir, "agent.db"));
}

function createCampaign(db: AgentDatabase, name: string, market: string): string {
  return db.createCampaign({
    name,
    market,
    product: "sample products",
    buyerType: "integrator",
    targetCount: 20,
    createdBy: "fixture",
    dailyLimit: 5,
    hourlyLimit: 2,
    followupDays: [3, 7, 14],
  });
}

function createLead(
  db: AgentDatabase,
  campaignId: string,
  domain: string,
  createdAt = cohortCreatedAt,
): string {
  const id = db.upsertLead({
    campaignId,
    company: domain,
    domain,
    website: `https://${domain}`,
    country: "fixture",
    buyerType: "integrator",
    product: "sample products",
    fitScore: 30,
    intentScore: 25,
    activityScore: 20,
    contactScore: 20,
    channelScore: 5,
    totalScore: 100,
    grade: "GOLD",
    lastActivityAt: createdAt,
    demandEvidenceQualified: true,
    demandPolicyVersion: DEMAND_POLICY_VERSION,
    demandStage: "RECENT_PROCUREMENT",
    demandEvidence: [{ sourceUrl: `https://${domain}/rfq` }],
    sendEligible: true,
    eligibilityReasons: [],
  });
  db.db.prepare("UPDATE leads SET created_at=?, updated_at=? WHERE id=?").run(createdAt, createdAt, id);
  return id;
}

function createCandidate(
  db: AgentDatabase,
  campaignId: string,
  domain: string,
  outcome: "SEND_READY" | "ENRICHMENT_PENDING" | "REJECTED",
  createdAt = cohortCreatedAt,
): void {
  db.upsertDiscoveryCandidate({
    campaignId,
    domain,
    company: domain,
    website: `https://${domain}`,
    round: 1,
    stage: outcome === "REJECTED" ? "COMPANY_ANALYSIS" : "CONTACT_ENRICHMENT",
    outcome,
    reason: "fixed funnel fixture",
    sourceCount: 2,
  });
  db.db
    .prepare("UPDATE discovery_candidates SET created_at=?, updated_at=? WHERE campaign_id=? AND domain=?")
    .run(createdAt, createdAt, campaignId, domain);
}

function addContact(
  db: AgentDatabase,
  leadId: string,
  suffix: string,
  status: EmailVerificationStatus,
): string {
  const lead = db.getLead(leadId)!;
  const domain = String(lead.domain);
  const roleMailbox = status === "RISKY";
  const email = roleMailbox ? `sales@${domain}` : `${suffix}@${domain}`;
  const sourceUrl = `https://${domain}/${roleMailbox ? "contact" : `team/${suffix}`}`;
  const officialText = roleMailbox ? `Sales enquiries: ${email}` : null;
  if (officialText) db.addLeadSource(leadId, sourceUrl, "official_website", null, officialText);
  return db.upsertContact({
    leadId,
    name: roleMailbox ? `${domain} team` : `Buyer ${suffix}`,
    title: roleMailbox ? "Company mailbox" : "Procurement Manager",
    email,
    sourceUrl,
    employmentVerifiedAt: roleMailbox ? null : "2026-07-19T09:00:00.000Z",
    emailStatus: status,
    emailRisk: status === "RISKY" ? "MX valid fixture" : "fixed fixture",
    roleAddress: roleMailbox,
    disposableAddress: false,
    catchAll: false,
    officialMailboxEvidence: officialText ? {
      sourceUrl,
      exactText: officialText,
      observedAt: "2026-07-19T09:00:00.000Z",
    } : null,
  });
}

function moveToReady(db: AgentDatabase, leadId: string): void {
  db.transitionLead(leadId, "VERIFYING", "fixture", "company passed");
  db.transitionLead(leadId, "READY_FOR_REVIEW", "fixture", "all gates passed");
}

function approveAndSend(
  db: AgentDatabase,
  campaignId: string,
  leadId: string,
  contactId: string,
  suffix: string,
): void {
  const contact = db.getContact(contactId)!;
  const destination = String(contact.email);
  const messageId = db.createOutboundMessage({
    campaignId,
    leadId,
    contactId,
    channel: "email",
    destination,
    subject: "Fixture",
    body: "Fixture",
    sequenceIndex: 0,
    status: "PENDING_APPROVAL",
  });
  db.approveLeadSequence(leadId, "fixture-reviewer", db.getSequenceReviewHash(leadId));
  db.setSetting("outbound_paused", "false");
  db.claimMessageForSending(messageId, { allowRiskyEmail: true });
  db.markMessageSent(messageId, `<${suffix}@provider.invalid>`);
}

function inbound(
  db: AgentDatabase,
  providerId: string,
  leadId: string | null,
  classification: "P1_INQUIRY" | "P2_INTEREST" | "OTHER_REPLY" | "AUTO_REPLY" | "UNKNOWN" | "BOUNCE" | "SOFT_BOUNCE",
): void {
  db.insertInbound({
    channel: "email",
    providerId,
    fromAddress: `${providerId}@fixture.invalid`,
    bodyText: "fixed fixture",
    receivedAt: "2026-07-21T08:00:00.000Z",
    classification,
    confidence: 1,
    reason: "fixed fixture",
    leadId,
  });
}

function find(slices: FunnelSlice[], label: string): FunnelSlice {
  const value = slices.find((slice) => slice.label === label);
  if (!value) throw new Error(`Missing funnel slice: ${label}`);
  return value;
}

function seedFixedFunnel(db: AgentDatabase): { malaysia: string; vietnam: string } {
  const malaysia = createCampaign(db, "Malaysia campaign", "Malaysia");
  const vietnam = createCampaign(db, "Vietnam campaign", "Vietnam");

  const leadA = createLead(db, malaysia, "a.example");
  const leadB = createLead(db, malaysia, "b.example");
  const leadC = createLead(db, vietnam, "c.example");
  const leadE = createLead(db, malaysia, "lead-only.example");
  const legacyRejected = createLead(db, malaysia, "rejected.example");
  const oldLead = createLead(db, malaysia, "old.example", oldCreatedAt);

  createCandidate(db, malaysia, "a.example", "SEND_READY");
  createCandidate(db, malaysia, "b.example", "SEND_READY");
  createCandidate(db, vietnam, "c.example", "SEND_READY");
  createCandidate(db, malaysia, "rejected.example", "REJECTED");
  createCandidate(db, malaysia, "old.example", "SEND_READY", oldCreatedAt);

  db.addLeadSource(leadA, "https://a.example/about", "official_website", null, "fixture");
  db.addLeadSource(leadA, "https://a.example/projects", "official_website", null, "second URL");
  db.addLeadSource(leadB, "https://b.example/about", "official_website", null, "fixture");
  db.addLeadSource(leadB, "https://expo.example/b", "trade_show", null, "fixture");
  db.addLeadSource(leadB, "https://expo.example/b-2", "trade_show", null, "second URL");
  db.addLeadSource(leadC, "https://expo.example/c", "trade_show", null, "fixture");
  db.addLeadSource(leadE, "https://lead-only.example/about", "official_website", null, "fixture");
  db.addLeadSource(legacyRejected, "https://rejected.example/about", "official_website", null, "legacy fixture");
  db.addLeadSource(oldLead, "https://old.example/about", "official_website", null, "fixture");

  const contactA = addContact(db, leadA, "a", "VALID");
  const contactB = addContact(db, leadB, "b", "RISKY");
  addContact(db, leadC, "c-valid", "VALID");
  addContact(db, leadC, "c-risky", "RISKY");

  moveToReady(db, leadA);
  moveToReady(db, leadB);
  moveToReady(db, leadC);
  db.transitionLead(leadE, "VERIFYING", "fixture", "company passed");
  db.transitionLead(legacyRejected, "VERIFYING", "fixture", "legacy verification");
  db.transitionLead(legacyRejected, "REJECTED", "fixture", "legacy lead did not pass");
  approveAndSend(db, malaysia, leadA, contactA, "a");
  approveAndSend(db, malaysia, leadB, contactB, "b");

  inbound(db, "a-p1-first", leadA, "P1_INQUIRY");
  inbound(db, "a-p1-duplicate", leadA, "P1_INQUIRY");
  inbound(db, "a-other", leadA, "OTHER_REPLY");
  inbound(db, "a-auto", leadA, "AUTO_REPLY");
  inbound(db, "a-unknown", leadA, "UNKNOWN");
  inbound(db, "b-bounce-first", leadB, "BOUNCE");
  inbound(db, "b-bounce-duplicate", leadB, "BOUNCE");
  inbound(db, "b-soft", leadB, "SOFT_BOUNCE");
  inbound(db, "unmatched-p2", null, "P2_INTEREST");
  inbound(db, "old-p2", oldLead, "P2_INTEREST");

  return { malaysia, vietnam };
}

describe("read-only cohort funnel report", () => {
  it("counts each lead once across duplicate URLs and replies while preserving historical stages", () => {
    const db = makeDatabase();
    seedFixedFunnel(db);
    const before = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };

    const report = buildFunnelReport(db, {
      startAt: "2026-07-19T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z",
      generatedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(report.overall.counts).toEqual({
      candidates: 5,
      companyPassed: 4,
      namedEmploymentVerified: 3,
      validEmail: 2,
      riskyEmail: 2,
      verifiedEmail: 3,
      ready: 3,
      approved: 2,
      sent: 2,
      hardBounce: 1,
      humanReply: 1,
      p1: 1,
      p2: 0,
    });
    expect(report.overall.rates).toMatchObject({
      candidateToCompany: 0.8,
      companyToNamedContact: 0.75,
      namedContactToVerifiedEmail: 1,
      readyToApproved: 2 / 3,
      approvedToSent: 1,
      sentToHardBounce: 0.5,
      sentToHumanReply: 0.5,
      humanReplyToP1: 1,
      humanReplyToP2: 0,
    });
    expect(find(report.byMarket, "Malaysia").counts).toMatchObject({
      candidates: 4,
      companyPassed: 3,
      sent: 2,
      hardBounce: 1,
      humanReply: 1,
      p1: 1,
    });
    expect(find(report.byMarket, "Vietnam").counts).toMatchObject({
      candidates: 1,
      companyPassed: 1,
      validEmail: 1,
      riskyEmail: 1,
      verifiedEmail: 1,
      ready: 1,
      approved: 0,
      sent: 0,
    });
    expect(find(report.bySourceType, "official_website").counts).toMatchObject({
      candidates: 4,
      companyPassed: 4,
      namedEmploymentVerified: 3,
      sent: 2,
    });
    expect(find(report.bySourceType, "trade_show").counts).toMatchObject({
      candidates: 2,
      companyPassed: 2,
      namedEmploymentVerified: 2,
      validEmail: 1,
      riskyEmail: 2,
      sent: 1,
      hardBounce: 1,
    });
    const after = db.db.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(after.count).toBe(before.count);
    db.close();
  });

  it("applies campaign, market and source attribution filters without URL multiplication", () => {
    const db = makeDatabase();
    const ids = seedFixedFunnel(db);

    const source = buildFunnelReport(db, {
      startAt: "2026-07-19T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z",
      sourceType: "official_website",
    });
    expect(source.overall.counts).toMatchObject({ candidates: 4, companyPassed: 4, sent: 2 });
    expect(source.bySourceType).toHaveLength(1);
    expect(source.bySourceType[0]?.key).toBe("official_website");
    expect(source.notes.join(" ")).toContain("不含未转为 lead 的候选");

    const campaign = buildFunnelReport(db, {
      startAt: "2026-07-19T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z",
      campaignId: ids.vietnam,
      market: "vietnam",
    });
    expect(campaign.overall.counts).toMatchObject({ candidates: 1, companyPassed: 1, sent: 0 });
    expect(campaign.byCampaign.map((item) => item.key)).toEqual([ids.vietnam]);
    db.close();
  });

  it("formats compact zero-safe text and calculates local-day UTC boundaries", () => {
    const db = makeDatabase();
    const report = buildFunnelReport(db, {
      startAt: "2030-01-01T00:00:00.000Z",
      endAt: "2030-01-02T00:00:00.000Z",
      generatedAt: "2030-01-02T00:00:00.000Z",
    });
    expect(Object.values(report.overall.rates).every((rate) => rate === 0)).toBe(true);
    const text = formatFunnelReport(report);
    expect(text).toContain("created_at cohort");
    expect(text).toContain("来源候选仅含已有 lead_sources 归因的 lead");
    expect(text).toContain("VALID 0 / RISKY 0");
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(localDayUtcWindow(new Date("2026-07-19T12:00:00.000Z"), "Asia/Shanghai")).toEqual({
      localDate: "2026-07-19",
      startAt: "2026-07-18T16:00:00.000Z",
      endAt: "2026-07-19T16:00:00.000Z",
    });
    expect(() => buildFunnelReport(db, {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-19T00:00:00.000Z",
    })).toThrow("endAt must be later than startAt");
    db.close();
  });
});
