import type { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ProposalStore } from "../store";
import type { LearningProposal } from "../types";
import { ensureApplyMigrations } from "./migrations";
import { type PromotionSnapshot, restoreSnapshot, snapshotFile, writeFileAtomically } from "./snapshots";

export type ApplyRejectionReason = "missing-sandbox" | "sandbox-fail" | "stale-eval";

export class ApplyProposalRejectedError extends Error {
	constructor(
		readonly proposalId: string,
		readonly reason: ApplyRejectionReason,
	) {
		super(`Learning proposal apply rejected: ${reason}`);
		this.name = "ApplyProposalRejectedError";
	}
}

export type ApplyProposalOptions = {
	store: ProposalStore;
	db: Database;
	proposalId: string;
	settingsPath?: string;
	skillsDir?: string;
	rulesDir?: string;
};

export type ApplyProposalResult = {
	version: string;
	snapshotRef: string;
};

export type RollbackProposalOptions = {
	store: ProposalStore;
	db: Database;
	proposalId: string;
};

type PromotionSnapshotRow = {
	id: string;
	version: string;
	snapshot_blob: string;
	applied_at: number;
};

export async function applyProposal(opts: ApplyProposalOptions): Promise<ApplyProposalResult> {
	ensureApplyMigrations(opts.db);
	const proposal = opts.store.get(opts.proposalId);
	if (!proposal) {
		throw new Error(`Learning proposal not found: ${opts.proposalId}`);
	}
	if (proposal.status !== "approved") {
		throw new Error(`Learning proposal must be approved before apply: ${proposal.status}`);
	}

	const rejection = applyRejectionReason(proposal);
	if (rejection) {
		opts.store.recordApplyRejected(proposal.id, rejection);
		throw new ApplyProposalRejectedError(proposal.id, rejection);
	}

	const version = createVersion();
	const appliedAt = Date.now();
	const snapshotRef = `${proposal.id}:${version}`;
	const snapshot = await snapshotForProposal(proposal, opts);

	await applyProposalPayload(proposal, opts);
	try {
		insertSnapshot(opts.db, snapshotRef, proposal.id, version, proposal.type, snapshot, appliedAt);
		opts.store.markApplied(proposal.id, version);
	} catch (error) {
		await restoreSnapshot(snapshot);
		throw error;
	}

	return { version, snapshotRef };
}

export async function rollbackProposal(opts: RollbackProposalOptions): Promise<void> {
	ensureApplyMigrations(opts.db);
	const rows = opts.db
		.query(
			`SELECT id, version, snapshot_blob, applied_at
			FROM promotion_snapshots
			WHERE proposal_id = ?
			ORDER BY applied_at DESC, version DESC`,
		)
		.all(opts.proposalId) as PromotionSnapshotRow[];
	if (rows.length === 0) {
		throw new Error(`No promotion snapshots found for proposal: ${opts.proposalId}`);
	}

	for (const row of rows) {
		await restoreSnapshot(JSON.parse(row.snapshot_blob) as PromotionSnapshot);
	}
	opts.store.markRolledBack(opts.proposalId, "manual rollback");
}

async function snapshotForProposal(proposal: LearningProposal, opts: ApplyProposalOptions): Promise<PromotionSnapshot> {
	switch (proposal.type) {
		case "settings":
			return snapshotFile("settings", requiredPath(opts.settingsPath, "settingsPath"));
		case "skill":
			return snapshotFile("skill", path.join(requiredPath(opts.skillsDir, "skillsDir"), proposal.name, "SKILL.md"));
		case "rule":
			return snapshotFile("rule", path.join(requiredPath(opts.rulesDir, "rulesDir"), `${proposal.id}.rule.md`));
		case "memory":
			return { type: "memory", mode: "noop" };
	}
}

async function applyProposalPayload(proposal: LearningProposal, opts: ApplyProposalOptions): Promise<void> {
	switch (proposal.type) {
		case "settings": {
			const settingsPath = requiredPath(opts.settingsPath, "settingsPath");
			const current = JSON.parse(await Bun.file(settingsPath).text()) as Record<string, unknown>;
			await writeFileAtomically(
				settingsPath,
				`${JSON.stringify(mergeObjects(current, proposal.patch), null, "\t")}\n`,
			);
			return;
		}
		case "skill":
			await writeFileAtomically(
				path.join(requiredPath(opts.skillsDir, "skillsDir"), proposal.name, "SKILL.md"),
				proposal.bodyMarkdown,
			);
			return;
		case "rule":
			await writeFileAtomically(
				path.join(requiredPath(opts.rulesDir, "rulesDir"), `${proposal.id}.rule.md`),
				proposal.ruleMarkdown,
			);
			return;
		case "memory":
			return;
	}
}

function insertSnapshot(
	db: Database,
	id: string,
	proposalId: string,
	version: string,
	type: string,
	snapshot: PromotionSnapshot,
	appliedAt: number,
): void {
	db.query(
		`INSERT INTO promotion_snapshots (id, proposal_id, version, type, snapshot_blob, applied_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
	).run(id, proposalId, version, type, JSON.stringify(snapshot), appliedAt);
}

function applyRejectionReason(proposal: LearningProposal): ApplyRejectionReason | undefined {
	if (!proposal.regressionCommands?.length) {
		return undefined;
	}

	const evalRep = proposal.lastEvalReport;
	if (!evalRep?.sandbox) {
		return "missing-sandbox";
	}
	if (!evalRep.sandbox.ok) {
		return "sandbox-fail";
	}
	if (evalRep.patchHash !== hashPatch(proposal)) {
		return "stale-eval";
	}
	return undefined;
}

export function hashPatch(proposal: LearningProposal): string {
	return crypto
		.createHash("sha256")
		.update(canonicalJson(patchPayload(proposal)))
		.digest("hex");
}

function patchPayload(proposal: LearningProposal): unknown {
	if (proposal.type === "settings") return proposal.patch;
	if (proposal.type === "rule") return proposal.ruleMarkdown;
	if (proposal.type === "skill") return proposal.bodyMarkdown;
	if (proposal.type === "memory") return [proposal.content];
	return null;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function mergeObjects(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
		} else if (isPlainObject(value) && isPlainObject(next[key])) {
			next[key] = mergeObjects(next[key], value);
		} else {
			next[key] = value;
		}
	}
	return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredPath(value: string | undefined, name: string): string {
	if (!value) {
		throw new Error(`${name} is required for this proposal type`);
	}
	return value;
}

function createVersion(): string {
	return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
