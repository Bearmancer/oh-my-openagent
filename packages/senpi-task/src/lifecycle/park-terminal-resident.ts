import { TERMINAL_STATUSES, type LifecycleContext } from "./context"
import { suspendHandle } from "./shutdown"

/**
 * Releases a finished child that still holds a resident slot in THIS process (omo#9785): its process or
 * session is torn down through the bounded suspend path and the record parks (persisted_only /
 * rpc_detached), so it stays readable and revivable. Returns false, changing nothing, when there is no
 * such resident here: not terminal, not resident, owned elsewhere, mail pending, or already being torn down.
 */
export async function parkTerminalResident(context: LifecycleContext, taskId: string, reason: string): Promise<boolean> {
  if (context.registry.tryClaimEviction?.(taskId) === false) return false
  try {
    const fresh = context.store.load(taskId)
    const handle = context.registry.get(taskId)
    if (
      fresh === null ||
      handle === undefined ||
      fresh.residency_state !== "resident" ||
      !TERMINAL_STATUSES.has(fresh.status) ||
      context.registry.hasPendingSends(taskId)
    ) return false
    await suspendHandle(context, handle, reason)
    return true
  } finally {
    context.registry.releaseEviction?.(taskId)
  }
}
