import type { MissionAutonomyProfile } from "../continuation/policy";
import type { MissionEventBus } from "../event-bus";
import { inferIntent, MISSION_INTENT_REQUIRES_MISSION, type MissionIntent } from "../policy";
import type { MissionStore } from "../store";
import { templateFor } from "./lifecycle-template";
import type { Mission, MissionVerification } from "./mission";
import type { MissionInput } from "./mission-input";
import type { MissionOutcome } from "./mission-outcome";
import type { MissionProposal } from "./mission-proposal";
import { MissionRuntimeImpl } from "./mission-runtime";
import type { MissionRuntimeEvent } from "./mission-runtime.iface";

const TERMINAL_LIFECYCLES = new Set<Mission["lifecycle"]>(["completed", "cancelled", "blocked"]);

export interface MissionControlDeps {
	store: MissionStore;
	setActiveMissionId: (id: string | undefined) => void;
	getActiveMissionId: () => string | undefined;
	now?: () => number;
	newId?: () => string;
	/** Session event bus so mission lifecycle transitions are observable (board/replay/web). */
	eventBus?: MissionEventBus;
	/**
	 * When this returns true, explicitly-created proposal-gated missions
	 * auto-attach an approved proposal so fully-autonomous Mission Control can
	 * execute and auto-continue without a manual `/mission approve`. Ambient-promoted
	 * missions never auto-approve. Defaults to disabled (human approval checkpoint preserved).
	 */
	autoApproveProposals?: () => boolean;
	autonomyProfile?: () => MissionAutonomyProfile;
}

export interface EnsureMissionInput {
	content: string;
	mode?: string;
}

export interface EnsureMissionResult {
	missionId: string | undefined;
	intent: MissionIntent;
	created: boolean;
}

export class MissionControlRuntime {
	readonly #deps: MissionControlDeps;
	readonly #runtime: MissionRuntimeImpl;

	constructor(deps: MissionControlDeps) {
		this.#deps = deps;
		this.#runtime = new MissionRuntimeImpl({
			store: deps.store,
			now: deps.now,
			...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
			autonomyProfile: deps.autonomyProfile?.() ?? "balanced",
		});
	}

	async ensureActiveMission(input: EnsureMissionInput): Promise<EnsureMissionResult> {
		const activeId = this.#deps.getActiveMissionId();
		if (activeId) {
			const mission = this.#runtime.tryGet(activeId);
			if (mission && !TERMINAL_LIFECYCLES.has(mission.lifecycle)) {
				return { missionId: activeId, intent: mission.intent ?? safeInferIntent(input), created: false };
			}
		}

		const intent = safeInferIntent(input);
		if (!MISSION_INTENT_REQUIRES_MISSION.has(intent)) {
			return { missionId: undefined, intent, created: false };
		}

		const mission = await this.#runtime.create({
			...(this.#deps.newId ? { id: this.#deps.newId() } : {}),
			title: deriveTitle(input.content),
			objective: input.content.slice(0, 240),
			mode: "auto",
			riskLevel: "medium",
			intent,
		});
		this.#deps.setActiveMissionId(mission.id);
		this.#driveInitialLifecycle(mission.id, intent, { explicitlyCreated: true });
		return { missionId: mission.id, intent, created: true };
	}

	/**
	 * Move a freshly-created mission into a lifecycle state that reflects reality on the
	 * interactive hot path. Proposal-required intents wait in `planning` (the policy gate keeps
	 * mutations blocked until a proposal is attached); everything else enters `executing` so its
	 * state is not misreported as pre-execution while the agent works. Best-effort: never throws.
	 */
	#driveInitialLifecycle(missionId: string, intent: MissionIntent, origin: { explicitlyCreated: boolean }): void {
		try {
			const requiresProposal = templateFor(intent).requireProposalBeforeMutation;
			if (
				origin.explicitlyCreated &&
				requiresProposal &&
				this.#deps.autoApproveProposals?.() &&
				this.#deps.autonomyProfile?.() === "autonomous"
			) {
				// Fully-autonomous Mission Control: satisfy the proposal gate up front for
				// explicitly-created missions so mutations and auto-continuation proceed
				// without a manual `/mission approve`. Ambient promotions keep the gate.
				this.#runtime.attachProposal(missionId, { approvedBy: "auto", summary: "Auto-approved (autonomous mode)" });
				return;
			}
			this.#runtime.markLifecycle(missionId, requiresProposal ? "planning" : "executing");
		} catch {
			// Lifecycle bookkeeping must never break the user turn.
		}
	}

	async promoteFromAmbient(input: { triggeringTool: string; objective?: string }): Promise<Mission> {
		const active = this.getActiveMission();
		if (active) return active;

		const objective = (input.objective?.trim() || `<mutation via ${input.triggeringTool}>`).slice(0, 240);
		const inferred = safeInferIntent({ content: objective });
		const intent = MISSION_INTENT_REQUIRES_MISSION.has(inferred) ? inferred : "code_change";
		const mission = await this.#runtime.create({
			...(this.#deps.newId ? { id: this.#deps.newId() } : {}),
			title: deriveTitle(objective),
			objective,
			mode: "auto",
			riskLevel: "medium",
			intent,
		});
		this.#deps.setActiveMissionId(mission.id);
		this.#driveInitialLifecycle(mission.id, intent, { explicitlyCreated: false });
		return mission;
	}

	/**
	 * Attach an approved proposal to a mission, satisfying the `requireProposalBeforeMutation`
	 * gate and advancing it into execution. This is the programmatic seam behind both approval
	 * paths: plan-mode exit and the `/mission approve` command.
	 */
	attachProposal(
		missionId: string,
		input: {
			proposalId?: string;
			planRef?: string | null;
			artifactUri?: string;
			contentHash?: string;
			summary?: string;
			approvedBy?: string;
		} = {},
	): Mission {
		return this.#runtime.attachProposal(missionId, input);
	}

	/**
	 * Approve the active mission's proposal. Returns the mission on success, or undefined when
	 * there is no active mission. Idempotent: re-approving simply re-attaches.
	 */
	approveActiveProposal(
		input: {
			planRef?: string | null;
			artifactUri?: string;
			contentHash?: string;
			summary?: string;
			approvedBy?: string;
		} = {},
	): Mission | undefined {
		const active = this.getActiveMission();
		if (!active) return undefined;
		return this.#runtime.attachProposal(active.id, input);
	}

	/**
	 * P4: Resolve the active mission's proposal record from the durable store, if any.
	 * Returns undefined when there is no active mission, no proposalId, or no matching row.
	 */
	getActiveProposal(): MissionProposal | undefined {
		const active = this.getActiveMission();
		if (!active?.proposalId) return undefined;
		return this.#deps.store.getProposal(active.proposalId);
	}

	/** Whether the active mission still needs a proposal before mutations are permitted. */
	activeMissionNeedsProposal(): boolean {
		const active = this.getActiveMission();
		if (!active) return false;
		const template = templateFor(active.intent ?? "code_change");
		return template.requireProposalBeforeMutation && !active.proposalId;
	}

	async ensureMissionScopeOrPromote(triggeringTool: string): Promise<Mission | undefined> {
		const active = this.getActiveMission();
		if (active) return active;
		return this.promoteFromAmbient({ triggeringTool });
	}

	getActiveMission(): Mission | undefined {
		const activeId = this.#deps.getActiveMissionId();
		if (!activeId) return undefined;
		const mission = this.#runtime.tryGet(activeId);
		if (!mission) return undefined;
		if (TERMINAL_LIFECYCLES.has(mission.lifecycle)) {
			// Self-heal: a terminal mission MUST NOT remain the active pointer. Detaching lets the
			// session fall back to ephemeral todos so stuck projection-only items (Decision record,
			// Verification verdict, etc.) clear instead of stranding the orchestrator's board.
			this.#deps.setActiveMissionId(undefined);
			return undefined;
		}
		return mission;
	}

	recordTaskUsage(missionId: string, delta: number): void {
		if (!Number.isFinite(delta) || delta <= 0) return;
		const mission = this.#runtime.tryGet(missionId);
		if (!mission) return;
		mission.budget.tokensUsed = (mission.budget.tokensUsed ?? 0) + delta;
		mission.updatedAt = this.#deps.now?.() ?? Date.now();
	}

	onMissionUpdated(listener: (mission: Mission) => void): () => void {
		return (
			this.#runtime.emit({
				missionId: "*",
				lifecycle: "created",
				at: this.#deps.now?.() ?? Date.now(),
				detail: {
					listener: (event: MissionRuntimeEvent) => {
						const detail = event.detail as { kind?: string; mission?: Mission } | undefined;
						if (detail?.kind === "mission_updated" && detail.mission) listener(detail.mission);
					},
				},
			}) ?? (() => {})
		);
	}

	clearActiveMission(): void {
		this.#deps.setActiveMissionId(undefined);
	}

	// ──────────────────────────────────────────────────────────────────────────
	// P3 write surface — the explicit, user-driven mission lifecycle. These wrap
	// MissionRuntime so the slash-command layer never reaches into private state.
	// ──────────────────────────────────────────────────────────────────────────

	/**
	 * Create a mission directly (independent of intent inference). The new mission becomes
	 * the session's active mission and is moved into the appropriate initial lifecycle
	 * (planning when proposals are required, executing otherwise).
	 */
	async createMission(input: MissionInput): Promise<Mission> {
		const mission = await this.#runtime.create(input);
		this.#deps.setActiveMissionId(mission.id);
		this.#driveInitialLifecycle(mission.id, mission.intent ?? "code_change", { explicitlyCreated: true });
		return mission;
	}

	/**
	 * Complete the active mission with an outcome summary. Returns undefined if there is
	 * no active mission. Acceptance verification is enforced inside MissionRuntime#complete.
	 */
	async completeActiveMission(outcome: Omit<MissionOutcome, "recordedAt">): Promise<Mission | undefined> {
		const active = this.getActiveMission();
		if (!active) return undefined;
		const mission = await this.#runtime.complete(active.id, {
			outcome: { ...outcome, recordedAt: this.#deps.now?.() ?? Date.now() },
		});
		this.#deps.setActiveMissionId(undefined);
		return mission;
	}

	/**
	 * Cancel the active mission. Returns undefined when there is no active mission. The
	 * active pointer is cleared so subsequent prompts can promote a new mission.
	 */
	async cancelActiveMission(reason?: string): Promise<Mission | undefined> {
		const active = this.getActiveMission();
		if (!active) return undefined;
		const mission = await this.#runtime.cancel(active.id, reason ? { reason } : {});
		this.#deps.setActiveMissionId(undefined);
		return mission;
	}

	/**
	 * Record an ambient verification verdict (e.g. from the acceptance verifier) against the
	 * active mission without changing lifecycle. Returns undefined when no mission is active.
	 */
	recordActiveVerification(verification: MissionVerification): Mission | undefined {
		const active = this.getActiveMission();
		if (!active) return undefined;
		return this.#runtime.recordVerification(active.id, verification);
	}

	recordActiveDesignAnswers(answers: Record<string, string>): Mission | undefined {
		const active = this.getActiveMission();
		if (!active) return undefined;
		return this.#runtime.recordDesignAnswers(active.id, answers);
	}
}

function safeInferIntent(input: EnsureMissionInput): MissionIntent {
	try {
		return inferIntent({ objective: input.content, mode: input.mode });
	} catch {
		return "conversation";
	}
}

function deriveTitle(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) return "Untitled mission";
	const sentenceEnd = trimmed.search(/[.!?。！？]\s|[.!?。！？]$/u);
	const firstSentence = sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd + 1).trim() : trimmed;
	return firstSentence.slice(0, 80).trim() || "Untitled mission";
}
