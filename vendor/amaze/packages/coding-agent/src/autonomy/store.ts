import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeObjectiveGuardrails } from "./guardrails";
import type { NewObjective, Objective, ObjectiveEvent, ObjectiveStatus } from "./types";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".amaze", "autonomy", "autonomy.db");
const LEGACY_DB_PATH = path.join(os.homedir(), ".amaze", "autonomy", "objectives.db");

const VALID_STATUSES = new Set<ObjectiveStatus>(["active", "paused", "completed", "cancelled"]);

type ObjectiveRow = {
	id: string;
	title: string;
	metric_targets: string;
	budget: string;
	guardrails: string;
	status: ObjectiveStatus;
	created_at: number;
	updated_at: number;
};

type ObjectiveEventRow = {
	objective_id: string;
	ts: number;
	kind: string;
	payload: string;
};

export class ObjectiveStore {
	readonly dbPath: string;
	readonly #db: Database;

	constructor(dbPath = DEFAULT_DB_PATH) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		}
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#db.run("PRAGMA busy_timeout = 3000");
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#init();
	}

	close(): void {
		this.#db.close();
	}

	create(input: NewObjective): Objective {
		const now = Date.now();
		const objective: Objective = {
			...input,
			id: input.id ?? generateObjectiveId(now),
			guardrails: normalizeObjectiveGuardrails(input.guardrails),
			status: input.status ?? "active",
		};
		assertObjectiveStatus(objective.status);
		this.#db
			.query(
				`INSERT INTO objectives
					(id, title, metric_targets, budget, guardrails, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				objective.id,
				objective.title,
				JSON.stringify(objective.metricTargets),
				JSON.stringify(objective.budget),
				JSON.stringify(objective.guardrails),
				objective.status,
				now,
				now,
			);
		this.recordEvent(objective.id, "created", { status: objective.status });
		return objective;
	}

	get(id: string): Objective | undefined {
		const row = this.#db.query("SELECT * FROM objectives WHERE id = ?").get(id) as ObjectiveRow | null;
		return row ? rowToObjective(row) : undefined;
	}

	list(): Objective[] {
		const rows = this.#db.query("SELECT * FROM objectives ORDER BY created_at ASC, id ASC").all() as ObjectiveRow[];
		return rows.map(rowToObjective);
	}

	updateStatus(id: string, status: ObjectiveStatus): Objective {
		assertObjectiveStatus(status);
		const current = this.get(id);
		if (!current) {
			throw new Error(`Objective not found: ${id}`);
		}
		const now = Date.now();
		this.#db.query("UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
		this.recordEvent(id, "status", { from: current.status, to: status });
		const updated = this.get(id);
		if (!updated) {
			throw new Error(`Objective disappeared after status update: ${id}`);
		}
		return updated;
	}

	recordEvent(objectiveId: string, kind: string, payload: Record<string, unknown> = {}): ObjectiveEvent {
		if (!this.get(objectiveId)) {
			throw new Error(`Objective not found: ${objectiveId}`);
		}
		const event = { objectiveId, ts: Date.now(), kind, payload } satisfies ObjectiveEvent;
		this.#db
			.query("INSERT INTO objective_events (objective_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(event.objectiveId, event.ts, event.kind, JSON.stringify(event.payload));
		return event;
	}

	listEvents(objectiveId: string): ObjectiveEvent[] {
		const rows = this.#db
			.query("SELECT * FROM objective_events WHERE objective_id = ? ORDER BY ts ASC, kind ASC")
			.all(objectiveId) as ObjectiveEventRow[];
		return rows.map(rowToObjectiveEvent);
	}

	#init(): void {
		this.#db.exec(`
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

			CREATE INDEX IF NOT EXISTS objectives_status_idx ON objectives(status);
			CREATE INDEX IF NOT EXISTS objective_events_objective_id_idx ON objective_events(objective_id);
		`);
		migrateLegacyIfNeeded(this.#db, this.dbPath);
	}
}

function migrateLegacyIfNeeded(
	db: Database,
	dbPath = DEFAULT_DB_PATH,
	paths: { defaultDbPath?: string; legacyDbPath?: string } = {},
): void {
	const defaultDbPath = paths.defaultDbPath ?? DEFAULT_DB_PATH;
	const legacyDbPath = paths.legacyDbPath ?? LEGACY_DB_PATH;
	if (dbPath !== defaultDbPath) return;
	if (legacyDbPath === defaultDbPath || !fs.existsSync(legacyDbPath)) return;
	const objectiveCount = db.query("SELECT COUNT(*) AS count FROM objectives").get() as { count: number };
	if (objectiveCount.count > 0) return;

	const escapedLegacyPath = legacyDbPath.replace(/'/g, "''");
	let attached = false;
	try {
		db.exec(`ATTACH DATABASE '${escapedLegacyPath}' AS legacy`);
		attached = true;
		db.transaction(() => {
			db.exec(`
				INSERT OR IGNORE INTO objectives
					(id, title, metric_targets, budget, guardrails, status, created_at, updated_at)
				SELECT id, title, metric_targets, budget, guardrails, status, created_at, updated_at
				FROM legacy.objectives;

				INSERT OR IGNORE INTO objective_events
					(objective_id, ts, kind, payload)
				SELECT objective_id, ts, kind, payload
				FROM legacy.objective_events;
			`);
		})();
	} catch (error) {
		process.stderr.write(`autonomy-db migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
	} finally {
		if (attached) {
			try {
				db.exec("DETACH DATABASE legacy");
			} catch {
				// Best-effort cleanup after a failed migration; callers must still be able to use the new DB.
			}
		}
	}
}

export const __test = { DEFAULT_DB_PATH, LEGACY_DB_PATH, migrateLegacyIfNeeded };

function generateObjectiveId(now: number): string {
	return `${now.toString(36)}${randomBytes(8).toString("hex")}`;
}

function assertObjectiveStatus(status: ObjectiveStatus): void {
	if (!VALID_STATUSES.has(status)) {
		throw new Error(`Invalid objective status: ${status}`);
	}
}

function rowToObjective(row: ObjectiveRow): Objective {
	return {
		id: row.id,
		title: row.title,
		metricTargets: JSON.parse(row.metric_targets) as Objective["metricTargets"],
		budget: JSON.parse(row.budget) as Objective["budget"],
		guardrails: JSON.parse(row.guardrails) as Objective["guardrails"],
		status: row.status,
	};
}

function rowToObjectiveEvent(row: ObjectiveEventRow): ObjectiveEvent {
	return {
		objectiveId: row.objective_id,
		ts: row.ts,
		kind: row.kind,
		payload: JSON.parse(row.payload) as Record<string, unknown>,
	};
}
