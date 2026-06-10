import type { Database } from "bun:sqlite";

export function ensureApplyMigrations(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS promotion_snapshots (
			id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL,
			version TEXT NOT NULL,
			type TEXT NOT NULL,
			snapshot_blob TEXT NOT NULL CHECK (json_valid(snapshot_blob)),
			applied_at INTEGER NOT NULL,
			FOREIGN KEY (proposal_id) REFERENCES learning_proposals(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS promotion_snapshots_proposal_id_version_idx
			ON promotion_snapshots(proposal_id, version);
		CREATE INDEX IF NOT EXISTS promotion_snapshots_applied_at_idx
			ON promotion_snapshots(applied_at);
	`);
}
