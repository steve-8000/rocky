export const MISSION_INTENTS = [
	"conversation",
	"question_answering",
	"repo_exploration",
	"code_change",
	"architecture_change",
	"runtime_refactor",
	"release_hardening",
	"external_side_effect",
] as const;
export type MissionIntent = (typeof MISSION_INTENTS)[number];

/**
 * Intents that trigger ambient mission promotion.
 */
export const MISSION_INTENT_REQUIRES_MISSION: ReadonlySet<MissionIntent> = new Set([
	"code_change",
	"architecture_change",
	"runtime_refactor",
	"release_hardening",
	"external_side_effect",
]);

const DESTRUCTIVE_ARCHITECTURE_SIGNALS =
	/\b(rebrand(ing)?|rename\b(?:\s+\S+){0,5}\s+(?:packages?|workspaces?|monorepos?|modules?|scopes?)|quarantine|wipe (the )?(runtime|state|memory|disk|data|dir|directory|home)|clean cutover|cross-cutting|package rename|(?:package|workspace|monorepo|module) rename)\b|리브랜딩|격리|와이프|재구축|전면 (재구축|개편)|통째로 갈|이름 바꾸기|패키지 (이름 바꾸|리네임)/;

export function inferIntent(input: { objective: string; mode?: string }): MissionIntent {
	const objective = input.objective.toLowerCase();

	if (/\b(ssh|deploy|push to (prod|production)|rollout)\b|배포/.test(objective)) return "external_side_effect";
	if (/\b(release|stabiliz|harden(ing)?|production[-\s]ready)\b|안정화/.test(objective)) {
		return "release_hardening";
	}
	if (DESTRUCTIVE_ARCHITECTURE_SIGNALS.test(objective)) return "architecture_change";
	if (/\b(architecture|architect)\b|구조|아키텍처/.test(objective)) return "architecture_change";
	if (/\b(refactor|runtime)\b|리팩터|리팩토|런타임/.test(objective)) return "runtime_refactor";
	if (/\b(fix|bug|add|implement|feature)\b|수정|고쳐|추가|구현/.test(objective)) return "code_change";
	if (/\b(look at|inspect|review)\b|어떻게|이 구조/.test(objective)) return "repo_exploration";
	if (/^\s*(what|why|how)\b/.test(objective) || /^\s*(왜|뭐|어떻게)/.test(objective)) {
		return "question_answering";
	}

	return "conversation";
}
