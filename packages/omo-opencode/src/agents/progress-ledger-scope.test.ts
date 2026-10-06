import { describe, expect, test } from "bun:test"
import { buildGpt56HephaestusPrompt } from "./hephaestus/gpt-5-6"
import { buildGrok4SisyphusPrompt } from "./sisyphus/grok-4"

const LEDGER_TEMPLATE = "You need: [ledger N/M done, findings, blockers]. Now: [todo task in progress]. Next: [next open task]."
const SCOPE = "A request finished in a single turn with no todo list gets a plain answer with no block"

describe("progress-ledger handoff block scope (#9616)", () => {
  test.each([
    ["hephaestus gpt-5.6", () => buildGpt56HephaestusPrompt([])],
    ["sisyphus grok-4", () => buildGrok4SisyphusPrompt("xai/grok-4", [])],
  ])("#given the %s prompt #when it defines the ledger block #then it exempts single-turn answers", (_name, build) => {
    // given
    const prompt = build()

    // when
    const ledgerAt = prompt.indexOf(LEDGER_TEMPLATE)
    const scopeAt = prompt.indexOf(SCOPE)

    // then
    expect(ledgerAt).toBeGreaterThan(-1)
    expect(scopeAt).toBeGreaterThan(ledgerAt)
    expect(prompt).toContain("never opens or closes with ledger lines such as `Next: none`")
  })
})
