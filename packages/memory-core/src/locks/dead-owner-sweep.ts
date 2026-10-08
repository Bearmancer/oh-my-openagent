import { hostname } from "node:os"
import path from "node:path"

import { lstat, readdir, readFile } from "../fs/resilient"
import { LockContentionError, acquireWithoutDirectorySweep, isLockOwnerProvenDead, releaseLock } from "./acquire"
import { createLockRecord, parseLockRecord } from "./lock-record"
import { getPidLiveness } from "./process-identity"

const LOCK_FILE_SUFFIX = ".lock"

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function ownerIsProvenDead(lockPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(lockPath, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
  const owner = parseLockRecord(raw)
  // A sweep checks only owners whose pid is already gone; a live pid would cost a start-identity probe
  // (a process spawn) per lock on every sweep. A recycled pid is still caught by the next contender.
  if (owner === null || owner.hostname !== hostname() || getPidLiveness(owner.pid) !== "dead") return false
  return isLockOwnerProvenDead(owner)
}

/**
 * Reclaims every `*.lock` in `lockDirectory` whose recorded owner's pid is gone on this host (the same
 * proof every contender applies; never age). A lock nobody contends for again is otherwise kept
 * forever. Reclaim goes through the acquire path with no wait, so it follows the same race-safe recovery
 * protocol every contender uses, and the lock is released at once. Returns how many were reclaimed.
 */
export async function sweepDeadOwnerLocks(lockDirectory: string): Promise<number> {
  let names: readonly string[]
  try {
    names = await readdir(lockDirectory)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0
    throw error
  }
  let reclaimed = 0
  for (const name of names) {
    if (!name.endsWith(LOCK_FILE_SUFFIX)) continue
    const lockPath = path.join(lockDirectory, name)
    const status = await lstat(lockPath).catch(() => undefined)
    if (status === undefined || !status.isFile() || !(await ownerIsProvenDead(lockPath))) continue
    const sweeper = await createLockRecord("dead-owner-sweep")
    try {
      await acquireWithoutDirectorySweep(lockPath, sweeper, { waitTimeoutMs: 0 })
    } catch (error) {
      if (error instanceof LockContentionError) continue
      throw error
    }
    await releaseLock(lockPath, sweeper)
    reclaimed += 1
  }
  return reclaimed
}
