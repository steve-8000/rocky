export type EvoStage =
	| "objective"
	| "signal"
	| "proposal"
	| "eval"
	| "human-gate"
	| "applied"
	| "rolled-back"
	| "blocked";

export interface EvoMetricSignal {
	metric: string;
	current: number;
	target: number;
	direction: "up" | "down";
	mismatch: boolean;
}

export interface EvoTrace {
	objectiveId: string;
	stage: EvoStage;
	metricSignals: EvoMetricSignal[];
	proposalId?: string;
	proposalType?: "memory" | "skill" | "rule" | "settings";
	gate?: "auto" | "review" | "human-required";
	guardrailBlocks?: string[];
	evalPassed?: boolean;
	version?: string;
	nextActions: string[];
}
