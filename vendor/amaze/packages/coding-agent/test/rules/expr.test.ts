import { describe, expect, test } from "bun:test";
import { compileExpr, evaluate } from "../../src/rules";

function evalExpr(source: string, ctx = {}) {
	return evaluate(compileExpr(source), {
		$: {},
		...ctx,
	});
}

describe("rule expression evaluator", () => {
	test("evaluates literals", () => {
		expect(evalExpr('"hello"')).toBe("hello");
		expect(evalExpr("42")).toBe(42);
		expect(evalExpr("true")).toBe(true);
		expect(evalExpr("null")).toBeNull();
	});

	test("reads JSONPath-like members and array indexes", () => {
		expect(evalExpr("$.type", { $: { type: "goal.complete" } })).toBe("goal.complete");
		expect(evalExpr("$.items[1].name", { $: { items: [{ name: "a" }, { name: "b" }] } })).toBe("b");
		expect(evalExpr("$.items[9].name", { $: { items: [] } })).toBeUndefined();
	});

	test("evaluates comparison, logic, and arithmetic", () => {
		expect(
			evalExpr('$.type == "goal.complete" && !($.verdict != "force")', {
				$: { type: "goal.complete", verdict: "force" },
			}),
		).toBe(true);
		expect(evalExpr("(2 + 3 * 4) % 5 == 4")).toBe(true);
		expect(evalExpr("10 / 2 >= 5 && 1 < 2")).toBe(true);
	});

	test("reads counters and thresholds", () => {
		expect(
			evalExpr("$count / $windowSize > thresholds.maxRate", {
				count: 12,
				windowSize: 100,
				thresholds: { maxRate: 0.05 },
			}),
		).toBe(true);
		expect(evalExpr("$now >= thresholds.start", { now: 200, thresholds: { start: 100 } })).toBe(true);
	});

	test("rejects code-like input without executing it", () => {
		(globalThis as { __ruleExprExecuted?: boolean }).__ruleExprExecuted = false;
		expect(() => compileExpr("eval('__ruleExprExecuted = true')")).toThrow();
		expect(() => compileExpr("new Function('__ruleExprExecuted = true')()")).toThrow();
		expect((globalThis as { __ruleExprExecuted?: boolean }).__ruleExprExecuted).toBe(false);
	});
});
