/**
 * Self-improvement loop wiring tests — flag gating, trigger filtering, coalescing,
 * and resilience (a throwing analyze never escapes into the event bus).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { attachSelfImprovementLoop, isSelfImprovementLoopEnabled } from "../../src/learning/loop-wiring";
import { EventBus } from "../../src/observability/event-bus";

const FLAG = "AMAZE_SELF_IMPROVE_LOOP";
let prev: string | undefined;

beforeEach(() => {
	prev = process.env[FLAG];
});
afterEach(() => {
	if (prev === undefined) delete process.env[FLAG];
	else process.env[FLAG] = prev;
});

const goalComplete = () =>
	({
		type: "goal.complete",
		sessionId: "s",
		ts: 1,
		goalId: "g",
		verdict: "pass",
		failedCount: 0,
		uncertainCount: 0,
	}) as const;

describe("attachSelfImprovementLoop", () => {
	it("defaults the flag OFF and is a no-op subscriber when disabled", () => {
		delete process.env[FLAG];
		expect(isSelfImprovementLoopEnabled()).toBe(false);
		const bus = new EventBus();
		let calls = 0;
		const off = attachSelfImprovementLoop({ eventBus: bus, analyze: async () => void calls++ });
		bus.emit(goalComplete());
		expect(calls).toBe(0); // never subscribed
		off();
	});

	it("accepts common truthy spellings and surrounding whitespace", () => {
		for (const v of ["1", "true", "TRUE", "True", "yes", "on", " 1 ", "true\n"]) {
			process.env[FLAG] = v;
			expect(isSelfImprovementLoopEnabled()).toBe(true);
		}
		for (const v of ["0", "false", "no", "off", "", "  "]) {
			process.env[FLAG] = v;
			expect(isSelfImprovementLoopEnabled()).toBe(false);
		}
	});

	it("runs analyze on goal.complete when enabled", async () => {
		process.env[FLAG] = "1";
		const bus = new EventBus();
		let calls = 0;
		const off = attachSelfImprovementLoop({ eventBus: bus, analyze: async () => void calls++ });
		bus.emit(goalComplete());
		await new Promise(r => setTimeout(r, 5));
		expect(calls).toBe(1);
		off();
	});

	it("ignores non-trigger events", async () => {
		process.env[FLAG] = "1";
		const bus = new EventBus();
		let calls = 0;
		const off = attachSelfImprovementLoop({ eventBus: bus, analyze: async () => void calls++ });
		bus.emit({ type: "turn.start", sessionId: "s", ts: 1, turn: 1 });
		await new Promise(r => setTimeout(r, 5));
		expect(calls).toBe(0);
		off();
	});

	it("coalesces overlapping triggers into a single rerun", async () => {
		process.env[FLAG] = "1";
		const bus = new EventBus();
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		const off = attachSelfImprovementLoop({
			eventBus: bus,
			analyze: async () => {
				calls++;
				if (calls === 1) await gate; // hold the first pass open
			},
		});
		bus.emit(goalComplete()); // starts pass 1 (held)
		bus.emit(goalComplete()); // coalesced → schedules 1 rerun
		bus.emit(goalComplete()); // coalesced again → still just 1 rerun
		await new Promise(r => setTimeout(r, 5));
		expect(calls).toBe(1); // pass 1 still in-flight
		release();
		await new Promise(r => setTimeout(r, 5));
		expect(calls).toBe(2); // exactly one coalesced rerun
		off();
	});

	it("is resilient: a throwing analyze routes to onError, never into the bus", async () => {
		process.env[FLAG] = "1";
		const bus = new EventBus();
		const errors: unknown[] = [];
		const off = attachSelfImprovementLoop({
			eventBus: bus,
			analyze: async () => {
				throw new Error("boom");
			},
			onError: e => errors.push(e),
		});
		expect(() => bus.emit(goalComplete())).not.toThrow();
		await new Promise(r => setTimeout(r, 5));
		expect(errors.length).toBe(1);
		off();
	});
});
