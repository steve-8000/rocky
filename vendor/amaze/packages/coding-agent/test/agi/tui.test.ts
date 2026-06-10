import { describe, expect, it, vi } from "bun:test";
import { AgiGatewayStore } from "../../src/agi/store";
import { AgiDashboardComponent } from "../../src/agi/tui";

function createSession(id: string, state: "watching" | "waiting" | "blocked") {
	const store = new AgiGatewayStore(":memory:");
	const session = store.addSession({ sessionId: id, sessionPath: `/tmp/${id}.jsonl`, cwd: "/tmp/project", title: id });
	const updated = store.updateSession(id, {
		state,
		score: state === "blocked" ? 40 : 20,
		completionState: session.completionState,
		controlState: session.controlState,
	});
	store.close();
	return updated;
}

describe("AGI dashboard component", () => {
	it("routes pause resume unblock remove and command to the selected session", () => {
		const onAdd = vi.fn();
		const onPause = vi.fn();
		const onResume = vi.fn();
		const onUnblock = vi.fn();
		const onRemove = vi.fn();
		const onCommand = vi.fn();
		const onQuit = vi.fn();
		const component = new AgiDashboardComponent(
			[createSession("s1", "watching"), createSession("s2", "blocked")],
			20,
			{ onAdd, onPause, onResume, onUnblock, onRemove, onCommand, onQuit },
		);

		component.handleInput("p");
		expect(onPause).toHaveBeenCalledWith("s1");
		component.handleInput(":");
		expect(onCommand).toHaveBeenCalledWith("s1");
		component.handleInput("\u001b[B");
		component.handleInput("u");
		expect(onUnblock).toHaveBeenCalledWith("s2");
		component.handleInput("r");
		expect(onResume).toHaveBeenCalledWith("s2");
		component.handleInput("x");
		expect(onRemove).toHaveBeenCalledWith("s2");
		component.handleInput("a");
		expect(onAdd).toHaveBeenCalledTimes(1);
		component.handleInput("q");
		expect(onQuit).toHaveBeenCalledTimes(1);
	});
});
