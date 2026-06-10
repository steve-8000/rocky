import { describe, expect, test } from "bun:test";
import { evaluateContradictionGate } from "../../src/learning/eval";
import type { LearningProposal } from "../../src/learning/types";

describe("evaluateContradictionGate", () => {
	test("fails memory proposals that lexically contradict existing memory", () => {
		const result = evaluateContradictionGate(memoryProposal({ content: "Always use wide integration tests." }), {
			existingMemoryContent: ["Never use wide integration tests."],
		});

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("contradicts");
	});

	test("passes memory proposals without contradiction signal", () => {
		const result = evaluateContradictionGate(memoryProposal({ content: "Prefer narrow regression tests." }), {
			existingMemoryContent: ["Use snapshots only when output is intentionally broad."],
		});

		expect(result).toEqual({ passed: true });
	});

	test("fails skill proposals when the name collides", () => {
		const result = evaluateContradictionGate(skillProposal({ name: "debug-checklist" }), {
			existingSkill: { name: "debug-checklist", bodyMarkdown: "# Existing\n" },
		});

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("debug-checklist");
	});

	test("fails settings proposals without rollback", () => {
		const proposal = settingsProposal() as LearningProposal & { rollback?: Record<string, unknown> };
		delete proposal.rollback;

		const result = evaluateContradictionGate(proposal);

		expect(result.passed).toBe(false);
		expect(result.reason).toContain("rollback");
	});
});

function baseProposal(): Omit<LearningProposal, "type"> {
	return {
		id: "proposal-1",
		createdAt: 1,
		status: "pending",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1 },
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

function settingsProposal(overrides: Partial<Extract<LearningProposal, { type: "settings" }>> = {}): LearningProposal {
	return {
		...baseProposal(),
		type: "settings",
		patch: { "goal.uncertainPolicy": "ask" },
		reason: "Need deterministic policy.",
		rollback: { "goal.uncertainPolicy": "default" },
		...overrides,
	};
}
