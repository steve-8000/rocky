import { describe, expect, it } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import { projectMissionToTodoPhases } from "@amaze/coding-agent/mission/core/mission-todo-projection";
import { MissionStore } from "@amaze/coding-agent/mission/store";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@amaze/coding-agent/tools";

/**
 * Reproduces the bug where `done`/`rm` ops targeting mission-projection-only items
 * (Decision record, Verification verdict, the Verification phase itself, …) were
 * rejected with confusing `Task "X" not found` errors that aborted the whole batch.
 * The fix turns these into informational notices and lets the rest of the batch flow.
 */
describe("todo_write synthetic mission phases", () => {
	function build() {
		const store = new MissionStore(":memory:");
		let activeMissionId: string | undefined;
		let sessionLocalPhases: TodoPhase[] = [];
		const missionControl = new MissionControlRuntime({
			store,
			setActiveMissionId: id => {
				activeMissionId = id;
			},
			getActiveMissionId: () => activeMissionId,
		});
		const session: ToolSession = {
			cwd: "/tmp/test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getActiveMission: () => missionControl.getActiveMission(),
			missionControl,
			getTodoPhases: () => {
				const mission = missionControl.getActiveMission();
				return mission && mission.tasks.length > 0 ? projectMissionToTodoPhases(mission) : sessionLocalPhases;
			},
			setTodoPhases: phases => {
				sessionLocalPhases = phases;
			},
		};
		return { store, session, missionControl };
	}

	it("does not error when `done` targets the synthetic 'Decision record' task", async () => {
		const { store, session, missionControl } = build();
		try {
			// "architecture" keyword routes the inferred intent to architecture_change, which
			// synthesizes Decision + Regression + Verification phases via projectMissionToTodoPhases.
			await missionControl.ensureActiveMission({
				content: "redesign architecture for the api auth flow",
			});
			const tool = new TodoWriteTool(session);
			await tool.execute("call-1", {
				ops: [{ op: "init", list: [{ phase: "Execution", items: ["Audit code", "Draft proposal"] }] }],
			});
			const result = await tool.execute("call-2", {
				ops: [
					{ op: "done", task: "Audit code" },
					{ op: "done", task: "Decision record" },
					{ op: "done", task: "Verification verdict" },
				],
			});
			expect(result.isError).toBeFalsy();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('Skipped op "done" on "Decision record"');
			expect(text).toContain('Skipped op "done" on "Verification verdict"');
			expect(text).toContain("mission runtime tools");
			const mission = missionControl.getActiveMission();
			const audit = mission?.tasks.find(t => t.title === "Audit code");
			expect(audit?.status).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("skips ops targeting a synthetic phase by name with a notice", async () => {
		const { store, session, missionControl } = build();
		try {
			await missionControl.ensureActiveMission({
				content: "redesign architecture for the scheduler runtime",
			});
			const tool = new TodoWriteTool(session);
			await tool.execute("call-1", {
				ops: [{ op: "init", list: [{ phase: "Execution", items: ["task one"] }] }],
			});
			const result = await tool.execute("call-2", {
				ops: [{ op: "rm", phase: "Verification" }],
			});
			expect(result.isError).toBeFalsy();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('Skipped op "rm" on phase "Verification"');
		} finally {
			store.close();
		}
	});
});
