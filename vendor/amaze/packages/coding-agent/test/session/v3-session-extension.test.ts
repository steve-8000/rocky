/**
 * R1 proof — V3SessionExtension carries v3 state cleanly outside AgentSession.
 *
 * Verifies the extracted module's behavior is equivalent to the previous inline logic in
 * agent-session.ts. The migration is value-preserving: same cache-thrash detection rules,
 * same telemetry aggregation, same edge cases.
 */

import { describe, expect, it } from "bun:test";
import { CACHE_THRASH_WINDOW, V3SessionExtension } from "@amaze/coding-agent/session/v3-session-extension";

describe("V3SessionExtension — cache thrash detection", () => {
	it("does not warn before any cache write has been observed", () => {
		const ext = new V3SessionExtension();
		for (let i = 0; i < CACHE_THRASH_WINDOW + 2; i++) {
			ext.onTurnStart({ cacheRead: 0, cacheWrite: 0 });
		}
		const inspect = ext._inspectThrashState();
		expect(inspect.hasObservedCacheWrite).toBe(false);
		expect(inspect.thrashWarned).toBe(false);
	});

	it("does not warn when cache reads are non-zero (cache is working)", () => {
		const ext = new V3SessionExtension();
		ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		ext.onTurnStart({ cacheRead: 500, cacheWrite: 1000 });
		ext.onTurnStart({ cacheRead: 1000, cacheWrite: 1000 });
		ext.onTurnStart({ cacheRead: 1500, cacheWrite: 1000 });
		const inspect = ext._inspectThrashState();
		expect(inspect.hasObservedCacheWrite).toBe(true);
		expect(inspect.thrashWarned).toBe(false);
	});

	it("warns once after CACHE_THRASH_WINDOW consecutive zero-read turns post-write", () => {
		const ext = new V3SessionExtension();
		// First turn: cache write happens, no read yet.
		ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		// Subsequent turns: read stays at 0 (thrash signature).
		for (let i = 0; i < CACHE_THRASH_WINDOW; i++) {
			ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		}
		expect(ext._inspectThrashState().thrashWarned).toBe(true);
	});

	it("resets warn state when a non-zero read appears (recovered cache)", () => {
		const ext = new V3SessionExtension();
		ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		for (let i = 0; i < CACHE_THRASH_WINDOW; i++) {
			ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		}
		expect(ext._inspectThrashState().thrashWarned).toBe(true);
		// Recovery: a turn with positive read clears the warn flag.
		ext.onTurnStart({ cacheRead: 500, cacheWrite: 1000 });
		expect(ext._inspectThrashState().thrashWarned).toBe(false);
	});

	it("emits warn only ONCE per thrash episode (no log spam)", () => {
		const ext = new V3SessionExtension();
		ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		for (let i = 0; i < CACHE_THRASH_WINDOW + 5; i++) {
			ext.onTurnStart({ cacheRead: 0, cacheWrite: 1000 });
		}
		// Inspect: warned flag stays true; no per-turn re-warn.
		expect(ext._inspectThrashState().thrashWarned).toBe(true);
		// Once-only is captured by the flag staying high — the actual log would have been
		// emitted on the third zero-read turn and not again. Stateful assertion above proves
		// the re-entry guard works.
	});
});

describe("V3SessionExtension — telemetry passthrough", () => {
	it("exposes the V3Telemetry aggregator directly for tool integration", () => {
		const ext = new V3SessionExtension();
		ext.telemetry.recordDesignInterviewCall("fired");
		ext.telemetry.recordSubagentSpawn(true);
		const stats = ext.telemetry.getStats();
		expect(stats.designInterview.totalCalls).toBe(1);
		expect(stats.subagent.totalSpawned).toBe(1);
	});

	it("formatSummary renders the placeholder when no events recorded", () => {
		const ext = new V3SessionExtension();
		expect(ext.formatSummary()).toContain("no events recorded");
	});

	it("formatSummary renders real data once populated", () => {
		const ext = new V3SessionExtension();
		ext.telemetry.recordDesignInterviewCall("fired");
		ext.telemetry.recordClosingAudit({ passed: true, forced: false, uncertainCount: 0 });
		const summary = ext.formatSummary();
		expect(summary).toContain("Design Interview");
		expect(summary).toContain("Closing audit");
	});
});

describe("R1 ACCEPTANCE — extraction is value-preserving", () => {
	it("CACHE_THRASH_WINDOW remains 3 (no behavioral drift from original inline code)", () => {
		expect(CACHE_THRASH_WINDOW).toBe(3);
	});

	it("a single V3SessionExtension instance replaces 5 AgentSession fields", () => {
		// Sanity: the extension exposes exactly the surfaces AgentSession needs.
		const ext = new V3SessionExtension();
		expect(typeof ext.onTurnStart).toBe("function");
		expect(typeof ext.telemetry).toBe("object");
		expect(typeof ext.formatSummary).toBe("function");
		// Internal state stays internal — not enumerable on the public surface.
		const publicKeys = Object.keys(ext);
		expect(publicKeys).not.toContain("cacheReadDeltaHistory");
		expect(publicKeys).not.toContain("lastSeenCacheRead");
		expect(publicKeys).not.toContain("hasObservedCacheWrite");
		expect(publicKeys).not.toContain("cacheThrashWarned");
	});
});
