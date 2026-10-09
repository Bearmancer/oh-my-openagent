import { createCompletionNotifier } from "../../completion/notifier"
import type { ParentNotifierMessage } from "../../completion/types"
import { baseSpec, FakeRunner, makeManager, makeHandle } from "../../manager/__fixtures__/manager-fakes"
import type { TaskRecordStore } from "../../store"
import { createTaskRecordStore } from "../../store"
import { createTaskLifecycle } from "../create"
import type { IdleReclaimerScheduler, IdleReclaimerTimer, LifecycleDeps, ResidentHandle } from "../port"
import { hostLifecycleDeps, hostSession } from "./host-session-fakes"
import { settings, tempStore } from "./lifecycle-fakes"

export function signal<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("live-parent lifecycle event did not arrive")), 2_000)
    })])
  } finally { clearTimeout(timer) }
}

export function liveParentFixture(mode: "in-process" | "child-process" | "host-session" = "in-process") {
  const backing = tempStore()
  const messages: ParentNotifierMessage[] = []
  const notifier = createCompletionNotifier({
    store: backing, notifier: { enqueue: (message) => messages.push(message) },
    getCurrentSessionId: () => "parent-1",
  })
  const listeners = new Set<() => void>()
  const events = new Map<string, Array<() => void>>()
  const changed = () => { for (const listener of listeners) listener() }
  const store: TaskRecordStore = {
    ...backing,
    save: (record) => { backing.save(record); changed() },
    replace: (record) => { backing.replace(record); changed() },
    mutate: (id, fn) => { const result = backing.mutate(id, fn); changed(); return result },
    transition: (id, transition) => {
      const result = backing.transition(id, transition)
      if (result.applied && transition.type === "fail") notifier.notifyTerminal({
        record: result.record, parentState: { kind: "idle" }, runInBackground: true,
      })
      changed()
      return result
    },
    appendEvent: (id, event) => {
      const path = backing.appendEvent(id, event)
      for (const resolve of events.get(event.type)?.splice(0) ?? []) resolve()
      return path
    },
  }
  const clock = { now: Date.parse("2026-10-09T00:00:00Z") }
  const timers = new Map<IdleReclaimerTimer, { callback: () => void; delay: number; due: number }>()
  const scheduler: IdleReclaimerScheduler = {
    setInterval(callback, delay) {
      const timer = { unref: () => undefined }
      timers.set(timer, { callback, delay, due: clock.now + delay })
      return timer
    },
    clearInterval: (timer) => { timers.delete(timer) },
  }
  const runner = new FakeRunner()
  const alivePids = new Set<number>()
  const signals: number[] = []
  if (mode === "child-process") runner.childPid = 42424
  const config = settings({ default_concurrency: 1, global_concurrency: 0, resident_idle_timeout_ms: 600_000 })
  const { manager } = makeManager({ store, project: backing.stateDir, inProcess: runner, process: runner, config })
  const host = hostLifecycleDeps({ store, hostPid: process.pid, now: () => clock.now })
  const state = { live: true, revivable: false, closes: 0, closeRefused: true, respawns: 0 }
  let respawnGate: ReturnType<typeof signal<void>> | undefined
  let closeGate: ReturnType<typeof signal<void>> | undefined
  let closeStarted = signal<void>()
  const registry = {
    get: (id: string): ResidentHandle | undefined => {
      const handle = manager.getResidentHandle(id)
      return handle === undefined ? undefined : {
        task_id: id, kind: mode === "child-process" ? "rpc" : mode, pid: handle.pid,
        abort: handle.abort, dispose: handle.dispose, terminate: handle.terminate ?? (async () => undefined),
      }
    },
    entries: (): readonly ResidentHandle[] => [],
    forget: (id: string) => manager.forget(id),
    hasPendingSends: () => false,
    ownsRecord: (record: { readonly parent_session_id: string }) => state.live && record.parent_session_id === "parent-1",
  }
  const subscription = {
    onStoreMutation: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const deps: LifecycleDeps = {
    ...host.deps, ...subscription, store, registry, config,
    idleReclaimerScheduler: scheduler,
    hostCloseScheduler: scheduler,
    signaller: {
      isAlive: (pid) => alivePids.has(pid),
      signal: (pid) => { signals.push(pid); alivePids.delete(pid) },
    },
    respawn: async (record) => {
      state.respawns += 1
      if (respawnGate !== undefined) await respawnGate.promise
      return state.revivable
        ? { ok: true, handle: makeHandle(record.task_id).handle }
        : { ok: false, disposition: "retryable", code: "model_unavailable", reason: "fixture model unavailable" }
    },
    reattach: (record, handle) => manager.reattach(record, handle),
    hostSessionClose: async (request) => {
      state.closes += 1
      closeStarted.resolve()
      if (closeGate !== undefined) await closeGate.promise
      if (state.closeRefused || !host.daemon.alive) throw new Error("fixture daemon unreachable")
      await host.daemon.close(request)
    },
    hostRetry: { ...host.deps.hostRetry, maxDrainAttempts: 1, defaultRetryAfterMs: 2_000,
      daemonLossBackoffMs: [], deferredRetryBackoffMs: [], wait: async () => undefined },
  }
  let lifecycle = createTaskLifecycle(deps)
  return {
    store, backing, manager, runner, state, messages, notifier, host, registry, timers, signals, alivePids,
    get lifecycle() { return lifecycle },
    wait: (event: string) => {
      const waiting = signal<void>()
      const entries = events.get(event) ?? []
      entries.push(() => waiting.resolve())
      events.set(event, entries)
      return bounded(waiting.promise)
    },
    holdRevival: () => { respawnGate = signal<void>(); return respawnGate },
    holdClose: () => {
      closeGate = signal<void>()
      closeStarted = signal<void>()
      return { ...closeGate, started: closeStarted.promise }
    },
    nextClose: () => { closeStarted = signal<void>(); return bounded(closeStarted.promise) },
    until: (predicate: () => boolean) => {
      const reached = signal<void>()
      const listener = () => {
        if (!predicate()) return
        listeners.delete(listener)
        reached.resolve()
      }
      listeners.add(listener)
      listener()
      return bounded(reached.promise)
    },
    advance: (ms: number) => {
      clock.now += ms
      for (const timer of [...timers.values()]) if (timer.due <= clock.now) {
        timer.due = clock.now + timer.delay
        timer.callback()
      }
    },
    start: async () => {
      const result = await manager.start(baseSpec({ run_in_background: true, execution_mode: mode === "in-process" ? "in-process" : "process" }))
      if (result.kind !== "started") throw new Error(`fixture start failed: ${result.kind}`)
      if (mode === "child-process") alivePids.add(42424)
      if (mode === "host-session") {
        const identity = hostSession(result.task_id)
        store.mutate(result.task_id, (record) => ({ ...record, runner_kind: "host-session", host_session: identity }))
        host.daemon.hold(identity.session_path)
      }
      return result.task_id
    },
    park: (id: string) => runner.handles.get(id)?.park("idle_evicted"),
    restart: () => {
      lifecycle.dispose?.()
      const reloaded = createTaskRecordStore({ project_dir: backing.stateDir, task: { state_dir: backing.stateDir } })
      lifecycle = createTaskLifecycle({ ...deps, store: reloaded })
      return lifecycle
    },
    dispose: () => lifecycle.dispose?.(),
  }
}
