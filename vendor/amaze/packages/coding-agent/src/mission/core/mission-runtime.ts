import type { ConfidenceLevel, RiskLevel } from "../../research/types";
import { buildAcceptancePreflight, type MissionAutonomyProfile } from "../continuation/policy";
import type { MissionEventBus } from "../event-bus";
import { defaultMissionClassifier, toCoreRiskLevel } from "../policy";
import { MissionStore } from "../store";
import type { MissionState as LegacyMissionState, MissionPhaseRecord } from "../types";
import type { AcceptanceCriterion } from "./acceptance-criteria";
import type {
	Mission,
	MissionLifecycleState,
	MissionPlan,
	MissionPlanStep,
	MissionReview,
	MissionTask,
	MissionVerification,
} from "./mission";
import type { MissionInput, MissionMode } from "./mission-input";
import type { MissionPhase, MissionPhaseInput } from "./mission-phase";
import type {
	MissionBlockOptions,
	MissionCancelOptions,
	MissionClassifyOptions,
	MissionClassifyResult,
	MissionCompleteOptions,
	MissionEventUnsubscribe,
	MissionExecuteOptions,
	MissionExecuteResult,
	MissionPlanOptions,
	MissionPlanResult,
	MissionRuntime,
	MissionRuntimeEvent,
	MissionVerifyOptions,
	MissionVerifyResult,
} from "./mission-runtime.iface";
import { MissionTaskDispatcher } from "./mission-task-dispatcher";

const MAX_TITLE_LENGTH = 4_000;
const DEFAULT_TOKEN_BUDGET = 0;
const DEFAULT_MAX_CONTEXT_TOKENS = 0;

/** Token usage snapshot consumed by {@link missionTokenDelta}. */
export interface MissionTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Per-tool token accounting event accepted by {@link MissionRuntimeImpl.accountTokens}.
 */
export interface MissionTokenAccountInput {
	usage: MissionTokenUsage;
	baseline?: MissionTokenUsage;
	taskId?: string | null;
	tool?: string;
	toolCallId?: string;
}

/**
 * Thrown by {@link MissionRuntimeImpl.complete} when acceptance verification surfaces a
 * failing verdict. Mirrors `GoalAcceptanceFailureError` so callers get the same structured
 * `verification` payload (per-criterion id/description/satisfied) and the mission stays
 * uncompleted. Bypass with `complete(..., { force: true })`.
 */
export class MissionAcceptanceFailureError extends Error {
	readonly verification: MissionVerification;
	readonly failedCriteria: AcceptanceCriterion[];
	constructor(verification: MissionVerification, failedCriteria: AcceptanceCriterion[], message?: string) {
		const summary = failedCriteria.map(c => `- [${c.id}] ${c.description}`).join("\n");
		super(
			message ??
				`Mission acceptance verification blocked completion: ${verification.failedCount ?? failedCriteria.length} of ${
					verification.failedCount ?? 0
				} criteria failed.\n${summary}\n\nResolve the failing criteria before completing the mission, or complete with force.`,
		);
		this.name = "MissionAcceptanceFailureError";
		this.verification = verification;
		this.failedCriteria = failedCriteria;
	}
}

/**
 * Token accounting model shared with `goalTokenDelta`.
 *
 * Counts input + cacheWrite + output and excludes cacheRead: cache writes are billed new
 * work (rotating a 1h ephemeral cache or re-anchoring a changed system prompt can write
 * 100K+ tokens) while cache reads are reused prefix, not new consumption.
 */
export function missionTokenDelta(current: MissionTokenUsage, baseline: MissionTokenUsage): number {
	return (
		Math.max(0, current.input - baseline.input) +
		Math.max(0, current.cacheWrite - baseline.cacheWrite) +
		Math.max(0, current.output - baseline.output)
	);
}

function validateTitle(value: string): string {
	const title = value.trim();
	if (!title) throw new Error("title is required when creating a mission");
	let count = 0;
	for (const _ of title) {
		count++;
		if (count > MAX_TITLE_LENGTH) {
			throw new Error(
				`Mission title is too long: ${count.toLocaleString()} characters. Limit: ${MAX_TITLE_LENGTH.toLocaleString()}.`,
			);
		}
	}
	return title;
}

function validateTokenBudget(tokenBudget: number | undefined): void {
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget < 0)) {
		throw new Error("mission token budget must be a non-negative integer when provided");
	}
}

/** Map a core lifecycle state to a legacy {@link LegacyMissionState} for store persistence. */
function lifecycleToStoreState(lifecycle: MissionLifecycleState): LegacyMissionState {
	switch (lifecycle) {
		case "researching":
		case "critiquing":
		case "executing":
		case "verifying":
		case "completed":
		case "rolled_back":
		case "blocked":
		case "cancelled":
			return lifecycle;
		case "contracting":
			return "contracted";
		default:
			return "drafting";
	}
}

/**
 * Best-effort inverse of {@link lifecycleToStoreState} for hydrating legacy rows that predate
 * the persisted `lifecycle` column. Terminal store states map back exactly; any non-terminal
 * legacy state collapses to `created` (the gate treats it as pre-execution).
 */
function storeStateToLifecycle(state: LegacyMissionState): MissionLifecycleState {
	switch (state) {
		case "completed":
			return "completed";
		case "blocked":
			return "blocked";
		case "cancelled":
			return "cancelled";
		case "rolled_back":
			return "rolled_back";
		default:
			return "created";
	}
}

function cloneCriterion(criterion: AcceptanceCriterion): AcceptanceCriterion {
	return {
		...criterion,
		...(criterion.evidenceRefs ? { evidenceRefs: [...criterion.evidenceRefs] } : {}),
	};
}

function phaseRecordToPhase(record: MissionPhaseRecord): MissionPhase {
	const criteria = JSON.parse(record.acceptanceCriteriaJson) as AcceptanceCriterion[];
	return {
		id: record.id,
		missionId: record.missionId,
		ordinal: record.ordinal,
		name: record.name,
		...(record.description !== null ? { description: record.description } : {}),
		planStepIds: [...record.planStepIds],
		acceptanceCriteria: criteria.map(cloneCriterion),
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.closedAt !== null ? { closedAt: record.closedAt } : {}),
	};
}

function serializeCriteria(criteria: AcceptanceCriterion[]): string {
	return JSON.stringify(criteria.map(cloneCriterion));
}

function verificationVerdict(
	verification: MissionVerification | undefined,
): MissionVerification["verdict"] | undefined {
	if (!verification) return undefined;
	if (verification.verdict) return verification.verdict;
	if (verification.status === "pass" || verification.status === "force") return "pass";
	if (verification.status === "fail") return "fail";
	return "pending";
}

function isMarkdownPath(path: string): boolean {
	return /\.md$/i.test(path.trim());
}

function normalizeReview(review: MissionReview): MissionReview {
	const sourceFiles = review.sourceFiles.filter(path => !isMarkdownPath(path));
	const excludedMarkdownFiles = [...review.excludedMarkdownFiles, ...review.sourceFiles.filter(isMarkdownPath)];
	if (review.verdict === "pass" && sourceFiles.length === 0) {
		throw new Error("Pass mission review requires at least one non-Markdown source file.");
	}
	return {
		...review,
		sourceFiles,
		excludedMarkdownFiles,
	};
}

export type MissionRuntimeImplOptions = {
	store?: MissionStore;
	dbPath?: string;
	eventBus?: MissionEventBus;
	now?: () => number;
	dispatcher?: MissionTaskDispatcher;
	autonomyProfile?: MissionAutonomyProfile;
};

/**
 * Concrete implementation of the canonical {@link MissionRuntime} contract.
 *
 * Owns:
 *   - the rich core {@link Mission} aggregate per mission (held in memory),
 *   - a durable thin record via {@link MissionStore} (lifecycle mapped to legacy state),
 *   - a per-mission token budget + accounting tracked on `mission.budget`,
 *   - canonical lifecycle event emission via the {@link MissionEventBus} (and therefore the
 *     jsonl sink).
 */
export class MissionRuntimeImpl implements MissionRuntime {
	readonly #store: MissionStore;
	readonly #ownsStore: boolean;
	readonly #bus: MissionEventBus | undefined;
	readonly #now: () => number;
	readonly #missions = new Map<string, Mission>();
	readonly #runtimeEvents: MissionRuntimeEvent[] = [];
	readonly #subscribers = new Set<(event: MissionRuntimeEvent) => void>();
	readonly #dispatcher: MissionTaskDispatcher | undefined;
	readonly #autonomyProfile: MissionAutonomyProfile;

	constructor(options: MissionRuntimeImplOptions = {}) {
		if (options.store) {
			this.#store = options.store;
			this.#ownsStore = false;
		} else {
			this.#store = new MissionStore(options.dbPath, options.eventBus);
			this.#ownsStore = true;
		}
		this.#bus = options.eventBus;
		this.#now = options.now ?? (() => Date.now());
		this.#dispatcher = options.dispatcher;
		this.#autonomyProfile = options.autonomyProfile ?? "balanced";
	}

	close(): void {
		if (this.#ownsStore) this.#store.close();
	}

	#emit(event: Parameters<MissionEventBus["emit"]>[0]): void {
		this.#bus?.emit(event);
	}

	tryGet(missionId: string): Mission | undefined {
		const cached = this.#missions.get(missionId);
		if (cached) {
			const storedRevision = this.#store.getMissionRevision(missionId);
			if (storedRevision === undefined) {
				this.#missions.delete(missionId);
				return undefined;
			}
			if (storedRevision !== cached.revision) {
				this.#missions.delete(missionId);
				return this.#hydrate(missionId);
			}
			return cached;
		}
		return this.#hydrate(missionId);
	}

	#require(missionId: string): Mission {
		const mission = this.#missions.get(missionId) ?? this.#hydrate(missionId);
		if (!mission) throw new Error(`Mission not found: ${missionId}`);
		return mission;
	}

	/**
	 * Rebuild an in-memory {@link Mission} from the durable store when it is not yet
	 * resident (e.g. after a session restart). Restores the gate-critical pointers —
	 * intent, lifecycle, proposalId, regressionContractId, decisionId — so the policy and
	 * close gates behave identically across restarts. Plan / tasks / acceptance criteria /
	 * budget / scope guard are rehydrated from the durable aggregate (P2) when present;
	 * absent aggregate rows fall back to empty defaults.
	 */
	#hydrate(missionId: string): Mission | undefined {
		const record = this.#store.getMission(missionId);
		if (!record) return undefined;
		const mission: Mission = {
			id: record.id,
			title: record.title,
			objective: record.title,
			mode: "auto",
			lifecycle: (record.lifecycle as MissionLifecycleState | null) ?? storeStateToLifecycle(record.state),
			riskLevel: record.riskLevel,
			...(record.intent ? { intent: record.intent as Mission["intent"] } : {}),
			constraints: [],
			acceptanceCriteria: this.#store.listAcceptanceCriteria(record.id),
			budget: { tokenBudget: DEFAULT_TOKEN_BUDGET, tokensUsed: 0 },
			contextBudget: { maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS, contextTokensUsed: 0 },
			tasks: this.#store.listTasks(record.id),
			phases: this.#store.listPhases(record.id).map(phaseRecordToPhase),
			evidenceRefs: [],
			...(record.decisionId ? { decisionId: record.decisionId } : {}),
			...(record.regressionContractId ? { regressionContractId: record.regressionContractId } : {}),
			...(record.proposalId ? { proposalId: record.proposalId } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			revision: record.revision ?? 0,
		};
		const budgetRow = this.#store.getBudget(record.id);
		if (budgetRow) {
			mission.budget = budgetRow.budget;
			mission.contextBudget = budgetRow.contextBudget;
		}
		const plan = this.#store.getPlan(record.id);
		if (plan) mission.plan = plan;
		const scope = this.#store.getScopeGuard(record.id);
		if (scope) mission.scopeGuard = scope;
		const designAnswers = this.#store.getMissionDesignAnswers(record.id);
		if (designAnswers && Object.keys(designAnswers).length > 0) mission.designAnswers = designAnswers;
		try {
			const latestVerification = this.#store.getLatestVerification(record.id);
			if (latestVerification) {
				mission.verification = {
					status: latestVerification.status,
					verdict:
						latestVerification.status === "pass" || latestVerification.status === "force"
							? "pass"
							: latestVerification.status === "fail"
								? "fail"
								: "pending",
					summary: latestVerification.summary,
					failedCount: latestVerification.failedCount,
					uncertainCount: latestVerification.uncertainCount,
				};
			}
			const latestReview = this.#store.getLatestReview(record.id);
			if (latestReview) {
				mission.review = {
					status: latestReview.status,
					verdict: latestReview.verdict,
					summary: latestReview.summary,
					failedCount: latestReview.failedCount,
					uncertainCount: latestReview.uncertainCount,
					sourceFiles: latestReview.sourceFiles,
					excludedMarkdownFiles: latestReview.excludedMarkdownFiles,
					createdAt: latestReview.createdAt,
					reviewedAt: latestReview.reviewedAt,
				};
			}
		} catch {
			// Preserve legacy hydrate behavior when verification storage is unavailable.
		}
		this.#missions.set(mission.id, mission);
		return mission;
	}

	#notifyUpdated(mission: Mission): void {
		this.emit({
			missionId: mission.id,
			lifecycle: mission.lifecycle,
			at: mission.updatedAt,
			detail: { kind: "mission_updated", mission },
		});
	}

	#advance(mission: Mission, lifecycle: MissionLifecycleState): Mission {
		mission.lifecycle = lifecycle;
		const persisted = this.#store.updateMission(mission.id, { state: lifecycleToStoreState(lifecycle), lifecycle });
		mission.updatedAt = persisted.updatedAt;
		mission.revision = persisted.revision;
		this.#notifyUpdated(mission);
		return mission;
	}

	#markMutated(mission: Mission): void {
		mission.updatedAt = this.#now();
		mission.revision += 1;
	}

	async create(input: MissionInput): Promise<Mission> {
		const title = validateTitle(input.title);
		const objective = input.objective?.trim();
		if (!objective) throw new Error("objective is required when creating a mission");
		validateTokenBudget(input.budget?.tokenBudget);
		const riskLevel: RiskLevel = input.riskLevel ?? "medium";
		const mode: MissionMode = input.mode ?? "interactive";
		const createdAt = this.#now();

		const record = this.#store.createMission({
			...(input.id ? { id: input.id } : {}),
			title,
			objectiveId: input.projectId ?? null,
			briefId: null,
			decisionId: null,
			riskLevel,
			state: "drafting",
			confidence: null,
			snapshotRef: null,
			intent: input.intent ?? null,
			lifecycle: "created",
		});

		const mission: Mission = {
			id: record.id,
			title,
			objective,
			mode,
			lifecycle: "created",
			riskLevel,
			...(input.intent ? { intent: input.intent } : {}),
			constraints: input.constraints ? [...input.constraints] : [],
			acceptanceCriteria: input.acceptanceCriteria ? input.acceptanceCriteria.map(cloneCriterion) : [],
			budget: {
				tokenBudget: input.budget?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
				tokensUsed: input.budget?.tokensUsed ?? 0,
				...(input.budget?.timeBudgetMs !== undefined ? { timeBudgetMs: input.budget.timeBudgetMs } : {}),
				...(input.budget?.taskBudget !== undefined ? { taskBudget: input.budget.taskBudget } : {}),
			},
			contextBudget: {
				maxContextTokens: input.contextBudget?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
				contextTokensUsed: input.contextBudget?.contextTokensUsed ?? 0,
				...(input.contextBudget?.compactionThreshold !== undefined
					? { compactionThreshold: input.contextBudget.compactionThreshold }
					: {}),
			},
			tasks: [],
			evidenceRefs: [],
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			revision: record.revision ?? 0,
		};
		if (input.projectId !== undefined) mission.projectId = input.projectId;
		if (input.sessionId !== undefined) mission.sessionId = input.sessionId;
		if (input.parentMissionId !== undefined) mission.parentMissionId = input.parentMissionId;
		if (input.scopeGuard !== undefined) mission.scopeGuard = input.scopeGuard;
		this.#missions.set(mission.id, mission);
		this.#notifyUpdated(mission);

		this.#emit({
			type: "mission.created",
			missionId: mission.id,
			title: mission.title,
			objectiveId: mission.projectId ?? null,
			riskLevel: mission.riskLevel,
			ts: createdAt,
		});
		return mission;
	}

	async classify(missionId: string, options: MissionClassifyOptions = {}): Promise<MissionClassifyResult> {
		void options;
		const mission = this.#require(missionId);
		this.#advance(mission, "classified");
		const decision = defaultMissionClassifier.classify(mission);
		mission.intent = decision.intent;
		mission.riskLevel = toCoreRiskLevel(decision.riskLevel);
		this.#store.updateMission(mission.id, { intent: mission.intent, riskLevel: mission.riskLevel });
		const confidence: ConfidenceLevel | null = mission.riskLevel === "low" ? "high" : null;
		this.#emit({
			type: "mission.classified",
			missionId: mission.id,
			riskLevel: mission.riskLevel,
			confidence,
			ts: mission.updatedAt,
		});
		return { riskLevel: mission.riskLevel, intent: mission.intent, rationale: decision.rationale };
	}

	async plan(missionId: string, options: MissionPlanOptions = {}): Promise<MissionPlanResult> {
		const mission = this.#require(missionId);
		const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
		const steps: MissionPlanStep[] = mission.plan?.steps ? mission.plan.steps.slice(0, maxSteps) : [];
		const plan: MissionPlan = mission.plan ?? { steps };
		plan.steps = steps;
		mission.plan = plan;
		// Seed tasks from plan steps when none exist yet.
		if (mission.tasks.length === 0) {
			mission.tasks = steps.map<MissionTask>((step, index) => ({
				id: `${mission.id}-task-${index + 1}`,
				title: step.description,
				status: "pending",
				planStepId: step.id,
			}));
		}
		this.#advance(mission, "planning");
		this.#emit({
			type: "mission.planned",
			missionId: mission.id,
			taskCount: plan.steps.length,
			ts: mission.updatedAt,
		});
		return { plan };
	}

	/**
	 * Attach an approved proposal to a mission. This is the single seam that satisfies the
	 * `requireProposalBeforeMutation` gate: until a mission carries a `proposalId`, mutation
	 * tools on proposal-required intents are denied (see {@link MissionPolicyGate}). Idempotent
	 * per mission — re-attaching overwrites the pointer and re-emits.
	 */
	attachProposal(
		missionId: string,
		input: {
			proposalId?: string;
			planRef?: string | null;
			/** P4: artifact URI (e.g. `local://PLAN.md`) for the approved plan. */
			artifactUri?: string;
			/** P4: SHA-256 of the artifact bytes at approval time. */
			contentHash?: string;
			/** P4: short summary describing the proposed change. */
			summary?: string;
			/** P4: who approved (defaults to "user"). */
			approvedBy?: string;
		} = {},
	): Mission {
		const mission = this.#require(missionId);
		const proposalId = input.proposalId ?? `proposal-${mission.id}-${this.#now()}`;
		mission.proposalId = proposalId;
		const shouldBeginExecution =
			mission.lifecycle === "created" || mission.lifecycle === "classified" || mission.lifecycle === "planning";
		if (shouldBeginExecution) mission.lifecycle = "executing";
		const proposalPersisted = this.#store.updateMission(mission.id, {
			proposalId,
			...(shouldBeginExecution
				? { state: lifecycleToStoreState("executing"), lifecycle: "executing" as const }
				: {}),
		});
		mission.updatedAt = proposalPersisted.updatedAt;
		mission.revision = proposalPersisted.revision;

		// P4: when artifact metadata is supplied, persist a real proposal row marked
		// approved. The policy gate consults this row to verify the proposalId is backed by
		// an approved, hash-bearing artifact rather than just a string pointer.
		if (input.artifactUri && input.contentHash) {
			const existing = this.#store.getProposal(proposalId);
			if (existing) {
				this.#store.updateProposalStatus(proposalId, "approved", input.approvedBy ?? "user");
			} else {
				this.#store.saveProposal({
					id: proposalId,
					missionId: mission.id,
					artifactUri: input.artifactUri,
					contentHash: input.contentHash,
					status: "approved",
					approvedBy: input.approvedBy ?? "user",
					approvedAt: this.#now(),
					summary: input.summary ?? null,
				});
			}
		}

		this.#emit({
			type: "mission.proposal.attached",
			missionId: mission.id,
			proposalId,
			planRef: input.planRef ?? null,
			ts: mission.updatedAt,
		});
		this.#notifyUpdated(mission);
		return mission;
	}

	/**
	 * Advance lifecycle state without running the task dispatcher. Used by the control runtime
	 * to keep a mission's lifecycle truthful on the interactive hot path, where the LLM agent
	 * loop — not {@link execute}'s dispatcher — performs the actual work. No-op once terminal.
	 */
	markLifecycle(missionId: string, lifecycle: Extract<MissionLifecycleState, "planning" | "executing">): Mission {
		const mission = this.#require(missionId);
		const terminal =
			mission.lifecycle === "completed" || mission.lifecycle === "cancelled" || mission.lifecycle === "blocked";
		if (!terminal && mission.lifecycle !== lifecycle) this.#advance(mission, lifecycle);
		return mission;
	}

	async execute(missionId: string, options: MissionExecuteOptions = {}): Promise<MissionExecuteResult> {
		const mission = this.#require(missionId);
		this.#advance(mission, "executing");
		const dispatcher = this.#dispatcher ?? new MissionTaskDispatcher();
		const targetIds = options.taskIds ? new Set(options.taskIds) : undefined;
		const tasks = mission.tasks.filter(t => !targetIds || targetIds.has(t.id));
		const result = await dispatcher.run(tasks, {
			scopeGuard: mission.scopeGuard,
			evidenceRefs: mission.evidenceRefs,
			recordAttempt: (taskId, verdict, note) => {
				this.#emit({
					type: "mission.task.attempt",
					missionId,
					taskId,
					verdict,
					note,
					ts: this.#now(),
				});
			},
		});
		for (const id of result.completedTaskIds) {
			const task = mission.tasks.find(t => t.id === id);
			if (task) task.status = "completed";
			this.#emit({
				type: "mission.task.completed",
				missionId: mission.id,
				taskId: id,
				status: "completed",
				ts: this.#now(),
			});
		}
		for (const id of result.failedTaskIds) {
			const task = mission.tasks.find(t => t.id === id);
			if (task) task.status = "failed";
			this.#emit({
				type: "mission.task.failed",
				missionId: mission.id,
				taskId: id,
				status: "failed",
				ts: this.#now(),
			});
		}
		this.#markMutated(mission);
		this.#notifyUpdated(mission);
		return result;
	}

	/**
	 * Verify the mission against acceptance criteria and record the resulting verdict.
	 *
	 * Notes: a verifier verdict is authoritative for mission completion; a `pass`
	 * verdict means completion may proceed even if stale criterion flags disagree,
	 * while a `fail` verdict blocks completion unless the verifier was forced.
	 */
	async verify(missionId: string, options: MissionVerifyOptions = {}): Promise<MissionVerifyResult> {
		const mission = this.#require(missionId);
		this.#advance(mission, "verifying");
		const verification = this.#evaluateAcceptance(mission, options.force ?? false);
		mission.verification = verification;
		this.#markMutated(mission);
		const verificationRecord = this.#store.recordVerification({
			missionId: mission.id,
			status: verification.status,
			failedCount: verification.failedCount ?? 0,
			uncertainCount: verification.uncertainCount ?? 0,
			summary: verification.summary,
		});
		this.#emit({
			type: "mission.verification.completed",
			missionId: mission.id,
			verificationId: verificationRecord.id,
			status: verification.status === "force" ? "pass" : verification.status,
			failedCount: verification.failedCount ?? 0,
			uncertainCount: verification.uncertainCount ?? 0,
			ts: mission.updatedAt,
		});
		this.#notifyUpdated(mission);
		return { verification };
	}

	/**
	 * Record an external verifier verdict without changing lifecycle.
	 *
	 * Notes: the verifier verdict is the authority. A `pass` verdict projects
	 * success onto criteria by marking every criterion satisfied; explicit fail
	 * and uncertain/pending verdicts leave per-criterion flags as recorded.
	 */
	recordVerification(missionId: string, verification: MissionVerification): Mission {
		const mission = this.#require(missionId);
		mission.verification = { ...verification };
		if (verification.verdict === "pass") {
			for (const criterion of mission.acceptanceCriteria) {
				criterion.satisfied = true;
			}
			this.#store.saveAcceptanceCriteria(mission.id, mission.acceptanceCriteria);
		}
		this.#markMutated(mission);
		this.#store.recordVerification({
			missionId: mission.id,
			status: verification.status,
			failedCount: verification.failedCount ?? 0,
			uncertainCount: verification.uncertainCount ?? 0,
			summary: verification.summary,
		});
		this.#notifyUpdated(mission);
		return mission;
	}

	/**
	 * Record a whole-source review verdict without changing lifecycle. Markdown
	 * paths are excluded from authority and cannot satisfy a passing review.
	 */
	recordReview(missionId: string, review: MissionReview): Mission {
		const mission = this.#require(missionId);
		const normalized = normalizeReview(review);
		mission.review = normalized;
		this.#markMutated(mission);
		const record = this.#store.recordReview({
			missionId: mission.id,
			status: normalized.status,
			verdict: normalized.verdict,
			failedCount: normalized.failedCount,
			uncertainCount: normalized.uncertainCount,
			summary: normalized.summary,
			sourceFiles: normalized.sourceFiles,
			excludedMarkdownFiles: normalized.excludedMarkdownFiles,
			createdAt: normalized.createdAt,
			reviewedAt: normalized.reviewedAt,
		});
		mission.review = {
			...normalized,
			createdAt: record.createdAt,
			reviewedAt: record.reviewedAt,
		};
		this.#notifyUpdated(mission);
		return mission;
	}

	async declarePhases(missionId: string, phases: MissionPhaseInput[]): Promise<MissionPhase[]> {
		const mission = this.#require(missionId);
		const ordinals = new Set<number>();
		for (const phase of phases) {
			if (ordinals.has(phase.ordinal)) throw new Error(`Duplicate mission phase ordinal: ${phase.ordinal}`);
			ordinals.add(phase.ordinal);
		}
		const declared = phases.map(input => {
			const record = this.#store.createPhase({
				...(input.id ? { id: input.id } : {}),
				missionId: mission.id,
				ordinal: input.ordinal,
				name: input.name,
				description: input.description ?? null,
				status: input.ordinal === 0 ? "active" : "pending",
				planStepIds: input.planStepIds ? [...input.planStepIds] : [],
				acceptanceCriteriaJson: serializeCriteria(input.acceptanceCriteria ?? []),
				closedAt: null,
			});
			const phase = phaseRecordToPhase(record);
			this.#emit({
				type: "mission.phase.declared",
				missionId: mission.id,
				phaseId: phase.id,
				ordinal: phase.ordinal,
				name: phase.name,
				ts: phase.createdAt,
			});
			return phase;
		});
		mission.phases = [...(mission.phases ?? []), ...declared].sort((a, b) => a.ordinal - b.ordinal);
		this.#markMutated(mission);
		this.#notifyUpdated(mission);
		return mission.phases;
	}

	async listPhases(missionId: string): Promise<MissionPhase[]> {
		const mission = this.#require(missionId);
		if (mission.phases !== undefined) return mission.phases;
		mission.phases = this.#store.listPhases(mission.id).map(phaseRecordToPhase);
		return mission.phases;
	}

	async verifyPhase(
		missionId: string,
		phaseId: string,
		options: { force?: boolean } = {},
	): Promise<{ verification: MissionVerification }> {
		const mission = this.#require(missionId);
		const phases = await this.listPhases(missionId);
		const phase = phases.find(p => p.id === phaseId);
		if (!phase) throw new Error(`Mission phase not found: ${phaseId}`);
		const verification = this.#evaluateAcceptance(
			{ ...mission, acceptanceCriteria: phase.acceptanceCriteria },
			options.force ?? false,
		);
		phase.verification = verification;
		if (verification.status === "pass" || verification.status === "force") phase.status = "verified";
		else if (verification.status === "fail") phase.status = "failed";
		else phase.status = "active";
		phase.updatedAt = this.#now();
		this.#markMutated(mission);
		this.#store.updatePhase(phase.id, {
			status: phase.status,
			updatedAt: phase.updatedAt,
			acceptanceCriteriaJson: serializeCriteria(phase.acceptanceCriteria),
			closedAt: phase.closedAt ?? null,
		});
		const record = this.#store.recordPhaseVerification({
			missionId: mission.id,
			phaseId: phase.id,
			status: verification.status,
			failedCount: verification.failedCount ?? 0,
			uncertainCount: verification.uncertainCount ?? 0,
			summary: verification.summary,
		});
		this.#emit({
			type: "mission.phase.verified",
			missionId: mission.id,
			phaseId: phase.id,
			verificationId: record.id,
			status: verification.status,
			failedCount: verification.failedCount ?? 0,
			uncertainCount: verification.uncertainCount ?? 0,
			ts: record.createdAt,
		});
		return { verification };
	}

	async closePhase(missionId: string, phaseId: string, options: { force?: boolean } = {}): Promise<MissionPhase> {
		const mission = this.#require(missionId);
		const phases = await this.listPhases(missionId);
		const phase = phases.find(p => p.id === phaseId);
		if (!phase) throw new Error(`Mission phase not found: ${phaseId}`);
		let latest = this.#store
			.listPhaseVerifications(missionId)
			.filter(v => v.phaseId === phaseId)
			.at(-1);
		if (!latest && options.force) {
			await this.verifyPhase(missionId, phaseId, { force: true });
			latest = this.#store
				.listPhaseVerifications(missionId)
				.filter(v => v.phaseId === phaseId)
				.at(-1);
		}
		if (latest?.status !== "pass" && latest?.status !== "force") {
			throw new MissionAcceptanceFailureError(
				{
					status: "fail",
					verdict: "fail",
					summary: `Mission "${missionId}" cannot close phase "${phase.name}": phase not verified.`,
					failedCount: 1,
					uncertainCount: 0,
				},
				phase.acceptanceCriteria.filter(c => !c.satisfied),
			);
		}
		phase.status = "verified";
		phase.closedAt = this.#now();
		phase.updatedAt = phase.closedAt;
		this.#markMutated(mission);
		this.#store.updatePhase(phase.id, {
			status: phase.status,
			updatedAt: phase.updatedAt,
			closedAt: phase.closedAt,
			acceptanceCriteriaJson: serializeCriteria(phase.acceptanceCriteria),
		});
		this.#emit({
			type: "mission.phase.closed",
			missionId,
			phaseId: phase.id,
			ts: phase.closedAt,
		});
		return phase;
	}

	/**
	 * Evaluate the mission's acceptance criteria from their `satisfied` flags.
	 * Unsatisfied criteria with no verification method are treated as `uncertain`
	 * (a human/llm-judged item) rather than a hard fail; unsatisfied criteria that
	 * declare a verification method are `fail`. `force` collapses to a `force` verdict.
	 *
	 * Notes: when a mission already carries a verifier verdict, completion treats
	 * that verdict as authoritative instead of recomputing divergent criterion state.
	 */
	#evaluateAcceptance(mission: Mission, force: boolean): MissionVerification {
		const criteria = mission.acceptanceCriteria;
		if (force) {
			return {
				status: "force",
				verdict: "pass",
				summary: "Mission verification forced.",
				failedCount: 0,
				uncertainCount: 0,
			};
		}
		if (criteria.length === 0) {
			return {
				status: "pass",
				verdict: "pass",
				summary: "No acceptance criteria.",
				failedCount: 0,
				uncertainCount: 0,
			};
		}
		const failed: AcceptanceCriterion[] = [];
		const uncertain: AcceptanceCriterion[] = [];
		for (const criterion of criteria) {
			if (criterion.satisfied) continue;
			if (criterion.verificationMethod) failed.push(criterion);
			else uncertain.push(criterion);
		}
		const failedCount = failed.length;
		const uncertainCount = uncertain.length;
		const status: MissionVerification["status"] =
			failedCount > 0 ? "fail" : uncertainCount > 0 ? "uncertain" : "pass";
		return {
			status,
			verdict: status === "pass" ? "pass" : status === "fail" ? "fail" : "pending",
			summary: `${failedCount} failed; ${uncertainCount} uncertain; ${
				criteria.length - failedCount - uncertainCount
			} passed.`,
			failedCount,
			uncertainCount,
		};
	}

	/**
	 * Complete the mission with verifier verdicts as the source of truth.
	 *
	 * Notes: a recorded `pass` verdict satisfies acceptance even if stale
	 * criterion flags disagree; a recorded `fail` verdict blocks completion unless
	 * the verification status is `force`. Missing verification still falls back to
	 * criterion evaluation.
	 */
	async complete(missionId: string, options: MissionCompleteOptions): Promise<Mission> {
		const mission = this.#require(missionId);
		const latestReview = this.#store.getLatestReview(mission.id);
		if (latestReview) {
			mission.review = {
				status: latestReview.status,
				verdict: latestReview.verdict,
				summary: latestReview.summary,
				failedCount: latestReview.failedCount,
				uncertainCount: latestReview.uncertainCount,
				sourceFiles: latestReview.sourceFiles,
				excludedMarkdownFiles: latestReview.excludedMarkdownFiles,
				createdAt: latestReview.createdAt,
				reviewedAt: latestReview.reviewedAt,
			};
		} else {
			mission.review = undefined;
		}
		// Shared acceptance preflight — single source of truth reused by the
		// continuation runtime (see ./continuation/policy.ts buildAcceptancePreflight).
		const preflight = buildAcceptancePreflight(mission, { autonomyProfile: this.#autonomyProfile });
		if (preflight.missingGates.length) {
			const missing = preflight.missingGates;
			throw new MissionAcceptanceFailureError(
				{
					status: "fail",
					verdict: "fail",
					summary: `Mission "${mission.id}" cannot complete: missing ${missing.join(", ")}`,
					failedCount: missing.length,
					uncertainCount: 0,
				},
				[],
				`Mission "${mission.id}" cannot complete: missing ${missing.join(", ")}`,
			);
		}
		if (preflight.unverifiedPhases.length > 0) {
			const names = preflight.unverifiedPhases.join(", ");
			throw new MissionAcceptanceFailureError(
				{
					status: "fail",
					verdict: "fail",
					summary: `Mission "${mission.id}" cannot complete: phase(s) ${names} not verified.`,
					failedCount: preflight.unverifiedPhases.length,
					uncertainCount: 0,
				},
				[],
				`Mission "${mission.id}" cannot complete: phase(s) ${names} not verified.`,
			);
		}
		const force = mission.verification?.status === "force";
		let verification = mission.verification;
		const verdict = verificationVerdict(verification);
		if (!force && verdict === "fail") {
			throw new MissionAcceptanceFailureError(
				verification ?? {
					status: "fail",
					verdict: "fail",
					summary: `Mission "${mission.id}" cannot complete: verifier recorded a failing verdict.`,
					failedCount: 1,
					uncertainCount: 0,
				},
				mission.acceptanceCriteria.filter(c => !c.satisfied && c.verificationMethod),
			);
		}
		if (!force && verdict !== "pass" && !verification) {
			verification = this.#evaluateAcceptance(mission, false);
			mission.verification = verification;
			if (verification.status === "fail") {
				const failedCriteria = mission.acceptanceCriteria.filter(c => !c.satisfied && c.verificationMethod);
				throw new MissionAcceptanceFailureError(verification, failedCriteria);
			}
		}
		mission.outcome = options.outcome;
		this.#advance(mission, "completed");
		this.#emit({
			type: "mission.completed",
			missionId: mission.id,
			finalState: lifecycleToStoreState("completed"),
			ts: mission.updatedAt,
		});
		return mission;
	}

	async block(missionId: string, options: MissionBlockOptions): Promise<Mission> {
		const mission = this.#require(missionId);
		if (options.evidenceRefs) {
			mission.evidenceRefs = [...mission.evidenceRefs, ...options.evidenceRefs];
		}
		this.#advance(mission, "blocked");
		this.#emit({
			type: "mission.blocked",
			missionId: mission.id,
			reason: options.reason,
			ts: mission.updatedAt,
		});
		return mission;
	}

	async cancel(missionId: string, options: MissionCancelOptions = {}): Promise<Mission> {
		const mission = this.#require(missionId);
		this.#advance(mission, "cancelled");
		this.#emit({
			type: "mission.cancelled",
			missionId: mission.id,
			reason: options.reason ?? null,
			ts: mission.updatedAt,
		});
		return mission;
	}

	recordDesignAnswers(missionId: string, answers: Record<string, string>): Mission {
		const mission = this.#require(missionId);
		if (Object.keys(answers).length === 0) return mission;
		if (mission.designAnswers && Object.keys(mission.designAnswers).length > 0) return mission;
		mission.designAnswers = { ...answers };
		this.#markMutated(mission);
		this.#store.setMissionDesignAnswers(mission.id, mission.designAnswers);
		this.#notifyUpdated(mission);
		return mission;
	}

	/**
	 * Record a runtime event and notify subscribers. Per the canonical contract this
	 * doubles as a subscription seam: when called with a listener-bearing detail it
	 * registers and returns an unsubscribe; otherwise it records the event and returns
	 * undefined.
	 */
	emit(event: MissionRuntimeEvent): MissionEventUnsubscribe | undefined {
		const listener = (event.detail as { listener?: (e: MissionRuntimeEvent) => void } | undefined)?.listener;
		if (typeof listener === "function") {
			this.#subscribers.add(listener);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				this.#subscribers.delete(listener);
			};
		}
		this.#runtimeEvents.push(event);
		for (const subscriber of [...this.#subscribers]) {
			subscriber(event);
		}
		return undefined;
	}

	/** Drain the runtime events recorded via {@link emit}. Test/inspection aid. */
	runtimeEvents(): readonly MissionRuntimeEvent[] {
		return this.#runtimeEvents;
	}

	async get(missionId: string): Promise<Mission | undefined> {
		return this.#missions.get(missionId) ?? this.#hydrate(missionId);
	}

	/**
	 * Account for tokens consumed by a tool call against the mission budget. Adds the delta to
	 * `budget.tokensUsed` and emits a `mission.tool.completed` lifecycle event. Returns the delta applied.
	 */
	accountTokens(missionId: string, input: MissionTokenAccountInput): number {
		const mission = this.#require(missionId);
		const baseline = input.baseline ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const delta = missionTokenDelta(input.usage, baseline);
		if (delta > 0) {
			mission.budget.tokensUsed += delta;
			this.#markMutated(mission);
			this.#notifyUpdated(mission);
		}
		this.#emit({
			type: "mission.tool.completed",
			missionId: mission.id,
			taskId: input.taskId ?? null,
			toolCallId: input.toolCallId ?? `${mission.id}-tool-${this.#now()}`,
			tool: input.tool ?? "unknown",
			status: "ok",
			ts: this.#now(),
		});
		return delta;
	}
}
