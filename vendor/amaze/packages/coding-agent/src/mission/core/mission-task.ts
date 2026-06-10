/**
 * MissionTask — the canonical unit of work owned by a mission (workplan §10).
 *
 * This is the binding point between the Mission execution model and the existing
 * task/subagent machinery. The shape is deliberately a **superset** of the small
 * task record embedded in {@link ../core/mission.Mission.tasks}: every field the
 * runtime seeds today (id, title, status, planStepId, evidenceRefs) is preserved,
 * and the richer operational fields (objective, assignedAgent, scope, criteria,
 * tool allow/deny, output, timestamps) are **all optional** so existing seeding
 * and existing callers keep compiling and behaving identically.
 *
 * The richer fields are populated when a task is actually bound to an executor run
 * via {@link ../../task/mission-task-runner.MissionTaskRunner}, which threads
 * `missionId`/`taskId` through execution and links the task output back to mission
 * evidence.
 */

/**
 * Status of a unit of work owned by a mission. Mirrors the existing task lifecycle
 * exactly — do not narrow or widen without updating the runtime seeding path.
 */
export type MissionTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";

/**
 * Tool-permission envelope for a mission task. Empty/absent lists mean "no
 * restriction" — enforcement happens in the tool gateway, this is the declaration.
 */
export interface MissionTaskToolPolicy {
	allowedTools?: string[];
	deniedTools?: string[];
}

/**
 * A unit of work owned by a mission.
 *
 * Only `id`, `title`, and `status` are required so that the minimal records seeded
 * by {@link ../core/mission-runtime} (plan-step → task) remain valid. The remaining
 * fields are filled in as a task is bound and executed.
 */
export interface MissionTask {
	/** Stable task identifier, unique within its mission. */
	id: string;
	/** Owning mission's id. Optional for the minimal seeded form; required once bound. */
	missionId?: string;
	/** Short human-readable label. */
	title: string;
	/** What this task must accomplish. */
	objective?: string;
	/** Agent (role / definition name) assigned to carry out the task. */
	assignedAgent?: string;
	/** File-glob scope the task is allowed to touch. */
	scope?: {
		include: string[];
		exclude: string[];
	};
	/** Criteria that must hold for the task to be considered done. */
	successCriteria?: string[];
	/** Conditions under which the task must stop and escalate to the parent. */
	escalationCriteria?: string[];
	/** Tools explicitly permitted for this task (empty/absent = no restriction). */
	allowedTools?: string[];
	/** Tools explicitly denied for this task. */
	deniedTools?: string[];
	/** Lifecycle status. */
	status: MissionTaskStatus;
	/** Plan step this task was seeded from, when applicable. */
	planStepId?: string;
	/** Evidence artifact references produced/linked by this task. */
	evidenceRefs?: string[];
	/** Raw output produced by the task's execution, when captured. */
	output?: string;
	/** Creation timestamp (epoch ms). */
	createdAt?: number;
	/** Last-update timestamp (epoch ms). */
	updatedAt?: number;
}
