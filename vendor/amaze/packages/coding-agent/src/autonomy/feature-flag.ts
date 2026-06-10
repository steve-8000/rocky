import type { ObjectiveStore } from "./store";

export interface AutonomySettings {
	get(path: "autonomy.enabled"): boolean;
}

export interface AutonomyLoopOptions {
	settings: AutonomySettings;
	store: ObjectiveStore;
	tickMs?: number;
}

export interface AutonomyLoopHandle {
	stop(): void;
	readonly tickCount: number;
}

export function isAutonomyEnabled(settings: AutonomySettings): boolean {
	return settings.get("autonomy.enabled") === true;
}

export async function startAutonomyLoop(opts: AutonomyLoopOptions): Promise<AutonomyLoopHandle> {
	if (!isAutonomyEnabled(opts.settings)) {
		return {
			stop() {},
			get tickCount() {
				return 0;
			},
		};
	}

	let tickCount = 0;
	const interval = setInterval(() => {
		void opts.store;
		tickCount += 1;
	}, opts.tickMs ?? 60_000);

	return {
		stop() {
			clearInterval(interval);
		},
		get tickCount() {
			return tickCount;
		},
	};
}
