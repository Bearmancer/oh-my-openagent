import { describe, expect, test } from "bun:test"

import { reportOnlyEntryMatches, reportOnlyOwner } from "./test-temp-leak-match"

describe("reportOnlyEntryMatches (#9766)", () => {
  test.each([
    ["omo-tui-", "omo-tui-xdg-Ab12Cd", true],
    ["omo-tui-", "omo-tui-", true],
    ["omo-tui-", "omo-tu", false],
    ["omo-tui-", "x-omo-tui-1", false],
    ["omo.js$", "omo.js", true],
    ["omo.js$", "omo.jsx", false],
    ["omo.js$", "omo.j", false],
    [".omo$", ".omo", true],
    [".omo$", ".omo-x", false],
  ])("entry %p against %p is %p", (entry, name, matches) => {
    expect(reportOnlyEntryMatches(entry, name)).toBe(matches)
  })
})

describe("reportOnlyOwner (#9766)", () => {
  const list = { "omo-opencode": ["omo-cli-", "opencode$"], "team-core": ["team-mode-paths-"] }

  test.each([
    ["omo-cli-Zx9", "omo-opencode"],
    ["opencode", "omo-opencode"],
    ["team-mode-paths-1", "team-core"],
    ["opencode-data", undefined],
    ["brand-new-leak-", undefined],
  ])("%p is owned by %p", (name, owner) => {
    expect(reportOnlyOwner(name, list)).toBe(owner)
  })
})
