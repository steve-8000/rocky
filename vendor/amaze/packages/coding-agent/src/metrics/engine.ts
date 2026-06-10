import type { SessionEvent } from "../observability";
import type { MetricDefinition, MetricResult, MetricWindow, MetricWindowOptions, SessionEventType } from "./types";

const metrics = new Map<string, MetricDefinition>();

export function registerMetric(definition: MetricDefinition): void {
	if (!definition.name) {
		throw new Error("Metric definition requires a name");
	}
	metrics.set(definition.name, definition);
}

export function registeredMetrics(): MetricDefinition[] {
	return [...metrics.values()];
}

export function getMetricDefinition(name: string): MetricDefinition | undefined {
	return metrics.get(name);
}

export function computeMetric(
	name: string,
	events: SessionEvent[],
	opts: { window?: MetricWindowOptions } = {},
): MetricResult {
	const definition = metrics.get(name);
	if (!definition) {
		throw new Error(`Unknown metric: ${name}`);
	}

	const { selected, window } = applyWindow(events, opts.window);
	const eventTypes = new Set<SessionEventType>(definition.eventTypes);
	let state = definition.initial();
	let sampleN = 0;

	for (const event of selected) {
		if (!eventTypes.has(event.type)) {
			continue;
		}
		state = definition.reducer(state, event);
		sampleN += 1;
	}

	const finalized = definition.finalize(state, { window, sampleN });
	const value = typeof finalized === "number" ? finalized : finalized.value;
	const meta = typeof finalized === "number" ? undefined : finalized.meta;
	return meta === undefined ? { name, value, window, sampleN } : { name, value, window, sampleN, meta };
}

function applyWindow(
	events: SessionEvent[],
	opts?: MetricWindowOptions,
): { selected: SessionEvent[]; window: MetricWindow } {
	let selected = events;
	if (opts?.last !== undefined) {
		selected = selected.slice(-opts.last);
	}
	if (opts?.since !== undefined) {
		selected = selected.filter(event => event.ts >= opts.since!);
	}

	const timestamps = selected.map(event => event.ts);
	return {
		selected,
		window: {
			total: selected.length,
			start: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
			end: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
			last: opts?.last,
			since: opts?.since,
		},
	};
}
