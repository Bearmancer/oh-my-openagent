import { randomUUID } from "node:crypto"
import type { TaskRecord } from "../state"
import { nowIso, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import { endClosingFallbackChild } from "./fallback-closing-child"
import { isHostSessionRecord } from "./host-session"
import { isSuspendedResidency } from "./revival-selection"
import { terminateOldRpc } from "./revive-rollback"

export function isSuspensionExpiry(record: TaskRecord): boolean {
  return record.failure_kind === "suspended_unresumable" && record.killed === true
}

/**
 * Claim the stopped run BEFORE any close I/O. Keep suspended residency, with killed as the existing
 * no-revival fence; neither cold revival nor session_start may take a new residency claim. The
 * durable failure kind also lets a new lifecycle finish this operation after a crash.
 */
export async function expireSuspendedChild(
  context: LifecycleContext,
  observed: TaskRecord,
  parentLive: () => boolean,
): Promise<void> {
  const token = randomUUID()
  const cause = observed.revival_deferred_reason ?? observed.suspension_reason ?? "suspended"
  const reason = observed.error_message?.startsWith("suspended_unresumable:")
    ? observed.error_message : `suspended_unresumable:${cause}`
  let claimed = false
  const record = context.store.mutate(observed.task_id, (fresh) => {
    if (!parentLive() || (!isSuspendedResidency(fresh.residency_state) && !isSuspensionExpiry(fresh))
      || (fresh.status !== "pending" && fresh.status !== "running")
      || fresh.notification.run_epoch !== observed.notification.run_epoch
      || fresh.residency_claim !== observed.residency_claim || fresh.cancel_requested !== undefined
      || (fresh.killed === true && !isSuspensionExpiry(fresh))) return fresh
    claimed = true
    return {
      ...fresh, killed: true, failure_kind: "suspended_unresumable", error_message: reason,
      host_pid: context.hostPid, residency_claim: token,
      ...(isHostSessionRecord(fresh) ? {
        fallback_closing_child: { host_session: fresh.host_session, requires_confirmation: true },
      } : {}),
    }
  })
  if (!claimed || record === null) return
  context.store.appendEvent(record.task_id, { type: "live_parent_expiry_claimed", payload: { cause } })
  const closed = isHostSessionRecord(record)
    ? await endClosingFallbackChild(context, record)
    : await stopLocalChild(context, record)
  if (!isHostSessionRecord(record) && !closed) return
  const fresh = context.store.load(record.task_id)
  if (fresh === null || fresh.residency_claim !== token
    || fresh.notification.run_epoch !== record.notification.run_epoch
    || (fresh.status !== "pending" && fresh.status !== "running")) return
  const message = closed ? `${reason}\nThe child could not be resumed (${cause}); its stop is confirmed.`
    : `${reason}\nThe child could not be resumed (${cause}). Its old session may still be running on an unreachable host; closing it is being retried. There is no at-most-once guarantee if you re-dispatch: the work may run twice while the old run is still live. Check side-effecting work before re-running.`
  // Dispose/release before notification. This is NOT a cancellation: externally caused failure
  // must take the normal fail transition so the waiting parent receives one result.
  context.dequeuePending(record.task_id)
  context.kernelToolBindings?.release(record.task_id)
  context.store.transition(record.task_id, { type: "dispose", timestamp: nowIso(context) })
  const result = context.store.transition(record.task_id, {
    type: "fail", timestamp: nowIso(context), error_message: message,
    failure_kind: "suspended_unresumable", killed: true,
  })
  context.registry.forget(record.task_id)
  if (result.applied) context.store.appendEvent(record.task_id, {
    type: "suspended_unresumable", payload: { cause, confirmed_stop: closed },
  })
}

async function stopLocalChild(context: LifecycleContext, record: TaskRecord): Promise<boolean> {
  if (context.failedTeardowns.has(record.task_id)) return false
  if (record.execution_mode === "process" && !(await terminateOldRpc(context, record))) return false
  await destroyResidentTask(context, record.task_id, "cancel")
  return true
}

/** Strict obligations are independent of parent liveness and TTL age; restart/cleanup retries them. */
export async function retrySuspendedClosures(context: LifecycleContext): Promise<void> {
  await Promise.all(context.store.list().records
    .filter((record) => record.fallback_closing_child?.requires_confirmation === true)
    .map((record) => endClosingFallbackChild(context, record)))
}
