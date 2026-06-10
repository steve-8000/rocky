import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MissionPlan } from "../../src/mission/core/mission";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";

const stores: MissionStore[] = [];
const dbPaths: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-store-migrations-"));
	const dbPath = path.join(dir, "autonomy.db");
	dbPaths.push(dbPath);
	return dbPath;
}

function createStore(dbPath = tempDbPath()): MissionStore {
	const store = new MissionStore(dbPath);
	stores.push(store);
	return store;
}

function userVersion(dbPath: string): number {
	const db = new Database(dbPath, { create: false, strict: true });
	try {
		return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	} finally {
		db.close();
	}
}

function countPlanRows(dbPath: string, missionId: string): { plans: number; steps: number } {
	const db = new Database(dbPath, { create: false, strict: true });
	try {
		const plans = (
			db.query("SELECT COUNT(*) AS count FROM mission_plans WHERE mission_id = ?").get(missionId) as {
				count: number;
			}
		).count;
		const steps = (
			db.query("SELECT COUNT(*) AS count FROM mission_plan_steps WHERE mission_id = ?").get(missionId) as {
				count: number;
			}
		).count;
		return { plans, steps };
	} finally {
		db.close();
	}
}

function newMission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Migration Mission",
		objectiveId: null,
		briefId: null,
		decisionId: null,
		riskLevel: "medium",
		state: "drafting",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dbPath of dbPaths.splice(0)) {
		fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
	}
});

describe("mission store migrations", () => {
	test("fresh store bumps PRAGMA user_version to 3", () => {
		const dbPath = tempDbPath();
		createStore(dbPath);

		expect(userVersion(dbPath)).toBe(3);
	});

	test("pre-existing user_version 0 database with baseline schema upgrades idempotently", () => {
		const dbPath = tempDbPath();
		createStore(dbPath).close();
		stores.pop();

		const db = new Database(dbPath, { create: false, strict: true });
		try {
			db.exec("PRAGMA user_version = 0");
		} finally {
			db.close();
		}

		createStore(dbPath);

		expect(userVersion(dbPath)).toBe(3);
	});

	test("savePlan rolls back partial writes when step serialization fails", () => {
		const dbPath = tempDbPath();
		const store = createStore(dbPath);
		const mission = store.createMission(newMission());
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		const plan = {
			rationale: "bad",
			revision: 1,
			steps: [
				{ id: "s1", description: "first" },
				{ id: "s2", description: "throws", edges: cyclic },
			],
		} as MissionPlan;

		expect(() => store.savePlan(mission.id, plan)).toThrow(/cyclic|circular/i);
		expect(countPlanRows(dbPath, mission.id)).toEqual({ plans: 0, steps: 0 });
	});
});
