/**
 * Ready-to-attach analyzer for the self-improvement loop. Bundles the dependencies a
 * live pass needs — configured rules, persisted session events, and a ProposalStore —
 * into a single `analyze()` closure that {@link attachSelfImprovementLoop} can fire on
 * objective completion. Owns the ProposalStore lifecycle per pass (open → run → close)
 * so it holds no long-lived handle.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import { getPackageDir } from "../config";
import { readSessionEvents } from "../observability/session-events";
import { loadRules } from "../rules/loader";
import { type ObjectiveLoopResult, runObjectiveLoopOnce } from "./loop";
import { ProposalStore } from "./store";

export interface ObjectiveLoopAnalyzerOptions {
	/** Project root, for the project-scoped rules dir. */
	cwd: string;
	/** Override the observability dir (defaults to AMAZE_OBSERVABILITY_DIR / ~/.amaze/observability). */
	observabilityDir?: string;
	/** Override the proposal store path (defaults to ~/.amaze/autonomy/autonomy.db). */
	proposalDbPath?: string;
}

/**
 * Build the `analyze` closure: load rules (builtin + personal + project), read persisted
 * session events, and run one {@link runObjectiveLoopOnce} pass against a fresh
 * ProposalStore. Rule-derived proposals are review/human gated, so no auto-eval is wired
 * here — proposals land in the store for explicit operator review.
 */
export function createObjectiveLoopAnalyzer(options: ObjectiveLoopAnalyzerOptions): () => Promise<ObjectiveLoopResult> {
	return async () => {
		const [loaded, events] = await Promise.all([
			loadRules({
				builtinDir: process.env.AMAZE_RULES_BUILTIN_DIR ?? path.join(getPackageDir(), "src", "rules", "builtin"),
				userDir: process.env.AMAZE_RULES_USER_DIR ?? path.join(process.env.HOME || homedir(), ".amaze", "rules"),
				projectDir: process.env.AMAZE_RULES_PROJECT_DIR ?? path.join(options.cwd, ".amaze", "rules"),
			}),
			readSessionEvents({ observabilityDir: options.observabilityDir }),
		]);
		const store = new ProposalStore(options.proposalDbPath);
		try {
			return await runObjectiveLoopOnce({ rules: loaded.map(l => l.rule), events, store });
		} finally {
			store.close();
		}
	};
}
