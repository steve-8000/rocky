import { describe, expect, it } from "bun:test";
import { AgiGatewayStore, buildAgiCompletionState } from "../../src/agi/store";

function makeStore(): AgiGatewayStore {
	return new AgiGatewayStore(":memory:");
}

describe("AGI gateway store", () => {
	it("adds monitored sessions with a structured completion contract", () => {
		const store = makeStore();
		try {
			const created = store.addSession({
				sessionId: "s1",
				sessionPath: "/tmp/s1.jsonl",
				cwd: "/tmp/project",
				title: "Initial task",
			});
			expect(created).toMatchObject({
				sessionId: "s1",
				sessionPath: "/tmp/s1.jsonl",
				cwd: "/tmp/project",
				title: "Initial task",
				state: "watching",
				score: 20,
			});
			expect(created.goalSpec.markerPrefix).toBe("AGI_GATEWAY_RESULT");
			expect(created.completionState.supervisorSatisfiedCriteria).toEqual(["monitored_by_gateway"]);
			expect(created.completionState.missingCriteria).toContain("initial_build_goal_complete");
		} finally {
			store.close();
		}
	});

	it("records durable gateway events for monitored sessions", () => {
		const store = makeStore();
		try {
			store.addSession({ sessionId: "s1", sessionPath: "/tmp/s1.jsonl", cwd: "/tmp/project" });
			const event = store.recordEvent("s1", "session.completed", { summary: "done" });
			expect(event).toMatchObject({ sessionId: "s1", type: "session.completed", payload: { summary: "done" } });
			expect(store.listEvents("s1")).toHaveLength(1);
			expect(store.getSession("s1")?.lastEventAt).toBe(event.createdAt);
		} finally {
			store.close();
		}
	});

	it("tracks actions and keeps completion state aligned with score updates", () => {
		const store = makeStore();
		try {
			const session = store.addSession({ sessionId: "s1", sessionPath: "/tmp/s1.jsonl", cwd: "/tmp/project" });
			const completionState = buildAgiCompletionState(session.goalSpec, {
				score: 80,
				complete: false,
				structuredResultSeen: true,
				summary: "Agent reported bounded context and initial build completion.",
				agentSatisfiedCriteria: ["context_boundaries_preserved", "initial_build_goal_complete"],
				supervisorSatisfiedCriteria: [
					"monitored_by_gateway",
					"completion_alarm_detected",
					"follow_up_turn_executed",
				],
			});
			const updated = store.updateSession("s1", { score: 80, completionState });
			expect(updated.score).toBe(80);
			expect(updated.completionState.score).toBe(80);
			expect(updated.completionState.structuredResultSeen).toBe(true);
			const event = store.recordEvent("s1", "session.turn_completed", { summary: "ready" });
			const action = store.createAction({
				sessionId: "s1",
				eventId: event.id,
				actionType: "follow_up_turn",
				instruction: "continue",
			});
			expect(store.overallScore()).toBe(80);
			expect(store.listPendingActions()).toHaveLength(1);
			store.markActionRunning(action.id, 10);
			store.markActionCompleted(action.id, { ok: true }, 20);
			expect(store.getAction(action.id)).toMatchObject({
				status: "completed",
				startedAt: 10,
				finishedAt: 20,
				result: { ok: true },
			});
		} finally {
			store.close();
		}
	});
});
