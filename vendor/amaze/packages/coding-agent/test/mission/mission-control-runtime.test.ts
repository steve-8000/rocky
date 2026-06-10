import { afterEach, describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";
import { MissionPolicyGate } from "../../src/tools/gateway/mission-policy-gate";
import type { ToolDescriptor } from "../../src/tools/registry/tool-descriptor";

const writeDescriptor = { name: "write" } as ToolDescriptor;

const stores: MissionStore[] = [];

function createRuntime() {
	const store = new MissionStore(":memory:");
	stores.push(store);
	let activeMissionId: string | undefined;
	const setCalls: Array<string | undefined> = [];
	const runtime = new MissionControlRuntime({
		store,
		setActiveMissionId: id => {
			activeMissionId = id;
			setCalls.push(id);
		},
		getActiveMissionId: () => activeMissionId,
	});
	return {
		runtime,
		store,
		setCalls,
		get activeMissionId() {
			return activeMissionId;
		},
	};
}

describe("MissionControlRuntime", () => {
	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
	});

	test("does not create a mission for ambient conversation", async () => {
		const { runtime, store, setCalls } = createRuntime();

		const result = await runtime.ensureActiveMission({ content: "안녕" });

		expect(result).toEqual({ missionId: undefined, intent: "conversation", created: false });
		expect(store.listMissions()).toHaveLength(0);
		expect(setCalls).toEqual([]);
	});

	test("does not create a mission for ambient questions", async () => {
		const { runtime, store, setCalls } = createRuntime();

		const result = await runtime.ensureActiveMission({ content: "what does the auth module do?" });

		expect(result).toEqual({ missionId: undefined, intent: "question_answering", created: false });
		expect(store.listMissions()).toHaveLength(0);
		expect(setCalls).toEqual([]);
	});

	test("creates and activates a mission for a runtime_refactor intent", async () => {
		const { runtime, store, setCalls } = createRuntime();

		const result = await runtime.ensureActiveMission({ content: "런타임을 리팩터하자" });

		expect(result.created).toBe(true);
		expect(result.intent).toBe("runtime_refactor");
		expect(result.missionId).toBeDefined();
		expect(runtime.getActiveMission()?.id).toBe(result.missionId);
		expect(store.getMission(result.missionId!)).toBeDefined();
		expect(setCalls).toEqual([result.missionId]);
	});

	test("returns an existing active mission unchanged", async () => {
		const { runtime } = createRuntime();
		const first = await runtime.ensureActiveMission({ content: "런타임을 리팩터하자" });

		const second = await runtime.ensureActiveMission({ content: "런타임을 다시 손보자" });

		expect(second).toEqual({ missionId: first.missionId, intent: "runtime_refactor", created: false });
	});

	test("creates a new mission after clearing the active mission", async () => {
		const { runtime } = createRuntime();
		const first = await runtime.ensureActiveMission({ content: "런타임을 리팩터하자" });

		runtime.clearActiveMission();
		const second = await runtime.ensureActiveMission({ content: "런타임을 또 리팩터하자" });

		expect(second.created).toBe(true);
		expect(second.missionId).toBeDefined();
		expect(second.missionId).not.toBe(first.missionId);
	});

	test("caps mission objective at 240 characters", async () => {
		const { runtime } = createRuntime();
		const input = `런타임 리팩터 ${"x".repeat(496)}`;

		const result = await runtime.ensureActiveMission({ content: input });

		expect(runtime.getActiveMission()?.objective).toHaveLength(240);
		expect(result.created).toBe(true);
	});

	test("a code_change mission created explicitly needs no proposal and enters executing", async () => {
		const { runtime } = createRuntime();
		// code_change intent no longer triggers ambient promotion (conservative policy, P6.7);
		// explicit createMission still works the same way.
		const mission = await runtime.createMission({
			title: "Fix the bug",
			objective: "fix the bug",
			mode: "interactive",
			intent: "code_change",
		});

		expect(runtime.activeMissionNeedsProposal()).toBe(false);
		expect(mission.lifecycle).toBe("executing");
	});

	test("an architecture_change mission needs a proposal and waits in planning", async () => {
		const { runtime, store } = createRuntime();
		const result = await runtime.ensureActiveMission({ content: "아키텍처를 재설계하자" });

		expect(result.intent).toBe("architecture_change");
		expect(runtime.activeMissionNeedsProposal()).toBe(true);
		const mission = runtime.getActiveMission()!;
		expect(mission.lifecycle).toBe("planning");
		expect(mission.proposalId).toBeUndefined();
		// Persisted so the gate behaves identically after a restart.
		expect(store.getMission(mission.id)?.intent).toBe("architecture_change");
		expect(store.getMission(mission.id)?.lifecycle).toBe("planning");
	});

	test("approving the active proposal unblocks mutations and persists", async () => {
		const { runtime, store } = createRuntime();
		await runtime.ensureActiveMission({ content: "아키텍처를 재설계하자" });
		const missionId = runtime.getActiveMission()!.id;

		const gate = new MissionPolicyGate({ missionControl: runtime });
		// Before approval: subagent mutation tool is denied; orchestrator bypasses the gate
		// (which is why this assertion explicitly carries agentRole: "subagent").
		expect(gate.check(writeDescriptor, { agentRole: "subagent" }, "HIGH")).toMatchObject({
			allowed: false,
			code: "PROPOSAL_REQUIRED",
		});

		const approved = runtime.approveActiveProposal({ planRef: "local://PLAN.md" });
		expect(approved?.proposalId).toBeDefined();

		// After approval: same tool call is permitted, and the proposal pointer is durable.
		expect(gate.check(writeDescriptor, { agentRole: "subagent" }, "HIGH")).toEqual({ allowed: true });
		expect(runtime.activeMissionNeedsProposal()).toBe(false);
		expect(runtime.getActiveMission()?.lifecycle).toBe("executing");
		expect(store.getMission(missionId)?.proposalId).toBe(approved!.proposalId!);
	});

	test("proposal state survives a fresh runtime over the same store (hydrate)", async () => {
		const { runtime, store } = createRuntime();
		await runtime.ensureActiveMission({ content: "런타임을 리팩터하자" });
		const missionId = runtime.getActiveMission()!.id;
		runtime.approveActiveProposal();

		// Simulate a restart: a new control runtime over the same store, same active id.
		let activeId: string | undefined = missionId;
		const revived = new MissionControlRuntime({
			store,
			setActiveMissionId: id => {
				activeId = id;
			},
			getActiveMissionId: () => activeId,
		});
		const mission = revived.getActiveMission();
		expect(mission?.intent).toBe("runtime_refactor");
		expect(mission?.proposalId).toBeDefined();
		expect(revived.activeMissionNeedsProposal()).toBe(false);
	});
});
