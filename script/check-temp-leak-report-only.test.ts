import { describe, expect, test } from "bun:test"

import { addedReportOnlyEntries } from "./check-temp-leak-report-only.mjs"

// Contract: the report-only temp-leak list may only shrink (#9766). A change that adds a prefix to an
// existing owner, or a new owner, must be named; a change that only removes entries passes.
describe("addedReportOnlyEntries", () => {
  test("#given entries only removed #when compared #then nothing is added", () => {
    const base = { "omo-codex": ["omo-codex-agents-", "omo-codex-cache-"], "team-core": ["worktree-"] }
    const head = { "omo-codex": ["omo-codex-cache-"] }

    expect(addedReportOnlyEntries(base, head)).toEqual([])
  })

  test("#given a prefix added to a listed owner and a new owner #when compared #then both are named", () => {
    const base = { "omo-codex": ["omo-codex-cache-"] }
    const head = { "omo-codex": ["omo-codex-cache-", "omo-codex-new-"], "boulder-state": ["boulder-stale-"] }

    expect(addedReportOnlyEntries(base, head)).toEqual(["boulder-state: boulder-stale-", "omo-codex: omo-codex-new-"])
  })

  test("#given a prefix moved between owners #when compared #then the move counts as an addition", () => {
    const base = { "omo-opencode": ["skill-content-test-"] }
    const head = { "skills-loader-core": ["skill-content-test-"] }

    expect(addedReportOnlyEntries(base, head)).toEqual(["skills-loader-core: skill-content-test-"])
  })
})
