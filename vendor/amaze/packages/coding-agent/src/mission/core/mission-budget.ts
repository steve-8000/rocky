/**
 * Token/cost budget for a mission. Tracks the ceiling and the running usage so
 * the runtime can enforce caps and surface remaining headroom.
 */
export interface MissionBudget {
	/** Maximum number of tokens the mission is allowed to consume. */
	tokenBudget: number;
	/** Tokens consumed so far. */
	tokensUsed: number;
	/** Optional hard cap on wall-clock duration in milliseconds. */
	timeBudgetMs?: number;
	/** Optional elapsed wall-clock time in milliseconds. */
	timeUsedMs?: number;
	/** Optional cap on the number of sub-tasks/agents that may be spawned. */
	taskBudget?: number;
	/** Optional count of tasks spawned so far. */
	tasksUsed?: number;
}

/**
 * Context-window budget for a mission. Distinct from {@link MissionBudget}: this
 * governs how much of the model context window the mission may occupy at once,
 * driving compaction and context-packet trimming decisions.
 */
export interface MissionContextBudget {
	/** Maximum tokens allowed in the active context window. */
	maxContextTokens: number;
	/** Tokens currently occupying the context window. */
	contextTokensUsed: number;
	/** Optional fraction (0-1) at which compaction should be triggered. */
	compactionThreshold?: number;
}
