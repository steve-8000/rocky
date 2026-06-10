/**
 * SubagentContract — Primitive B of the v3 team coordination layer.
 *
 * A SubagentContract is the formal interface between a parent agent and a delegated
 * subagent. It does THREE jobs that the v2 `task` tool's free-form prompt could not:
 *
 *   1. Declares the subagent's role and scope as structured data, so the tool layer
 *      can enforce file-system boundaries (`scope.exclude` matches → tool blocks the
 *      write, prompt rule is just belt-and-suspenders).
 *   2. Carries `successCriteria` — a subset of the parent goal's acceptance criteria
 *      that the AcceptanceVerifier checks against the subagent's completion. The
 *      parent doesn't merge subagent output without a verifier verdict.
 *   3. Sets escalation rules: budget cap, what to do on uncertainty. Predictable
 *      hand-off boundary instead of a free-floating "do your best".
 *
 * The contract is **rendered into the subagent's STABLE_CORE** so it lives inside the
 * cached prefix — model can't lose it via compaction, can't ignore it without the rule
 * also disappearing from attention. Tool-level enforcement makes ignoring it costly
 * regardless.
 *
 * Canonical XML serialization keeps the rendered block byte-stable across the
 * subagent's session — prerequisite for prompt cache hits.
 */

import type { AcceptanceCriterion } from "../mission/core/verifier";

export type EscalationOnUncertainty = "ask-parent" | "block";
export type MissionScopeForContract = { include: string[]; exclude: string[] };

export interface SubagentContract {
	/**
	 * Owning mission's id, when this subagent runs under the Mission execution model.
	 *
	 * OPTIONAL-with-enforcement: when a mission context exists at mint time, the binding
	 * layer ({@link ../task/mission-task-runner.MissionTaskRunner}) REQUIRES this and
	 * threads it through execution + evidence linkage. When absent (legacy direct `task`
	 * use, no mission), the contract is still valid and the field is simply unset.
	 */
	missionId?: string;
	/**
	 * Mission task this subagent fulfills, when bound. Paired with `missionId`: either both
	 * are present (mission-bound) or both absent (legacy). See {@link ../task/mission-task-runner}.
	 */
	taskId?: string;
	/**
	 * Short role label, used in logs and the contract block header. Examples: `refactor-applier`,
	 * `test-writer`, `spec-reviewer`. NOT free-form prose — keep to a verb-noun phrase so the
	 * subagent can clearly self-identify and the parent can match expectations.
	 */
	role: string;
	/**
	 * Snapshot of the parent mission's contract revision at the moment this contract was minted.
	 * The subagent reads the live mission revision from its rendered context and compares:
	 * when the live revision exceeds this baseline, the contract is stale and the subagent
	 * MUST yield to let the parent re-issue a fresh contract instead of plowing ahead with
	 * outdated scope/criteria. See `isSubagentContractStale`.
	 *
	 * Optional for backward compatibility: a contract minted before this field landed (or by
	 * a caller that doesn't care about pivots) treats every revision as fresh.
	 */
	parentMissionRev?: number;
	/**
	 * File-glob scope. `include` is whitelist (empty = "no restriction"); `exclude` is blacklist
	 * (empty = "no excluded paths"). Tool-layer guards check `exclude` first (hard fail), then
	 * `include` (when non-empty, off-include paths also fail). Paths are matched in a normalized
	 * forward-slash form relative to the subagent's cwd.
	 */
	scope: {
		include: string[];
		exclude: string[];
	};
	/**
	 * Parent mission scope this contract was derived under, when spawned beneath an
	 * objective that declared a scope (set by {@link deriveContractScopeFromParent}). A
	 * delegated child can never exceed the parent's blast radius: enforcement checks the
	 * mutation against this in ADDITION to `scope`. This captures the parent INCLUDE
	 * allowlist, which cannot be folded into a single contract `scope` (parent excludes
	 * ARE folded into `scope.exclude`). NOT rendered into the XML contract block — it is an
	 * enforcement-only field, so it does not affect the prompt-cache-stable rendering.
	 */
	parentMissionScope?: MissionScopeForContract;
	/**
	 * Acceptance criteria the parent will verify after the subagent yields. Use a SUBSET of the
	 * parent goal's acceptanceCriteria narrowed to this subagent's deliverables. The verifier
	 * runs at the task-completion boundary; fail blocks merge / triggers revision.
	 */
	successCriteria: AcceptanceCriterion[];
	/**
	 * Escalation policy. `onUncertainty=ask-parent` means the subagent should yield with a
	 * question instead of guessing; `block` means stop without yielding. `budgetCap` is a
	 * token soft limit — the executor surfaces a warning when crossed, but does not hard-kill
	 * the subagent (kill is the parent's call).
	 */
	escalation: {
		onUncertainty: EscalationOnUncertainty;
		budgetCap: number;
	};
	/**
	 * Optional shared-context artifact for handoff. Parent writes the spec/plan to a `local://`
	 * artifact and references it here. The subagent reads it as its first action.
	 */
	inputArtifact?: string;
	/**
	 * Files / artifacts the subagent MUST produce. Closing audit checks file-exists for each.
	 * Distinct from `successCriteria`: outputContract is a structural requirement (you must
	 * produce X), successCriteria is a behavioral check (X must satisfy Y).
	 */
	outputContract?: {
		mustProduce: string[];
	};
}

/**
 * Result of a subagent invocation as observed by the parent. The fields here are the
 * subset the parent needs to verify against `SubagentContract.successCriteria` —
 * specifically the list of files the subagent claims to have changed, derived from
 * the executor's `SingleResult.outputMeta.changedFiles` or git diff if the subagent
 * ran isolated.
 */
export interface SubagentCompletion {
	role: string;
	changedFiles: string[];
	/** Working directory the subagent ran in. Verifier's file-exists / command-exit checks resolve here. */
	cwd: string;
}

/**
 * Auto revision-loop primitive — wraps a subagent attempt with verifier-driven retry.
 *
 * Flow:
 *   1. Run `attempt(revisionRequest?)` to drive one subagent execution. First call passes
 *      `undefined` (fresh attempt); on retry, passes the list of failing criteria + their
 *      evidence so the subagent can self-correct.
 *   2. Verify the resulting `SubagentCompletion` against `contract.successCriteria`.
 *   3. If verdict is `pass` (or `uncertain`-only), return early — no retry needed.
 *   4. On `fail` and `maxRetries > 0`, run attempt(revisionRequest) ONE more time and
 *      re-verify. The retry receives a structured revision request, not a free-form note.
 *   5. Return whichever attempt produced the better verdict, plus a record of attempts.
 *
 * Cap is explicit (`maxRetries`, default 1) and small — auto retry is a courtesy, not a
 * fix-it-forever loop. After cap, the parent surfaces the final fail to the operator who
 * decides whether to escalate, force-merge, or rewrite the contract.
 */
export async function runRevisionLoop(args: {
	contract: SubagentContract;
	attempt: (revisionRequest: RevisionRequest | undefined) => Promise<SubagentCompletion>;
	maxRetries?: number;
	criticActions?: Array<{
		id: string;
		description: string;
		requiredAction: string;
		evidence?: string;
		severity?: string;
	}>;
}): Promise<{
	finalVerdict: import("../mission/core/verifier").VerificationVerdict;
	finalCompletion: SubagentCompletion;
	attempts: Array<{ verdict: import("../mission/core/verifier").VerificationVerdict; completion: SubagentCompletion }>;
}> {
	const { contract, attempt } = args;
	const maxRetries = args.maxRetries ?? 1;
	const history: Array<{
		verdict: import("../mission/core/verifier").VerificationVerdict;
		completion: SubagentCompletion;
	}> = [];

	let revisionRequest: RevisionRequest | undefined;
	for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
		const completion = await attempt(revisionRequest);
		const { verdict } = await verifySubagentCompletion(contract, completion);
		history.push({ verdict, completion });
		if (verdict.verdict === "pass") {
			return { finalVerdict: verdict, finalCompletion: completion, attempts: history };
		}
		// Build the structured revision request from the failing criteria. This is what the
		// retry attempt receives — actionable list, not a vague "try again".
		const failed = verdict.results.filter(r => r.status === "fail");
		revisionRequest = {
			attemptNumber: attemptIndex + 1,
			failedCriteria: failed.map(r => ({ id: r.id, description: r.description, evidence: r.evidence })),
		};
		if (args.criticActions?.length) {
			for (const action of args.criticActions) {
				if (revisionRequest.failedCriteria.some(criterion => criterion.id === action.id)) continue;
				revisionRequest.failedCriteria.push({
					id: action.id,
					description: `${action.description} Required action: ${action.requiredAction}.`,
					evidence: action.evidence ?? `critic action severity: ${action.severity ?? "unknown"}`,
				});
			}
		}
	}
	const last = history[history.length - 1];
	return { finalVerdict: last.verdict, finalCompletion: last.completion, attempts: history };
}

export interface RevisionRequest {
	/** 1 for the first retry, 2 for the second, etc. (Production cap is currently 1.) */
	attemptNumber: number;
	/** Criteria that failed in the prior attempt, with evidence the subagent should use. */
	failedCriteria: Array<{ id: string; description: string; evidence: string }>;
}

/**
 * Format a RevisionRequest as a prompt fragment for the retry subagent invocation. Use
 * this in the task tool's revision-spawn path: the subagent's user prompt should include
 * this block so it sees concretely what to fix.
 */
export function renderRevisionRequest(request: RevisionRequest): string {
	const lines = [`# Revision request (attempt ${request.attemptNumber + 1})`, ""];
	lines.push("Your previous attempt failed the parent's acceptance verifier on these criteria:");
	for (const c of request.failedCriteria) {
		lines.push(`- **[${c.id}]** ${c.description}`);
		lines.push(`  Evidence: ${c.evidence}`);
	}
	lines.push("");
	lines.push("Address each failed criterion specifically. Do not start over; iterate on what you already produced.");
	return lines.join("\n");
}

/**
 * Structured exception thrown when a stale contract is detected and the subagent must yield.
 * Carries enough metadata for the parent to act: contract role, baseline revision, and the
 * live parent revision that overtook it.
 *
 * Thrown by `enforceContractFreshness` — turn-start hooks and verifier consumers call this
 * helper instead of comparing revisions inline, so the failure shape is consistent across
 * call sites and the parent's revision-loop can identify stale-yield results vs other fails.
 */
export class StaleContractError extends Error {
	readonly role: string;
	readonly baselineRevision: number;
	readonly parentRevision: number;
	constructor(role: string, baselineRevision: number, parentRevision: number) {
		super(
			`SubagentContract (role: ${role}) is stale: parent mission advanced from revision ${baselineRevision} to ${parentRevision}. Yield to parent for fresh contract issuance.`,
		);
		this.name = "StaleContractError";
		this.role = role;
		this.baselineRevision = baselineRevision;
		this.parentRevision = parentRevision;
	}
}
export interface ContractFreshnessResult {
	stale: boolean;
	staleness?: { stamped: number; current: number };
}

/**
 * Structural contract freshness comparison. Returns staleness metadata when both
 * revisions are known and the live parent mission has advanced past the stamped
 * contract revision; incomplete data is treated as fresh for backward compatibility.
 */
export function enforceContractFreshness(
	stampedRevision: number | undefined,
	currentRevision: number | undefined,
): ContractFreshnessResult {
	if (stampedRevision === undefined) return { stale: false };
	if (currentRevision === undefined) return { stale: false };
	if (currentRevision > stampedRevision) {
		return { stale: true, staleness: { stamped: stampedRevision, current: currentRevision } };
	}
	return { stale: false };
}

/**
 * Stamp the parent's current mission revision onto a SubagentContract at issuance time.
 * Use this when spawning a subagent: the contract authored by the parent (or model) may
 * not specify a baseline, and the task executor should fill it from the parent mission's
 * current contract revision. Idempotent — preserves an explicit baseline if already set.
 *
 * Returns a NEW contract object; never mutates the input.
 */
export function stampContractRevision(
	contract: SubagentContract,
	parentCurrentRevision: number | undefined,
): SubagentContract {
	if (contract.parentMissionRev !== undefined) return contract;
	if (parentCurrentRevision === undefined) return contract;
	return { ...contract, parentMissionRev: parentCurrentRevision };
}

/**
 * Mission context handed to {@link bindContractToMission} / {@link enforceMissionBinding}.
 * When present, the subagent runs under the Mission execution model and the contract MUST
 * carry the mission identifiers. When `undefined`, the subagent is in legacy direct mode and
 * mission identifiers are neither required nor stamped.
 */
export interface MissionBindingContext {
	missionId: string;
	taskId: string;
}

/**
 * Thrown by {@link enforceMissionBinding} when a mission context exists but the contract is
 * missing (or contradicts) the expected mission identifiers. Keeps the failure shape distinct
 * from {@link StaleContractError} so callers can tell "unbound under mission" from "stale".
 */
export class MissionBindingError extends Error {
	readonly role: string;
	readonly expected: MissionBindingContext;
	constructor(role: string, expected: MissionBindingContext, detail: string) {
		super(
			`SubagentContract (role: ${role}) is not bound to its mission: ${detail} (expected missionId=${expected.missionId}, taskId=${expected.taskId}).`,
		);
		this.name = "MissionBindingError";
		this.role = role;
		this.expected = expected;
	}
}

/**
 * Stamp the mission identifiers onto a contract at issuance time. Mirrors
 * {@link stampContractRevision}: returns a NEW contract, never mutates the input, and is
 * a no-op when there is no mission context (legacy direct use). Idempotent — preserves an
 * explicitly-set binding if it already matches.
 */
export function bindContractToMission(
	contract: SubagentContract,
	mission: MissionBindingContext | undefined,
): SubagentContract {
	if (!mission) return contract;
	if (contract.missionId === mission.missionId && contract.taskId === mission.taskId) return contract;
	return { ...contract, missionId: mission.missionId, taskId: mission.taskId };
}

/**
 * Structural enforcement of the mission binding. The "OPTIONAL-with-enforcement" rule:
 *
 *   - No mission context (`undefined`)  → legacy direct mode; binding is not required. No-op.
 *   - Mission context present           → the contract MUST carry the SAME missionId/taskId.
 *
 * Throws {@link MissionBindingError} when a mission context exists but the contract is unbound
 * or bound to a different mission/task. Never invents a requirement from incomplete data —
 * legacy callers that pass no mission context keep working unchanged.
 */
export function enforceMissionBinding(contract: SubagentContract, mission: MissionBindingContext | undefined): void {
	if (!mission) return;
	if (contract.missionId === undefined || contract.taskId === undefined) {
		throw new MissionBindingError(contract.role, mission, "contract is missing missionId/taskId");
	}
	if (contract.missionId !== mission.missionId || contract.taskId !== mission.taskId) {
		throw new MissionBindingError(
			contract.role,
			mission,
			`contract is bound to a different mission/task (missionId=${contract.missionId}, taskId=${contract.taskId})`,
		);
	}
}

/**
 * Detects whether a SubagentContract is stale relative to the parent mission's current
 * revision. Returns `true` when the contract is stale and the subagent should yield for
 * fresh contract issuance.
 *
 * Three cases:
 *   - Contract has no `parentMissionRev` baseline → never stale (back-compat path).
 *   - Parent's current revision <= baseline → fresh.
 *   - Parent's current revision > baseline → STALE. Subagent yields.
 *
 * Equality is fresh, not stale: the baseline is "this is the revision I was issued under";
 * a parent that hasn't bumped past it has nothing new to communicate.
 */
export function isSubagentContractStale(
	contract: SubagentContract,
	parentCurrentRevision: number | undefined,
): boolean {
	if (contract.parentMissionRev === undefined) return false;
	if (parentCurrentRevision === undefined) return false;
	return parentCurrentRevision > contract.parentMissionRev;
}

/**
 * Run the AcceptanceVerifier against a SubagentContract's success criteria using the
 * subagent's reported completion. This is the parent-side check that closes the loop:
 *
 *   1. Subagent yields with a list of changed files.
 *   2. Parent calls `verifySubagentCompletion(contract, completion)`.
 *   3. Verdict is `pass` → parent merges/accepts the result.
 *   4. Verdict is `fail` → parent surfaces evidence and (in a future revision-loop phase)
 *      sends the subagent back with the failure list as a revision request.
 *
 * `uncertain` items surface but do NOT block — the same contract as closing audit.
 * Returns the full `VerificationVerdict` so callers can render per-criterion evidence.
 */
export async function verifySubagentCompletion(
	contract: SubagentContract,
	completion: SubagentCompletion,
): Promise<{
	verdict: import("../mission/core/verifier").VerificationVerdict;
}> {
	const { AcceptanceVerifier, summarize } = await import("../mission/core/verifier");
	const verifier = new AcceptanceVerifier();
	const results = await verifier.verify(contract.successCriteria, {
		cwd: completion.cwd,
		changedFiles: completion.changedFiles,
	});
	return { verdict: summarize(results, contract.successCriteria, "contract") };
}

function escapeXml(input: string): string {
	let out = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "&") out += "&amp;";
		else if (ch === "<") out += "&lt;";
		else if (ch === ">") out += "&gt;";
		else if (ch === '"') out += "&quot;";
		else out += ch;
	}
	return out;
}

/**
 * Render a SubagentContract as a deterministic XML block for injection into the subagent's
 * STABLE_CORE system prompt. The output is byte-stable for identical contracts — required for
 * prompt cache hits across the subagent's session. Keys are emitted in fixed order; arrays
 * preserve caller-provided order (callers must decide canonical order at contract creation
 * time, not at render).
 */
export function renderSubagentContract(contract: SubagentContract): string {
	const lines: string[] = [];
	// `parent-mission-rev` lets the model self-check at runtime: when the live mission
	// context shows a higher revision than this baseline, the subagent should yield
	// instead of trusting its cached contract.
	const revisionAttr =
		contract.parentMissionRev !== undefined ? ` parent-mission-rev="${contract.parentMissionRev}"` : "";
	lines.push(`<subagent-contract role="${escapeXml(contract.role)}"${revisionAttr}>`);
	lines.push(`  <scope>`);
	for (const pattern of contract.scope.include) {
		lines.push(`    <include>${escapeXml(pattern)}</include>`);
	}
	for (const pattern of contract.scope.exclude) {
		lines.push(`    <exclude>${escapeXml(pattern)}</exclude>`);
	}
	lines.push(`  </scope>`);
	if (contract.successCriteria.length > 0) {
		lines.push(`  <success-criteria>`);
		for (const criterion of contract.successCriteria) {
			lines.push(
				`    <criterion id="${escapeXml(criterion.id)}" kind="${escapeXml(criterion.check.type)}">${escapeXml(criterion.description)}</criterion>`,
			);
		}
		lines.push(`  </success-criteria>`);
	}
	lines.push(
		`  <escalation on-uncertainty="${escapeXml(contract.escalation.onUncertainty)}" budget-cap="${contract.escalation.budgetCap}"/>`,
	);
	if (contract.inputArtifact) {
		lines.push(`  <input-artifact>${escapeXml(contract.inputArtifact)}</input-artifact>`);
	}
	if (contract.outputContract && contract.outputContract.mustProduce.length > 0) {
		lines.push(`  <output-contract>`);
		for (const artifact of contract.outputContract.mustProduce) {
			lines.push(`    <must-produce>${escapeXml(artifact)}</must-produce>`);
		}
		lines.push(`  </output-contract>`);
	}
	lines.push(`</subagent-contract>`);
	return lines.join("\n");
}

/**
 * Convenience guard for tool implementations (edit, write). Throws a structured error when
 * the path violates contract scope. Tools should call this before any filesystem mutation.
 * The error message names the rule that fired so the model can correct course on the next
 * turn instead of guessing.
 *
 * Pass an Error-thrower factory (e.g. `ToolError`) so tools surface the failure consistently
 * with their existing error channel.
 */
export function enforceContractScope(
	contract: SubagentContract | undefined,
	filePath: string,
	throwError: (message: string) => never,
): void {
	const verdict = checkScope(contract, filePath);
	if (!verdict.allowed) {
		throwError(
			`SubagentContract scope violation: ${verdict.reason} Adjust your edit or escalate to the parent via yield.`,
		);
	}
	// A delegated child can never exceed the parent mission's blast radius. The parent
	// EXCLUDES are already folded into `scope.exclude` by deriveContractScopeFromParent, but
	// the parent INCLUDE allowlist cannot be merged into a single contract scope (checkScope
	// ORs includes), so it is carried on `parentMissionScope` and enforced here in addition.
	if (contract?.parentMissionScope) {
		const parentVerdict = checkScope(
			{
				role: "parent-mission-scope",
				scope: contract.parentMissionScope,
				successCriteria: [],
				escalation: { onUncertainty: "block", budgetCap: 0 },
			},
			filePath,
		);
		if (!parentVerdict.allowed) {
			throwError(
				`Parent mission scope violation: ${parentVerdict.reason.replace("(role: parent-mission-scope)", "(parent mission guard)")} A subagent cannot edit outside the parent mission's scope; escalate to the parent via yield.`,
			);
		}
	}
}

/**
 * Goal-level fallback guard. Used when no `SubagentContract` is active for the calling session
 * but a parent Goal has declared a `scopeGuard` for the whole goal's work. Same semantics as
 * `enforceContractScope`, but the error message distinguishes the source so the model can tell
 * whether it crossed a subagent boundary or the broader goal boundary.
 *
 * Tools call BOTH guards: contract first (if any), then this. If contract is set, the goal-level
 * fallback is a no-op (contract is the more specific declaration).
 */
export function enforceGoalScope(
	goalScope: { include: string[]; exclude: string[] } | undefined,
	filePath: string,
	throwError: (message: string) => never,
): void {
	if (!goalScope) return;
	// Adapt the goal-level scope to the same shape SubagentContract uses so we share the
	// glob-matching code path. The fake "contract" is never user-visible.
	const adapted: SubagentContract = {
		role: "goal-scope",
		scope: goalScope,
		successCriteria: [],
		escalation: { onUncertainty: "block", budgetCap: 0 },
	};
	const verdict = checkScope(adapted, filePath);
	if (!verdict.allowed) {
		throwError(
			`Goal scope violation: ${verdict.reason.replace("(role: goal-scope)", "(goal-level guard)")} If this edit is intentional, ask the user or host runtime to revise the goal scope before retrying.`,
		);
	}
}

/**
 * Derive a subagent contract whose scope is bounded by the parent mission's scope
 * (consolidation PR4). A delegated child must never exceed the parent's blast radius:
 *   - Parent denials always bind children: the parent's `exclude` globs are unioned into
 *     the child's `exclude` (this can only RESTRICT, never widen — always sound).
 *   - Parent allowlist constrains children: when the parent restricts to an `include` set
 *     and the child declares none, the child inherits the parent's includes so it cannot
 *     roam outside the parent's domain. When the child declares its own includes they are
 *     kept (the child is expected to narrow within the parent's domain), and the unioned
 *     parent excludes above still bind.
 *
 * Returns the contract unchanged when there is no parent scope.
 */
export function deriveContractScopeFromParent(
	contract: SubagentContract,
	parentMissionScope: MissionScopeForContract | undefined,
): SubagentContract {
	if (!parentMissionScope) return contract;
	const exclude = Array.from(new Set([...contract.scope.exclude, ...parentMissionScope.exclude]));
	const include =
		parentMissionScope.include.length > 0 && contract.scope.include.length === 0
			? [...parentMissionScope.include]
			: [...contract.scope.include];
	// Carry the parent scope so enforcement bounds the child by the parent INCLUDE allowlist
	// too (not just the folded excludes) — see enforceContractScope. Only attach when the
	// parent actually restricts via an include allowlist; a parent with no allowlist adds no
	// include ceiling (its excludes are already folded above), so we avoid a redundant field.
	const carriedParent = parentMissionScope.include.length > 0 ? { parentMissionScope } : {};
	return { ...contract, scope: { ...contract.scope, include, exclude }, ...carriedParent };
}

/**
 * Mission-level scope guard. Used when no `SubagentContract` is active but the calling
 * session is bound to a Mission that declared a scope guard. Mission scope is the canonical
 * authority over the legacy Goal scope: when a mission scope is present, callers enforce it
 * INSTEAD of the goal-level guard so the two can never disagree on the same mutation.
 *
 * Semantics mirror `checkScope`: `deniedPaths` always block; `allowedPaths` act as a
 * whitelist only when non-empty (empty ⇒ unrestricted), matching `MissionScopeGuard` docs.
 */
export function enforceMissionScope(
	missionScope: { allowedPaths: string[]; deniedPaths: string[] } | undefined,
	filePath: string,
	throwError: (message: string) => never,
): void {
	if (!missionScope) return;
	// Adapt mission scope to the SubagentContract shape so it shares the glob-matching path.
	const adapted: SubagentContract = {
		role: "mission-scope",
		scope: { include: missionScope.allowedPaths, exclude: missionScope.deniedPaths },
		successCriteria: [],
		escalation: { onUncertainty: "block", budgetCap: 0 },
	};
	const verdict = checkScope(adapted, filePath);
	if (!verdict.allowed) {
		throwError(
			`Mission scope violation: ${verdict.reason.replace("(role: mission-scope)", "(mission-level guard)")} If this edit is intentional, revise the mission scope before retrying.`,
		);
	}
}

/**
 * Check a file path against the contract's scope. Returns `{ allowed: false, reason }` on
 * violation, `{ allowed: true }` on pass. Tool guards (edit/write) MUST call this before
 * writing — text-level "please don't edit X" rules in prompts can be ignored under pressure;
 * a structural gate cannot.
 *
 * Matching is glob-based via Bun's `Glob`. Paths are normalized to forward slashes before
 * matching so Windows / Unix differences don't leak through.
 */
export function checkScope(
	contract: SubagentContract | undefined,
	filePath: string,
): { allowed: true } | { allowed: false; reason: string } {
	if (!contract) return { allowed: true };
	const normalized = filePath.replace(/\\/g, "/");
	const { Glob } = require("bun") as typeof import("bun");

	for (const pattern of contract.scope.exclude) {
		const glob = new Glob(pattern);
		if (glob.match(normalized)) {
			return {
				allowed: false,
				reason: `Path "${normalized}" matches contract scope.exclude glob "${pattern}" (role: ${contract.role}).`,
			};
		}
	}

	if (contract.scope.include.length === 0) return { allowed: true };

	for (const pattern of contract.scope.include) {
		const glob = new Glob(pattern);
		if (glob.match(normalized)) return { allowed: true };
	}
	return {
		allowed: false,
		reason: `Path "${normalized}" outside contract scope.include globs [${contract.scope.include.join(", ")}] (role: ${contract.role}).`,
	};
}
