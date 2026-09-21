import { describe, expect, test } from "bun:test"

import type { PanelMemoryIdentity, PanelMemorySource } from "../types"
import { createPanelMemoryReader } from "./memory"

const identity: PanelMemoryIdentity = {
  id: "notwork-09334074",
  reflectionDir: "/mem/agents/notwork-09334074/runtime/reflection",
  factsQueueDir: "/mem/agents/notwork-09334074/runtime/facts-queue",
  recallLedgerDir: "/mem/agents/notwork-09334074/runtime/recall/ledger",
  recallPendingDir: "/mem/agents/notwork-09334074/runtime/recall/pending",
}

const SESSION = "01a0c2b7-adb1-7e1d-8d80-da16a25469ff"
const PARKED_AT = "2026-09-21T09:00:00.000Z"
/** REFLECTION_PARK_PROBE_INTERVAL_MS is six hours. */
const SIX_HOURS_AFTER_PARK = "2026-09-21T15:00:00.000Z"

interface FakeOptions {
  readonly park?: Awaited<ReturnType<PanelMemorySource["park"]>>
  readonly dirs?: Readonly<Record<string, readonly string[]>>
  readonly files?: Readonly<Record<string, unknown>>
}

/** Counts every path touched, so "this read never happens" can be proven rather than assumed. */
function fakeSource(options: FakeOptions = {}) {
  const touched: string[] = []
  const port: PanelMemorySource = {
    async park(dir) {
      touched.push(dir)
      return options.park
    },
    async list(dir) {
      touched.push(dir)
      return options.dirs?.[dir] ?? []
    },
    async readJson(path) {
      touched.push(path)
      return options.files?.[path]
    },
  }
  return { port, touched }
}

const ledgerFile = `${identity.recallLedgerDir}/${SESSION}.json`
const pendingFile = `${identity.recallPendingDir}/${SESSION}.json`

describe("createPanelMemoryReader", () => {
  test("#given a parked identity #when read #then the column gets the park facts it draws", async () => {
    // given the scheduler parked automatic reflection after repeated deterministic failures
    const source = fakeSource({
      park: {
        version: 1,
        streak: 3,
        parkedAt: PARKED_AT,
        lastFailure: {
          runId: "run-7",
          at: PARKED_AT,
          fingerprint: "sandbox:bwrap",
          retryable: false,
          reason: "reflection sandbox refused to start",
          detail: "bwrap: Creating new namespace failed: Operation not permitted",
        },
      },
    })

    // when
    const memory = await createPanelMemoryReader(source.port)(identity, SESSION)

    // then
    expect(memory?.identity).toBe("notwork-09334074")
    expect(memory?.reflection).toEqual({
      streak: 3,
      parkedAt: PARKED_AT,
      nextProbeAt: SIX_HOURS_AFTER_PARK,
      reason: "reflection sandbox refused to start",
      detail: "bwrap: Creating new namespace failed: Operation not permitted",
    })
  })

  test("#given a half-open probe already spent #when read #then the next probe is measured from it", async () => {
    // given the host measures the interval from lastProbeAt when there is one
    // (`reflectionParkNextProbeAt`), so a probed identity must not look overdue forever
    const source = fakeSource({
      park: { version: 1, streak: 4, parkedAt: "2026-09-20T00:00:00.000Z", lastProbeAt: PARKED_AT },
    })

    // when / then
    expect((await createPanelMemoryReader(source.port)(identity, SESSION))?.reflection?.nextProbeAt).toBe(
      SIX_HOURS_AFTER_PARK,
    )
  })

  test("#given failures that have not parked yet #when read #then the streak comes through alone", async () => {
    // given a streak below the threshold is worth showing and is not a park
    const source = fakeSource({ park: { version: 1, streak: 2 } })

    // when
    const reflection = (await createPanelMemoryReader(source.port)(identity, SESSION))?.reflection

    // then
    expect(reflection?.streak).toBe(2)
    expect(reflection?.parkedAt).toBeUndefined()
    expect(reflection?.nextProbeAt).toBeUndefined()
  })

  test("#given healthy reflection #when read #then no reflection block is reported", async () => {
    // given an empty park state is what a working identity looks like, and it is not news
    const source = fakeSource({ park: { version: 1, streak: 0 } })

    // when
    const memory = await createPanelMemoryReader(source.port)(identity, SESSION)

    // then
    expect(memory?.reflection).toBeUndefined()
    expect(memory?.identity).toBe("notwork-09334074")
  })

  test("#given an unreadable park file #when read #then the rest of the block survives", async () => {
    // given a hand-edited or truncated park.json must not blank the identity and the backlog
    const source = fakeSource({
      dirs: { [identity.factsQueueDir]: ["20260921T090000000Z-abc123def456-0a1b2c3d.json"] },
    })

    // when
    const memory = await createPanelMemoryReader(source.port)(identity, SESSION)

    // then
    expect(memory?.reflection).toBeUndefined()
    expect(memory?.factsQueued).toBe(1)
  })

  test("#given a facts queue #when read #then bookkeeping files are not counted as backlog", async () => {
    // given the queue dir also holds the cursor dir and two watermark files
    const source = fakeSource({
      dirs: {
        [identity.factsQueueDir]: [
          "20260921T090000000Z-abc123def456-0a1b2c3d.json",
          "20260921T091000000Z-abc123def456-1a2b3c4d.json",
          "consumed.json",
          "failures.json",
          "cursor",
          "20260921T092000000Z-abc123def456-2a3b4c5d.json.tmp-4242",
        ],
      },
    })

    // when / then
    expect((await createPanelMemoryReader(source.port)(identity, SESSION))?.factsQueued).toBe(2)
  })

  test("#given a recall ledger for this session #when read #then the surfaced paths are counted", async () => {
    // given
    const source = fakeSource({
      files: {
        [ledgerFile]: {
          version: 1,
          surfaced: {
            "reference/strix-halo.md": { hash: "a", at: PARKED_AT },
            "system/human.md": { hash: "b", at: PARKED_AT },
          },
        },
      },
    })

    // when / then
    expect((await createPanelMemoryReader(source.port)(identity, SESSION))?.recallSurfaced).toBe(2)
  })

  test("#given pending nudges for this session #when read #then they are counted and left alone", async () => {
    // given `PendingNudges.take()` DELETES the file; a status column that consumed the session's
    // nudges would be a bug wearing a rendering choice
    const source = fakeSource({
      files: {
        [pendingFile]: {
          version: 1,
          sessionId: SESSION,
          writtenAt: PARKED_AT,
          nudges: [{ path: "notes/open-threads.md", hint: "check the parked thread" }],
        },
      },
    })

    // when / then
    expect((await createPanelMemoryReader(source.port)(identity, SESSION))?.recallPending).toBe(1)
  })

  test("#given a pending file owned by another session #when read #then it is not counted here", async () => {
    // given sanitizeSessionFilename maps distinct session ids onto one filename, which is why
    // the host verifies the embedded id before it trusts the payload
    const source = fakeSource({
      files: {
        [pendingFile]: {
          version: 1,
          sessionId: "some-other-session",
          writtenAt: PARKED_AT,
          nudges: [{ path: "notes/open-threads.md", hint: "not yours" }],
        },
      },
    })

    // when / then
    expect((await createPanelMemoryReader(source.port)(identity, SESSION))?.recallPending).toBe(0)
  })

  test("#given no session id yet #when read #then the recall files are not even looked for", async () => {
    // given recall state is per session, so without one there is nothing to name
    const source = fakeSource()

    // when
    const memory = await createPanelMemoryReader(source.port)(identity, undefined)

    // then
    expect(memory?.recallSurfaced).toBe(0)
    expect(memory?.recallPending).toBe(0)
    expect(source.touched.some((path) => path.includes("recall"))).toBe(false)
  })

  test("#given no identity #when read #then nothing is read at all", async () => {
    // given memory can be off, or the identity can fail to resolve; both mean a silent block
    const source = fakeSource()

    // when
    const memory = await createPanelMemoryReader(source.port)(undefined, SESSION)

    // then
    expect(memory).toBeUndefined()
    expect(source.touched).toEqual([])
  })
})
