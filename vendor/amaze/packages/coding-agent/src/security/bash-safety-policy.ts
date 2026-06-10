/**
 * Bash safety policy for runtime command gates.
 *
 * Shared by the bash tool, MCP stdio transport, and `!cmd` config resolver so
 * high-risk shell surfaces use one narrow, testable rule set.
 */

export type BashSafetyMode = "block" | "ask" | "off";
export type BashSafetySeverity = "low" | "medium" | "high" | "critical";

export interface BashSafetyRule {
	id: string;
	description: string;
	severity: BashSafetySeverity;
	pattern: RegExp;
}

export interface BashSafetyMatch {
	rule: BashSafetyRule;
	command: string;
	matched: string;
}

export interface BashSafetyDecision {
	allowed: boolean;
	mode: BashSafetyMode;
	matches: BashSafetyMatch[];
	reason?: string;
}

export interface BashSafetyPolicyOptions {
	enabled: boolean;
	mode: BashSafetyMode;
	allowPatterns: readonly string[];
	denyPatterns: readonly string[];
}

const SEVERITY_RANK: Record<BashSafetySeverity, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

export const BUILTIN_BASH_SAFETY_RULES: readonly BashSafetyRule[] = [
	{
		id: "AMZ-BASH-001",
		description: "rm -rf targets root or home",
		severity: "critical",
		// Matches recursive force deletion only when an argument is exactly a root/home anchor.
		// Relative project paths such as ./tmp/build and named dirs like node_modules are not path anchors.
		pattern:
			/(?:^|[;&|()\s])rm\s+(?=[^;&|\n]*-[A-Za-z]*r[A-Za-z]*)(?=[^;&|\n]*-[A-Za-z]*f[A-Za-z]*)(?:[^;&|\n]*\s)(?:--\s*)?(?:\/(?:\s|[;&|]|$)|~(?:\/[^\s;&|]*)?(?:\s|[;&|]|$)|\$HOME(?:\/[^\s;&|]*)?(?:\s|[;&|]|$)|\$\{HOME\}(?:\/[^\s;&|]*)?(?:\s|[;&|]|$)|(?:"\$HOME"|'\$HOME'|"~"|'~')(?:\/[^\s;&|]*)?(?:\s|[;&|]|$))/,
	},
	{
		id: "AMZ-BASH-002",
		description: "find -delete on broad scope",
		severity: "high",
		// Blocks find when any starting point before -delete is root/home/current-directory broad scope.
		// Scoped paths like ./src or /tmp/build do not match.
		pattern:
			/(?:^|[;&|()\s])find\s+(?=[^;&|\n]*\s-delete(?:\s|[;&|]|$))(?:(?:-[^\s;&|]+|\([^;&|\n]*\)|![^;&|\n]*|[^\s;&|]+)\s+)*(?:\/?|~|\$HOME|\$\{HOME\}|\.|"\/"|'\/'|"~"|'~'|"\."|'\.')(?:\s|[;&|]|$)/,
	},
	{
		id: "AMZ-BASH-003",
		description: "destructive git clean or reset",
		severity: "high",
		// Covers git clean flag groups containing f, d, and x anywhere, plus git reset --hard.
		// Safer clean variants missing one of f/d/x and soft/mixed resets are ignored.
		pattern:
			/(?:^|[;&|()\s])git\s+(?:clean\s+(?=[^;&|\n]*-[A-Za-z]*f)(?=[^;&|\n]*-[A-Za-z]*d)(?=[^;&|\n]*-[A-Za-z]*x)[^;&|\n]*|reset\s+--hard(?:\s|[;&|]|$))/,
	},
	{
		id: "AMZ-BASH-004",
		description: "network download piped to shell",
		severity: "critical",
		// Detects curl/wget output piped directly into a shell interpreter.
		// Requires an actual pipe, so downloads to files or piping to non-shell tools are allowed.
		pattern: /(?:^|[;&|()\s])(?:curl|wget)\b[^|\n]*\|\s*(?:env\s+)?(?:sh|bash|zsh|ksh|fish)\b/,
	},
	{
		id: "AMZ-BASH-005",
		description: "privilege escalation command",
		severity: "high",
		// Flags direct privilege escalation commands while avoiding substrings in words like pseudo.
		pattern: /(?:^|[;&|()\s])(?:sudo\b|doas\b|su\s+-)(?:\s|$)/,
	},
	{
		id: "AMZ-BASH-006",
		description: "recursive unsafe permission or ownership change",
		severity: "medium",
		// Blocks world writable/readable recursive chmod forms and all recursive chown forms.
		pattern:
			/(?:^|[;&|()\s])(?:chmod\s+(?=[^;&|\n]*-R)(?:[^;&|\n]*\s)?(?:777|666)(?:\s|[;&|]|$)|chown\s+(?=[^;&|\n]*-R)\S+)/,
	},
	{
		id: "AMZ-BASH-007",
		description: "dd writes directly to device",
		severity: "critical",
		// Requires dd and an of=/dev/... destination; reads from devices remain outside this rule.
		pattern: /(?:^|[;&|()\s])dd\b(?=[^;&|\n]*\bof=\/dev\/)[^;&|\n]*/,
	},
	{
		id: "AMZ-BASH-008",
		description: "broad force-kill command",
		severity: "high",
		// Blocks kill -9 -1 and pkill -9 -f with an explicit pattern, but not targeted kill -9 <pid>.
		pattern: /(?:^|[;&|()\s])(?:kill\s+-9\s+-1|pkill\s+(?=[^;&|\n]*-9)(?=[^;&|\n]*-f)\S+(?:\s+\S+)*)(?:\s|[;&|]|$)/,
	},
	{
		id: "AMZ-BASH-009",
		description: "environment or token exfiltration via network command",
		severity: "critical",
		// Network clients combined with sensitive env/home expansion in the same shell segment.
		pattern:
			/(?:^|[;&|()\s])(?:curl|wget|nc|scp|ssh)\b(?=[^;&|\n]*(?:\$GITHUB_TOKEN|\$OPENAI_API_KEY|\$ANTHROPIC_API_KEY|\$AWS_(?:SECRET|ACCESS)[A-Z_]*|\$HOME|\$\{HOME\}))[^;&|\n]*/,
	},
	{
		id: "AMZ-BASH-010",
		description: "private config read into network sink",
		severity: "high",
		// Requires a local read of private dirs piped to a network sink; plain inspection without a sink is allowed.
		pattern:
			/(?:^|[;&|()\s])(?:cat|head|read)\b[^|\n]*(?:~\/\.(?:ssh|aws|config)|\$HOME\/\.(?:ssh|aws|config)|\$\{HOME\}\/\.(?:ssh|aws|config))[^|\n]*\|\s*(?:curl|wget|nc)\b/,
	},
] as const;

export function checkBashSafety(command: string, options: BashSafetyPolicyOptions): BashSafetyDecision {
	if (!options.enabled || options.mode === "off") {
		return { allowed: true, mode: options.mode, matches: [] };
	}

	const rules = [...BUILTIN_BASH_SAFETY_RULES, ...compileUserDenyRules(options.denyPatterns)];
	const matches = collectMatches(command, rules);
	if (matches.length === 0) {
		return { allowed: true, mode: options.mode, matches };
	}

	if (matchesAnyAllowPattern(command, options.allowPatterns)) {
		return { allowed: true, mode: options.mode, matches };
	}

	const top = [...matches].sort((a, b) => SEVERITY_RANK[b.rule.severity] - SEVERITY_RANK[a.rule.severity])[0];
	const reason = `Command rejected by bash safety policy: ${top.rule.id} ${top.rule.description}`;

	// Ask mode intentionally logs/allows at callers until an interactive consent UI exists.
	return { allowed: options.mode !== "block", mode: options.mode, matches, reason };
}

function compileUserDenyRules(patterns: readonly string[]): BashSafetyRule[] {
	return patterns.flatMap((pattern, idx) => {
		try {
			return [
				{
					id: `USER-DENY-${idx}`,
					description: "user configured deny pattern",
					severity: "high" as const,
					pattern: new RegExp(pattern),
				},
			];
		} catch {
			return [];
		}
	});
}

function collectMatches(command: string, rules: readonly BashSafetyRule[]): BashSafetyMatch[] {
	const matches: BashSafetyMatch[] = [];
	for (const rule of rules) {
		const pattern = cloneWithoutGlobalState(rule.pattern);
		const match = pattern.exec(command);
		if (match) {
			matches.push({ rule, command, matched: match[0] });
		}
	}
	return matches;
}

function matchesAnyAllowPattern(command: string, patterns: readonly string[]): boolean {
	for (const pattern of patterns) {
		try {
			if (new RegExp(pattern).test(command)) return true;
		} catch {}
	}
	return false;
}

function cloneWithoutGlobalState(pattern: RegExp): RegExp {
	return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}
