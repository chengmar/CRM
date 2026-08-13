import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutonomousPilotCatalogError,
  AutonomousPilotLaunchBlockedError,
  autonomousPilotCapabilityWarnings,
  autonomousPilotLaunchBlockers,
  launchAutonomousPilotFromCatalog,
  loadAutonomousPilotCatalog,
} from "../src/acquisition/autonomous-pilot-catalog.js";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { markEmailChannelSelfTestPassed } from "../src/outreach/email-channel.js";

const tempDirs: string[] = [];
const sourceSpecPath = fileURLToPath(new URL(
  "./fixtures/autonomous-pilot-spec.json",
  import.meta.url,
));

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixtureSpec(): Record<string, unknown> {
  const spec = JSON.parse(fs.readFileSync(sourceSpecPath, "utf8")) as Record<string, unknown> & {
    launchKey: string;
    actionId: string;
    campaign: { targetCount: number };
    brief: { id: string; deadline: string };
    sellerKnowledge: {
      profile: { validFrom: string; validTo: string; sender: { email: string } };
      facts: Array<{ validFrom: string; validTo: string }>;
      offers: Array<{ validFrom: string; validTo: string }>;
    };
    validFrom: string;
    expiresAt: string;
  };
  spec.launchKey = "catalog-security-fixture";
  spec.actionId = "catalog-security-fixture:authorized";
  spec.brief.id = "catalog-security-fixture-brief";
  spec.validFrom = "2020-01-01T00:00:00.000Z";
  spec.expiresAt = "2099-01-01T00:00:00.000Z";
  spec.brief.deadline = "2098-12-31T00:00:00.000Z";
  spec.sellerKnowledge.profile.validFrom = spec.validFrom;
  spec.sellerKnowledge.profile.validTo = spec.expiresAt;
  for (const fact of spec.sellerKnowledge.facts) {
    fact.validFrom = spec.validFrom;
    fact.validTo = spec.expiresAt;
  }
  for (const offer of spec.sellerKnowledge.offers) {
    offer.validFrom = spec.validFrom;
    offer.validTo = spec.expiresAt;
  }
  return spec;
}

function workspace(): { root: string; business: string; catalog: string; db: AgentDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-pilot-catalog-"));
  tempDirs.push(root);
  const business = path.join(root, "business");
  const catalog = path.join(business, "autonomous_pilot_specs");
  fs.mkdirSync(business, { recursive: true });
  return { root, business, catalog, db: new AgentDatabase(path.join(root, "agent.db")) };
}

function installCatalog(catalog: string, spec = fixtureSpec()): string {
  fs.mkdirSync(catalog, { recursive: true });
  const file = "catalog-fixture.json";
  const campaign = spec.campaign as { targetCount: number };
  fs.writeFileSync(path.join(catalog, file), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(catalog, "manifest.json"), `${JSON.stringify({
    schemaVersion: "production-acquisition-spec-manifest-v1",
    planId: "catalog-security-plan",
    targetTotal: campaign.targetCount,
    campaigns: [{ file, market: "Malaysia", targetCount: campaign.targetCount }],
  }, null, 2)}\n`, "utf8");
  return file;
}

function readyConfig(business: string, overrides: NodeJS.ProcessEnv = {}): AgentConfig {
  const sender = String((fixtureSpec().sellerKnowledge as {
    profile: { sender: { email: string } };
  }).profile.sender.email);
  return loadConfig({
    AGENT_MODE: "production",
    BUSINESS_DATA_DIR: business,
    OUTBOUND_ENABLED: "true",
    EMAIL_OUTREACH_ENABLED: "true",
    EMAIL_INBOUND_ENABLED: "true",
    EMAIL_FROM_ADDRESS: sender,
    EMAIL_FROM_NAME: "Example Sales",
    EMAIL_REPLY_TO: sender,
    EMAIL_UNSUBSCRIBE_TEXT: "Reply unsubscribe to opt out.",
    COMPANY_POSTAL_ADDRESS: "No. 10, Shuangmiao Village, Jiaohe Town, Example City, China",
    EMAIL_DOMAIN_AUTH_VERIFIED: "true",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_USER: sender,
    SMTP_PASSWORD: "fixture-smtp-password",
    IMAP_HOST: "imap.example.test",
    IMAP_PORT: "993",
    IMAP_USER: sender,
    IMAP_PASSWORD: "fixture-imap-password",
    SEARCH_PROVIDER: "searxng",
    SEARXNG_BASE_URL: "https://search.example.test",
    ACQ_SEARXNG_V2_ENABLED: "true",
    ACQ_LOCAL_PUBLIC_WEB_ENABLED: "true",
    ACQ_BOUNCER_V2_ENABLED: "true",
    BOUNCER_API_KEY: "fixture-bouncer-key",
    FEISHU_ALERT_OPEN_IDS: "ou_catalog_fixture",
    ...overrides,
  });
}

function tableCount(db: AgentDatabase, table: string): number {
  return Number((db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function captureCatalogError(operation: () => unknown): AutonomousPilotCatalogError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AutonomousPilotCatalogError);
    return error as AutonomousPilotCatalogError;
  }
  throw new Error("Expected AutonomousPilotCatalogError");
}

describe("Feishu autonomous pilot catalog", () => {
  it("fails closed for a missing catalog, invalid manifest, and lexical path escape", () => {
    const fixture = workspace();
    const config = readyConfig(fixture.business);

    expect(captureCatalogError(() => loadAutonomousPilotCatalog(config, fixture.db)).code)
      .toBe("CATALOG_MISSING");

    fs.mkdirSync(fixture.catalog, { recursive: true });
    fs.writeFileSync(path.join(fixture.catalog, "manifest.json"), "{not-json", "utf8");
    expect(captureCatalogError(() => loadAutonomousPilotCatalog(config, fixture.db)).code)
      .toBe("CATALOG_INVALID");

    fs.writeFileSync(path.join(fixture.catalog, "manifest.json"), JSON.stringify({
      schemaVersion: "production-acquisition-spec-manifest-v1",
      planId: "escape-fixture",
      targetTotal: 1,
      campaigns: [{ file: "../outside.json", market: "Malaysia", targetCount: 1 }],
    }), "utf8");
    expect(captureCatalogError(() => loadAutonomousPilotCatalog(config, fixture.db)).code)
      .toBe("CATALOG_INVALID");
    fixture.db.close();
  });

  it("invalidates an old card when the exact spec file changes", () => {
    const fixture = workspace();
    const file = installCatalog(fixture.catalog);
    const config = readyConfig(fixture.business);
    const entry = loadAutonomousPilotCatalog(config, fixture.db).entries[0]!;
    const changed = fixtureSpec() as Record<string, unknown> & { campaign: { name: string } };
    changed.campaign.name = "Changed after card rendering";
    fs.writeFileSync(path.join(fixture.catalog, file), `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    const error = captureCatalogError(() => launchAutonomousPilotFromCatalog(config, fixture.db, {
      file,
      fileHash: entry.fileHash,
      actor: "ou_approver",
      replyChatId: "oc_catalog_fixture",
    }));
    expect(error.code).toBe("CATALOG_STALE");
    expect(tableCount(fixture.db, "campaign_send_authorizations")).toBe(0);
    fixture.db.close();
  });

  it("blocks a server sender mismatch before creating any authorization", () => {
    const fixture = workspace();
    const file = installCatalog(fixture.catalog);
    const config = readyConfig(fixture.business, {
      EMAIL_FROM_ADDRESS: "different-sender@example.com",
      EMAIL_REPLY_TO: "different-sender@example.com",
      SMTP_USER: "different-sender@example.com",
      IMAP_USER: "different-sender@example.com",
    });
    const entry = loadAutonomousPilotCatalog(config, fixture.db).entries[0]!;

    expect(() => launchAutonomousPilotFromCatalog(config, fixture.db, {
      file,
      fileHash: entry.fileHash,
      actor: "ou_approver",
      replyChatId: "oc_catalog_fixture",
    })).toThrow(AutonomousPilotLaunchBlockedError);
    expect(tableCount(fixture.db, "campaigns")).toBe(0);
    expect(tableCount(fixture.db, "campaign_approvals")).toBe(0);
    expect(tableCount(fixture.db, "campaign_send_authorizations")).toBe(0);
    fixture.db.close();
  });

  it("creates zero launch material until the mailbox self-test has passed", () => {
    const fixture = workspace();
    const file = installCatalog(fixture.catalog);
    const config = readyConfig(fixture.business);
    const entry = loadAutonomousPilotCatalog(config, fixture.db).entries[0]!;

    try {
      launchAutonomousPilotFromCatalog(config, fixture.db, {
        file,
        fileHash: entry.fileHash,
        actor: "ou_approver",
        replyChatId: "oc_catalog_fixture",
      });
      throw new Error("Expected mailbox self-test blocker");
    } catch (error) {
      expect(error).toBeInstanceOf(AutonomousPilotLaunchBlockedError);
      expect((error as AutonomousPilotLaunchBlockedError).blockers)
        .toContain("企业邮箱自发自收验收尚未通过");
    }
    expect(tableCount(fixture.db, "campaigns")).toBe(0);
    expect(tableCount(fixture.db, "campaign_approvals")).toBe(0);
    expect(tableCount(fixture.db, "campaign_send_authorizations")).toBe(0);
    fixture.db.close();
  });

  it("creates exactly bounded authority and preserves the independent runtime switches", () => {
    const fixture = workspace();
    const file = installCatalog(fixture.catalog);
    const config = readyConfig(fixture.business);
    markEmailChannelSelfTestPassed(config, fixture.db, "self-test-fixture");
    fixture.db.setSetting("outbound_paused", "true");
    fixture.db.setSetting("daily_research_enabled", "false");
    const entry = loadAutonomousPilotCatalog(config, fixture.db).entries[0]!;

    const launched = launchAutonomousPilotFromCatalog(config, fixture.db, {
      file,
      fileHash: entry.fileHash,
      actor: "ou_approver",
      replyChatId: "oc_catalog_fixture",
    });

    expect(launched.result.status).toBe("LAUNCHED");
    expect(tableCount(fixture.db, "campaign_approvals")).toBe(3);
    expect(fixture.db.db.prepare("SELECT scope FROM campaign_approvals ORDER BY scope").all())
      .toEqual([
        { scope: "EXTERNAL_SEND" },
        { scope: "PROVIDER_BUDGET" },
        { scope: "SHADOW_PLAN" },
      ]);
    expect(tableCount(fixture.db, "campaign_send_authorizations")).toBe(1);
    expect(tableCount(fixture.db, "outbound_messages")).toBe(0);
    expect(fixture.db.getSetting("outbound_paused")).toBe("true");
    expect(fixture.db.getSetting("daily_research_enabled")).toBe("false");
    fixture.db.close();
  });

  it("launches the tier B path without a configured verifier and keeps tier A visibly paused", () => {
    const fixture = workspace();
    const file = installCatalog(fixture.catalog);
    const config = readyConfig(fixture.business, {
      ACQ_BOUNCER_V2_ENABLED: "false",
      BOUNCER_API_KEY: "",
    });
    markEmailChannelSelfTestPassed(config, fixture.db, "self-test-tier-b-only");
    fixture.db.setSetting("outbound_paused", "true");
    const entry = loadAutonomousPilotCatalog(config, fixture.db).entries[0]!;

    expect(autonomousPilotLaunchBlockers(config, fixture.db, entry))
      .not.toContain("本方案选择的 Bouncer 官方邮箱验证服务未就绪");
    expect(autonomousPilotCapabilityWarnings(config, entry)).toEqual([
      "Bouncer 官方邮箱验证器尚未就绪：B 类官网精确公开职能邮箱仍可研究、生成并授权首封邮件；A 类具名联系人将保持阻断。",
    ]);

    const launched = launchAutonomousPilotFromCatalog(config, fixture.db, {
      file,
      fileHash: entry.fileHash,
      actor: "ou_approver",
      replyChatId: "oc_catalog_fixture",
    });

    expect(launched.result.status).toBe("LAUNCHED");
    expect(tableCount(fixture.db, "campaign_send_authorizations")).toBe(1);
    expect(tableCount(fixture.db, "outbound_messages")).toBe(0);
    expect(fixture.db.getSetting("outbound_paused")).toBe("true");
    fixture.db.close();
  });
});
