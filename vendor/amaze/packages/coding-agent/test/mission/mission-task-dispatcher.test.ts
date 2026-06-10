import { describe, expect, test } from "bun:test";
import type { MissionTask } from "../../src/mission/core/mission-task";
import { MissionTaskDispatcher } from "../../src/mission/core/mission-task-dispatcher";
import type { MissionTaskRunResult } from "../../src/task/mission-task-runner";

describe("MissionTaskDispatcher", () => {
	test("records successful runner attempts and evidence", async () => {
		const dispatcher = new MissionTaskDispatcher(((task: MissionTask) => ({
			async run(): Promise<MissionTaskRunResult> {
				return {
					binding: { missionId: task.missionId ?? "m1", taskId: task.id },
					evidenceRefs: ["task-run://r1"],
					task: { ...task, status: "completed" },
					result: {
						index: 0,
						id: "r1",
						agent: "Builder",
						agentSource: "bundled",
						task: task.title,
						exitCode: 0,
						output: "done",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
					},
				};
			},
		})) as unknown as ConstructorParameters<typeof MissionTaskDispatcher>[0]);
		const evidenceRefs: string[] = [];
		const attempts: Array<{ taskId: string; attempt: "success" | "failure"; note?: string }> = [];

		const result = await dispatcher.run([{ id: "t1", missionId: "m1", title: "Task", status: "pending" }], {
			scopeGuard: undefined,
			evidenceRefs,
			recordAttempt: (taskId, attempt, note) => attempts.push({ taskId, attempt, note }),
		});

		expect(result).toEqual({ completedTaskIds: ["t1"], failedTaskIds: [], blocked: false });
		expect(evidenceRefs).toEqual(["task-run://r1"]);
		expect(attempts).toEqual([{ taskId: "t1", attempt: "success", note: undefined }]);
	});
});
