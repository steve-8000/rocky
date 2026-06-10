import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __test, type NewObjective, ObjectiveStore } from "../../src/autonomy";
import { DEFAULT_AUTONOMY_FORBIDDEN_SCOPES } from "../../src/autonomy/guardrails";

const stores: ObjectiveStore[] = [];

function createStore(): ObjectiveStore {
	const store = new ObjectiveStore(":memory:");
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

function createTempStore(dbPath: string): ObjectiveStore {
	const store = new ObjectiveStore(dbPath);
	stores.push(store);
	return store;
}

function objective(overrides: Partial<NewObjective> = {}): NewObjective {
	return {
		title: "Reduce force-complete rate",
		metricTargets: [{ metric: "forceCompleteRate", target: 0.01, direction: "down", deadline: 1_800_000_000_000 }],
		budget: { tokens: 100_000, usd: 25, wallClockMs: 86_400_000 },
		guardrails: {
			requireHumanForApply: true,
			maxAutoSubgoalsPerDay: 1,
			forbiddenScopes: ["packages/coding-agent/src/learning/**"],
		},
		...overrides,
	};
}

describe("ObjectiveStore", () => {
	test("creates, lists, and updates objective status", () => {
		const store = createStore();
		const created = store.create(objective({ id: "objective-1" }));

		expect(created).toEqual({
			...objective({ id: "objective-1" }),
			id: "objective-1",
			guardrails: {
				requireHumanForApply: true,
				maxAutoSubgoalsPerDay: 1,
				forbiddenScopes: [...DEFAULT_AUTONOMY_FORBIDDEN_SCOPES],
			},
			status: "active",
		});
		expect(store.get("objective-1")).toEqual(created);
		expect(store.list()).toEqual([created]);

		const paused = store.updateStatus("objective-1", "paused");
		expect(paused.status).toBe("paused");
		expect(store.get("objective-1")?.status).toBe("paused");
		expect(store.list().map(item => item.id)).toEqual(["objective-1"]);
	});

	test("records objective events", () => {
		const store = createStore();
		const created = store.create(objective({ id: "objective-events" }));
		const event = store.recordEvent(created.id, "note", { ok: true });

		expect(event.objectiveId).toBe(created.id);
		expect(event.kind).toBe("note");
		expect(event.payload).toEqual({ ok: true });
		expect(store.listEvents(created.id).map(item => item.kind)).toEqual(["created", "note"]);
	});

	test("applies default forbidden scopes when guardrails are omitted", () => {
		const store = createStore();
		const created = store.create(objective({ guardrails: {} }));

		expect(created.guardrails.forbiddenScopes).toEqual(
			expect.arrayContaining([...DEFAULT_AUTONOMY_FORBIDDEN_SCOPES]),
		);
	});

	test("merges custom forbidden scopes with defaults", () => {
		const store = createStore();
		const created = store.create(objective({ guardrails: { forbiddenScopes: ["custom/**"] } }));

		expect(created.guardrails.forbiddenScopes).toEqual(
			expect.arrayContaining([...DEFAULT_AUTONOMY_FORBIDDEN_SCOPES, "custom/**"]),
		);
		expect(new Set(created.guardrails.forbiddenScopes).size).toBe(created.guardrails.forbiddenScopes.length);
	});
});

describe("legacy migration", () => {
	test("imports one legacy objective into the shared autonomy database", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-objective-migration-"));
		const legacyPath = path.join(root, ".amaze", "autonomy", "objectives.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		const legacyObjective = legacyStore.create(objective({ id: "legacy-objective" }));
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);

		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS objectives (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					metric_targets TEXT NOT NULL CHECK (json_valid(metric_targets)),
					budget TEXT NOT NULL CHECK (json_valid(budget)),
					guardrails TEXT NOT NULL CHECK (json_valid(guardrails)),
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS objective_events (
					objective_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect((db.query("SELECT COUNT(*) AS count FROM objectives").get() as { count: number }).count).toBe(1);
			expect((db.query("SELECT id FROM objectives").get() as { id: string }).id).toBe(legacyObjective.id);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not re-import legacy objectives on a second construction", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-objective-migration-"));
		const legacyPath = path.join(root, ".amaze", "autonomy", "objectives.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		legacyStore.create(objective({ id: "legacy-objective" }));
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);

		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS objectives (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					metric_targets TEXT NOT NULL CHECK (json_valid(metric_targets)),
					budget TEXT NOT NULL CHECK (json_valid(budget)),
					guardrails TEXT NOT NULL CHECK (json_valid(guardrails)),
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS objective_events (
					objective_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect((db.query("SELECT COUNT(*) AS count FROM objectives").get() as { count: number }).count).toBe(1);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
