import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentDatabase } from "../agent_service/dist/db.js";

const [sourceArgument, targetArgument, reportArgument] = process.argv.slice(2);

if (!sourceArgument || !targetArgument || !reportArgument) {
  throw new Error(
    "Usage: node scripts/rehearse-v15-v16.mjs <source-v15.db> <target-v16.db> <report.json>",
  );
}

const sourcePath = path.resolve(sourceArgument);
const targetPath = path.resolve(targetArgument);
const reportPath = path.resolve(reportArgument);
const rollbackPath = `${targetPath}.rollback-v15.db`;

if (!existsSync(sourcePath)) throw new Error("Source v15 database does not exist");
if (existsSync(targetPath)) throw new Error("Target rehearsal database already exists");
if (existsSync(rollbackPath)) throw new Error("Rollback rehearsal database already exists");

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function settings(database) {
  const rows = database.prepare(
    "SELECT key, value FROM settings " +
    "WHERE key IN ('outbound_paused','daily_research_enabled') ORDER BY key",
  ).all();
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

function snapshot(database) {
  const quickCheck = database.prepare("PRAGMA quick_check").all()
    .map((row) => String(row.quick_check));
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  return {
    schema: Number(database.prepare("PRAGMA user_version").get().user_version),
    campaigns: count(database, "campaigns"),
    leads: count(database, "leads"),
    contacts: count(database, "contacts"),
    outboundMessages: count(database, "outbound_messages"),
    settings: settings(database),
    quickCheck,
    foreignKeyViolations,
  };
}

const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
const source = new DatabaseSync(sourcePath, { readOnly: true });
let before;
try {
  before = snapshot(source);
} finally {
  source.close();
}

if (before.schema !== 15 || before.quickCheck.join(",") !== "ok" || before.foreignKeyViolations !== 0) {
  throw new Error("Source database is not a healthy schema v15 snapshot");
}

mkdirSync(path.dirname(targetPath), { recursive: true });
copyFileSync(sourcePath, targetPath);

const migrated = new AgentDatabase(targetPath);
let after;
let bouncer;
let migrationRows;
try {
  after = snapshot(migrated.db);
  bouncer = migrated.db.prepare(
    "SELECT provider_key, provider_kind, status " +
    "FROM provider_registry WHERE id='provider_bouncer'",
  ).get();
  migrationRows = Number(migrated.db.prepare(
    "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=16",
  ).get().count);
} finally {
  migrated.close();
}

const countsPreserved = ["campaigns", "leads", "contacts", "outboundMessages"]
  .every((key) => before[key] === after[key]);
const gatesPreserved = after.settings.outbound_paused === "true" &&
  after.settings.daily_research_enabled === "false";
copyFileSync(sourcePath, rollbackPath);
const rollback = new DatabaseSync(rollbackPath, { readOnly: true });
let rollbackSnapshot;
try {
  rollbackSnapshot = snapshot(rollback);
} finally {
  rollback.close();
}
const rollbackHash = createHash("sha256").update(readFileSync(rollbackPath)).digest("hex");
const rollbackReady = rollbackHash === sourceHash &&
  JSON.stringify(rollbackSnapshot) === JSON.stringify(before);
const passed = after.schema === 16 &&
  after.quickCheck.join(",") === "ok" &&
  after.foreignKeyViolations === 0 &&
  countsPreserved &&
  gatesPreserved &&
  rollbackReady &&
  bouncer?.provider_key === "bouncer" &&
  bouncer?.provider_kind === "EMAIL_VERIFICATION" &&
  bouncer?.status === "ENABLED" &&
  migrationRows === 1;

const report = {
  generatedAt: new Date().toISOString(),
  result: passed ? "PASS" : "BLOCKED",
  source: {
    path: sourcePath,
    sha256: sourceHash,
  },
  target: { path: targetPath },
  rollback: {
    path: rollbackPath,
    sha256: rollbackHash,
    snapshot: rollbackSnapshot,
  },
  before,
  after,
  countsPreserved,
  gatesPreserved,
  rollbackReady,
  bouncer,
  migrationRows,
};

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (!passed) throw new Error(`Migration rehearsal blocked; report=${reportPath}`);
console.log(JSON.stringify({
  result: report.result,
  report: reportPath,
  beforeSchema: before.schema,
  afterSchema: after.schema,
  countsPreserved,
  gatesPreserved,
  rollbackReady,
}, null, 2));
