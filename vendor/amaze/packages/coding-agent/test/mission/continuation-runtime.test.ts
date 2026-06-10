import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { MissionContinuationRuntime } from "../../src/mission/continuation/runtime";
import { MISSION_CONTINUATION_MESSAGE_TYPE } from "../../src/mission/continuation/types";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];

interface SentContinuation {
	content: string;
	details: { missionId: string; generation: number };
}

function harness(
	opts: {
		allowsAgentInitiatedTurns?: boolean;
		settings?: Settings;
		autoApprove?: boolean;
		autonomyProfile?: "manual" | "balanced" | "autonomous" | "strict";
	} = {},
) {
	const store = new MissionStore(":memory:");
	stores.push(store);
	let activeMissionId: string | undefined;
	const missionControl = new MissionControlRuntime({
		store,
		setActiveMissionId: id => {
			activeMissionId = id;
		},
		getActiveMissionId: () => activeMissionId,
		autoApproveProposals: () => opts.autoApprove ?? false,
		autonomyProfile: () => opts.autonomyProfile ?? "balanced",
	});
	let pending = false;
	const sent: SentContinuation[] = [];
	const runtime = new MissionContinuationRuntime({
		missionControl,
		store,
		settings: opts.settings ?? Settings.isolated({ "mission.continuation.enabled": true }),
		host: {
			hasPendingUserMessage: () => pending,
			allowsAgentInitiatedTurns: () => opts.allowsAgentInitiatedTurns ?? true,
			owner: () => ({ sessionId: "s1", ownerBranch: null, ownerTreeId: null }),
			sendContinuation: async msg => {
				sent.push(msg);
			},
		},
	});
	return {
		store,
		missionControl,
		runtime,
		sent,
		setPending: (v: boolean) => {
			pending = v;
		},
		setActive: (id: string | undefined) => {
			activeMissionId = id;
		},
	};
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("MissionContinuationRuntime", () => {
	test("schedules exactly one hidden nextTurn for an incomplete code_change mission", async () => {
		const h = harness();
		const mission = await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});

		await h.runtime.afterAgentEnd();

		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.details.missionId).toBe(mission.id);
		expect(h.sent[0]?.details.generation).toBe(1);
		const rec = h.store.getContinuation(mission.id);
		expect(rec?.status).toBe("scheduled");
		expect(rec?.generation).toBe(1);
	});

	test("does not schedule when a user message is pending", async () => {
		const h = harness();
		await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});
		h.setPending(true);

		await h.runtime.afterAgentEnd();

		expect(h.sent).toHaveLength(0);
	});

	test("does not schedule when the host disallows agent-initiated turns", async () => {
		const h = harness({ allowsAgentInitiatedTurns: false });
		await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});

		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);
	});

	test("does not schedule a runtime_refactor mission that still needs a proposal", async () => {
		const h = harness();
		await h.missionControl.createMission({
			title: "Refactor runtime",
			objective: "Refactor the runtime",
			mode: "interactive",
			riskLevel: "high",
			intent: "runtime_refactor",
		});
		// runtime_refactor requires a proposal before mutation; continuation must hold.
		expect(h.missionControl.activeMissionNeedsProposal()).toBe(true);

		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);
		expect(h.store.getContinuation(h.missionControl.getActiveMission()!.id)?.status).toBe("idle");
	});

	test("a completed mission observes terminal and never schedules", async () => {
		const h = harness();
		const mission = await h.missionControl.createMission({
			title: "Quick task",
			objective: "Answer a question",
			mode: "interactive",
			riskLevel: "low",
			intent: "code_change",
		});
		// Ledger row exists (a prior continuation scheduled it).
		h.store.ensureContinuation(mission.id, { sessionId: "s1" });
		h.missionControl.recordActiveVerification({ status: "pass", verdict: "pass", summary: "verified" });
		const completed = await h.missionControl.completeActiveMission({ status: "success", summary: "done" });
		expect(completed?.review).toBeUndefined();
		// Session wires observeTerminal into the mission-updated terminal hook.
		h.runtime.observeTerminal(completed!);

		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);
		expect(h.store.getContinuation(mission.id)?.status).toBe("completed");
	});

	test("pause holds and resume re-enables scheduling", async () => {
		const h = harness();
		await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});

		h.runtime.pause();
		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);

		h.runtime.resume();
		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(1);
	});

	test("disabled setting suppresses scheduling entirely", async () => {
		const h = harness({ settings: Settings.isolated({ "mission.continuation.enabled": false }) });
		await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});
		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);
	});

	test("sent continuation carries the mission-continuation envelope content", async () => {
		const h = harness();
		await h.missionControl.createMission({
			title: "Ship X",
			objective: "Ship feature X with a unique marker",
			mode: "interactive",
			riskLevel: "medium",
			intent: "code_change",
		});
		await h.runtime.afterAgentEnd();
		expect(h.sent[0]?.content).toContain("Mission Control continuation");
		expect(h.sent[0]?.content).toContain("Ship feature X with a unique marker");
		expect(MISSION_CONTINUATION_MESSAGE_TYPE).toBe("mission-continuation");
	});

	test("auto-approve: an explicitly created proposal-gated runtime_refactor mission schedules a continuation turn", async () => {
		const h = harness({ autoApprove: true, autonomyProfile: "autonomous" });
		await h.missionControl.createMission({
			title: "Refactor runtime",
			objective: "Refactor the runtime end to end",
			mode: "interactive",
			riskLevel: "high",
			intent: "runtime_refactor",
		});
		// Explicit mission creation can clear the proposal gate in autonomous mode.
		expect(h.missionControl.activeMissionNeedsProposal()).toBe(false);

		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.content).toContain("Refactor the runtime end to end");
	});

	test("auto-approve: an ambient-promoted proposal-gated runtime_refactor mission does not schedule", async () => {
		const h = harness({ autoApprove: true });
		await h.missionControl.promoteFromAmbient({
			triggeringTool: "write",
			objective: "Refactor the runtime end to end",
		});
		// Ambient promotion must preserve the proposal gate even when auto-approve is enabled.
		expect(h.missionControl.activeMissionNeedsProposal()).toBe(true);

		await h.runtime.afterAgentEnd();
		expect(h.sent).toHaveLength(0);
		expect(h.store.getContinuation(h.missionControl.getActiveMission()!.id)?.status).toBe("idle");
	});
});
