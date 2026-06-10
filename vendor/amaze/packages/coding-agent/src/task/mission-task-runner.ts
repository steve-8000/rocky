/**
 * MissionTaskRunner — a thin adapter that binds the existing subagent task executor
 * ({@link ./executor.runSubprocess}) to the Mission execution model (workplan §4 Lane I).
 *
 * Responsibilities (and ONLY these — it adds no execution behavior of its own):
 *   1. Carry `missionId` / `taskId` through a single executor run.
 *   2. Bind the run's {@link SubagentContract} to the mission (stamp + enforce the
 *      OPTIONAL-with-enforcement rule) before delegating.
 *   3. Link the executor's output back to the mission as evidence refs and reflect the
 *      run's outcome onto a {@link MissionTask} snapshot.
 *
 * It delegates execution verbatim to `runSubprocess` (injectable for testing). Parallel /
 * worktree execution logic stays exactly where it is — this adapter wraps a SINGLE run, so
 * it does not touch the fan-out path and cannot regress it.
 */

import type { MissionTask } from "../mission/core/mission-task";
import { bindContractToMission, enforceMissionBinding, type SubagentContract } from "../subagent/contract";
import { runSubprocess as defaultRunSubprocess, type ExecutorOptions } from "./executor";
import type { SingleResult } from "./types";

/** Mission identifiers threaded through a bound task run. */
export interface MissionTaskBinding {
	missionId: string;
	taskId: string;
}

export interface MissionTaskRunResult {
	/** The unmodified executor result. */
	result: SingleResult;
	/** The mission identifiers this run was bound to. */
	binding: MissionTaskBinding;
	/** Evidence refs derived from the executor output, linkable to the mission. */
	evidenceRefs: string[];
	/** A MissionTask snapshot reflecting the run outcome (caller persists it; runner never does). */
	task: MissionTask;
}

/** Injectable executor seam (kept for testability; defaults to the real `runSubprocess`). */
export type RunSubprocessFn = (options: ExecutorOptions) => Promise<SingleResult>;

/**
 * Derive mission evidence references from an executor result. Output / patch / branch
 * artifacts are the durable trail a mission can point its verification at. Pure & side-effect
 * free so callers and tests can reason about the linkage deterministically.
 */
export function deriveEvidenceRefs(result: SingleResult): string[] {
	const refs: string[] = [];
	if (result.outputPath) refs.push(`task-output://${result.outputPath}`);
	if (result.patchPath) refs.push(`task-patch://${result.patchPath}`);
	if (result.branchName) refs.push(`task-branch://${result.branchName}`);
	// Always expose a stable handle to the run itself so the mission can correlate
	// even when no file artifact was produced (in-place edits, dry runs, etc.).
	refs.push(`task-run://${result.id}`);
	return refs;
}

/** Map an executor result onto a MissionTask lifecycle status without losing the legacy union. */
function statusFromResult(result: SingleResult): MissionTask["status"] {
	if (result.aborted) return "cancelled";
	if (result.error || result.exitCode !== 0) return "failed";
	return "completed";
}

/**
 * Bind a subagent task to a mission and run it, threading the mission identifiers through
 * execution and linking output to mission evidence. The executor's behavior is unchanged —
 * this only adds binding + evidence around the delegated call.
 */
export class MissionTaskRunner {
	readonly #binding: MissionTaskBinding;
	readonly #run: RunSubprocessFn;

	constructor(binding: MissionTaskBinding, run: RunSubprocessFn = defaultRunSubprocess) {
		this.#binding = binding;
		this.#run = run;
	}

	get binding(): MissionTaskBinding {
		return { ...this.#binding };
	}

	/**
	 * Bind a contract to this runner's mission. Stamps the identifiers (no-op if already bound
	 * to the same mission/task) and enforces the binding fail-closed before returning.
	 */
	bindContract(contract: SubagentContract): SubagentContract {
		const bound = bindContractToMission(contract, this.#binding);
		enforceMissionBinding(bound, this.#binding);
		return bound;
	}

	/**
	 * Execute a single subagent run under the mission binding.
	 *
	 * `taskSeed` is an optional MissionTask to update in place of constructing a fresh one;
	 * the returned `task` is always a new object (the seed is never mutated).
	 */
	async run(options: ExecutorOptions, taskSeed?: MissionTask): Promise<MissionTaskRunResult> {
		// Thread mission identifiers onto the contract before delegating, enforcing the binding.
		const boundOptions: ExecutorOptions = options.contract
			? { ...options, contract: this.bindContract(options.contract) }
			: options;

		const result = await this.#run(boundOptions);
		const evidenceRefs = deriveEvidenceRefs(result);

		const now = Date.now();
		const existingRefs = taskSeed?.evidenceRefs ?? [];
		const task: MissionTask = {
			id: this.#binding.taskId,
			missionId: this.#binding.missionId,
			title: taskSeed?.title ?? options.description ?? options.agent.name,
			objective: taskSeed?.objective ?? options.task,
			assignedAgent: taskSeed?.assignedAgent ?? options.contract?.role ?? options.agent.name,
			scope: taskSeed?.scope ?? options.contract?.scope,
			successCriteria: taskSeed?.successCriteria,
			escalationCriteria: taskSeed?.escalationCriteria,
			allowedTools: taskSeed?.allowedTools,
			deniedTools: taskSeed?.deniedTools,
			status: statusFromResult(result),
			planStepId: taskSeed?.planStepId,
			evidenceRefs: dedupe([...existingRefs, ...evidenceRefs]),
			output: result.output,
			createdAt: taskSeed?.createdAt ?? now,
			updatedAt: now,
		};

		return { result, binding: this.binding, evidenceRefs, task };
	}
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}
