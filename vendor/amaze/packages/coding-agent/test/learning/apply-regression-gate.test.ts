import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type EvalReport, type NewLearningProposal, ProposalStore } from "../../src/learning";
import { ApplyProposalRejectedError, applyProposal, hashPatch } from "../../src/learning/apply";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

describe("apply regression command gate", () => {
	test("allows apply when sandbox passed and patch hash matches", async () => {
		const fixture = await createFixture();
		const settingsPath = await writeSettings(fixture.dir);
		const proposal = approve(
			fixture.store,
			settingsProposal({ patch: { model: "safe" }, regressionCommands: [{ argv: ["bun", "test"] }] }),
		);
		fixture.store.setLastEval(proposal.id, evalReport({ patchHash: hashPatch(proposal), sandbox: { ok: true } }));

		await applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, settingsPath });

		expect(fixture.store.get(proposal.id)?.status).toBe("applied");
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({ model: "safe" });
	});

	test("rejects stale-eval when proposal patch differs from recorded eval", async () => {
		const fixture = await createFixture();
		const settingsPath = await writeSettings(fixture.dir);
		const original = approve(
			fixture.store,
			settingsProposal({ patch: { model: "evaluated" }, regressionCommands: [{ argv: ["bun", "test"] }] }),
		);
		fixture.store.setLastEval(original.id, evalReport({ patchHash: hashPatch(original), sandbox: { ok: true } }));
		mutatePayload(fixture.db, original.id, { patch: { model: "changed" } });

		await expect(
			applyProposal({ store: fixture.store, db: fixture.db, proposalId: original.id, settingsPath }),
		).rejects.toMatchObject({
			reason: "stale-eval",
		});
		expect(fixture.store.get(original.id)?.status).toBe("approved");
		expect(lastApplyRejectedReason(fixture.db, original.id)).toBe("stale-eval");
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({ model: "default" });
	});

	test("rejects missing-sandbox when regression commands exist without sandbox report", async () => {
		const fixture = await createFixture();
		const settingsPath = await writeSettings(fixture.dir);
		const proposal = approve(
			fixture.store,
			settingsProposal({ patch: { model: "safe" }, regressionCommands: [{ argv: ["bun", "test"] }] }),
		);
		fixture.store.setLastEval(proposal.id, evalReport({ patchHash: hashPatch(proposal) }));

		await expect(
			applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, settingsPath }),
		).rejects.toBeInstanceOf(ApplyProposalRejectedError);
		expect(lastApplyRejectedReason(fixture.db, proposal.id)).toBe("missing-sandbox");
	});

	test("rejects sandbox-fail when sandbox ok is false", async () => {
		const fixture = await createFixture();
		const settingsPath = await writeSettings(fixture.dir);
		const proposal = approve(
			fixture.store,
			settingsProposal({ patch: { model: "safe" }, regressionCommands: [{ argv: ["bun", "test"] }] }),
		);
		fixture.store.setLastEval(proposal.id, evalReport({ patchHash: hashPatch(proposal), sandbox: { ok: false } }));

		await expect(
			applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, settingsPath }),
		).rejects.toMatchObject({
			reason: "sandbox-fail",
		});
		expect(lastApplyRejectedReason(fixture.db, proposal.id)).toBe("sandbox-fail");
	});

	test("allows apply when proposal has no regression commands", async () => {
		const fixture = await createFixture();
		const settingsPath = await writeSettings(fixture.dir);
		const proposal = approve(fixture.store, settingsProposal({ patch: { model: "human-reviewed" } }));

		await applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, settingsPath });

		expect(fixture.store.get(proposal.id)?.status).toBe("applied");
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({ model: "human-reviewed" });
	});
});

async function createFixture(): Promise<{ dir: string; store: ProposalStore; db: Database }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-regression-gate-"));
	const dbPath = path.join(dir, "proposals.db");
	const store = new ProposalStore(dbPath);
	const db = new Database(dbPath, { create: true, strict: true });
	cleanups.push(() => db.close());
	cleanups.push(() => store.close());
	cleanups.push(() => fs.rm(dir, { force: true, recursive: true }));
	return { dir, store, db };
}

async function writeSettings(dir: string): Promise<string> {
	const settingsPath = path.join(dir, "settings.json");
	await fs.writeFile(settingsPath, `${JSON.stringify({ model: "default" })}\n`);
	return settingsPath;
}

function approve(store: ProposalStore, proposal: NewLearningProposal) {
	return store.approve(store.create(proposal).id, "test");
}

function settingsProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "settings",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1 },
		provenance: { source: "manual" },
		patch: { enabled: true },
		reason: "test",
		rollback: {},
		...overrides,
	} as NewLearningProposal;
}

function evalReport(overrides: { patchHash: string; sandbox?: { ok: boolean } }): EvalReport {
	return {
		passed: overrides.sandbox?.ok ?? true,
		stage: "done",
		signals: {},
		durationMs: 1,
		patchHash: overrides.patchHash,
		...(overrides.sandbox
			? {
					sandbox: {
						ok: overrides.sandbox.ok,
						perCommand: [],
						revertedCleanly: true,
					},
				}
			: {}),
	};
}

function mutatePayload(db: Database, proposalId: string, patch: Record<string, unknown>): void {
	const row = db.query("SELECT payload FROM learning_proposals WHERE id = ?").get(proposalId) as { payload: string };
	db.query("UPDATE learning_proposals SET payload = ? WHERE id = ?").run(
		JSON.stringify({ ...JSON.parse(row.payload), ...patch }),
		proposalId,
	);
}

function lastApplyRejectedReason(db: Database, proposalId: string): string | undefined {
	const row = db
		.query(
			`SELECT payload FROM learning_proposal_events
			WHERE proposal_id = ? AND kind = 'apply-rejected'
			ORDER BY ts DESC
			LIMIT 1`,
		)
		.get(proposalId) as { payload: string } | null;
	return row ? (JSON.parse(row.payload).reason as string) : undefined;
}
