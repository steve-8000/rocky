import {
	MissionAcceptanceFailureError,
	MissionRuntimeImpl,
	type MissionRuntimeImplOptions,
	type MissionTokenAccountInput,
	type MissionTokenUsage,
	missionTokenDelta,
} from "./core/mission-runtime";
import { MissionEventBus } from "./event-bus";
import { MissionJsonlSink } from "./jsonl-sink";

// Re-export the canonical mission runtime implementation + error so consumers can
// reach them via the mission runtime barrel without deep-importing core/.
export {
	MissionAcceptanceFailureError,
	MissionRuntimeImpl,
	type MissionRuntimeImplOptions,
	type MissionTokenAccountInput,
	type MissionTokenUsage,
	missionTokenDelta,
};

type MissionRuntimeOptions = {
	baseDir?: string;
	batchSize?: number;
	flushIntervalMs?: number;
	maxBytes?: number;
	maxAgeMs?: number;
};

type MissionRuntime = {
	bus: MissionEventBus;
	sink: MissionJsonlSink;
};

let runtime: MissionRuntime | undefined;

export function initializeMissionRuntime(options: MissionRuntimeOptions = {}): MissionRuntime {
	if (runtime) return runtime;
	const bus = new MissionEventBus();
	const sink = new MissionJsonlSink(bus, options);
	runtime = { bus, sink };
	return runtime;
}

export function getMissionEventBus(): MissionEventBus | undefined {
	return runtime?.bus;
}

export async function closeMissionRuntime(): Promise<void> {
	const current = runtime;
	runtime = undefined;
	await current?.sink.close();
}
