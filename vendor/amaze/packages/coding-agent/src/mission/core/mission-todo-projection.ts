import type { TodoItem, TodoPhase } from "../../tools/todo-write";
import { templateFor } from "./lifecycle-template";
import type { Mission, MissionTask } from "./mission";

type MissionTaskWithNotes = MissionTask & { notes?: string[] };

export function projectMissionToTodoPhases(mission: Mission): TodoPhase[] {
	const template = templateFor(mission.intent ?? "conversation");
	const isTerminal =
		mission.lifecycle === "completed" ||
		mission.lifecycle === "cancelled" ||
		mission.lifecycle === "rolled_back" ||
		mission.lifecycle === "blocked";
	const terminalStatus: TodoItem["status"] = mission.lifecycle === "completed" ? "completed" : "abandoned";
	const phases: TodoPhase[] = [];

	const framePhase: TodoPhase = { name: "Frame", tasks: [] };
	framePhase.tasks.push({
		content: `Objective: ${mission.objective}`,
		status: "completed",
	});
	if (mission.evidenceRefs.length > 0) {
		framePhase.tasks.push({
			content: `Evidence (${mission.evidenceRefs.length} refs)`,
			status: "completed",
			notes: mission.evidenceRefs.slice(0, 5),
		});
	}
	phases.push(framePhase);

	if (template.requireDecisionRecord) {
		phases.push({
			name: "Decision",
			tasks: [
				{
					content: "Decision record",
					status: mission.decisionId ? "completed" : isTerminal ? terminalStatus : "pending",
				},
			],
		});
	}

	if (template.requireRegressionContract) {
		phases.push({
			name: "Regression",
			tasks: [
				{
					content: "Regression contract",
					status: mission.regressionContractId ? "completed" : isTerminal ? terminalStatus : "pending",
				},
			],
		});
	}

	if (mission.tasks.length > 0) {
		phases.push({
			name: "Execution",
			tasks: mission.tasks.map(task => {
				const projected: TodoItem = {
					content: task.title,
					status: mapTaskStatus(task.status),
				};
				const notes = (task as MissionTaskWithNotes).notes;
				if (notes && notes.length > 0) projected.notes = [...notes];
				return projected;
			}),
		});
	}

	if (template.requireVerification) {
		phases.push({
			name: "Verification",
			tasks: [
				{
					content: "Verification verdict",
					status:
						mission.verification?.verdict === "pass"
							? "completed"
							: mission.verification?.verdict === "fail"
								? "abandoned"
								: isTerminal
									? terminalStatus
									: "pending",
				},
			],
		});
	}

	return phases;
}

function mapTaskStatus(status: MissionTask["status"]): TodoItem["status"] {
	switch (status) {
		case "completed":
			return "completed";
		case "running":
			return "in_progress";
		case "failed":
		case "blocked":
		case "cancelled":
			return "abandoned";
		case "pending":
			return "pending";
	}
}
