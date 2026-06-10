import { afterEach, describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";
import { handleMissionWriteVerb } from "../../src/slash-commands/helpers/mission-command";

const stores: MissionStore[] = [];

function fixture() {
	const store = new MissionStore(":memory:");
	stores.push(store);
	let activeId: string | undefined;
	const control = new MissionControlRuntime({
		store,
		getActiveMissionId: () => activeId,
		setActiveMissionId: id => {
			activeId = id;
		},
	});
	return { store, control, getActiveId: () => activeId };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("P3 /mission write surface", () => {
	test("createMission sets the active mission and drives initial lifecycle", async () => {
		const { control, getActiveId } = fixture();
		const mission = await control.createMission({
			title: "Test mission",
			objective: "Investigate the auth bug",
			mode: "interactive",
			intent: "code_change",
		});
		expect(mission.id).toBeString();
		expect(mission.lifecycle).toBe("executing"); // code_change has no proposal gate
		expect(getActiveId()).toBe(mission.id);
	});

	test("createMission with proposal-required intent lands in planning", async () => {
		const { control } = fixture();
		const mission = await control.createMission({
			title: "Refactor mission",
			objective: "Restructure the kernel",
			mode: "interactive",
			intent: "architecture_change",
		});
		expect(mission.lifecycle).toBe("planning");
	});

	test("cancelActiveMission marks cancelled and clears the active pointer", async () => {
		const { control, getActiveId } = fixture();
		const mission = await control.createMission({
			title: "Cancellable",
			objective: "Will be cancelled",
			mode: "interactive",
		});
		const cancelled = await control.cancelActiveMission("operator changed mind");
		expect(cancelled?.id).toBe(mission.id);
		expect(cancelled?.lifecycle).toBe("cancelled");
		expect(getActiveId()).toBeUndefined();
	});

	test("completeActiveMission requires unmet acceptance criteria to be satisfied", async () => {
		const { control, store } = fixture();
		const mission = await control.createMission({
			title: "Completable",
			objective: "Finish work",
			mode: "interactive",
			acceptanceCriteria: [
				{ id: "c1", description: "tests pass", satisfied: false, verificationMethod: "bun test" },
			],
		});
		// Persist criteria so any future hydrate sees them, though in-memory runtime keeps them too.
		store.saveAcceptanceCriteria(mission.id, [
			{ id: "c1", description: "tests pass", satisfied: false, verificationMethod: "bun test" },
		]);
		await expect(control.completeActiveMission({ status: "success", summary: "done" })).rejects.toThrow(
			/cannot complete|acceptance/i,
		);
	});

	test("completeActiveMission closes when criteria are satisfied", async () => {
		const { control, getActiveId } = fixture();
		const mission = await control.createMission({
			title: "Completable",
			objective: "Finish work",
			mode: "interactive",
			acceptanceCriteria: [{ id: "c1", description: "tests pass", satisfied: true }],
		});
		const done = await control.completeActiveMission({ status: "success", summary: "ok" });
		expect(done?.id).toBe(mission.id);
		expect(done?.lifecycle).toBe("completed");
		expect(getActiveId()).toBeUndefined();
	});

	test("handleMissionWriteVerb create routes through MissionControlRuntime", async () => {
		const { control, getActiveId } = fixture();
		const out = await handleMissionWriteVerb("create", "create Verify the cluster", control);
		expect(out).toMatch(/^Created mission /);
		expect(getActiveId()).toBeString();
	});

	test("handleMissionWriteVerb cancel reports no-op when nothing active", async () => {
		const { control } = fixture();
		const out = await handleMissionWriteVerb("cancel", "cancel --reason testing", control);
		expect(out).toBe("No active mission to cancel.");
	});

	test("handleMissionWriteVerb without missionControl reports session requirement", async () => {
		const out = await handleMissionWriteVerb("complete", "complete done", undefined);
		expect(out).toContain("requires an active session");
	});

	test("handleMissionWriteVerb returns undefined for unrecognized verbs", async () => {
		const { control } = fixture();
		const out = await handleMissionWriteVerb("show", "show m1", control);
		expect(out).toBeUndefined();
	});
});
