import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const runtimes: MissionRuntimeImpl[] = [];
const stores: MissionStore[] = [];
const tempDirs: string[] = [];

function createRuntimePair(): { runtime1: MissionRuntimeImpl; runtime2: MissionRuntimeImpl; store: MissionStore } {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-runtime-stale-cache-"));
	const store = new MissionStore(path.join(tempDir, "missions.db"));
	const runtime1 = new MissionRuntimeImpl({ store });
	const runtime2 = new MissionRuntimeImpl({ store });
	tempDirs.push(tempDir);
	stores.push(store);
	runtimes.push(runtime1, runtime2);
	return { runtime1, runtime2, store };
}

function createInput() {
	return {
		title: "Ship the thing",
		objective: "Deliver a working feature",
		intent: "code_change" as const,
	};
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) store.close();
	for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("MissionRuntimeImpl stale cache detection", () => {
	test("tryGet returns cached mission when stored lifecycle matches", async () => {
		const { runtime1 } = createRuntimePair();
		const mission = await runtime1.create(createInput());

		expect(runtime1.tryGet(mission.id)).toBe(mission);
	});

	test("tryGet drops cache and re-hydrates when stored lifecycle diverges (external mutation)", async () => {
		const { runtime1, store } = createRuntimePair();
		const mission = await runtime1.create(createInput());

		store.updateMission(mission.id, { state: "completed", lifecycle: "completed" });

		const rehydrated = runtime1.tryGet(mission.id);
		expect(rehydrated).toBeDefined();
		expect(rehydrated).not.toBe(mission);
		expect(rehydrated?.lifecycle).toBe("completed");
	});

	test("tryGet returns undefined and drops cache when row was deleted externally", async () => {
		const { runtime1, store } = createRuntimePair();
		const mission = await runtime1.create(createInput());
		const db = new Database(store.dbPath);
		try {
			db.query("DELETE FROM missions WHERE id = ?").run(mission.id);
		} finally {
			db.close();
		}

		expect(runtime1.tryGet(mission.id)).toBeUndefined();
		expect(runtime1.tryGet(mission.id)).toBeUndefined();
	});

	test("tryGet does not refetch when row is unchanged (cache hit path)", async () => {
		const { runtime1 } = createRuntimePair();
		const mission = await runtime1.create(createInput());

		expect(runtime1.tryGet(mission.id)).toBe(mission);
		expect(runtime1.tryGet(mission.id)).toBe(mission);
	});
});
