import { describe, expect, test } from "bun:test";
import { evaluateProvenanceGate } from "../../src/learning/eval";
import type { LearningProposal } from "../../src/learning/types";

describe("evaluateProvenanceGate", () => {
	test("passes tool_verified memory with at least one sample", () => {
		expect(
			evaluateProvenanceGate(memoryProposal({ confidence: "tool_verified", evidence: evidence({ sampleN: 1 }) })),
		).toEqual({
			passed: true,
		});
	});

	test("fails inferred memory when sampleN is too low", () => {
		const result = evaluateProvenanceGate(
			memoryProposal({ confidence: "inferred", evidence: evidence({ sampleN: 2, sessionIds: ["s1", "s2"] }) }),
		);

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("sampleN >= 3");
	});

	test("passes inferred memory with sampleN three and at least two distinct sessions", () => {
		const result = evaluateProvenanceGate(
			memoryProposal({ confidence: "inferred", evidence: evidence({ sampleN: 3, sessionIds: ["s1", "s2", "s2"] }) }),
		);

		expect(result).toEqual({ passed: true });
	});

	test("fails hypothesis memory", () => {
		const result = evaluateProvenanceGate(
			memoryProposal({ confidence: "hypothesis", evidence: evidence({ sampleN: 10 }) }),
		);

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("hypothesis");
	});

	test("fails skill proposals with fewer than two source memory ids", () => {
		const result = evaluateProvenanceGate(skillProposal({ sourceMemoryIds: ["mem-1"] }));

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("2 source memory ids");
	});

	test("fails rule proposals with fewer than five replay sessions", () => {
		const result = evaluateProvenanceGate(ruleProposal({ replaySessions: ["s1", "s2", "s3", "s4"] }));

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("5 replay sessions");
	});
});

function evidence(overrides: Partial<LearningProposal["evidence"]> = {}): LearningProposal["evidence"] {
	return { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1, ...overrides };
}

function baseProposal(): Omit<LearningProposal, "type"> {
	return {
		id: "proposal-1",
		createdAt: 1,
		status: "pending",
		gate: "review",
		evidence: evidence(),
		provenance: { source: "manual" },
	} as Omit<LearningProposal, "type">;
}

function memoryProposal(overrides: Partial<Extract<LearningProposal, { type: "memory" }>> = {}): LearningProposal {
	return {
		...baseProposal(),
		type: "memory",
		content: "Prefer narrow tests.",
		memoryType: "project",
		confidence: "tool_verified",
		...overrides,
	};
}

function skillProposal(overrides: Partial<Extract<LearningProposal, { type: "skill" }>> = {}): LearningProposal {
	return {
		...baseProposal(),
		type: "skill",
		name: "skill-name",
		sourceMemoryIds: ["mem-1", "mem-2"],
		bodyMarkdown: "# Skill\n",
		...overrides,
	};
}

function ruleProposal(overrides: Partial<Extract<LearningProposal, { type: "rule" }>> = {}): LearningProposal {
	return {
		...baseProposal(),
		type: "rule",
		ruleMarkdown: "---\nid: sample.rule\n---\nwhen true then report\n",
		replaySessions: ["s1", "s2", "s3", "s4", "s5"],
		expectedImpact: "Reduce regressions.",
		...overrides,
	};
}
