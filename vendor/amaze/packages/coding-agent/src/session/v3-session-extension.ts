/**
 * V3SessionExtension — extracted v3 coordination state from `AgentSession`.
 *
 * AgentSession is a known monolith (~8K LoC; architecture review flagged it as the top
 * maintainability risk). Adding the v3 telemetry + cache-thrash detection directly into
 * that class would have made the monolith worse. This module owns the v3-specific session
 * state and exposes a minimal interface to AgentSession:
 *
 *   - `onTurnStart(stats)`: called at session turn_start, threads cache stats for thrash
 *     detection. AgentSession passes its `getSessionStats().tokens` snapshot.
 *   - `telemetry`: the V3Telemetry aggregator instance, exposed for tool integration
 *     (ask, goal, task) and for `formatSummary()` consumers.
 *   - `formatSummary()`: human-readable telemetry dump for debug paths.
 *
 * Net change on AgentSession: 5 fields + ~30 lines of logic → 1 field + 3 lines of call-through.
 *
 * Lifecycle: created per-session at AgentSession construction, garbage-collected with it.
 * No persistent state across sessions — measurement is live-only by design.
 */

import { logger } from "@amaze/utils";
import { formatV3Stats, V3Telemetry } from "../mission/core/telemetry";

/**
 * Cache thrash detection window. After the cache has been written to at least once, this many
 * consecutive turns with zero cache_read tokens triggers a `logger.warn`. 3 is enough to filter
 * one-off Anthropic API hiccups while still catching real prefix instability fast.
 */
export const CACHE_THRASH_WINDOW = 3;

export interface SessionCacheTokenSnapshot {
	cacheRead: number;
	cacheWrite: number;
}

export class V3SessionExtension {
	readonly telemetry: V3Telemetry = new V3Telemetry();

	#cacheReadDeltaHistory: number[] = [];
	#lastSeenCacheRead = 0;
	#hasObservedCacheWrite = false;
	#cacheThrashWarned = false;

	/**
	 * Per-turn hook. Called by AgentSession at turn_start. Detects cache thrash by tracking
	 * cache_read deltas after the first write has been observed — three consecutive zero
	 * deltas while the cache *should* be active indicates STABLE_CORE mutating mid-session.
	 *
	 * Emits a single warning per thrash episode (not per turn) to keep logs readable. Resets
	 * after any non-zero read so a recovered cache lifts the warning state.
	 */
	onTurnStart(stats: SessionCacheTokenSnapshot): void {
		const cacheReadDelta = Math.max(0, stats.cacheRead - this.#lastSeenCacheRead);
		this.#lastSeenCacheRead = stats.cacheRead;
		if (stats.cacheWrite > 0) this.#hasObservedCacheWrite = true;
		if (!this.#hasObservedCacheWrite) return;

		this.#cacheReadDeltaHistory.push(cacheReadDelta);
		if (this.#cacheReadDeltaHistory.length > CACHE_THRASH_WINDOW) {
			this.#cacheReadDeltaHistory.shift();
		}
		if (cacheReadDelta > 0) {
			this.#cacheThrashWarned = false;
			return;
		}
		if (
			!this.#cacheThrashWarned &&
			this.#cacheReadDeltaHistory.length >= CACHE_THRASH_WINDOW &&
			this.#cacheReadDeltaHistory.every(d => d === 0)
		) {
			this.#cacheThrashWarned = true;
			logger.warn("Prompt cache thrash detected", {
				consecutiveZeroReadTurns: CACHE_THRASH_WINDOW,
				hint: "STABLE_CORE bytes are likely changing between turns; check workspace_tree, intent fields, or MCP server flap.",
				cumulativeCacheWrite: stats.cacheWrite,
				cumulativeCacheRead: stats.cacheRead,
			});
		}
	}

	formatSummary(): string {
		return formatV3Stats(this.telemetry.getStats());
	}

	/**
	 * Test-only inspector. Exposes internal counters so unit tests can assert thrash detection
	 * fires under the right conditions without driving a full session. Production code MUST NOT
	 * read these — use `telemetry.getStats()` and `formatSummary()` instead.
	 */
	_inspectThrashState(): {
		hasObservedCacheWrite: boolean;
		thrashWarned: boolean;
		deltaHistory: readonly number[];
		lastSeenCacheRead: number;
	} {
		return {
			hasObservedCacheWrite: this.#hasObservedCacheWrite,
			thrashWarned: this.#cacheThrashWarned,
			deltaHistory: [...this.#cacheReadDeltaHistory],
			lastSeenCacheRead: this.#lastSeenCacheRead,
		};
	}
}
