import { describe, expect, mock, test } from "bun:test";
import type { LearningProposal } from "../../src/learning/types";
import type { SessionEvent } from "../../src/observability";

const provenanceGate = mock((): { passed: boolean; reason?: string } => ({ passed: true }));
const contradictionGate = mock((): { passed: boolean; reason?: string } => ({ passed: true }));
const replay = mock(
	async (sessionId: string, opts: { events?: SessionEvent[] }): Promise<ReturnType<typeof replayResult>> => ({
		sessionId,
		eventsReplayed: opts.events?.length ?? 0,
		decisions: { goalCompleteVerdict: "pass", subagentVerdicts: [] },
		networkCalls: 0,
	}),
);

mock.module("../../src/learning/eval/provenance", () => ({
	evaluateProvenanceGate: provenanceGate,
}));

mock.module("../../src/learning/eval/contradiction", () => ({
	evaluateContradictionGate: contradictionGate,
}));

mock.module("../../src/learning/eval/replay", () => ({
	replaySession: replay,
}));

const { evaluateProposal } = await import("../../src/learning/eval/pipeline");

describe("evaluateProposal", () => {
	test("stops at provenance failure", async () => {
		resetMocks();
		provenanceGate.mockReturnValueOnce({ passed: false, reason: "missing evidence" });

		const report = await evaluateProposal(memoryProposal(), { replaySessions: ["session-1"] });

		expect(report.passed).toBe(false);
		expect(report.stage).toBe("provenance");
		expect(provenanceGate).toHaveBeenCalledTimes(1);
		expect(contradictionGate).not.toHaveBeenCalled();
		expect(replay).not.toHaveBeenCalled();
	});

	test("stops at contradiction failure after provenance passes", async () => {
		resetMocks();
		contradictionGate.mockReturnValueOnce({ passed: false, reason: "conflict" });

		const report = await evaluateProposal(memoryProposal(), { replaySessions: ["session-1"] });

		expect(report.passed).toBe(false);
		expect(report.stage).toBe("contradiction");
		expect(provenanceGate).toHaveBeenCalledTimes(1);
		expect(contradictionGate).toHaveBeenCalledTimes(1);
		expect(replay).not.toHaveBeenCalled();
	});

	test("passes when every stage passes", async () => {
		resetMocks();
		replay.mockResolvedValueOnce(replayResult("session-1", "pass"));
		replay.mockResolvedValueOnce(replayResult("session-2", "pass"));

		const report = await evaluateProposal(memoryProposal(), {
			baselinePassRate: 1,
			replaySessions: ["session-1", "session-2"],
			recentEvents: [goalComplete("session-1", "pass"), goalComplete("session-2", "pass")],
		});

		expect(report.passed).toBe(true);
		expect(report.stage).toBe("done");
		expect(replay).toHaveBeenCalledTimes(2);
		expect(report.signals.replay).toMatchObject({ baselinePassRate: 1, passRate: 1 });
	});

	test("returns deterministic reports for identical input except durationMs", async () => {
		resetMocks();
		replay.mockResolvedValue(replayResult("session-1", "pass"));
		const ctx = { baselinePassRate: 1, replaySessions: ["session-1"], now: 10 };

		const first = await evaluateProposal(memoryProposal(), ctx);
		const second = await evaluateProposal(memoryProposal(), ctx);
		const { durationMs: _firstDuration, ...firstComparable } = first;
		const { durationMs: _secondDuration, ...secondComparable } = second;

		expect(firstComparable).toEqual(secondComparable);
	});
});

function resetMocks() {
	provenanceGate.mockReset();
	provenanceGate.mockReturnValue({ passed: true });
	contradictionGate.mockReset();
	contradictionGate.mockReturnValue({ passed: true });
	replay.mockReset();
	replay.mockResolvedValue(replayResult("session-1", "pass"));
}

function replayResult(
	sessionId: string,
	verdict: "pass" | "fail" | "force" | null,
): {
	sessionId: string;
	eventsReplayed: number;
	decisions: { goalCompleteVerdict: "pass" | "fail" | "force" | null; subagentVerdicts: never[] };
	networkCalls: number;
} {
	return {
		sessionId,
		eventsReplayed: 1,
		decisions: { goalCompleteVerdict: verdict, subagentVerdicts: [] },
		networkCalls: 0,
	};
}

function goalComplete(sessionId: string, verdict: "pass" | "fail" | "force"): SessionEvent {
	return { type: "goal.complete", sessionId, ts: 1, goalId: "goal-1", verdict, failedCount: 0, uncertainCount: 0 };
}

function memoryProposal(): LearningProposal {
	return {
		id: "proposal-1",
		createdAt: 1,
		status: "approved",
		gate: "auto",
		evidence: { sessionIds: ["session-1", "session-2"], eventRefs: ["events.jsonl:1"], sampleN: 3 },
		provenance: { source: "rule", ruleId: "rule-1" },
		type: "memory",
		content: "Always prefer deterministic eval reports.",
		memoryType: "operational",
		confidence: "inferred",
	};
}
