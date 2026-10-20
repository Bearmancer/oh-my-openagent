import type { GitCommitAuthor, GitMemoryRepo, MemoryCommit } from "../git"
import type { FactsApplyRecovery } from "./mutation-plan"
import { FactsMutationTransaction, FactsOwnershipLostError } from "./recovery-mutation"
import { captureOwnedFactsState, describeForeignParentState, sameFactsOwnedState } from "./recovery-ownership"

const PARENT_DIRTY_DETAIL_MAX_LINES = 5

async function describeParentDirty(repo: GitMemoryRepo, recovery: FactsApplyRecovery): Promise<string> {
  const lines = await describeForeignParentState(repo, recovery)
  const shown = lines.slice(0, PARENT_DIRTY_DETAIL_MAX_LINES).join("; ")
  return lines.length > PARENT_DIRTY_DETAIL_MAX_LINES
    ? `${shown}; +${lines.length - PARENT_DIRTY_DETAIL_MAX_LINES} more`
    : shown
}

export type FactsRecoveryResult =
  | { readonly outcome: "committed"; readonly sha: string; readonly affectedPaths: readonly string[] }
  | { readonly outcome: "parent_dirty"; readonly detail?: string }

export async function findFactsBatchReceipt(
  repo: GitMemoryRepo,
  batchId: string,
): Promise<MemoryCommit | undefined> {
  return (await repo.log()).find((commit) => commit.trailers["Omo-Facts-Batch"] === batchId)
}

export async function applyFactsRecovery(
  repo: GitMemoryRepo,
  recovery: FactsApplyRecovery,
  recordCount: number,
  author: GitCommitAuthor,
): Promise<FactsRecoveryResult> {
  const observed = await captureOwnedFactsState(repo, recovery)
  if (observed === undefined) {
    return { outcome: "parent_dirty", detail: await describeParentDirty(repo, recovery) }
  }
  const boundary = await captureOwnedFactsState(repo, recovery)
  if (boundary === undefined || !sameFactsOwnedState(observed, boundary)) {
    return { outcome: "parent_dirty", detail: await describeParentDirty(repo, recovery) }
  }
  const transaction = new FactsMutationTransaction(repo, recovery, boundary)
  try {
    await transaction.restorePreState()
    await transaction.applyPostState()
    const result = await repo.commitPrepared(
      recovery.paths.map((entry) => entry.path),
      commitMessage(recovery.batchId, recordCount),
      author,
    )
    return { outcome: "committed", sha: result.sha, affectedPaths: recovery.paths.map((entry) => entry.path) }
  } catch (error) {
    await transaction.rollback()
    if (error instanceof FactsOwnershipLostError) return {
      outcome: "parent_dirty",
      ...(error.recoveryPath === undefined ? {} : { detail: `Foreign entry retained at ${error.recoveryPath}` }),
    }
    throw error
  }
}

function commitMessage(batchId: string, count: number): string {
  return [
    `chore(facts): extract ${count} ${count === 1 ? "fact" : "facts"}`,
    "",
    "Generated-By: facts-extractor",
    "Omo-Writer: facts-extractor",
    `Omo-Facts-Batch: ${batchId}`,
  ].join("\n")
}
