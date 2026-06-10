export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	goalId?: string;
	goalObjective?: string;
	goalTokenBudget?: number | null;
	goalContractRevision?: number;
}

function parseGoalId(raw: Record<string, unknown>): string | undefined {
	if (typeof raw.goalId === "string") return raw.goalId;
	const goal = raw.goal;
	return goal && typeof goal === "object" && "id" in goal && typeof (goal as { id?: unknown }).id === "string"
		? (goal as { id: string }).id
		: undefined;
}

function parseGoalObjective(raw: Record<string, unknown>): string | undefined {
	if (typeof raw.goalObjective === "string") return raw.goalObjective;
	const goal = raw.goal;
	return goal &&
		typeof goal === "object" &&
		"objective" in goal &&
		typeof (goal as { objective?: unknown }).objective === "string"
		? (goal as { objective: string }).objective
		: undefined;
}

function parseGoalTokenBudgetValue(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
	return value;
}

function parseGoalTokenBudget(raw: Record<string, unknown>, goalId: string | undefined): number | null | undefined {
	const explicit = parseGoalTokenBudgetValue(raw.goalTokenBudget);
	if (explicit !== undefined) return explicit;
	const goal = raw.goal;
	const snapshot =
		goal && typeof goal === "object" && "tokenBudget" in goal
			? parseGoalTokenBudgetValue((goal as { tokenBudget?: unknown }).tokenBudget)
			: undefined;
	if (snapshot !== undefined) return snapshot;
	return goalId ? null : undefined;
}

function parseGoalContractRevision(raw: Record<string, unknown>, goalId: string | undefined): number | undefined {
	const explicit = raw.goalContractRevision;
	if (typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
	const goal = raw.goal;
	const snapshot =
		goal && typeof goal === "object" && "contractRevision" in goal
			? (goal as { contractRevision?: unknown }).contractRevision
			: undefined;
	if (typeof snapshot === "number" && Number.isSafeInteger(snapshot) && snapshot >= 0) return snapshot;
	return goalId ? 0 : undefined;
}

export function parsePlanModeState(
	modeData: Record<string, unknown> | undefined,
	options?: { enabled?: boolean; reentry?: boolean },
): PlanModeState | undefined {
	const raw = modeData;
	if (!raw) return undefined;
	const planFilePath = raw.planFilePath;
	if (typeof planFilePath !== "string" || planFilePath.trim().length === 0) return undefined;

	const workflow = raw.workflow;
	if (workflow !== undefined && workflow !== "parallel" && workflow !== "iterative") return undefined;

	const goalId = parseGoalId(raw);

	return {
		enabled: options?.enabled ?? true,
		planFilePath,
		workflow,
		reentry: options?.reentry,
		goalId,
		goalObjective: parseGoalObjective(raw),
		goalTokenBudget: parseGoalTokenBudget(raw, goalId),
		goalContractRevision: parseGoalContractRevision(raw, goalId),
	};
}
