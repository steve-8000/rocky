import { describe, expect, it } from "bun:test";
import { EventBus, type SessionEvent } from "../../src/observability";

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

function event(turn: number, sessionId = "session-1"): SessionEvent {
	return { type: "turn.start", sessionId, ts: turn, turn };
}

describe("EventBus", () => {
	it("emits to subscribers asynchronously and unsubscribes", async () => {
		const bus = new EventBus();
		const received: SessionEvent[] = [];
		const unsubscribe = bus.subscribe(next => received.push(next));
		const first = event(1);
		const second = event(2);

		bus.emit(first);
		expect(bus.snapshot(1)).toEqual([first]);
		expect(received).toEqual([]);

		await tick();
		expect(received).toEqual([first]);

		unsubscribe();
		bus.emit(second);
		await tick();

		expect(received).toEqual([first]);
		expect(bus.snapshot(2)).toEqual([first, second]);
	});

	it("trims oldest events when the ring overflows", () => {
		const bus = new EventBus(3);
		for (let turn = 1; turn <= 5; turn += 1) {
			bus.emit(event(turn));
		}

		expect(bus.snapshot(10).map(next => (next.type === "turn.start" ? next.turn : -1))).toEqual([3, 4, 5]);
		expect(bus.snapshot(2).map(next => (next.type === "turn.start" ? next.turn : -1))).toEqual([4, 5]);
	});
});
