export type ObjectiveStatus = "active" | "paused" | "completed" | "cancelled";

export interface ObjectiveMetricTarget {
	metric: string;
	target: number;
	direction: "down" | "up";
	deadline?: number;
}

export interface ObjectiveBudget {
	tokens?: number;
	usd?: number;
	wallClockMs?: number;
}

export interface ObjectiveGuardrails {
	requireHumanForApply: boolean;
	maxAutoSubgoalsPerDay: number;
	forbiddenScopes: string[];
}

export interface Objective {
	id: string;
	title: string;
	metricTargets: ObjectiveMetricTarget[];
	budget: ObjectiveBudget;
	guardrails: ObjectiveGuardrails;
	status: ObjectiveStatus;
}

export interface ObjectiveEvent {
	objectiveId: string;
	ts: number;
	kind: string;
	payload: Record<string, unknown>;
}

export type NewObjective = Omit<Objective, "id" | "status" | "guardrails"> & {
	id?: string;
	status?: ObjectiveStatus;
	guardrails?: Partial<ObjectiveGuardrails>;
};
