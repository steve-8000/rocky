/**
 * Mission continuation runtime.
 *
 * Ported from OpenAI Codex's `Session` goal runtime (codex-rs/core/src/goals.rs):
 * `goal_runtime_apply`, `maybe_start_goal_continuation_turn`, and the per-turn
 * accounting / budget-limit steering. Adapted to Amaze's Mission Control:
 *   - Mission lifecycle stays authoritative (MissionControlRuntime / MissionStore).
 *   - The continuation *ledger* (mission_continuation table) governs scheduling
 *     with CAS transitions keyed by missionId.
 *   - Hidden continuation turns are delivered through the host's
 *     `sendContinuation` callback (AgentSession.sendCustomMessage with
 *     deliverAs:'nextTurn'), which already enforces ACP agent-initiated-turn gating.
 *
 * This class performs the IO; all decisions come from ./policy.ts pure functions.
 */

import { logger } from "@amaze/utils";
import type { Settings } from "../../config/settings";
import type { Mission } from "../core/mission";
import type { MissionControlRuntime } from "../core/mission-control-runtime";
import type { MissionStore } from "../store";
import { type ContinuationAction, classifyContinuation, progressFingerprint } from "./policy";
import { buildBudgetLimitPrompt, buildMissionContinuationPrompt } from "./prompt";

/** Host capabilities the continuation runtime needs from the owning session. */
export interface MissionContinuationHost {
	/** True when a user-authored message is queued (user intent has priority). */
	hasPendingUserMessage(): boolean;
	/** True when the host mode allows agent-initiated turns (TUI/RPC yes; one-shot no). */
	allowsAgentInitiatedTurns(): boolean;
	/** Current owner identity for ledger ownership checks. */
	owner(): { sessionId: string | null; ownerBranch: string | null; ownerTreeId: string | null };
	/**
	 * Deliver a hidden continuation message as the next turn. Mirrors
	 * AgentSession.sendCustomMessage(..., {deliverAs:'nextTurn', triggerTurn:true}).
	 */
	sendContinuation(message: { content: string; details: { missionId: string; generation: number } }): Promise<void>;
	/** Deliver a hidden budget-limit steering message for the current turn. */
	sendBudgetSteering?(message: { content: string; details: { missionId: string } }): Promise<void>;
}

export interface MissionContinuationRuntimeDeps {
	missionControl: MissionControlRuntime;
	store: MissionStore;
	settings: Settings;
	host: MissionContinuationHost;
}

export class MissionContinuationRuntime {
	readonly #missionControl: MissionControlRuntime;
	readonly #store: MissionStore;
	readonly #settings: Settings;
	readonly #host: MissionContinuationHost;
	/** Serializes scheduling so concurrent agent_end events cannot double-schedule. */
	#busy = false;

	constructor(deps: MissionContinuationRuntimeDeps) {
		this.#missionControl = deps.missionControl;
		this.#store = deps.store;
		this.#settings = deps.settings;
		this.#host = deps.host;
	}

	#enabled(): boolean {
		return this.#settings.get("mission.continuation.enabled") === true;
	}

	#maxAutoTurns(): number {
		return this.#settings.get("mission.continuation.maxAutoTurns") ?? 0;
	}

	#noProgressLimit(): number {
		return this.#settings.get("mission.continuation.noProgressLimit") ?? 0;
	}

	#autonomyProfile() {
		return this.#settings.get("mission.autonomyProfile");
	}

	/**
	 * Restore continuation state on session start/resume. Reconciles any stale
	 * `running`/`scheduled` generation left by a crash or shutdown back to `idle`
	 * so the next classification starts clean (Codex restore_thread_goal_runtime_after_resume).
	 */
	rehydrate(): void {
		if (!this.#enabled()) return;
		const mission = this.#missionControl.getActiveMission();
		if (!mission) return;
		const record = this.#store.getContinuation(mission.id);
		if (record && (record.status === "running" || record.status === "scheduled")) {
			this.#store.reconcileContinuationRunningToIdle(mission.id, "rehydrate_interrupted");
		}
	}

	/**
	 * Mark the matching generation as running when a continuation turn begins.
	 * Called from `before_agent_start` when the incoming message is a continuation
	 * envelope (Codex: before_agent_start marks generation running).
	 */
	markRunning(missionId: string, generation: number, turnId?: string): void {
		if (!this.#enabled()) return;
		this.#store.markContinuationRunning(missionId, generation, turnId);
	}

	/**
	 * Evaluate the persisted mission after an agent turn ends and schedule the next
	 * continuation turn if eligible. This is the heart of the loop (Codex
	 * maybe_continue_goal_if_idle_runtime + agent_end accounting).
	 */
	async afterAgentEnd(opts: { wasContinuationTurn: boolean } = { wasContinuationTurn: false }): Promise<void> {
		if (!this.#enabled() || !this.#host.allowsAgentInitiatedTurns()) return;
		if (this.#busy) return;
		this.#busy = true;
		try {
			await this.#evaluateAndSchedule(opts.wasContinuationTurn);
		} catch (err) {
			logger.debug("mission continuation evaluation failed", { error: String(err) });
		} finally {
			this.#busy = false;
		}
	}

	async #evaluateAndSchedule(wasContinuationTurn: boolean): Promise<void> {
		const mission = this.#missionControl.getActiveMission();
		if (!mission) return;

		// Reconcile stale running state first (Codex agent_end step 1). A user-authored
		// turn after an interrupted continuation also lands here.
		const existing = this.#store.getContinuation(mission.id);
		if (!wasContinuationTurn && existing && existing.status === "running") {
			this.#store.reconcileContinuationRunningToIdle(mission.id, "user_turn_after_running");
		} else if (wasContinuationTurn && existing && existing.status === "running") {
			this.#store.markContinuationIdleAfterEnd(mission.id, existing.generation);
		}

		// Record observable-state progress fingerprint for no-progress detection.
		this.#store.ensureContinuation(mission.id, this.#host.owner());
		this.#store.recordContinuationProgress(mission.id, progressFingerprint(mission));

		const record = this.#store.getContinuation(mission.id);
		const action = classifyContinuation({
			mission,
			record,
			hasPendingUserMessage: this.#host.hasPendingUserMessage(),
			needsProposal: this.#missionControl.activeMissionNeedsProposal(),
			maxAutoTurns: this.#maxAutoTurns(),
			noProgressLimit: this.#noProgressLimit(),
			autonomyProfile: this.#autonomyProfile(),
		});

		await this.#applyAction(mission, action);
	}

	async #applyAction(mission: Mission, action: ContinuationAction): Promise<void> {
		switch (action.kind) {
			case "none":
				return;
			case "observe-terminal":
				this.#store.setContinuationStatus(mission.id, action.status, action.reason);
				return;
			case "hold":
				this.#store.setContinuationStatus(mission.id, action.status, action.reason);
				if (action.status === "budget_limited" && this.#host.sendBudgetSteering) {
					const record = this.#store.getContinuation(mission.id);
					await this.#host.sendBudgetSteering({
						content: buildBudgetLimitPrompt(mission, record?.timeUsedSeconds ?? 0),
						details: { missionId: mission.id },
					});
				}
				return;
			case "block":
				this.#store.setContinuationStatus(mission.id, "blocked", action.reason);
				return;
			case "continue":
				await this.#schedule(mission);
				return;
		}
	}

	async #schedule(mission: Mission): Promise<void> {
		const record = this.#store.ensureContinuation(mission.id, this.#host.owner());
		if (record.status !== "idle") return;

		// Re-check pending user input immediately before scheduling (design doc:
		// re-check hasPendingMessages right before sendMessage).
		if (this.#host.hasPendingUserMessage()) {
			this.#store.setContinuationStatus(mission.id, "idle", "user_message_pending");
			return;
		}

		// CAS schedule: only succeeds when still idle at the expected generation.
		const scheduled = this.#store.scheduleNextContinuation(mission.id, record.generation, "auto_continue");
		if (!scheduled) {
			// Conflicting writer — duplicate suppression (design doc).
			logger.debug("mission continuation duplicate suppressed", { missionId: mission.id });
			return;
		}

		// Final pending re-check after CAS, before delivering.
		if (this.#host.hasPendingUserMessage()) {
			this.#store.reconcileContinuationRunningToIdle(mission.id, "user_message_pending_post_cas");
			return;
		}

		try {
			await this.#host.sendContinuation({
				content: buildMissionContinuationPrompt({
					mission,
					generation: scheduled.generation,
					autonomyProfile: this.#autonomyProfile(),
				}),
				details: { missionId: mission.id, generation: scheduled.generation },
			});
		} catch (err) {
			// Delivery failed — roll the scheduled generation back to idle so a later
			// turn can retry instead of stranding a scheduled-but-undelivered row.
			this.#store.reconcileContinuationRunningToIdle(mission.id, "send_failed");
			throw err;
		}
	}

	/**
	 * Observe a mission entering a terminal lifecycle. Called from the mission
	 * update hook (not via getActiveMission, which detaches terminal missions).
	 * Marks the ledger terminal so a previously scheduled/running generation can
	 * never resume (Codex: terminal goal clears continuation runtime state).
	 */
	observeTerminal(mission: Mission): void {
		if (!this.#enabled()) return;
		const record = this.#store.getContinuation(mission.id);
		if (!record) return;
		const status = mission.lifecycle === "completed" ? "completed" : "blocked";
		this.#store.setContinuationStatus(mission.id, status, `mission_${mission.lifecycle}`);
	}

	/** Pause continuation for the active mission (user `mission pause`). */
	pause(reason = "user_pause"): void {
		const mission = this.#missionControl.getActiveMission();
		if (!mission) return;
		this.#store.ensureContinuation(mission.id, this.#host.owner());
		this.#store.setContinuationStatus(mission.id, "paused", reason);
	}

	/** Resume continuation for the active mission (user `mission resume`). */
	resume(reason = "user_resume"): void {
		const mission = this.#missionControl.getActiveMission();
		if (!mission) return;
		this.#store.ensureContinuation(mission.id, this.#host.owner());
		this.#store.transferContinuationOwnership(mission.id, this.#host.owner());
		this.#store.setContinuationStatus(mission.id, "idle", reason);
	}
}
