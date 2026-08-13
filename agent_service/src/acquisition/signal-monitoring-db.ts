import type { AgentDatabase } from "../db.js";
import {
  evaluateSignalRuleRun,
  executeSignalRulePlan,
  type LocalControlIntent,
  type MonitoringContext,
  type MonitoringRuleVersion,
  type OutreachControlIntent,
  type PendingOutreach,
  type PendingSalesTask,
  type SalesTaskIntent,
  type SignalObservation,
  type SignalRuleExecutionResult,
  type SignalRuleLedger,
  type SignalRuleRunPlan,
  type StoredSignalRuleRun,
  type TaskCancellationIntent,
} from "./signal-monitoring.js";

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class SqliteSignalRuleLedger implements SignalRuleLedger {
  constructor(private readonly db: AgentDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.db.runInTransaction(operation);
  }

  getRuleRun(idempotencyKey: string): StoredSignalRuleRun | null {
    const row = this.db.db.prepare(
      `SELECT payload_json FROM events
       WHERE entity_type='signal_rule_run' AND entity_id=? AND event_type='SIGNAL_RULE_RUN_RECORDED'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(idempotencyKey) as { payload_json: string } | undefined;
    if (!row) return null;
    const payload = parseObject(row.payload_json);
    const planHash = String(payload.planHash ?? "");
    return planHash ? { idempotencyKey, planHash } : null;
  }

  recordRuleRun(plan: SignalRuleRunPlan): void {
    this.db.recordEvent("signal_rule_run", plan.idempotencyKey, "SIGNAL_RULE_RUN_RECORDED", "signal-monitor", {
      planHash: plan.planHash,
      ruleId: plan.ruleId,
      ruleVersion: plan.ruleVersion,
      accountId: plan.accountId,
      decision: plan.decision,
      matchedSignalIds: plan.matchedSignalIds,
      commitLocalEffects: plan.commitLocalEffects,
      safety: plan.safety,
    });
  }

  upsertSalesTask(intent: SalesTaskIntent): boolean {
    return this.db.createOrGetSalesTask({
      idempotencyKey: intent.idempotencyKey,
      taskType: intent.taskType,
      owner: intent.owner,
      dueAt: intent.dueAt,
      sourceSignal: intent.sourceSignalIds.join(","),
      accountId: intent.accountId,
      personId: intent.personId,
      playId: intent.playId,
      enrollmentId: intent.enrollmentId,
      payload: { ...intent.payload, sourceSignalIds: intent.sourceSignalIds, externalAction: "NONE" },
    }).created;
  }

  cancelSalesTask(intent: TaskCancellationIntent): boolean {
    const now = new Date().toISOString();
    const result = this.db.db.prepare(
      `UPDATE sales_tasks SET status='CANCELLED', updated_at=?
       WHERE id=? AND status IN ('OPEN','IN_PROGRESS','SNOOZED')`,
    ).run(now, intent.taskId);
    if (Number(result.changes) !== 1) return false;
    this.db.recordEvent("sales_task", intent.taskId, "SALES_TASK_CANCELLED_BY_SIGNAL", "signal-monitor", {
      idempotencyKey: intent.idempotencyKey,
      reason: intent.reason,
      externalAction: "NONE",
    });
    return true;
  }

  applyOutreachControl(intent: OutreachControlIntent): boolean {
    const now = new Date().toISOString();
    const result = this.db.db.prepare(
      `UPDATE outbound_messages SET status='CANCELLED', failure_reason=?, updated_at=?
       WHERE id=? AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','SENDING','FAILED')`,
    ).run(`signal ${intent.action.toLowerCase()}: ${intent.reason}`.slice(0, 1000), now, intent.outreachId);
    if (Number(result.changes) !== 1) return false;
    this.db.recordEvent("outbound_message", intent.outreachId, "OUTREACH_CONTROLLED_BY_SIGNAL", "signal-monitor", {
      idempotencyKey: intent.idempotencyKey,
      action: intent.action,
      reason: intent.reason,
      externalAction: "NONE",
    });
    return true;
  }

  recordLocalControl(intent: LocalControlIntent): boolean {
    const existing = this.db.db.prepare(
      `SELECT 1 FROM events WHERE entity_type='signal_local_control' AND entity_id=?
       AND event_type='SIGNAL_LOCAL_CONTROL_RECORDED' LIMIT 1`,
    ).get(intent.idempotencyKey);
    if (existing) return false;
    if (intent.type === "MARK_EMPLOYMENT_FORMER" && intent.personId) {
      this.db.db.prepare(
        `UPDATE employments SET status='ENDED', is_current=0, updated_at=?
         WHERE person_id=? AND account_id=? AND is_current=1`,
      ).run(new Date().toISOString(), intent.personId, intent.accountId);
    }
    if (intent.type === "MOVE_TO_WATCHLIST" && intent.playId) {
      this.db.db.prepare(
        `UPDATE play_enrollments SET qualification_track='WATCHLIST', status='WATCHLIST', updated_at=?
         WHERE account_id=? AND play_version_id IN (SELECT id FROM play_versions WHERE play_id=? AND status='ACTIVE')
           AND status IN ('PROSPECT','RESEARCHING','QUALIFIED','WATCHLIST','READY_FOR_REVIEW','APPROVED','ACTIVE')`,
      ).run(new Date().toISOString(), intent.accountId, intent.playId);
    }
    this.db.recordEvent(
      "signal_local_control",
      intent.idempotencyKey,
      "SIGNAL_LOCAL_CONTROL_RECORDED",
      "signal-monitor",
      {
        type: intent.type,
        accountId: intent.accountId,
        personId: intent.personId,
        playId: intent.playId,
        sourceSignalIds: intent.sourceSignalIds,
        payload: intent.payload,
        externalAction: "NONE",
      },
    );
    return true;
  }
}

export interface PersistedSignalRuleResult {
  ruleVersionId: string;
  signalObservationIds: string[];
  plan: SignalRuleRunPlan;
  execution: SignalRuleExecutionResult;
}

export function persistAndExecuteSignalRule(input: {
  db: AgentDatabase;
  rule: MonitoringRuleVersion;
  signals: readonly SignalObservation[];
  context: MonitoringContext;
  pendingTasks?: readonly PendingSalesTask[];
  pendingOutreach?: readonly PendingOutreach[];
  createdBy: string;
}): PersistedSignalRuleResult {
  const ruleVersion = input.db.saveRuleVersion({
    ruleKey: input.rule.ruleKey,
    condition: input.rule.condition,
    actions: input.rule.actions,
    createdBy: input.createdBy,
  });
  const signalObservationIds = input.signals.map((signal) => input.db.saveSignalObservation({
    idempotencyKey: `monitoring-signal:${signal.id}`,
    accountId: signal.accountId,
    personId: signal.personId,
    signalType: signal.signalType,
    sourceUrl: signal.sourceUrl,
    exactQuote: signal.exactQuote,
    publishedAt: signal.publishedAt,
    observedAt: signal.observedAt,
    expiresAt: signal.expiresAt,
    confidence: signal.confidence,
    authorityClass: signal.authorityClass,
    entityMatch: signal.entityMatch,
    createdBy: input.createdBy,
    metadata: {
      sourceObservationId: signal.id,
      sourceKind: signal.sourceKind,
      diagnosticCount: signal.diagnosticCount,
      externalAction: "NONE",
    },
  }).id);
  const plan = evaluateSignalRuleRun({
    rule: input.rule,
    signals: input.signals,
    context: input.context,
    pendingTasks: input.pendingTasks ?? [],
    pendingOutreach: input.pendingOutreach ?? [],
  });
  const execution = executeSignalRulePlan(new SqliteSignalRuleLedger(input.db), plan);
  return { ruleVersionId: ruleVersion.id, signalObservationIds, plan, execution };
}
