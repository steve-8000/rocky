import { describe, expect, it } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import { projectMissionToTodoPhases } from "@amaze/coding-agent/mission/core/mission-todo-projection";
import { MissionStore } from "@amaze/coding-agent/mission/store";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@amaze/coding-agent/tools";

describe("todo_write synthetic rejection recorded-state context", () => {
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

	async function withMission(run: (fixture: ReturnType<typeof build>) => Promise<void>) {
		const fixture = build();
		try {
			await fixture.missionControl.ensureActiveMission({
				content: "redesign architecture for the payment runtime",
			});
			await run(fixture);
		} finally {
			fixture.store.close();
		}
	}

	async function rejectSyntheticTaskText(session: ToolSession, task: string) {
		const result = await new TodoWriteTool(session).execute("call-1", {
			ops: [{ op: "done", task }],
		});
		expect(result.isError).toBeFalsy();
		return result.content?.[0]?.type === "text" ? result.content[0].text : "";
	}

	it('done op on "Decision record" against mission with decisionId surfaces a recorded-state hint', async () => {
		await withMission(async ({ session, missionControl }) => {
			missionControl.getActiveMission()!.decisionId = "dec-1";

			const text = await rejectSyntheticTaskText(session, "Decision record");

			expect(text).toContain("projection-only");
			expect(text).toContain("decisionId=dec-1");
			expect(text).toContain("next session reload");
		});
	});

	it('done op on "Regression contract" against mission with regressionContractId surfaces a hint', async () => {
		await withMission(async ({ session, missionControl }) => {
			missionControl.getActiveMission()!.regressionContractId = "reg-1";

			const text = await rejectSyntheticTaskText(session, "Regression contract");

			expect(text).toContain("regressionContractId=reg-1");
		});
	});

	it('done op on "Verification verdict" against mission with pass verdict surfaces "completed" wording', async () => {
		await withMission(async ({ session, missionControl }) => {
			missionControl.getActiveMission()!.verification = { status: "pass", verdict: "pass", summary: "" };

			const text = await rejectSyntheticTaskText(session, "Verification verdict");

			expect(text).toContain("verdict=pass");
			expect(text).toContain("completed on next session reload");
		});
	});

	it('done op on "Decision record" against mission with no decisionId does NOT add the hint', async () => {
		await withMission(async ({ session }) => {
			const text = await rejectSyntheticTaskText(session, "Decision record");

			expect(text).toContain('Skipped op "done" on "Decision record" — projection-only.');
			expect(text).not.toContain("Decision is already recorded");
			expect(text).not.toContain("decisionId=");
			expect(text).not.toContain("next session reload");
		});
	});
});
