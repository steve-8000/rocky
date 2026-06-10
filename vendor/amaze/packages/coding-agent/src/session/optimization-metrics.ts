/**
 * Fire-and-forget optimization-metric recorder.
 *
 * Wraps `AgentStorage.recordOptimizationMetric` so call sites in the agent
 * hot path (continuous demotion, subagent spawn) can record measurements
 * without plumbing AgentStorage through their dependency tree, and without
 * blocking on disk I/O.
 *
 * Reads agent.db lazily on first call. All failures are swallowed — telemetry
 * must never affect agent behavior.
 */

import { AgentStorage } from "./agent-storage";

let storagePromise: Promise<AgentStorage | null> | null = null;

function getStorage(): Promise<AgentStorage | null> {
	if (!storagePromise) {
		storagePromise = AgentStorage.open().catch(() => null);
	}
	return storagePromise;
}

/**
 * Record an optimization-metric event. Returns immediately; the write happens
 * asynchronously and is best-effort. Use for fan-out counts, demotion fires,
 * cache hit estimates — anything we want to validate post-hoc.
 *
 * @param sessionId   Origin session id, or null when not associated.
 * @param metric      Short snake_case name (e.g. "subagent_spawn", "demotion_fire").
 * @param value       Numeric payload (count delta, tokens saved, …).
 * @param meta        Optional structured payload; will be JSON-stringified.
 */
export function recordOptimizationMetric(
	sessionId: string | null,
	metric: string,
	value: number,
	meta?: Record<string, unknown>,
): void {
	void getStorage().then(storage => {
		storage?.recordOptimizationMetric(sessionId, metric, value, meta);
	});
}
