import { describe, expect, it } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import { projectMissionToTodoPhases } from "@amaze/coding-agent/mission/core/mission-todo-projection";
import { MissionStore } from "@amaze/coding-agent/mission/store";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@amaze/coding-agent/tools";

describe("todo_write mission board projection", () => {
	it("writes active mission tasks and returns projected todo phases", async () => {
		const store = new MissionStore(":memory:");
		try {
			let activeMissionId: string | undefined;
			let sessionLocalPhases: TodoPhase[] = [
				{ name: "Session local", tasks: [{ content: "stale local task", status: "pending" }] },
			];
			const staleSessionLocalPhases = sessionLocalPhases;
			const missionControl = new MissionControlRuntime({
				store,
				setActiveMissionId: id => {
					activeMissionId = id;
				},
				getActiveMissionId: () => activeMissionId,
			});
			await missionControl.ensureActiveMission({ content: "fix the todo mission board wiring" });

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
			const tool = new TodoWriteTool(session);

			await tool.execute("call-1", {
				ops: [{ op: "init", list: [{ phase: "Execution", items: ["Wire projection", "Assert store"] }] }],
			});
			await tool.execute("call-2", { ops: [{ op: "done", task: "Wire projection" }] });

			const mission = missionControl.getActiveMission();
			expect(mission?.tasks.map(task => ({ title: task.title, status: task.status }))).toEqual([
				{ title: "Wire projection", status: "completed" },
				{ title: "Assert store", status: "running" },
			]);
			expect(session.getTodoPhases?.()).toEqual(projectMissionToTodoPhases(mission!));
			expect(session.getTodoPhases?.()).not.toEqual(staleSessionLocalPhases);
		} finally {
			store.close();
		}
	});
});
