/**
 * Self-improvement loop orchestrator — the keystone that closes the
 * observe → analyze → propose → (eval) cycle.
 *
 * Previously the pieces existed in isolation (rules engine, ruleFindingToProposal,
 * ProposalStore, evaluateProposal) but nothing connected them: a completed objective
 * never triggered rule evaluation, so no proposals were ever generated automatically.
 * This function wires them into one resilient, dependency-injected pass:
 *
 *   events ─▶ evaluateRule(rule, events) ─▶ RuleFinding[]
 *          ─▶ ruleFindingToProposal ─▶ ProposalStore.create (pending)
 *          ─▶ [gate==="auto"] evaluateProposal ─▶ store.setLastEval
 *
 * It is PURE w.r.t. its inputs (rules + events injected) so it is fully unit-testable,
 * and RESILIENT: a failing eval or a bad finding never aborts the pass. The live wiring
 * (a flag-gated subscriber that feeds it goal.complete events) is thin and calls this
 * fire-and-forget so it can never break the objective flow.
 */
import type { SessionEvent } from "../observability/event-schema";
import { evaluateRule, type RuleFinding } from "../rules/evaluator";
import type { Rule } from "../rules/types";
import { ruleFindingToProposal } from "./from-rule";
import type { ProposalStore } from "./store";
import type { EvalReport, LearningProposal } from "./types";

export interface ObjectiveLoopInput {
	/** Configured rules to evaluate against the event window. */
	rules: Rule[];
	/** Session events to analyze (e.g. recent goal.complete + tool events). */
	events: SessionEvent[];
	/** Where generated proposals are persisted. */
	store: ProposalStore;
	/**
	 * Optional auto-eval. When provided, proposals whose gate is `auto` are run through
	 * the eval pipeline and the result recorded. Omit to leave proposals pending for
	 * human/review gating. Failures here are swallowed (the proposal stays pending).
	 */
	evaluate?: (proposal: LearningProposal) => Promise<EvalReport>;
}

export interface ObjectiveLoopResult {
	/** Proposals newly created this pass. */
	created: LearningProposal[];
	/** How many `auto`-gated proposals were evaluated. */
	autoEvaluated: number;
	/** Findings skipped because an equivalent pending proposal already exists. */
	skippedDuplicates: number;
}

function provenanceRuleId(p: { provenance?: unknown }): string | undefined {
	const prov = p.provenance as { ruleId?: string } | undefined;
	return typeof prov?.ruleId === "string" ? prov.ruleId : undefined;
}

/**
 * Stable dedup key for a (draft or stored) proposal. Keys on the rule id PLUS the
 * finding's distinguishing detail (`reason` for settings, `expectedImpact` for rule
 * proposals — both derived from the per-group finding message). This keeps DISTINCT
 * findings from the same array-returning rule (one per group/session/workspace bucket)
 * from collapsing into one, while still deduping a re-proposal of the SAME finding across
 * passes. Memory-type proposals carry no message, so they key on ruleId alone (correct —
 * they are identical).
 */
function proposalDedupKey(p: { provenance?: unknown; reason?: unknown; expectedImpact?: unknown }): string {
	const ruleId = provenanceRuleId(p) ?? "";
	const detail =
		typeof p.reason === "string" ? p.reason : typeof p.expectedImpact === "string" ? p.expectedImpact : "";
	return `${ruleId}::${detail}`;
}

/**
 * Run one analysis pass: evaluate every rule against the events, convert findings to
 * proposals, persist them (deduping against still-pending proposals from the same rule),
 * and optionally auto-eval `auto`-gated proposals. Never throws on a single bad
 * rule/finding/eval — the loop must not be able to break the objective flow.
 */
export async function runObjectiveLoopOnce(input: ObjectiveLoopInput): Promise<ObjectiveLoopResult> {
	const { rules, events, store } = input;

	// Dedup window: a finding that already has a pending proposal should not spawn another
	// until the existing one is resolved. Keyed per-finding (see proposalDedupKey) so
	// distinct findings from one array-returning rule are NOT collapsed.
	const pendingKeys = new Set<string>();
	for (const pending of store.listByStatus("pending")) {
		pendingKeys.add(proposalDedupKey(pending));
	}

	const created: LearningProposal[] = [];
	let autoEvaluated = 0;
	let skippedDuplicates = 0;

	for (const rule of rules) {
		let findings: RuleFinding[];
		try {
			const result = evaluateRule(rule, events);
			findings = Array.isArray(result) ? result : result ? [result] : [];
		} catch {
			// A malformed rule must not abort the whole pass.
			continue;
		}
		for (const finding of findings) {
			const draft = ruleFindingToProposal(finding);
			if (!draft) continue;
			const key = proposalDedupKey(draft);
			if (pendingKeys.has(key)) {
				skippedDuplicates++;
				continue;
			}
			// Persisting one finding must not abort the pass (transient SQLITE_BUSY under
			// cross-session contention, a constraint error, disk full, …) — skip it and
			// keep going. This upholds the documented "one bad finding never aborts the pass".
			let proposal: LearningProposal;
			try {
				proposal = store.create(draft);
			} catch {
				continue;
			}
			created.push(proposal);
			pendingKeys.add(key);

			if (proposal.gate === "auto" && input.evaluate) {
				try {
					const report = await input.evaluate(proposal);
					store.setLastEval(proposal.id, report);
					autoEvaluated++;
				} catch {
					// Eval failure leaves the proposal pending; never break the pass.
				}
			}
		}
	}

	return { created, autoEvaluated, skippedDuplicates };
}
