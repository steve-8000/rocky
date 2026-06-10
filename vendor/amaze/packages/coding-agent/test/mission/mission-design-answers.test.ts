import { afterEach, describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];

function runtimeFixture() {
	const store = new MissionStore(":memory:");
	stores.push(store);
	const runtime = new MissionRuntimeImpl({ store });
	return { store, runtime };
}

function controlFixture() {
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
	return { control, getActiveId: () => activeId };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("mission design answers", () => {
	test("recordDesignAnswers writes once and no-ops for later or empty input", async () => {
		const { runtime } = runtimeFixture();
		const mission = await runtime.create({
			title: "Design mission",
			objective: "Collect design answers",
		});

		const empty = runtime.recordDesignAnswers(mission.id, {});
		expect(empty.designAnswers).toBeUndefined();

		const captured = runtime.recordDesignAnswers(mission.id, { scope: "only auth", approach: "small patch" });
		expect(captured.designAnswers).toEqual({ scope: "only auth", approach: "small patch" });

		const second = runtime.recordDesignAnswers(mission.id, { scope: "overwrite" });
		expect(second.designAnswers).toEqual({ scope: "only auth", approach: "small patch" });
	});

	test("recordDesignAnswers persists and hydrates through a fresh runtime", async () => {
		const { store, runtime } = runtimeFixture();
		const mission = await runtime.create({
			title: "Persistent mission",
			objective: "Persist design answers",
		});
		runtime.recordDesignAnswers(mission.id, { constraints: "no UI changes", acceptance: "test passes" });

		const freshRuntime = new MissionRuntimeImpl({ store });
		const hydrated = await freshRuntime.get(mission.id);
		expect(hydrated?.designAnswers).toEqual({ constraints: "no UI changes", acceptance: "test passes" });
	});

	test("recordActiveDesignAnswers returns undefined without an active mission", () => {
		const { control, getActiveId } = controlFixture();
		expect(getActiveId()).toBeUndefined();
		expect(control.recordActiveDesignAnswers({ scope: "none" })).toBeUndefined();
	});

	test("recordActiveDesignAnswers writes to the active mission", async () => {
		const { control } = controlFixture();
		const mission = await control.createMission({
			title: "Active design mission",
			objective: "Mirror active design answers",
		});

		const captured = control.recordActiveDesignAnswers({ scope: "mission core", acceptance: "roundtrip" });
		expect(captured?.id).toBe(mission.id);
		expect(captured?.designAnswers).toEqual({ scope: "mission core", acceptance: "roundtrip" });
	});
});
