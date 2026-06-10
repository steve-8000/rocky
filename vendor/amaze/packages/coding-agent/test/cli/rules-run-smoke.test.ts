import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionEvent } from "../../src/observability";
import { evaluateRule, type RuleFinding } from "../../src/rules";
import { loadRules } from "../../src/rules/loader";

const BUILTIN_RULE_DIR = join(import.meta.dir, "../../src/rules/builtin");

const syntheticEvents = [
	event("goal.complete", "session-a", 1, { verdict: "force", failedCount: 1, uncertainCount: 0, goalId: "goal-a" }),
	event("subagent.end", "session-a", 2, { verdict: "fail", reason: "no-yield" }),
	event("tool.call", "session-a", 3, { tool: "ask" }),
	event("subagent.start", "session-a", 4, { contractRevision: 1 }),
	event("memory.recall", "session-a", 5, { hits: 4, usedHits: 1 }),
	event("session.start", "session-a", 6),
	event("turn.start", "session-a", 7, { turn: 1 }),
	event("cache.lookup", "session-a", 8, { missReason: "tail-change" }),
	event("turn.end", "session-a", 9, { turn: 1 }),
] satisfies SessionEvent[];

function event(type: string, sessionId: string, ts: number, extra: Record<string, unknown> = {}): SessionEvent {
	return { type, sessionId, ts, ...extra } as SessionEvent;
}

describe("rules run builtin smoke", () => {
	test("every builtin rule evaluates over representative events without throwing", async () => {
		const loaded = await loadRules({ builtinDir: BUILTIN_RULE_DIR });
		expect(loaded.length).toBeGreaterThan(0);

		for (const { rule } of loaded) {
			expect(() => evaluateRule(rule, syntheticEvents), rule.id).not.toThrow();
			const result = evaluateRule(rule, syntheticEvents);
			expect(result === null || Array.isArray(result) || isFinding(result), rule.id).toBe(true);
		}
	});
});

function isFinding(value: unknown): value is RuleFinding {
	return typeof value === "object" && value !== null && "ruleId" in value && "severity" in value;
}
