import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const stores: MissionStore[] = [];
const runtimes: MissionRuntimeImpl[] = [];
const tempDirs: string[] = [];

function createStore(dbPath = ":memory:"): MissionStore {
	const store = new MissionStore(dbPath);
	stores.push(store);
	return store;
}

function createRuntime(store = createStore()): { store: MissionStore; runtime: MissionRuntimeImpl } {
	const runtime = new MissionRuntimeImpl({ store });
	runtimes.push(runtime);
	return { store, runtime };
}

function controlFixture() {
	const store = createStore();
	let activeId: string | undefined;
	const control = new MissionControlRuntime({
		store,
		getActiveMissionId: () => activeId,
		setActiveMissionId: id => {
			activeId = id;
		},
	});
	return { store, control };
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// already closed by the owning runtime
		}
	}
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("mission verification mirror", () => {
	test("recordVerification writes a mission_verifications row and exposes verification on the mission", async () => {
		const { store, runtime } = createRuntime();
		const mission = await runtime.create({
			title: "Verify ambient verdict",
			objective: "Capture acceptance verifier output",
			riskLevel: "low",
		});
		const lifecycle = mission.lifecycle;

		const verified = runtime.recordVerification(mission.id, { status: "pass", summary: "ok" });

		expect(verified.verification?.status).toBe("pass");
		expect(mission.verification?.status).toBe("pass");
		expect(store.getLatestVerification(mission.id)?.status).toBe("pass");
		expect(verified.lifecycle).toBe(lifecycle);
	});

	test("recordActiveVerification returns undefined without an active mission", () => {
		const { control } = controlFixture();

		expect(control.recordActiveVerification({ status: "uncertain", summary: "no active mission" })).toBeUndefined();
	});

	test("recordActiveVerification mutates the active mission and persists", async () => {
		const { store, control } = controlFixture();
		const active = await control.createMission({
			title: "Active verification",
			objective: "Persist ambient verifier verdict",
			riskLevel: "medium",
		});

		const verified = control.recordActiveVerification({ status: "fail", summary: "not done", failedCount: 1 });

		expect(verified?.id).toBe(active.id);
		expect(verified?.verification?.status).toBe("fail");
		expect(store.getLatestVerification(active.id)).toMatchObject({
			missionId: active.id,
			status: "fail",
			failedCount: 1,
			summary: "not done",
		});
	});
});
