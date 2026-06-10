/**
 * Live wiring for the self-improvement loop (the thin, resilient glue that connects
 * objective completion to {@link runObjectiveLoopOnce}).
 *
 * Subscribes to the session event bus and, on a trigger event (default `goal.complete`),
 * fires a caller-provided `analyze` pass fire-and-forget. It NEVER throws into the event
 * bus and serializes passes with an in-flight guard so a burst of completions can't pile
 * up overlapping analyses. The analyze closure (which loads rules + reads events + calls
 * runObjectiveLoopOnce against a ProposalStore) is injected so this module stays decoupled
 * from JSONL/rule/store internals and fully testable.
 *
 * Gated by {@link isSelfImprovementLoopEnabled} (`AMAZE_SELF_IMPROVE_LOOP`, default OFF):
 * the live attach point is a no-op unless explicitly enabled, so the loop is opt-in and
 * cannot change agent behavior until turned on.
 */
import type { EventBus, Unsubscribe } from "../observability/event-bus";
import type { SessionEvent } from "../observability/event-schema";

/**
 * Rollout flag for the self-improvement loop. Default OFF. Tolerant of common truthy
 * spellings and surrounding whitespace (.env files frequently add trailing newlines), so
 * `AMAZE_SELF_IMPROVE_LOOP=TRUE` / `=yes` / `=1\n` all enable it rather than silently
 * being treated as off.
 */
export function isSelfImprovementLoopEnabled(): boolean {
	const v = process.env.AMAZE_SELF_IMPROVE_LOOP?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface SelfImprovementLoopWiringOptions {
	/** Session event bus to observe. */
	eventBus: EventBus;
	/** One analysis pass (loads rules + events, runs runObjectiveLoopOnce). Must be idempotent-ish. */
	analyze: () => Promise<unknown>;
	/** Event types that trigger a pass. Default: `["goal.complete"]`. */
	triggerOn?: ReadonlyArray<SessionEvent["type"]>;
	/** Non-fatal error sink (the pass never throws into the bus). */
	onError?: (error: unknown) => void;
}

/**
 * Attach the loop to the bus. Returns an unsubscribe handle. Safe to call when the flag
 * is off — it simply returns a no-op unsubscribe and never subscribes.
 */
export function attachSelfImprovementLoop(options: SelfImprovementLoopWiringOptions): Unsubscribe {
	if (!isSelfImprovementLoopEnabled()) return () => {};

	const triggers = new Set<SessionEvent["type"]>(options.triggerOn ?? ["goal.complete"]);
	let inFlight = false;
	let rerunRequested = false;

	const runPass = (): void => {
		if (inFlight) {
			// Coalesce: a trigger during a pass schedules exactly one rerun afterward.
			rerunRequested = true;
			return;
		}
		inFlight = true;
		void (async () => {
			try {
				await options.analyze();
			} catch (error) {
				options.onError?.(error);
			} finally {
				inFlight = false;
				if (rerunRequested) {
					rerunRequested = false;
					runPass();
				}
			}
		})();
	};

	return options.eventBus.subscribe(event => {
		if (triggers.has(event.type)) runPass();
	});
}
