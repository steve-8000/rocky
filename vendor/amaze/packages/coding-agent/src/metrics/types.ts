import type { SessionEvent } from "../observability";

export type SessionEventType = SessionEvent["type"];

export type MetricWindowOptions = {
	last?: number;
	since?: number;
};

export type MetricWindow = {
	total: number;
	start?: number;
	end?: number;
	last?: number;
	since?: number;
};

export type MetricFinalizeContext = {
	window: MetricWindow;
	sampleN: number;
};

export type MetricDefinition<State = any> = {
	name: string;
	eventTypes: SessionEventType[];
	initial: () => State;
	reducer: (state: State, event: SessionEvent) => State;
	finalize: (state: State, ctx: MetricFinalizeContext) => number | { value: number; meta?: unknown };
};

export type MetricResult = {
	name: string;
	value: number;
	window: MetricWindow;
	sampleN: number;
	meta?: unknown;
};
