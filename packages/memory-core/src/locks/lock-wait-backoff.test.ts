import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import * as resilientFs from "../fs/resilient"
import { LockContentionError, acquireLock, releaseLock } from "./acquire"
import { LOCK_RETRY_MAX_DELAY_MS, lockRetryDelayMs } from "./retry-delay"
import { memoryWriterLockPath } from "./domains"
import { createLockRecord } from "./lock-record"
import { RecallWakeBusyError, acquireRecallWakeLease, recallWakeTicketDirectory } from "./recall-wake-domain"

// Time is the behavior under test: a waiter polling at a fixed 25 ms makes ~40 reads per second for
// as long as the holder keeps the lock. The spies count the polls each wait loop makes.
const temporaryDirectories: string[] = []

async function createLocksDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lock-wait-backoff-"))
  temporaryDirectories.push(directory)
  return directory
}

function countCalls(name: "readFile" | "readdir", target: string): { readonly count: () => number; readonly restore: () => void } {
  const spy = spyOn(resilientFs, name)
  return {
    count: () => spy.mock.calls.filter((call) => String(call[0]) === target).length,
    restore: () => spy.mockRestore(),
  }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe("lock wait backoff", () => {
  test("#given the retry schedule #when attempts grow #then each delay stays inside its jitter band and under the cap", () => {
    let previousCeiling = 0
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ceiling = Math.min(LOCK_RETRY_MAX_DELAY_MS, 5 * 2 ** attempt)
      expect(lockRetryDelayMs(attempt, 5, () => 0)).toBe(Math.max(1, Math.round(ceiling / 2)))
      expect(lockRetryDelayMs(attempt, 5, () => 1)).toBe(ceiling)
      expect(ceiling).toBeGreaterThanOrEqual(previousCeiling)
      previousCeiling = ceiling
    }
    expect(previousCeiling).toBe(LOCK_RETRY_MAX_DELAY_MS)
  })

  test("#given a live holder for a whole second #when a contender waits with a 5 ms base delay #then it polls a bounded number of times", async () => {
    // #given
    const lockPath = memoryWriterLockPath(await createLocksDirectory())
    const holder = await createLockRecord("memory-write")
    await acquireLock(lockPath, holder)
    const reads = countCalls("readFile", lockPath)

    // #when
    try {
      await expect(acquireLock(lockPath, await createLockRecord("memory-write"), { waitTimeoutMs: 1_000, retryDelayMs: 5 })).rejects.toBeInstanceOf(LockContentionError)

      // #then
      expect(reads.count()).toBeLessThanOrEqual(25)
    } finally {
      reads.restore()
      await releaseLock(lockPath, holder)
    }
  })

  test("#given every recall-wake slot held for a second #when a contender waits #then the queue is polled a bounded number of times", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const held = await acquireRecallWakeLease(locksDirectory, { maxConcurrent: 1 })
    const polls = countCalls("readdir", recallWakeTicketDirectory(locksDirectory))

    // #when
    try {
      await expect(acquireRecallWakeLease(locksDirectory, { maxConcurrent: 1, waitTimeoutMs: 1_000, retryDelayMs: 5 })).rejects.toBeInstanceOf(RecallWakeBusyError)

      // #then
      expect(polls.count()).toBeLessThanOrEqual(25)
    } finally {
      polls.restore()
      await held.release()
    }
  })
})
