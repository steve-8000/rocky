import { describe, expect, test } from "bun:test";
import { templateFor } from "../../src/mission/core/lifecycle-template";
import { MISSION_INTENTS, type MissionIntent } from "../../src/mission/policy/intent";

describe("mission lifecycle templates", () => {
	const expected: Record<MissionIntent, Omit<ReturnType<typeof templateFor>, "intent">> = {
		conversation: {
			allowDirectTaskCompletion: true,
			requireDecisionRecord: false,
			requireRegressionContract: false,
			requireProposalBeforeMutation: false,
			requireVerification: false,
		},
		question_answering: {
			allowDirectTaskCompletion: true,
			requireDecisionRecord: false,
			requireRegressionContract: false,
			requireProposalBeforeMutation: false,
			requireVerification: false,
		},
		repo_exploration: {
			allowDirectTaskCompletion: true,
			requireDecisionRecord: false,
			requireRegressionContract: false,
			requireProposalBeforeMutation: false,
			requireVerification: false,
		},
		code_change: {
			allowDirectTaskCompletion: true,
			requireDecisionRecord: false,
			requireRegressionContract: false,
			requireProposalBeforeMutation: false,
			requireVerification: true,
		},
		architecture_change: {
			allowDirectTaskCompletion: false,
			requireDecisionRecord: true,
			requireRegressionContract: true,
			requireProposalBeforeMutation: true,
			requireVerification: true,
		},
		runtime_refactor: {
			allowDirectTaskCompletion: false,
			requireDecisionRecord: true,
			requireRegressionContract: true,
			requireProposalBeforeMutation: true,
			requireVerification: true,
		},
		release_hardening: {
			allowDirectTaskCompletion: false,
			requireDecisionRecord: true,
			requireRegressionContract: true,
			requireProposalBeforeMutation: true,
			requireVerification: true,
		},
		external_side_effect: {
			allowDirectTaskCompletion: false,
			requireDecisionRecord: true,
			requireRegressionContract: false,
			requireProposalBeforeMutation: true,
			requireVerification: true,
		},
	};

	for (const intent of MISSION_INTENTS) {
		test(`pins ${intent}`, () => {
			expect(templateFor(intent)).toEqual({ intent, ...expected[intent] });
		});
	}
});
