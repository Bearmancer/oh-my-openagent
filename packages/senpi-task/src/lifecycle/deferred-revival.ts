import { markRecordLostForReconciliation, type TaskRecord } from "../state"
import { nowIso, TERMINAL_STATUSES, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import { isHostSessionRecord } from "./host-session"
import { reconcileScopedRevival } from "./reconcile-revival"
import { newestSessionPath } from "./session-path"

export const SCOPED_RETRY_REASONS: ReadonlySet<string> = new Set([
  "capacity", "lock_contended", "model_unavailable", "session_unavailable",
  "rollback_failed", "foreign_live_owner",
])

const LOST_ON_EXHAUSTION: ReadonlySet<string> = new Set([
  "model_unavailable", "session_unavailable", "rollback_failed", "lock_contended",
])

/** Retry only this resumed session's child, using the same fenced admission as session_start. */
export async function retryDeferredScopedChild(
  context: LifecycleContext,
  taskId: string,
  parentSessionId: string,
  initialReason: string,
): Promise<void> {
  let reason = initialReason
  let attempts = 0
  let expected = context.store.load(taskId)
  for (const backoffMs of context.hostRetry.deferredRetryBackoffMs) {
    await context.hostRetry.wait(backoffMs)
    const fresh = context.store.load(taskId)
    if (!canRetry(context, fresh, parentSessionId)) return
    // Another revival can claim a child before it installs its handle. The claim/epoch fence,
    // not just registry presence, stops this retry from reclaiming that in-flight owner.
    if (expected === null || fresh.notification.run_epoch !== expected.notification.run_epoch
      || (fresh.residency_claim !== expected.residency_claim
        && (reason !== "foreign_live_owner" || fresh.host_pid === context.hostPid || foreignOwnerAlive(context, fresh)))) return
    attempts += 1
    if (foreignOwnerAlive(context, fresh)) {
      // An existing owner may finish or release the child. Never steal its record or lose it.
      if (reason !== "foreign_live_owner") return
      continue
    }
    if (isHostSessionRecord(fresh)) context.hostSessionProbe.refresh(fresh.host_session.socket)
    if (reason === "foreign_live_owner" && isHostSessionRecord(fresh) && fresh.residency_state === "resident"
      && await context.hostSessionProbe.daemonAlive(fresh.host_session)
      && await context.hostSessionProbe.sessionLive(fresh.host_session)
      && (fresh.host_pid === undefined || fresh.host_pid === context.hostPid)) {
      // The same-process host can hold another engine's live child. Its session liveness,
      // rather than absence from our registry, is the ownership evidence startup used.
      continue
    }
    // The admission selector scans the store to measure capacity. Excluding the other children
    // preserves that measurement without claiming/respawning them once per sibling retry.
    const excludeTaskIds = new Set(context.reconcileAdmission.excludeTaskIds)
    for (const record of context.store.list().records) {
      if (record.task_id !== taskId) excludeTaskIds.add(record.task_id)
    }
    const outcomes = await reconcileScopedRevival(
      { ...context, reconcileAdmission: { ...context.reconcileAdmission, excludeTaskIds } },
      parentSessionId,
      [fresh],
      (id) => newestSessionPath(context, id),
    )
    const outcome = outcomes.find((entry) => entry.task_id === taskId)
    if (outcome?.kind !== "deferred" || outcome.reason === undefined) return
    reason = outcome.reason
    if (!SCOPED_RETRY_REASONS.has(reason)) return
    expected = context.store.load(taskId)
  }
  const observed = context.store.load(taskId)
  if (!canRetry(context, observed, parentSessionId)) return
  if (expected === null || observed.residency_claim !== expected.residency_claim
    || observed.notification.run_epoch !== expected.notification.run_epoch) return
  context.store.appendEvent(taskId, { type: "revival_retry_exhausted", payload: { reason, attempts } })
  // Capacity and a live foreign owner resolve when the other side moves, not when this session
  // retries harder. A daemon session's transcript still belongs to its host and is never lost.
  if (isHostSessionRecord(observed) || !LOST_ON_EXHAUSTION.has(reason) || foreignOwnerAlive(context, observed)) return
  let applied = false
  const message = `revival deferred: ${reason}; exhausted ${attempts} retry attempts`
  context.store.mutate(taskId, (fresh) => {
    if (!canRetry(context, fresh, parentSessionId) || isHostSessionRecord(fresh) || foreignOwnerAlive(context, fresh)
      || fresh.host_pid !== observed.host_pid || fresh.residency_claim !== observed.residency_claim
      || fresh.notification.run_epoch !== observed.notification.run_epoch || fresh.updated_at !== observed.updated_at) return fresh
    const result = markRecordLostForReconciliation(fresh, { timestamp: nowIso(context), error_message: message })
    applied = result.applied
    return result.record
  })
  if (!applied) return
  context.store.appendEvent(taskId, { type: "reconcile_lost", payload: { reason: message } })
  await destroyResidentTask(context, taskId, "reconcile_lost")
}

function canRetry(context: LifecycleContext, record: TaskRecord | null, parentSessionId: string): record is TaskRecord {
  return record !== null && record.parent_session_id === parentSessionId
    && !TERMINAL_STATUSES.has(record.status) && record.killed !== true
    && context.registry.get(record.task_id) === undefined
    && (record.residency_state === "persisted_only" || record.residency_state === "rpc_detached"
      || record.residency_state === "resident")
}

function foreignOwnerAlive(context: LifecycleContext, record: TaskRecord): boolean {
  return record.host_pid !== undefined && record.host_pid !== context.hostPid && context.signaller.isAlive(record.host_pid)
}
