import type { CacheRetention } from "@amaze/ai";
import type { Settings } from "./config/settings";
import type { ProjectContextMode } from "./system-prompt";

export type AgentPromptCacheRole = "orchestrator" | "subagent";
export type PromptCacheRetentionSetting = CacheRetention | "default";

export interface PromptCachePolicy {
	role: AgentPromptCacheRole;
	projectContextMode: ProjectContextMode;
	cacheRetention: CacheRetention | undefined;
}

function resolveCacheRetentionSetting(value: PromptCacheRetentionSetting): CacheRetention | undefined {
	return value === "default" ? undefined : value;
}

/**
 * Resolve the prompt cache policy for an agent invocation.
 *
 * **v2 cache strategy (interacting with the [STABLE_CORE, DYNAMIC_TAIL] system prompt layout):**
 *
 * - Orchestrator: defaults to provider policy (`resolveCacheRetention` in `@amaze/ai`, currently "long" = 1h).
 *   Math: 1h cache write costs ~2x base input vs ~1.25x for 5m, with both reading at ~0.1x. A session of length L
 *   pays `ceil(L / TTL) × write_premium`. For typical interactive coding sessions (10–30 min) 1h takes one write
 *   and the cache stays warm; 5m would re-write 2–6 times. Sessions that complete in under 5 min pay a small
 *   premium for 1h vs 5m — acceptable tradeoff since the alternative penalizes the common case.
 *   Override globally with `AMAZE_CACHE_RETENTION=short` for short-lived one-shot CLI runs.
 *
 * - Subagent (fan-out): forced to "long" when `prompt.cache.subagentPrefixReuse` is set — siblings share
 *   STABLE_CORE byte-for-byte, so one write amortizes across many reads. Without prefix reuse, defaults to
 *   "short" since orphan subagents don't repay long-cache write premiums.
 *
 * **Important**: the STABLE_CORE breakpoint is placed by `system-prompt.ts` via `systemPromptCacheBreakpointIndex`.
 * The retention setting here only chooses the TTL (5m vs 1h vs none); it does NOT choose which block is cached.
 */
export function resolvePromptCachePolicy(options: {
	settings: Settings;
	taskDepth?: number;
	parentTaskPrefix?: string;
}): PromptCachePolicy {
	const isSubagent = (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
	const role: AgentPromptCacheRole = isSubagent ? "subagent" : "orchestrator";

	if (role === "subagent") {
		// Prefix reuse promotes subagents to long retention: the parent's
		// system+tools+skills prefix is identical, so a fan-out of sibling
		// subagents amortizes one long cache write across many cheap reads.
		const prefixReuse = options.settings.get("prompt.cache.subagentPrefixReuse");
		if (prefixReuse) {
			return { role, projectContextMode: "full", cacheRetention: "long" };
		}
		return {
			role,
			projectContextMode: "full",
			cacheRetention: resolveCacheRetentionSetting(options.settings.get("prompt.cache.subagentRetention")),
		};
	}

	return {
		role,
		projectContextMode: options.settings.get("prompt.mainContextMode") ?? "compact",
		cacheRetention: resolveCacheRetentionSetting(options.settings.get("prompt.cache.orchestratorRetention")),
	};
}
