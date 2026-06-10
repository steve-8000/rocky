import { afterEach, describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";
import { MissionPolicyGate } from "../../src/tools/gateway/mission-policy-gate";
import type { ToolDescriptor, ToolExecutionContext } from "../../src/tools/registry/tool-descriptor";

const stores: MissionStore[] = [];
const writeDescriptor = { name: "write" } as ToolDescriptor;

function createRuntime(
	autoApprove: boolean,
	autonomyProfile: "manual" | "balanced" | "autonomous" | "strict" = "balanced",
) {
	const store = new MissionStore(":memory:");
	stores.push(store);
	let activeMissionId: string | undefined;
	const runtime = new MissionControlRuntime({
		store,
		setActiveMissionId: id => {
			activeMissionId = id;
		},
		getActiveMissionId: () => activeMissionId,
		autoApproveProposals: () => autoApprove,
		autonomyProfile: () => autonomyProfile,
	});
	return { runtime, store };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const subagentCtx = { agentRole: "subagent" } as unknown as ToolExecutionContext;

describe("Mission Control auto-approve", () => {
	test("default (off): a runtime_refactor mission still needs a proposal and blocks subagent mutation", async () => {
		const { runtime } = createRuntime(false);
		await runtime.createMission({
			title: "Refactor runtime",
			objective: "Refactor the runtime",
			mode: "interactive",
			riskLevel: "high",
			intent: "runtime_refactor",
		});

		expect(runtime.activeMissionNeedsProposal()).toBe(true);
		const gate = new MissionPolicyGate({ missionControl: runtime });
		const decision = gate.check(writeDescriptor, subagentCtx, "HIGH");
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROPOSAL_REQUIRED");
	});

	test("autonomous profile: a runtime_refactor mission auto-attaches a proposal, clears the gate, and enters executing", async () => {
		const { runtime } = createRuntime(true, "autonomous");
		const mission = await runtime.createMission({
			title: "Refactor runtime",
			objective: "Refactor the runtime",
			mode: "interactive",
			riskLevel: "high",
			intent: "runtime_refactor",
		});

		// Proposal gate satisfied without a manual /mission approve.
		expect(runtime.activeMissionNeedsProposal()).toBe(false);
		expect(runtime.getActiveMission()?.proposalId).toBeTruthy();
		expect(runtime.getActiveMission()?.lifecycle).toBe("executing");

		const gate = new MissionPolicyGate({ missionControl: runtime });
		const decision = gate.check(writeDescriptor, subagentCtx, "HIGH");
		expect(decision.allowed).toBe(true);

		// Sanity: the mission id is stable and active.
		expect(runtime.getActiveMission()?.id).toBe(mission.id);
	});

	test("autonomous profile: an ambient-promoted proposal-gated mission is not auto-approved", async () => {
		const { runtime } = createRuntime(true, "autonomous");
		const mission = await runtime.promoteFromAmbient({
			triggeringTool: "write",
			objective: "Refactor the runtime through a mutation tool",
		});

		expect(runtime.activeMissionNeedsProposal()).toBe(true);
		expect(runtime.getActiveMission()?.proposalId).toBeUndefined();
		expect(runtime.getActiveMission()?.lifecycle).toBe("planning");

		const gate = new MissionPolicyGate({ missionControl: runtime });
		const decision = gate.check(writeDescriptor, subagentCtx, "HIGH");
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROPOSAL_REQUIRED");
		expect(runtime.getActiveMission()?.id).toBe(mission.id);
	});

	test("on: a non-proposal intent (code_change) is unaffected and executes directly", async () => {
		const { runtime } = createRuntime(true);
		await runtime.createMission({
			title: "Small change",
			objective: "Tweak a function",
			mode: "interactive",
			riskLevel: "low",
			intent: "code_change",
		});
		expect(runtime.activeMissionNeedsProposal()).toBe(false);
		expect(runtime.getActiveMission()?.lifecycle).toBe("executing");
	});
});
