import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseRuleMarkdown } from "../../src/rules";

const BUILTIN_RULE_DIR = join(import.meta.dir, "../../src/rules/builtin");

const expectedRuleIds = [
	"force-complete-rate",
	"destructive-mission-discipline",
	"subagent-no-yield",
	"repeated-prompts",
	"stale-contract",
	"memory-low-precision",
	"verifier-bypass-rate",
	"session-memory-recall-decay",
	"request-cache-churn",
	"workspace-force-complete-trend",
];

describe("builtin rule files", () => {
	test("parse and expose required detection fields", () => {
		const files = readdirSync(BUILTIN_RULE_DIR)
			.filter(file => file.endsWith(".rule.md"))
			.sort();

		expect(files).toEqual(expectedRuleIds.map(id => `${id}.rule.md`).sort());

		for (const file of files) {
			const markdown = readFileSync(join(BUILTIN_RULE_DIR, file), "utf8");
			const rule = parseRuleMarkdown(markdown);
			const idFromFilename = basename(file, ".rule.md");

			expect(rule.id).toBe(idFromFilename);
			expect(expectedRuleIds).toContain(rule.id);
			expect(rule.detect.scan).toBeTruthy();
			expect(rule.detect.match).toBeTruthy();
			expect(rule.detect.aggregate).toBeTruthy();
			expect(rule.detect.check).toBeTruthy();
		}
	});
});
