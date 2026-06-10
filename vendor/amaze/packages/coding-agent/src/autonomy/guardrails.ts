import type { ObjectiveGuardrails } from "./types";

export const AMAZE_SETTINGS_PATH = ".amaze/settings.json";

export const DEFAULT_AUTONOMY_FORBIDDEN_SCOPES = [
	".git/**",
	AMAZE_SETTINGS_PATH,
	"AGENTS.md",
	"packages/coding-agent/src/learning/**",
] as const;

export function normalizeObjectiveGuardrails(input: Partial<ObjectiveGuardrails> = {}): ObjectiveGuardrails {
	return {
		requireHumanForApply: input.requireHumanForApply ?? true,
		maxAutoSubgoalsPerDay: input.maxAutoSubgoalsPerDay ?? 1,
		forbiddenScopes: [...new Set([...DEFAULT_AUTONOMY_FORBIDDEN_SCOPES, ...(input.forbiddenScopes ?? [])])],
	};
}
