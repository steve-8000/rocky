export type ProposalGate = "auto" | "review" | "human-required";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "rolled-back" | "expired";

export interface ProposalEvidence {
	sessionIds: string[];
	eventRefs: string[];
	ruleFindings?: string[];
	sampleN: number;
}

export interface ProposalProvenance {
	source: "rule" | "reflection" | "manual";
	ruleId?: string;
}

export interface RegressionCommand {
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
	expected?: number;
}

export interface SandboxReplayReport {
	ok: boolean;
	perCommand: Array<{
		argv: string[];
		exit: number | null;
		stdout: string;
		stderr: string;
		durationMs: number;
		timedOut: boolean;
	}>;
	revertedCleanly: boolean;
}

export interface EvalReport {
	passed: boolean;
	stage: "provenance" | "contradiction" | "replay" | "done";
	signals: Record<string, unknown>;
	durationMs: number;
	patchHash: string;
	sandbox?: SandboxReplayReport;
}

export interface ProposalBase {
	id: string;
	createdAt: number;
	status: ProposalStatus;
	gate: ProposalGate;
	evidence: ProposalEvidence;
	provenance: ProposalProvenance;
	expiresAt?: number;
	regressionCommands?: RegressionCommand[];
	lastEvalReport?: EvalReport;
}

export type MemoryLearningProposal = ProposalBase & {
	type: "memory";
	content: string;
	memoryType: string;
	confidence: "tool_verified" | "inferred" | "hypothesis";
};

export type SkillLearningProposal = ProposalBase & {
	type: "skill";
	name: string;
	sourceMemoryIds: string[];
	bodyMarkdown: string;
	evalCommand?: string;
};

export type RuleLearningProposal = ProposalBase & {
	type: "rule";
	ruleMarkdown: string;
	replaySessions: string[];
	expectedImpact: string;
};

export type SettingsLearningProposal = ProposalBase & {
	type: "settings";
	patch: Record<string, unknown>;
	reason: string;
	rollback: Record<string, unknown>;
};

export type LearningProposal =
	| MemoryLearningProposal
	| SkillLearningProposal
	| RuleLearningProposal
	| SettingsLearningProposal;

export type LearningProposalType = LearningProposal["type"];
