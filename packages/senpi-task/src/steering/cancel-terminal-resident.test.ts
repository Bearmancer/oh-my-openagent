import { afterEach, describe, expect, test } from "bun:test"

import { createTaskLifecycle } from "../lifecycle/create"
import { cleanupProjects, fakeHandle, FakeRegistry, seedRecord, settings, tempStore } from "../lifecycle/__fixtures__/lifecycle-fakes"
import { NO_HOST_ENDPOINT } from "../lifecycle/host-session"
import type { TaskRecordStore } from "../store"
import { runTaskCancel } from "../tools/control/cancel"
import { createSteeringEngine } from "./engine"
import type { SteeringPort } from "./types"

afterEach(cleanupProjects)

const TASK = "st_00009785"

function cancelSurface(store: TaskRecordStore, registry: FakeRegistry) {
  const lifecycle = createTaskLifecycle({ hostEndpoint: NO_HOST_ENDPOINT, store, registry, config: settings() })
  const port: SteeringPort = {
    store,
    liveHandle: () => undefined,
    reserveForRevive: () => ({ ok: true, commit: () => undefined, release: () => undefined }),
    reviveDetached: async () => ({ ok: false, reason: "not used" }),
    dequeuePending: () => false,
    destruction: lifecycle,
    runStatsSnapshot: () => undefined,
    now: () => Date.parse("2026-10-08T00:00:00.000Z"),
  }
  const engine = createSteeringEngine(port)
  const manager = { cancelTask: engine.cancelTask, get: (taskId: string) => store.load(taskId) ?? undefined }
  return { lifecycle, cancel: () => runTaskCancel(manager, { task_id: TASK }) }
}

describe("task_cancel on a finished child that is still resident (omo#9785)", () => {
  test("#given an errored child still resident here #when cancelled #then its child is stopped and the record parks, readable and revivable", async () => {
    // given
    const store = tempStore()
    const registry = new FakeRegistry()
    const calls: string[] = []
    const handle = fakeHandle(TASK, "in-process", calls)
    seedRecord(store, { task_id: TASK, status: "error", residency_state: "resident", host_pid: process.pid })
    registry.add(handle)
    const { lifecycle, cancel } = cancelSurface(store, registry)

    // when
    const result = await cancel()

    // then
    expect(result.details).toEqual({ kind: "released", task_id: TASK, status: "error" })
    expect(calls).toEqual([`abort:${TASK}`, `dispose:${TASK}`])
    expect(registry.get(TASK)).toBeUndefined()
    expect(store.load(TASK)?.status).toBe("error")
    expect(store.load(TASK)?.residency_state).toBe("persisted_only")
    lifecycle.dispose?.()
  })

  test("#given a released child #when cancelled again #then nothing changes and the finished status is reported", async () => {
    // given
    const store = tempStore()
    const registry = new FakeRegistry()
    seedRecord(store, { task_id: TASK, status: "completed", residency_state: "resident", host_pid: process.pid })
    registry.add(fakeHandle(TASK, "in-process", []))
    const { lifecycle, cancel } = cancelSurface(store, registry)
    await cancel()

    // when
    const again = await cancel()

    // then
    expect(again.details).toMatchObject({ kind: "noop", task_id: TASK, status: "completed" })
    expect(store.load(TASK)?.residency_state).toBe("persisted_only")
    lifecycle.dispose?.()
  })

  test("#given a finished child resident in another process #when cancelled here #then it is left alone", async () => {
    // given
    const store = tempStore()
    seedRecord(store, { task_id: TASK, status: "completed", residency_state: "resident", host_pid: process.pid + 1 })
    const { lifecycle, cancel } = cancelSurface(store, new FakeRegistry())

    // when
    const result = await cancel()

    // then
    expect(result.details).toMatchObject({ kind: "noop", status: "completed" })
    expect(store.load(TASK)?.residency_state).toBe("resident")
    lifecycle.dispose?.()
  })
})
