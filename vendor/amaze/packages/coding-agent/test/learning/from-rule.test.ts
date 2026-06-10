import { describe, expect, test } from "bun:test";
import { ruleFindingToProposal } from "../../src/learning";
import type { RuleFinding } from "../../src/rules";

function finding(overrides: Partial<RuleFinding>): RuleFinding {
	return {
		ruleId: "unknown-rule",
		severity: "warning",
		count: 3,
		windowSize: 10,
		sampleEvents: [],
		message: "rule impact",
		...overrides,
	};
}

describe("ruleFindingToProposal", () => {
	test("maps force-complete-rate findings to human-required settings proposals", () => {
		const proposal = ruleFindingToProposal(
			finding({ ruleId: "force-complete-rate", count: 4, message: "too many forced completions" }),
			{ sessionId: "session-1" },
		);

		expect(proposal).toMatchObject({
			type: "settings",
			gate: "human-required",
			patch: { "goal.uncertainPolicy": "block-manual" },
			reason: "too many forced completions",
			rollback: { "goal.uncertainPolicy": "allow" },
			evidence: {
				sessionIds: ["session-1"],
				eventRefs: [],
				ruleFindings: ["force-complete-rate"],
				sampleN: 4,
			},
			provenance: { source: "rule", ruleId: "force-complete-rate" },
		});
	});

	test("maps memory-low-precision findings to review memory proposals", () => {
		const proposal = ruleFindingToProposal(finding({ ruleId: "memory-low-precision", count: 2 }), {
			sessionId: "session-2",
		});

		expect(proposal).toMatchObject({
			type: "memory",
			gate: "review",
			content: "Memory hit precision low; consider tightening recall scope.",
			memoryType: "note",
			confidence: "inferred",
			evidence: {
				sessionIds: ["session-2"],
				eventRefs: [],
				ruleFindings: ["memory-low-precision"],
				sampleN: 2,
			},
			provenance: { source: "rule", ruleId: "memory-low-precision" },
		});
	});

	test("maps unknown rule findings to review rule proposals", () => {
		const proposal = ruleFindingToProposal(finding({ ruleId: "new-rule-candidate", count: 1, message: "add rule" }), {
			sessionId: "session-3",
		});

		expect(proposal).toMatchObject({
			type: "rule",
			gate: "review",
			ruleMarkdown: "",
			replaySessions: ["session-3"],
			expectedImpact: "add rule",
			evidence: {
				sessionIds: ["session-3"],
				eventRefs: [],
				ruleFindings: ["new-rule-candidate"],
				sampleN: 1,
			},
			provenance: { source: "rule", ruleId: "new-rule-candidate" },
		});
	});

	test("omits optional session ids when no session is provided", () => {
		const proposal = ruleFindingToProposal(finding({ ruleId: "new-rule-candidate" }));

		expect(proposal?.evidence.sessionIds).toEqual([]);
		expect(proposal?.type === "rule" ? proposal.replaySessions : undefined).toEqual([]);
	});
});
