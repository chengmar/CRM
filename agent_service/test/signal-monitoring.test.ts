import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persistAndExecuteSignalRule } from "../src/acquisition/signal-monitoring-db.js";
import {
  evaluateSignalRuleRun,
  executeSignalRulePlan,
  planConflictingFollowupCancellation,
  planMonitoringCycle,
  runSignalMonitoringShadow,
  type LocalControlIntent,
  type OutreachControlIntent,
  type SalesTaskIntent,
  type SignalRuleLedger,
  type SignalRuleRunPlan,
  type StoredSignalRuleRun,
  type TaskCancellationIntent,
} from "../src/acquisition/signal-monitoring.js";
import { AgentDatabase } from "../src/db.js";

const asOf = "2026-07-20T00:00:00.000Z";

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: "signal-expansion-1",
    accountId: "account-1",
    personId: null,
    signalType: "PLANT_EXPANSION",
    sourceUrl: "https://buyer.fixture.invalid/news/expansion",
    sourceKind: "OFFICIAL_WEBSITE",
    exactQuote: "The company announced a new production line.",
    publishedAt: "2026-07-01T00:00:00.000Z",
    observedAt: "2026-07-02T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    confidence: 0.9,
    authorityClass: "T1_COMPANY_OFFICIAL",
    entityMatch: "MATCHED",
    diagnosticCount: null,
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rulev-1",
    ruleKey: "expansion-review",
    version: 1,
    status: "APPROVED",
    condition: {
      signalTypes: ["PLANT_EXPANSION"],
      minimumConfidence: 0.8,
      allowedAuthorityClasses: ["T1_COMPANY_OFFICIAL"],
      allowedSourceKinds: ["OFFICIAL_WEBSITE"],
      maximumAgeDays: 365,
      requirePublishedAt: true,
    },
    actions: ["ENQUEUE_ACCOUNT_RESEARCH", "NOTIFY_OWNER"],
    owner: "owner-1",
    dueInMinutes: 60,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    asOf,
    accountId: "account-1",
    playId: "play-1",
    enrollmentId: "enrollment-1",
    owner: "owner-1",
    accountState: "WATCHLIST",
    dncMatch: false,
    existingCustomer: false,
    activeOpportunity: false,
    humanTakeover: false,
    ownershipConflict: false,
    territoryConflict: false,
    ...overrides,
  };
}

function evaluate(overrides: Record<string, unknown> = {}): SignalRuleRunPlan {
  return evaluateSignalRuleRun({
    rule: rule(),
    signals: [signal()],
    context: context(),
    pendingTasks: [],
    pendingOutreach: [],
    ...overrides,
  });
}

class MemoryLedger implements SignalRuleLedger {
  readonly runs = new Map<string, StoredSignalRuleRun>();
  readonly tasks = new Set<string>();
  readonly cancelled = new Set<string>();
  readonly outreach = new Set<string>();
  readonly controls = new Set<string>();

  transaction<T>(operation: () => T): T { return operation(); }
  getRuleRun(idempotencyKey: string): StoredSignalRuleRun | null {
    return this.runs.get(idempotencyKey) ?? null;
  }
  recordRuleRun(plan: SignalRuleRunPlan): void {
    this.runs.set(plan.idempotencyKey, {
      idempotencyKey: plan.idempotencyKey,
      planHash: plan.planHash,
    });
  }
  upsertSalesTask(intent: SalesTaskIntent): boolean {
    if (this.tasks.has(intent.idempotencyKey)) return false;
    this.tasks.add(intent.idempotencyKey);
    return true;
  }
  cancelSalesTask(intent: TaskCancellationIntent): boolean {
    if (this.cancelled.has(intent.idempotencyKey)) return false;
    this.cancelled.add(intent.idempotencyKey);
    return true;
  }
  applyOutreachControl(intent: OutreachControlIntent): boolean {
    if (this.outreach.has(intent.idempotencyKey)) return false;
    this.outreach.add(intent.idempotencyKey);
    return true;
  }
  recordLocalControl(intent: LocalControlIntent): boolean {
    if (this.controls.has(intent.idempotencyKey)) return false;
    this.controls.add(intent.idempotencyKey);
    return true;
  }
}

describe("WO-11 signal monitoring and rule engine", () => {
  it("persists signals, rule versions, and local task effects atomically with stable replay", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signal-rule-db-"));
    const db = new AgentDatabase(path.join(directory, "agent.db"));
    try {
      const accountId = db.upsertAccount({
        domain: "signal-rule.example",
        displayName: "Signal Rule Fixture",
        countryCode: "MY",
        accountType: "END_USER",
      });
      const input = {
        db,
        rule: rule(),
        signals: [signal({ accountId })],
        context: context({ accountId, playId: null, enrollmentId: null }),
        pendingTasks: [],
        pendingOutreach: [],
        createdBy: "signal-rule-test",
      } as never;
      const first = persistAndExecuteSignalRule(input);
      expect(first.execution).toEqual({
        created: true,
        tasksCreated: 1,
        tasksCancelled: 0,
        outreachControlled: 0,
        localControlsRecorded: 1,
        externalActions: 0,
      });
      expect(db.db.prepare("SELECT count(*) AS count FROM signal_observations").get())
        .toMatchObject({ count: 1 });
      expect(db.db.prepare("SELECT count(*) AS count FROM rule_versions").get())
        .toMatchObject({ count: 1 });
      expect(db.db.prepare("SELECT count(*) AS count FROM sales_tasks WHERE status='OPEN'").get())
        .toMatchObject({ count: 1 });
      expect(db.db.prepare(
        "SELECT count(*) AS count FROM events WHERE entity_type='signal_rule_run'",
      ).get()).toMatchObject({ count: 1 });

      const replay = persistAndExecuteSignalRule(input);
      expect(replay.execution).toMatchObject({ created: false, tasksCreated: 0, externalActions: 0 });
      expect(db.db.prepare("SELECT count(*) AS count FROM signal_observations").get())
        .toMatchObject({ count: 1 });
      expect(db.db.prepare("SELECT count(*) AS count FROM sales_tasks").get())
        .toMatchObject({ count: 1 });
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rejects any rule action outside the local allowlist", () => {
    expect(() => evaluate({ rule: rule({ actions: ["SEND"] }) })).toThrow();
    expect(() => evaluate({ rule: rule({ actions: ["APPROVE"] }) })).toThrow();
    expect(() => evaluate({ rule: rule({ actions: ["REMOVE_DNC"] }) })).toThrow();
    expect(() => evaluate({ rule: rule({ actions: ["QUOTE"] }) })).toThrow();
  });

  it("turns a fresh, entity-bound T1 expansion into local review work, never qualification or sending", () => {
    const plan = evaluate();
    expect(plan).toMatchObject({
      decision: "LOCAL_ACTIONS_READY",
      qualificationEffect: "ACTIVE_INTENT_CANDIDATE",
      blockers: [],
      commitLocalEffects: true,
      safety: {
        externalCalls: 0,
        paidCalls: 0,
        externalWrites: 0,
        messagesSent: 0,
        qualificationMutations: 0,
      },
    });
    expect(plan.taskIntents).toHaveLength(1);
    expect(plan.taskIntents[0]).toMatchObject({
      taskType: "ACCOUNT_RESEARCH",
      externalAction: "NONE",
    });
    expect(plan.localControls).toEqual([
      expect.objectContaining({ type: "NOTIFY_OWNER", externalAction: "NONE" }),
    ]);
  });

  it("is stable when the same input signals are replayed in a different order", () => {
    const secondSignal = signal({
      id: "signal-expansion-2",
      exactQuote: "The project includes a second line.",
      sourceUrl: "https://buyer.fixture.invalid/news/line-two",
    });
    const first = evaluate({ signals: [signal(), secondSignal] });
    const replay = evaluate({ signals: [secondSignal, signal()] });
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect(replay.planHash).toBe(first.planHash);
    expect(replay.taskIntents).toEqual(first.taskIntents);
  });

  it("blocks expired evidence and treats open counts as diagnostics only", () => {
    const expired = evaluate({ signals: [signal({ expiresAt: "2026-07-19T00:00:00.000Z" })] });
    expect(expired).toMatchObject({
      decision: "NO_ACTIONABLE_SIGNAL",
      qualificationEffect: "NONE",
      taskIntents: [],
    });
    expect(expired.blockers).toContain("SIGNAL_EXPIRED");

    const openOnly = evaluate({
      rule: rule({
        condition: {
          signalTypes: ["OPEN_TRACKING"],
          minimumConfidence: 0,
          allowedAuthorityClasses: [],
          allowedSourceKinds: ["OPEN_TRACKING"],
          maximumAgeDays: 30,
          requirePublishedAt: false,
        },
        actions: ["CREATE_MANUAL_CALL_TASK"],
      }),
      signals: [signal({
        id: "signal-open-1",
        signalType: "OPEN_TRACKING",
        sourceKind: "OPEN_TRACKING",
        sourceUrl: "https://tracking.fixture.invalid/diagnostic/1",
        exactQuote: "Diagnostic open event count only.",
        publishedAt: null,
        authorityClass: "OTHER",
        diagnosticCount: 99,
      })],
    });
    expect(openOnly.decision).toBe("NO_ACTIONABLE_SIGNAL");
    expect(openOnly.blockers).toContain("OPEN_TRACKING_DIAGNOSTIC_ONLY");
    expect(openOnly.taskIntents).toEqual([]);
    expect(openOnly.qualificationEffect).toBe("NONE");
  });

  it("handles job change by freezing old outreach, marking prior employment former, and creating re-verification only", () => {
    const jobSignal = signal({
      id: "signal-job-change-1",
      personId: "person-1",
      signalType: "JOB_CHANGE",
      sourceUrl: "https://provider.fixture.invalid/employment/person-1",
      sourceKind: "LICENSED_PROVIDER",
      exactQuote: "The current-employment assertion is no longer present.",
      publishedAt: null,
      authorityClass: "LICENSED_B2B_PROVIDER",
    });
    const plan = evaluate({
      rule: rule({
        ruleKey: "job-change-review",
        condition: {
          signalTypes: ["JOB_CHANGE"],
          minimumConfidence: 0.8,
          allowedAuthorityClasses: ["LICENSED_B2B_PROVIDER"],
          allowedSourceKinds: ["LICENSED_PROVIDER"],
          maximumAgeDays: 90,
          requirePublishedAt: false,
        },
        actions: ["REVERIFY_EMPLOYMENT", "NOTIFY_OWNER"],
      }),
      signals: [jobSignal],
      pendingTasks: [
        {
          id: "task-old-call",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          taskType: "CALL",
          status: "OPEN",
          owner: "owner-1",
          dueAt: "2026-07-21T00:00:00.000Z",
        },
        {
          id: "task-technical",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          taskType: "TECHNICAL_REVIEW",
          status: "OPEN",
          owner: "owner-1",
          dueAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      pendingOutreach: [
        {
          id: "message-unsent",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          status: "APPROVED",
        },
        {
          id: "message-already-sent",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          status: "SENT",
        },
      ],
    });
    expect(plan.taskIntents).toEqual([
      expect.objectContaining({ taskType: "EMPLOYMENT_REVERIFY", personId: "person-1" }),
    ]);
    expect(plan.taskCancellations.map((intent) => intent.taskId)).toEqual(["task-old-call"]);
    expect(plan.outreachControls).toEqual([
      expect.objectContaining({ outreachId: "message-unsent", action: "FREEZE", reason: "JOB_CHANGE" }),
    ]);
    expect(plan.localControls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "MARK_EMPLOYMENT_FORMER",
        personId: "person-1",
        payload: expect.objectContaining({
          newEmployerAssignment: "NONE",
          emailMutation: "NONE",
        }),
      }),
      expect.objectContaining({ type: "FREEZE_OUTREACH", personId: "person-1" }),
    ]));
    expect(JSON.stringify(plan)).not.toMatch(/guessedEmail|newEmployerId/);
  });

  it("blocks duplicate owner actions and cancels only conflicting cold-work tasks", () => {
    const pendingTasks = [
      {
        id: "task-wrong-owner",
        accountId: "account-1",
        personId: "person-1",
        playId: "play-1",
        enrollmentId: "enrollment-1",
        taskType: "CALL",
        status: "OPEN",
        owner: "owner-2",
        dueAt: "2026-07-21T00:00:00.000Z",
      },
      {
        id: "task-right-owner",
        accountId: "account-1",
        personId: "person-1",
        playId: "play-1",
        enrollmentId: "enrollment-1",
        taskType: "CALL",
        status: "OPEN",
        owner: "owner-1",
        dueAt: "2026-07-21T00:00:00.000Z",
      },
      {
        id: "task-inquiry",
        accountId: "account-1",
        personId: "person-1",
        playId: "play-1",
        enrollmentId: "enrollment-1",
        taskType: "INQUIRY_FOLLOWUP",
        status: "OPEN",
        owner: "owner-2",
        dueAt: "2026-07-21T00:00:00.000Z",
      },
    ];
    const plan = evaluate({
      context: context({ ownershipConflict: true }),
      pendingTasks,
    });
    expect(plan.decision).toBe("BLOCKED_CONFLICT");
    expect(plan.blockers).toContain("OWNER_CONFLICT");
    expect(plan.taskIntents).toEqual([]);
    expect(plan.taskCancellations.map((intent) => intent.taskId)).toEqual(["task-wrong-owner"]);
  });

  it("cancels cold follow-up on a human reply while retaining opportunity work", () => {
    const cancellation = planConflictingFollowupCancellation({
      trigger: "P1",
      scope: "ACCOUNT",
      accountId: "account-1",
      personId: null,
      playId: null,
      authoritativeOwner: null,
      tasks: [
        {
          id: "task-call",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          taskType: "CALL",
          status: "OPEN",
          owner: "owner-1",
          dueAt: "2026-07-21T00:00:00.000Z",
        },
        {
          id: "task-inquiry",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          taskType: "INQUIRY_FOLLOWUP",
          status: "OPEN",
          owner: "owner-1",
          dueAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      outreach: [
        {
          id: "message-pending",
          accountId: "account-1",
          personId: "person-1",
          playId: "play-1",
          enrollmentId: "enrollment-1",
          status: "SCHEDULED",
        },
      ],
    });
    expect(cancellation.taskCancellations.map((intent) => intent.taskId)).toEqual(["task-call"]);
    expect(cancellation.retainedTaskIds).toEqual(["task-inquiry"]);
    expect(cancellation.outreachControls).toEqual([
      expect.objectContaining({ outreachId: "message-pending", action: "CANCEL", reason: "P1" }),
    ]);
    expect(cancellation.externalActions).toBe(0);
  });

  it("persists a rule run transactionally and does no duplicate work on replay", () => {
    const ledger = new MemoryLedger();
    const plan = evaluate();
    expect(executeSignalRulePlan(ledger, plan)).toMatchObject({
      created: true,
      tasksCreated: 1,
      localControlsRecorded: 1,
      externalActions: 0,
    });
    expect(executeSignalRulePlan(ledger, plan)).toEqual({
      created: false,
      tasksCreated: 0,
      tasksCancelled: 0,
      outreachControlled: 0,
      localControlsRecorded: 0,
      externalActions: 0,
    });
    expect(ledger.tasks.size).toBe(1);
    expect(ledger.controls.size).toBe(1);
    expect(() => executeSignalRulePlan(ledger, {
      ...plan,
      planHash: "0".repeat(64),
    })).toThrow(/plan hash/i);
  });

  it("plans only due local-ingestion subscriptions with stable run keys and no network work", () => {
    const subscriptions = [
      {
        id: "subscription-due",
        accountId: "account-1",
        playId: "play-1",
        status: "ACTIVE",
        signalTypes: ["PLANT_EXPANSION", "JOB_CHANGE"],
        cadenceMinutes: 1_440,
        nextRunAt: "2026-07-20T00:00:00.000Z",
        sourceMode: "LOCAL_INGESTION_ONLY",
      },
      {
        id: "subscription-paused",
        accountId: "account-2",
        playId: null,
        status: "PAUSED",
        signalTypes: ["TENDER"],
        cadenceMinutes: 1_440,
        nextRunAt: "2026-07-19T00:00:00.000Z",
        sourceMode: "LOCAL_INGESTION_ONLY",
      },
      {
        id: "subscription-future",
        accountId: "account-3",
        playId: null,
        status: "ACTIVE",
        signalTypes: ["TENDER"],
        cadenceMinutes: 1_440,
        nextRunAt: "2026-07-21T00:00:00.000Z",
        sourceMode: "LOCAL_INGESTION_ONLY",
      },
    ];
    const first = planMonitoringCycle({ asOf, subscriptions });
    const replay = planMonitoringCycle({ asOf: "2026-07-20T12:00:00.000Z", subscriptions });
    expect(first.runIntents).toHaveLength(1);
    expect(first.runIntents[0]).toMatchObject({
      subscriptionId: "subscription-due",
      status: "AWAITING_LOCAL_OBSERVATIONS",
      sourceMode: "LOCAL_INGESTION_ONLY",
      externalCalls: 0,
      paidCalls: 0,
      externalWrites: 0,
    });
    expect(replay.runIntents[0]?.idempotencyKey).toBe(first.runIntents[0]?.idempotencyKey);
    expect(first.skippedSubscriptionIds).toEqual(["subscription-future", "subscription-paused"]);
    expect(first.safety).toEqual({ externalCalls: 0, paidCalls: 0, externalWrites: 0 });
  });

  it("runs the required 50-account/100-signal synthetic shadow without unsafe or external actions", () => {
    expect(runSignalMonitoringShadow()).toMatchObject({
      fixtureSet: "signal-monitoring-shadow-v1",
      accounts: 50,
      signals: 100,
      jobChangeSignals: 50,
      entityMatchedSignals: 95,
      replayStableRuns: 50,
      duplicateTaskKeys: 0,
      unsafeRuleActions: 0,
      actionValueRate: null,
      safety: { externalCalls: 0, paidCalls: 0, externalWrites: 0, messagesSent: 0 },
      verdict: "HOLD",
    });
  });
});
