import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __test, type NewLearningProposal, ProposalStore } from "../../src/learning";

const stores: ProposalStore[] = [];

function createStore(): ProposalStore {
	const store = new ProposalStore(":memory:");
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

function createTempStore(dbPath: string): ProposalStore {
	const store = new ProposalStore(dbPath);
	stores.push(store);
	return store;
}

function memoryProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "memory",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:12"], sampleN: 1 },
		provenance: { source: "manual" },
		content: "Prefer narrow tests for changed behavior.",
		memoryType: "project",
		confidence: "tool_verified",
		...overrides,
	} as NewLearningProposal;
}

describe("ProposalStore", () => {
	test("creates a memory proposal and retrieves the same proposal", () => {
		const store = createStore();
		const created = store.create(memoryProposal());

		expect(created.id).toBeString();
		expect(created.status).toBe("pending");
		expect(store.get(created.id)).toEqual(created);
	});

	test("transitions pending to approved, applied, then rolled-back", () => {
		const store = createStore();
		const created = store.create(memoryProposal());

		const approved = store.approve(created.id, "reviewer");
		expect(approved.status).toBe("approved");

		const applied = store.markApplied(created.id, "1");
		expect(applied.status).toBe("applied");

		const rolledBack = store.markRolledBack(created.id, "regression");
		expect(rolledBack.status).toBe("rolled-back");
		expect(store.get(created.id)?.status).toBe("rolled-back");
	});

	test("throws on an invalid applied to pending-like transition", () => {
		const store = createStore();
		const created = store.create(memoryProposal());
		store.approve(created.id);
		store.markApplied(created.id, "1");

		expect(() => store.markExpired(created.id)).toThrow(/Invalid learning proposal transition: applied -> expired/);
	});

	test("preserves expiresAt and marks pending proposals expired", () => {
		const store = createStore();
		const expiresAt = Date.now() + 60_000;
		const created = store.create(memoryProposal({ expiresAt }));

		expect(store.get(created.id)?.expiresAt).toBe(expiresAt);
		expect(store.markExpired(created.id).status).toBe("expired");
		expect(store.get(created.id)?.expiresAt).toBe(expiresAt);
	});

	test("filters proposals by status and type", () => {
		const store = createStore();
		const pendingMemory = store.create(memoryProposal({ content: "pending memory" }));
		const rejectedMemory = store.create(memoryProposal({ content: "rejected memory" }));
		const skill = store.create({
			type: "skill",
			gate: "review",
			evidence: { sessionIds: ["session-2"], eventRefs: ["events.jsonl:40"], sampleN: 1 },
			provenance: { source: "reflection" },
			name: "debugging-checklist",
			sourceMemoryIds: ["mem-1"],
			bodyMarkdown: "# Debugging Checklist\n",
		});
		store.reject(rejectedMemory.id, "duplicate");

		expect(new Set(store.listByStatus("pending").map(proposal => proposal.id))).toEqual(
			new Set([pendingMemory.id, skill.id]),
		);
		expect(store.listByStatus("rejected").map(proposal => proposal.id)).toEqual([rejectedMemory.id]);
		expect(new Set(store.listByType("memory").map(proposal => proposal.id))).toEqual(
			new Set([pendingMemory.id, rejectedMemory.id]),
		);
		expect(store.listByType("skill").map(proposal => proposal.id)).toEqual([skill.id]);
	});

	test("counts proposals for one objective since a timestamp", () => {
		const store = createStore();
		const sinceMs = Date.now() - 1_000;
		store.create(memoryProposal({ provenance: { source: "reflection", objectiveId: "obj-A" } as any }));
		store.create(memoryProposal({ provenance: { source: "reflection", objectiveId: "obj-B" } as any }));

		expect(store.countByObjectiveSince("obj-A", sinceMs)).toBe(1);
		expect(store.countByObjectiveSince("obj-B", sinceMs)).toBe(1);
		expect(store.countByObjectiveSince("obj-C", sinceMs)).toBe(0);
	});
});

describe("legacy migration", () => {
	test("imports one legacy proposal and its events into the shared autonomy database", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-proposal-migration-"));
		const legacyPath = path.join(root, ".amaze", "learning", "proposals.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		const legacyProposal = legacyStore.create(memoryProposal());
		legacyStore.approve(legacyProposal.id, "reviewer");
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);
		fs.mkdirSync(path.dirname(defaultPath), { recursive: true });

		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS learning_proposals (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL,
					status TEXT NOT NULL,
					gate TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					evidence TEXT NOT NULL CHECK (json_valid(evidence)),
					provenance TEXT NOT NULL CHECK (json_valid(provenance)),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					expires_at INTEGER NULL
				);

				CREATE TABLE IF NOT EXISTS learning_proposal_events (
					proposal_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect((db.query("SELECT COUNT(*) AS count FROM learning_proposals").get() as { count: number }).count).toBe(
				1,
			);
			expect((db.query("SELECT id FROM learning_proposals").get() as { id: string }).id).toBe(legacyProposal.id);
			expect(
				db.query("SELECT kind FROM learning_proposal_events ORDER BY ts ASC, kind ASC").all() as Array<{
					kind: string;
				}>,
			).toEqual([{ kind: "created" }, { kind: "approved" }]);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("imports legacy proposals and events when legacy snapshots exist without a destination snapshot table", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-proposal-migration-"));
		const legacyPath = path.join(root, ".amaze", "learning", "proposals.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		const legacyProposal = legacyStore.create(memoryProposal());
		legacyStore.approve(legacyProposal.id, "reviewer");
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);

		const legacyDb = new Database(legacyPath, { create: true, strict: true });
		try {
			legacyDb.exec(`
				CREATE TABLE promotion_snapshots (
					id TEXT PRIMARY KEY,
					payload TEXT NOT NULL
				);
				INSERT INTO promotion_snapshots (id, payload) VALUES ('snapshot-1', '{}');
			`);
		} finally {
			legacyDb.close();
		}

		fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS learning_proposals (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL,
					status TEXT NOT NULL,
					gate TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					evidence TEXT NOT NULL CHECK (json_valid(evidence)),
					provenance TEXT NOT NULL CHECK (json_valid(provenance)),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					expires_at INTEGER NULL
				);

				CREATE TABLE IF NOT EXISTS learning_proposal_events (
					proposal_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect((db.query("SELECT COUNT(*) AS count FROM learning_proposals").get() as { count: number }).count).toBe(
				1,
			);
			expect((db.query("SELECT id FROM learning_proposals").get() as { id: string }).id).toBe(legacyProposal.id);
			expect(
				db.query("SELECT kind FROM learning_proposal_events ORDER BY ts ASC, kind ASC").all() as Array<{
					kind: string;
				}>,
			).toEqual([{ kind: "created" }, { kind: "approved" }]);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("imports compatible legacy promotion snapshots using explicit destination columns", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-proposal-migration-"));
		const legacyPath = path.join(root, ".amaze", "learning", "proposals.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		const legacyProposal = legacyStore.create(memoryProposal());
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);

		const legacyDb = new Database(legacyPath, { create: true, strict: true });
		try {
			legacyDb.exec(`
				CREATE TABLE promotion_snapshots (
					legacy_order_marker TEXT NOT NULL,
					applied_at INTEGER NOT NULL,
					snapshot_blob TEXT NOT NULL CHECK (json_valid(snapshot_blob)),
					type TEXT NOT NULL,
					version TEXT NOT NULL,
					proposal_id TEXT NOT NULL,
					id TEXT PRIMARY KEY
				);
				INSERT INTO promotion_snapshots
					(legacy_order_marker, applied_at, snapshot_blob, type, version, proposal_id, id)
				VALUES
					('legacy-only', 1234, '{"before":"state"}', 'memory', 'v1', '${legacyProposal.id}', 'snapshot-1');
			`);
		} finally {
			legacyDb.close();
		}

		fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS learning_proposals (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL,
					status TEXT NOT NULL,
					gate TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					evidence TEXT NOT NULL CHECK (json_valid(evidence)),
					provenance TEXT NOT NULL CHECK (json_valid(provenance)),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					expires_at INTEGER NULL
				);

				CREATE TABLE IF NOT EXISTS learning_proposal_events (
					proposal_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
				);

				CREATE TABLE promotion_snapshots (
					id TEXT PRIMARY KEY,
					proposal_id TEXT NOT NULL,
					version TEXT NOT NULL,
					type TEXT NOT NULL,
					snapshot_blob TEXT NOT NULL CHECK (json_valid(snapshot_blob)),
					applied_at INTEGER NOT NULL,
					FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect(
				db.query("SELECT id, proposal_id, version, type, snapshot_blob, applied_at FROM promotion_snapshots").all(),
			).toEqual([
				{
					id: "snapshot-1",
					proposal_id: legacyProposal.id,
					version: "v1",
					type: "memory",
					snapshot_blob: '{"before":"state"}',
					applied_at: 1234,
				},
			]);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not re-import legacy proposals on a second construction", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-proposal-migration-"));
		const legacyPath = path.join(root, ".amaze", "learning", "proposals.db");
		const defaultPath = path.join(root, ".amaze", "autonomy", "autonomy.db");
		const legacyStore = createTempStore(legacyPath);
		const legacyProposal = legacyStore.create(memoryProposal());
		legacyStore.approve(legacyProposal.id, "reviewer");
		legacyStore.close();
		stores.splice(stores.indexOf(legacyStore), 1);
		fs.mkdirSync(path.dirname(defaultPath), { recursive: true });

		const db = new Database(defaultPath, { create: true, strict: true });
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS learning_proposals (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL,
					status TEXT NOT NULL,
					gate TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					evidence TEXT NOT NULL CHECK (json_valid(evidence)),
					provenance TEXT NOT NULL CHECK (json_valid(provenance)),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					expires_at INTEGER NULL
				);

				CREATE TABLE IF NOT EXISTS learning_proposal_events (
					proposal_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL CHECK (json_valid(payload)),
					FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
				);
			`);
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			__test.migrateLegacyIfNeeded(db, defaultPath, { defaultDbPath: defaultPath, legacyDbPath: legacyPath });
			expect((db.query("SELECT COUNT(*) AS count FROM learning_proposals").get() as { count: number }).count).toBe(
				1,
			);
			expect(
				(db.query("SELECT COUNT(*) AS count FROM learning_proposal_events").get() as { count: number }).count,
			).toBe(2);
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
