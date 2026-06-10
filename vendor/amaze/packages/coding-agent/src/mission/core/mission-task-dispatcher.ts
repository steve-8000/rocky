import { MissionTaskRunner } from "../../task/mission-task-runner";
import type { Mission } from "./mission";
import type { MissionTask } from "./mission-task";

export interface DispatchContext {
	scopeGuard: Mission["scopeGuard"];
	evidenceRefs: Mission["evidenceRefs"];
	recordAttempt: (taskId: string, attempt: "success" | "failure", note?: string) => void;
}

export interface MissionTaskDispatchResult {
	completedTaskIds: string[];
	failedTaskIds: string[];
	blocked: boolean;
}

type MissionTaskRunnerFactory = (task: MissionTask) => MissionTaskRunner;

function defaultRunnerFactory(task: MissionTask): MissionTaskRunner {
	return new MissionTaskRunner({ missionId: task.missionId ?? "", taskId: task.id });
}

export class MissionTaskDispatcher {
	readonly #runnerFactory: MissionTaskRunnerFactory;

	constructor(runnerFactory: MissionTaskRunnerFactory = defaultRunnerFactory) {
		this.#runnerFactory = runnerFactory;
	}

	async run(tasks: Mission["tasks"], ctx: DispatchContext): Promise<MissionTaskDispatchResult> {
		const completedTaskIds: string[] = [];
		const failedTaskIds: string[] = [];
		let blocked = false;

		for (const task of tasks) {
			try {
				const runner = this.#runnerFactory(task);
				const result = await runner.run(
					{
						cwd: process.cwd(),
						agent: {
							name: task.assignedAgent ?? "Builder",
							description: task.title,
							systemPrompt: "Execute the assigned mission task.",
							source: "bundled",
						},
						task: task.objective ?? task.title,
						description: task.title,
						index: 0,
						id: task.id,
						persistArtifacts: true,
					},
					task,
				);
				if (result.evidenceRefs.length > 0) ctx.evidenceRefs.push(...result.evidenceRefs);
				if (result.task.status === "completed") {
					completedTaskIds.push(task.id);
					ctx.recordAttempt(task.id, "success");
				} else if (result.task.status === "blocked") {
					blocked = true;
					ctx.recordAttempt(task.id, "failure", result.result.error ?? "Task blocked");
				} else {
					failedTaskIds.push(task.id);
					ctx.recordAttempt(task.id, "failure", result.result.error);
				}
			} catch (error) {
				failedTaskIds.push(task.id);
				ctx.recordAttempt(task.id, "failure", error instanceof Error ? error.message : String(error));
			}
		}

		return { completedTaskIds, failedTaskIds, blocked };
	}
}
