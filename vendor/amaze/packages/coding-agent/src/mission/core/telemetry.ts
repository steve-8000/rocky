/**
 * V3 telemetry aggregator — per-session counters for the team coordination layer.
 *
 * Built so operators (and future dashboards) can answer:
 *   - How often is the Design Interview actually firing vs being skipped?
 *   - What fraction of `goal complete` calls used `force` to override the closing audit?
 *     (force-rate is the calibration tripwire — > ~30% means criteria are mis-tuned)
 *   - How often do subagents run with structured contracts vs free-form?
 *   - Which criterion types pass/fail most often?
 *
 * Design notes:
 *   - Pure in-memory, per-session. Persisting across sessions would need a separate sink
 *     (file or HTTP); for now this is enough to inspect a live run and trigger calibration.
 *   - Counters are monotonic — never reset within a session. Operators get cumulative
 *     answers; rolling-window math is the consumer's job.
 *   - No callbacks / observers — the aggregator is read-only. Producers call `record*`
 *     methods directly; consumers call `getStats()`.
 */

export type DesignInterviewClassification = "fired" | "already_captured" | "no_goal" | "capture_failed";

export interface V3Stats {
	designInterview: {
		totalCalls: number;
		byClassification: Record<DesignInterviewClassification, number>;
	};
	closingAudit: {
		totalCompletions: number;
		passed: number;
		failed: number;
		forced: number;
		uncertainSurfaced: number;
	};
	subagent: {
		totalSpawned: number;
		withContract: number;
		withoutContract: number;
	};
	verifier: {
		// Cumulative criterion results by check type — surfaces which kinds carry the work
		// and which fail most often.
		criterionResults: Record<string, { pass: number; fail: number; uncertain: number }>;
	};
}

export class V3Telemetry {
	#stats: V3Stats = {
		designInterview: {
			totalCalls: 0,
			byClassification: { fired: 0, already_captured: 0, no_goal: 0, capture_failed: 0 },
		},
		closingAudit: { totalCompletions: 0, passed: 0, failed: 0, forced: 0, uncertainSurfaced: 0 },
		subagent: { totalSpawned: 0, withContract: 0, withoutContract: 0 },
		verifier: { criterionResults: {} },
	};

	recordDesignInterviewCall(classification: DesignInterviewClassification): void {
		this.#stats.designInterview.totalCalls++;
		this.#stats.designInterview.byClassification[classification]++;
	}

	recordClosingAudit(outcome: { passed: boolean; forced: boolean; uncertainCount: number }): void {
		this.#stats.closingAudit.totalCompletions++;
		if (outcome.forced) this.#stats.closingAudit.forced++;
		else if (outcome.passed) this.#stats.closingAudit.passed++;
		else this.#stats.closingAudit.failed++;
		this.#stats.closingAudit.uncertainSurfaced += outcome.uncertainCount;
	}

	recordSubagentSpawn(withContract: boolean): void {
		this.#stats.subagent.totalSpawned++;
		if (withContract) this.#stats.subagent.withContract++;
		else this.#stats.subagent.withoutContract++;
	}

	recordVerifierResult(checkType: string, status: "pass" | "fail" | "uncertain"): void {
		this.#stats.verifier.criterionResults[checkType] ??= { pass: 0, fail: 0, uncertain: 0 };
		this.#stats.verifier.criterionResults[checkType][status]++;
	}

	getStats(): V3Stats {
		// Defensive copy — consumers shouldn't be able to mutate counters by holding a reference.
		return {
			designInterview: {
				totalCalls: this.#stats.designInterview.totalCalls,
				byClassification: { ...this.#stats.designInterview.byClassification },
			},
			closingAudit: { ...this.#stats.closingAudit },
			subagent: { ...this.#stats.subagent },
			verifier: {
				criterionResults: Object.fromEntries(
					Object.entries(this.#stats.verifier.criterionResults).map(([k, v]) => [k, { ...v }]),
				),
			},
		};
	}

	/**
	 * Derived metric: force-rate ratio. Returns null when no completions observed yet (avoid
	 * the divide-by-zero noise in early-session dashboards). Threshold for "criteria need
	 * calibration" is typically > 0.3.
	 */
	getForceRate(): number | null {
		const total = this.#stats.closingAudit.totalCompletions;
		if (total === 0) return null;
		return this.#stats.closingAudit.forced / total;
	}

	/**
	 * Derived metric: Design Interview fire-rate (excluding ad-hoc no_goal asks). High fire
	 * rate confirms the interview is doing its job; persistent 0% suggests the model is
	 * skipping when it shouldn't.
	 */
	getInterviewFireRate(): number | null {
		const di = this.#stats.designInterview;
		const decisionable = di.byClassification.fired + di.byClassification.already_captured;
		if (decisionable === 0) return null;
		return di.byClassification.fired / decisionable;
	}
}

/**
 * Render a compact human-readable summary of telemetry. Used by `amaze stats` / debug dump.
 * Skips zero-valued sections so output stays focused on what's actually happening.
 */
export function formatV3Stats(stats: V3Stats): string {
	const lines: string[] = ["V3 coordination telemetry"];

	if (stats.designInterview.totalCalls > 0) {
		const di = stats.designInterview;
		const bc = di.byClassification;
		lines.push(
			`  Design Interview: ${di.totalCalls} ask call(s) — fired=${bc.fired} already=${bc.already_captured} no-goal=${bc.no_goal} failed=${bc.capture_failed}`,
		);
	}
	if (stats.closingAudit.totalCompletions > 0) {
		const ca = stats.closingAudit;
		const forceRate = ((ca.forced / ca.totalCompletions) * 100).toFixed(1);
		lines.push(
			`  Closing audit: ${ca.totalCompletions} completion(s) — pass=${ca.passed} fail=${ca.failed} force=${ca.forced} (${forceRate}%) uncertain=${ca.uncertainSurfaced}`,
		);
	}
	if (stats.subagent.totalSpawned > 0) {
		const sa = stats.subagent;
		const contractRate = ((sa.withContract / sa.totalSpawned) * 100).toFixed(1);
		lines.push(
			`  Subagents: ${sa.totalSpawned} spawn(s) — with contract=${sa.withContract} (${contractRate}%) free-form=${sa.withoutContract}`,
		);
	}
	const cr = stats.verifier.criterionResults;
	const checkKinds = Object.keys(cr);
	if (checkKinds.length > 0) {
		lines.push(`  Verifier criteria:`);
		for (const kind of checkKinds.sort()) {
			const slot = cr[kind];
			lines.push(`    ${kind}: pass=${slot.pass} fail=${slot.fail} uncertain=${slot.uncertain}`);
		}
	}

	return lines.length === 1 ? "V3 coordination telemetry: (no events recorded)" : lines.join("\n");
}
