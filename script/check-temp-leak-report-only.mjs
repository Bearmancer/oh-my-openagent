#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// test-temp-leak-report-only.json names the test temp entries that are still reported instead of
// failing the run (#9766). It exists to be emptied: a change may remove entries, never add them. A
// new leak is fixed where it is created, not listed.
export const REPORT_ONLY_LIST_PATH = "test-temp-leak-report-only.json"

/**
 * Owner/prefix pairs present in `head` but not in `base`. Both are the parsed list: owner -> prefixes.
 * @param {Record<string, readonly string[]>} base
 * @param {Record<string, readonly string[]>} head
 * @returns {string[]}
 */
export function addedReportOnlyEntries(base, head) {
  const added = []
  for (const [owner, prefixes] of Object.entries(head)) {
    const known = new Set(base[owner] ?? [])
    for (const prefix of prefixes) if (!known.has(prefix)) added.push(`${owner}: ${prefix}`)
  }
  return added.sort()
}

function readBaseList(baseSha) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${baseSha}:${REPORT_ONLY_LIST_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : ""
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return undefined
    throw error
  }
}

function main() {
  const baseSha = process.argv[2]
  if (!baseSha) throw new Error("usage: check-temp-leak-report-only.mjs <base-sha>")
  const base = readBaseList(baseSha)
  if (base === undefined) {
    console.log(`${REPORT_ONLY_LIST_PATH} is new at this change; nothing to compare.`)
    return
  }
  const head = JSON.parse(readFileSync(REPORT_ONLY_LIST_PATH, "utf8"))
  const added = addedReportOnlyEntries(base, head)
  if (added.length === 0) {
    console.log(`${REPORT_ONLY_LIST_PATH}: no entries added since ${baseSha.slice(0, 10)}.`)
    return
  }
  console.error(`${REPORT_ONLY_LIST_PATH} may only shrink (#9766). Remove the temp dirs these tests leave instead of listing them:`)
  for (const entry of added) console.error(`  ${entry}`)
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
