import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EvalReport, LearningProposal, LearningProposalType, ProposalStatus } from "./types";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".amaze", "autonomy", "autonomy.db");
const LEGACY_DB_PATH = path.join(os.homedir(), ".amaze", "learning", "proposals.db");

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
	pending: ["approved", "rejected", "expired"],
	approved: ["applied", "expired"],
	rejected: [],
	applied: ["rolled-back"],
	"rolled-back": [],
	expired: [],
};

type ProposalRow = {
	id: string;
	type: LearningProposalType;
	status: ProposalStatus;
	gate: LearningProposal["gate"];
	payload: string;
	evidence: string;
	provenance: string;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
};

export type NewLearningProposal = Omit<LearningProposal, "id" | "createdAt" | "status"> & Record<string, unknown>;

export class ProposalStore {
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

	create(proposal: NewLearningProposal): LearningProposal {
		const now = Date.now();
		const id = generateProposalId(now);
		const created = { ...proposal, id, createdAt: now, status: "pending" as const } as LearningProposal;
		this.#insert(created, now);
		this.#recordEvent(id, now, "created", { status: "pending" });
		return created;
	}

	get(id: string): LearningProposal | undefined {
		const row = this.#db.query("SELECT * FROM learning_proposals WHERE id = ?").get(id) as ProposalRow | null;
		return row ? rowToProposal(row) : undefined;
	}

	listByStatus(status: ProposalStatus): LearningProposal[] {
		const rows = this.#db
			.query("SELECT * FROM learning_proposals WHERE status = ? ORDER BY created_at ASC, updated_at ASC, id ASC")
			.all(status) as ProposalRow[];
		return rows.map(rowToProposal);
	}

	listByType(type: LearningProposalType): LearningProposal[] {
		const rows = this.#db
			.query("SELECT * FROM learning_proposals WHERE type = ? ORDER BY created_at ASC, id ASC")
			.all(type) as ProposalRow[];
		return rows.map(rowToProposal);
	}

	countByObjectiveSince(objectiveId: string, sinceMs: number): number {
		const row = this.#db
			.query(
				"SELECT COUNT(*) AS count FROM learning_proposals WHERE json_extract(provenance, '$.objectiveId') = ? AND created_at >= ?",
			)
			.get(objectiveId, sinceMs) as { count: number };
		return row.count;
	}

	approve(id: string, by?: string): LearningProposal {
		return this.#transition(id, "approved", { by });
	}

	setLastEval(id: string, report: EvalReport): LearningProposal {
		const current = this.get(id);
		if (!current) {
			throw new Error(`Learning proposal not found: ${id}`);
		}

		const now = Date.now();
		this.#db
			.query("UPDATE learning_proposals SET payload = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(proposalPayload({ ...current, lastEvalReport: report })), now, id);
		this.#recordEvent(id, now, "last-eval", { report });
		const updated = this.get(id);
		if (!updated) {
			throw new Error(`Learning proposal disappeared after last eval update: ${id}`);
		}
		return updated;
	}

	recordApplyRejected(id: string, reason: "missing-sandbox" | "sandbox-fail" | "stale-eval"): void {
		const current = this.get(id);
		if (!current) {
			throw new Error(`Learning proposal not found: ${id}`);
		}
		this.#recordEvent(id, Date.now(), "apply-rejected", { reason });
	}

	reject(id: string, reason: string): LearningProposal {
		return this.#transition(id, "rejected", { reason });
	}

	markApplied(id: string, version: string): LearningProposal {
		return this.#transition(id, "applied", { version });
	}

	markRolledBack(id: string, reason: string): LearningProposal {
		return this.#transition(id, "rolled-back", { reason });
	}

	markExpired(id: string): LearningProposal {
		return this.#transition(id, "expired", {});
	}

	#init(): void {
		this.#db.exec(`
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

			CREATE INDEX IF NOT EXISTS learning_proposals_status_idx ON learning_proposals(status);
			CREATE INDEX IF NOT EXISTS learning_proposals_type_idx ON learning_proposals(type);
			CREATE INDEX IF NOT EXISTS learning_proposals_provenance_rule_id_idx ON learning_proposals(json_extract(provenance, '$.ruleId'));
			CREATE INDEX IF NOT EXISTS learning_proposals_evidence_session_ids_idx ON learning_proposals(json_extract(evidence, '$.sessionIds'));
			CREATE INDEX IF NOT EXISTS learning_proposal_events_proposal_id_idx ON learning_proposal_events(proposal_id);
			CREATE INDEX IF NOT EXISTS learning_proposals_provenance_objective_id_idx ON learning_proposals(json_extract(provenance, '$.objectiveId'));
		`);
		migrateLegacyIfNeeded(this.#db, this.dbPath);
	}

	#insert(proposal: LearningProposal, now: number): void {
		this.#db
			.query(
				`INSERT INTO learning_proposals
					(id, type, status, gate, payload, evidence, provenance, created_at, updated_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				proposal.id,
				proposal.type,
				proposal.status,
				proposal.gate,
				JSON.stringify(proposalPayload(proposal)),
				JSON.stringify(proposal.evidence),
				JSON.stringify(proposal.provenance),
				proposal.createdAt,
				now,
				proposal.expiresAt ?? null,
			);
	}

	#transition(id: string, nextStatus: ProposalStatus, payload: Record<string, unknown>): LearningProposal {
		const current = this.get(id);
		if (!current) {
			throw new Error(`Learning proposal not found: ${id}`);
		}
		if (!VALID_TRANSITIONS[current.status].includes(nextStatus)) {
			throw new Error(`Invalid learning proposal transition: ${current.status} -> ${nextStatus}`);
		}

		const now = Date.now();
		this.#db.query("UPDATE learning_proposals SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, id);
		this.#recordEvent(id, now, nextStatus, payload);
		const updated = this.get(id);
		if (!updated) {
			throw new Error(`Learning proposal disappeared after transition: ${id}`);
		}
		return updated;
	}

	#recordEvent(proposalId: string, ts: number, kind: string, payload: Record<string, unknown>): void {
		this.#db
			.query("INSERT INTO learning_proposal_events (proposal_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(proposalId, ts, kind, JSON.stringify(payload));
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
	const proposalCount = db.query("SELECT COUNT(*) AS count FROM learning_proposals").get() as { count: number };
	if (proposalCount.count > 0) return;

	const escapedLegacyPath = legacyDbPath.replace(/'/g, "''");
	let attached = false;
	try {
		db.exec(`ATTACH DATABASE '${escapedLegacyPath}' AS legacy`);
		attached = true;
		db.transaction(() => {
			db.exec(`
				INSERT OR IGNORE INTO learning_proposals
					(id, type, status, gate, payload, evidence, provenance, created_at, updated_at, expires_at)
				SELECT id, type, status, gate, payload, evidence, provenance, created_at, updated_at, expires_at
				FROM legacy.learning_proposals;

				INSERT OR IGNORE INTO learning_proposal_events
					(proposal_id, ts, kind, payload)
				SELECT proposal_id, ts, kind, payload
				FROM legacy.learning_proposal_events;
			`);
		})();

		try {
			migrateLegacyPromotionSnapshotsIfSafe(db);
		} catch (error) {
			process.stderr.write(
				`promotion_snapshots legacy migration skipped: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
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

function migrateLegacyPromotionSnapshotsIfSafe(db: Database): void {
	const hasLegacyPromotionSnapshots = db
		.query("SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = 'promotion_snapshots'")
		.get();
	if (!hasLegacyPromotionSnapshots) return;

	const hasPromotionSnapshots = db
		.query("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'promotion_snapshots'")
		.get();
	if (!hasPromotionSnapshots) return;

	db.exec(`
		INSERT OR IGNORE INTO promotion_snapshots
			(id, proposal_id, version, type, snapshot_blob, applied_at)
		SELECT id, proposal_id, version, type, snapshot_blob, applied_at
		FROM legacy.promotion_snapshots;
	`);
}

export const __test = { DEFAULT_DB_PATH, LEGACY_DB_PATH, migrateLegacyIfNeeded };

function generateProposalId(now: number): string {
	return `${now.toString(36)}${crypto.randomBytes(8).toString("hex")}`;
}

function proposalPayload(proposal: LearningProposal): Record<string, unknown> {
	const {
		id: _id,
		createdAt: _createdAt,
		status: _status,
		gate: _gate,
		evidence: _evidence,
		provenance: _provenance,
		expiresAt: _expiresAt,
		...payload
	} = proposal;
	return payload;
}

function rowToProposal(row: ProposalRow): LearningProposal {
	const payload = JSON.parse(row.payload) as Record<string, unknown>;
	return {
		...payload,
		id: row.id,
		createdAt: row.created_at,
		status: row.status,
		gate: row.gate,
		evidence: JSON.parse(row.evidence),
		provenance: JSON.parse(row.provenance),
		...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
	} as LearningProposal;
}
