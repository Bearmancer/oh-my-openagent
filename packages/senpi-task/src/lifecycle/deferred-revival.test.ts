import { afterEach, describe, expect, test } from "bun:test"

import type { ManagedChildHandle } from "../manager/child-handle"
import { notContinuableReason } from "../steering/engine-policy"
import { runTaskOutput } from "../tools/output/output"
import { createTaskLifecycle } from "./create"
import { deferralOutlookFor } from "./deferred-revival-reasons"
import { hostLifecycleDeps, hostSession, hostSessionRecordInput } from "./__fixtures__/host-session-fakes"
import { cleanupProjects, seedRecord, tempStore } from "./__fixtures__/lifecycle-fakes"

afterEach(cleanupProjects)

/** Every queued microtask has run: the fakes here resolve immediately and the store is synchronous. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))


function harness(options: {
  host?: boolean
  capacity?: boolean
  succeeds?: boolean
  failure?: "model_unavailable" | "session_unavailable"
  lock?: boolean
  rollback?: boolean
  foreign?: boolean
  gateWait?: (ms: number) => Promise<void>
  respawnGate?: (attempt: number) => Promise<void>
  /** Reattach registers the live handle, as the manager's residency view does in production. */
  attachOnReattach?: boolean
} = {}) {
  const raw = tempStore()
  const taskId = "st_94980001"
  const events = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  const eventLog: string[] = []
  const event = (type: string) => {
    let signal = events.get(type)
    if (signal === undefined) {
      signal = Promise.withResolvers<unknown>()
      events.set(type, signal)
    }
    return signal.promise
  }
  // Subscribe before reconciliation; the real store still performs every state write.
  const revived = event("reconcile_reattached")
  const exhausted = event("revival_retry_exhausted")
  const lost = event("reconcile_lost")
  const suspended = event("suspended")
  const store = {
    ...raw,
    mutate: (id: string, mutation: Parameters<typeof raw.mutate>[1]) => raw.mutate(id, (fresh) => {
      const next = mutation(fresh)
      if (options.rollback && fresh.residency_state === "resident" && next.residency_state === "persisted_only") {
        throw new Error("rollback lock contended")
      }
      return next
    }),
    appendEvent: (id: string, input: { type: string; payload: unknown }) => {
      eventLog.push(`${id}:${input.type}`)
      const path = raw.appendEvent(id, input)
      events.get(input.type)?.resolve(input.payload)
      return path
    },
  }
  let attempts = 0
  let now = 0
  const fixture = hostLifecycleDeps({
    store,
    hostPid: 2222,
    isAlive: (pid) => options.foreign === true && pid === 4444,
    now: () => now,
    config: options.capacity ? { residency_max_children: 1 } : {},
    deferredRetryBackoffMs: [10, 20, 40],
    onWait: (ms) => { now += ms },
    ...(options.gateWait ? { gateWait: options.gateWait } : {}),
    respawn: async (record) => {
      attempts += 1
      await options.respawnGate?.(attempts)
      if (!options.succeeds || attempts === 1) {
        return { ok: false, disposition: "retryable", code: options.failure ?? "model_unavailable", reason: "temporarily unavailable" }
      }
      const handle: ManagedChildHandle = {
        task_id: record.task_id,
        sessionId: "child-session",
        pid: undefined,
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: async () => undefined,
        subscribe: () => () => undefined,
        waitForOutcome: () => new Promise(() => undefined),
        lastAssistantText: () => undefined,
        dispose: async () => undefined,
      }
      return { ok: true, handle }
    },
  })
  seedRecord(store, {
    ...(options.host
      ? hostSessionRecordInput(taskId, hostSession(taskId))
      : { task_id: taskId, spawn_spec: { version: 1, cwd: "/tmp", prompt: "continue" } }),
    status: "running",
    residency_state: options.host ? "rpc_detached" : "persisted_only",
    notify_on_terminal: true,
    ...(options.foreign ? { host_pid: 4444 } : {}),
  })
  if (options.capacity) {
    seedRecord(store, { task_id: "st_94980002", status: "running", host_pid: 2222 })
    fixture.registry.add({
      task_id: "st_94980002", kind: "in-process", pid: undefined,
      abort: async () => undefined, dispose: async () => undefined, terminate: async () => undefined,
    })
  }
  const lifecycle = createTaskLifecycle({
    ...fixture.deps,
    ...(options.attachOnReattach
      ? {
          reattach: async (record: { task_id: string }) => {
            fixture.registry.add({
              task_id: record.task_id, kind: "in-process", pid: undefined,
              abort: async () => undefined, dispose: async () => undefined, terminate: async () => undefined,
            })
            return { ok: true as const }
          },
        }
      : {}),
    ...(options.lock ? { reconcileAdmission: { acquireLease: async () => ({ kind: "contended" as const }) } } : {}),
  })
  return { store, taskId, fixture, lifecycle, revived, exhausted, lost, suspended, eventLog, attempts: () => attempts }
}

async function resume(h: ReturnType<typeof harness>) {
  const result = await h.lifecycle.reconcileOnSessionStart("parent-1")
  // The clock must be armed by this session_start, not by a later session or a real timer.
  expect(h.fixture.waits.length).toBeGreaterThan(0)
  return result
}

describe("bounded resumed-child revival (omo#9498)", () => {
  test("model_unavailable on session start revives on the first retry without a new session start", async () => {
    const h = harness({ succeeds: true })
    try {
      const result = await resume(h)
      expect(result.outcomes).toContainEqual({ task_id: h.taskId, kind: "deferred", reason: "model_unavailable" })
      await h.revived
      expect(h.attempts()).toBe(2)
      expect(h.fixture.waits).toEqual([10])
      expect(h.store.load(h.taskId)?.residency_state).toBe("resident")
      expect(h.store.load(h.taskId)?.suspension_reason).toBeUndefined()
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  test("model_unavailable exhausted retries mark lost and task_output reports terminal breadcrumbs", async () => {
    const h = harness()
    try {
      await resume(h)
      await h.lost
      const record = h.store.load(h.taskId)
      if (record === null) throw new Error("lost child record disappeared")
      expect(h.attempts()).toBe(4)
      expect(h.fixture.waits).toEqual([10, 20, 40])
      expect(record.status).toBe("lost")
      expect(record.error_message).toContain("model_unavailable")
      expect(record.error_message).toContain("3 retry attempts")
      const output = await runTaskOutput({
        manager: {
          get: (id) => h.store.load(id) ?? undefined,
          list: () => h.store.list().records.map((entry) => ({ record: entry })),
        },
        stateDir: h.store.stateDir,
      }, { task_id: h.taskId }, "parent-1")
      expect(output.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("[lost]") }),
      ]))
      expect(output.details.kind).toBe("status")
      if (output.details.kind === "status") expect(output.details.snapshot.lost?.session_dir).toBeDefined()
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  test("capacity exhaustion stays suspended and task_send states the recorded capacity deferral", async () => {
    const h = harness({ capacity: true })
    try {
      await resume(h)
      expect(await h.exhausted).toEqual({ reason: "capacity", attempts: 3 })
      const record = h.store.load(h.taskId)
      if (record === null) throw new Error("capacity-deferred child record disappeared")
      expect(record.status).toBe("running")
      expect(record.residency_state).toBe("persisted_only")
      expect(record.suspension_reason).toBe("revival_deferred")
      expect(record.revival_deferred_reason).toBe("capacity")
      expect(notContinuableReason(record)).toContain("capacity")
      expect(h.attempts()).toBe(0)
      expect(h.fixture.waits).toEqual([10, 20, 40])
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  test("a daemon-hosted model deferral exhausts the same retries without ever becoming lost", async () => {
    const h = harness({ host: true })
    try {
      await resume(h)
      expect(await h.exhausted).toEqual({ reason: "model_unavailable", attempts: 3 })
      expect(h.attempts()).toBe(4)
      expect(h.store.load(h.taskId)?.status).toBe("running")
      expect(h.store.load(h.taskId)?.residency_state).toBe("rpc_detached")
      expect(h.store.load(h.taskId)?.error_message).toBeUndefined()
      expect(h.fixture.daemon.closed).toEqual([])
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  for (const reason of ["session_unavailable", "lock_contended", "rollback_failed"] as const) {
    test(`${reason} exhausts retries through the existing lost transition`, async () => {
      const h = harness({
        failure: reason === "session_unavailable" ? reason : undefined,
        lock: reason === "lock_contended",
        rollback: reason === "rollback_failed",
      })
      try {
        await resume(h)
        await h.lost
        expect(h.store.load(h.taskId)?.status).toBe("lost")
        expect(h.store.load(h.taskId)?.error_message).toContain(`${reason}; exhausted 3 retry attempts`)
        expect(h.fixture.waits).toEqual([10, 20, 40])
      } finally {
        h.lifecycle.dispose?.()
      }
    }, 10_000)
  }

  test("a live foreign owner retains its suspended child after the retry budget", async () => {
    const h = harness({ foreign: true })
    try {
      const before = h.store.load(h.taskId)
      expect(before?.host_pid).toBe(4444)
      expect(h.fixture.deps.signaller?.isAlive(4444)).toBe(true)
      await resume(h)
      expect(await h.exhausted).toEqual({ reason: "foreign_live_owner", attempts: 3 })
      expect(h.store.load(h.taskId)).toEqual(before)
      expect(h.attempts()).toBe(0)
      expect(h.fixture.waits).toEqual([10, 20, 40])
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  // Review of omo#9714 (H1): a retry must not outlive the session that scheduled it.
  for (const stop of ["shutdown", "dispose"] as const) {
    test(`a pending retry stops on session ${stop}: the child is neither revived nor marked lost`, async () => {
      const gate = Promise.withResolvers<void>()
      const firstWait = Promise.withResolvers<void>()
      const h = harness({ succeeds: true, gateWait: () => { firstWait.resolve(); return gate.promise } })
      try {
        await h.lifecycle.reconcileOnSessionStart("parent-1")
        await firstWait.promise
        if (stop === "shutdown") await h.lifecycle.suspendOnSessionShutdown({ parentSessionId: "parent-1", reason: "quit" })
        else h.lifecycle.dispose?.()
        gate.resolve()
        await settled()

        expect(h.attempts()).toBe(1)
        const record = h.store.load(h.taskId)
        expect(record?.residency_state).toBe("persisted_only")
        expect(record?.status).toBe("running")
      } finally {
        h.lifecycle.dispose?.()
      }
    }, 10_000)
  }

  test("a session resumed again after shutdown retries its children again", async () => {
    const h = harness({ succeeds: true })
    try {
      await h.lifecycle.suspendOnSessionShutdown({ parentSessionId: "parent-1", reason: "quit" })
      await resume(h)
      await h.revived
      expect(h.store.load(h.taskId)?.residency_state).toBe("resident")
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  test("a second session start while a retry waits does not start a second retry loop for the same child", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness({ gateWait: () => gate.promise })
    try {
      await h.lifecycle.reconcileOnSessionStart("parent-1")
      await h.lifecycle.reconcileOnSessionStart("parent-1")
      // One loop is parked on its first backoff; a second loop would have parked a second one.
      expect(h.fixture.waits).toEqual([10])
    } finally {
      h.lifecycle.dispose?.()
      gate.resolve()
    }
  }, 10_000)

  // Review round 2 of omo#9714 (MEDIUM-1): shutdown lands while a retry is inside its revival attempt.
  test("a retry whose revival completes after its session shut down leaves the child suspended, not resident", async () => {
    const inRespawn = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness({
      succeeds: true,
      attachOnReattach: true,
      respawnGate: (attempt) => {
        if (attempt !== 2) return Promise.resolve()
        inRespawn.resolve()
        return release.promise
      },
    })
    try {
      await h.lifecycle.reconcileOnSessionStart("parent-1")
      await inRespawn.promise
      await h.lifecycle.suspendOnSessionShutdown({ parentSessionId: "parent-1", reason: "quit" })
      // A child the next engine queued for the same session while this attempt was still running.
      seedRecord(h.store, { task_id: "st_94980077", status: "pending", parent_session_id: "parent-1", host_pid: 2222 })
      release.resolve()
      await h.revived
      // Subscribed before the attempt: the late suspend's own record event, not a timing guess.
      expect(await h.suspended).toEqual({ reason: "revived_after_shutdown" })
      await settled()

      expect(h.fixture.registry.get(h.taskId)).toBeUndefined()
      expect(h.store.load(h.taskId)?.residency_state).not.toBe("resident")
      expect(h.store.load(h.taskId)?.status).toBe("running")
      // Only the handle this retry revived is suspended; the queued sibling is left to its own engine.
      expect(h.eventLog.filter((entry) => entry.startsWith("st_94980077:"))).toEqual([])
      expect(h.store.load("st_94980077")?.status).toBe("pending")
    } finally {
      h.lifecycle.dispose?.()
    }
  }, 10_000)

  test("each deferral reason maps to what happens next", () => {
    expect(deferralOutlookFor("model_unavailable", false)).toBe("retried_then_lost")
    expect(deferralOutlookFor("lock_contended", false)).toBe("retried_then_lost")
    expect(deferralOutlookFor("model_unavailable", true)).toBe("retried_not_lost")
    expect(deferralOutlookFor("host_unreachable", true)).toBe("retried_not_lost")
    expect(deferralOutlookFor("capacity", false)).toBe("waits_for_capacity")
    expect(deferralOutlookFor("foreign_live_owner", false)).toBe("may_stay_with_live_owner")
    expect(deferralOutlookFor("reattach_disabled", false)).toBe("not_retried")
    expect(deferralOutlookFor("tools_unavailable", false)).toBe("not_retried")
  })
})
