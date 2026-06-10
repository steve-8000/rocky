import type { MissionIntent } from "../policy/intent";

export interface MissionLifecycleTemplate {
	intent: MissionIntent;
	allowDirectTaskCompletion: boolean;
	requireDecisionRecord: boolean;
	requireRegressionContract: boolean;
	requireProposalBeforeMutation: boolean;
	requireVerification: boolean;
	requireReview?: boolean;
}

export const LIFECYCLE_TEMPLATES: Record<MissionIntent, MissionLifecycleTemplate> = {
	conversation: {
		intent: "conversation",
		allowDirectTaskCompletion: true,
		requireDecisionRecord: false,
		requireRegressionContract: false,
		requireProposalBeforeMutation: false,
		requireVerification: false,
		requireReview: false,
	},
	question_answering: {
		intent: "question_answering",
		allowDirectTaskCompletion: true,
		requireDecisionRecord: false,
		requireRegressionContract: false,
		requireProposalBeforeMutation: false,
		requireVerification: false,
		requireReview: false,
	},
	repo_exploration: {
		intent: "repo_exploration",
		allowDirectTaskCompletion: true,
		requireDecisionRecord: false,
		requireRegressionContract: false,
		requireProposalBeforeMutation: false,
		requireVerification: false,
		requireReview: false,
	},
	code_change: {
		intent: "code_change",
		allowDirectTaskCompletion: true,
		requireDecisionRecord: false,
		requireRegressionContract: false,
		requireProposalBeforeMutation: false,
		requireVerification: true,
		requireReview: true,
	},
	architecture_change: {
		intent: "architecture_change",
		allowDirectTaskCompletion: false,
		requireDecisionRecord: true,
		requireRegressionContract: true,
		requireProposalBeforeMutation: true,
		requireVerification: true,
		requireReview: true,
	},
	runtime_refactor: {
		intent: "runtime_refactor",
		allowDirectTaskCompletion: false,
		requireDecisionRecord: true,
		requireRegressionContract: true,
		requireProposalBeforeMutation: true,
		requireVerification: true,
		requireReview: true,
	},
	release_hardening: {
		intent: "release_hardening",
		allowDirectTaskCompletion: false,
		requireDecisionRecord: true,
		requireRegressionContract: true,
		requireProposalBeforeMutation: true,
		requireVerification: true,
		requireReview: true,
	},
	external_side_effect: {
		intent: "external_side_effect",
		allowDirectTaskCompletion: false,
		requireDecisionRecord: true,
		requireRegressionContract: false,
		requireProposalBeforeMutation: true,
		requireVerification: true,
		requireReview: false,
	},
};

export function templateFor(intent: MissionIntent): MissionLifecycleTemplate {
	return LIFECYCLE_TEMPLATES[intent];
}
