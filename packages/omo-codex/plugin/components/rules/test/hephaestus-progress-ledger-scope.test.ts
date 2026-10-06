import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LEDGER_TEMPLATE =
	"You need: [ledger N/M done, findings, blockers]. Now: [todo task in progress]. Next: [next open task].";
const SCOPE = "A request finished in a single turn with no todo list gets a plain answer with no block";

describe("Hephaestus progress-ledger handoff block scope (#9616)", () => {
	it.each(["gpt-5.6.md", "gpt-6.md"])(
		"#given the bundled %s rule #when it defines the ledger block #then it exempts single-turn answers",
		(file) => {
			// given
			const rule = readFileSync(join(process.cwd(), "bundled-rules", "hephaestus", file), "utf8");

			// when
			const ledgerAt = rule.indexOf(LEDGER_TEMPLATE);
			const scopeAt = rule.indexOf(SCOPE);

			// then
			expect(ledgerAt).toBeGreaterThan(-1);
			expect(scopeAt).toBeGreaterThan(ledgerAt);
			expect(rule).toContain("never opens or closes with ledger lines such as `Next: none`");
		},
	);
});
