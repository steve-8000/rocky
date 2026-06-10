import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type NewLearningProposal, ProposalStore } from "../../src/learning";
import { applyProposal, rollbackProposal } from "../../src/learning/apply";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

describe("versioned proposal apply and rollback", () => {
	test("settings proposal applies patch and rollback restores original settings", async () => {
		const fixture = await createFixture();
		const settingsPath = path.join(fixture.dir, "settings.json");
		await fs.writeFile(settingsPath, `${JSON.stringify({ model: "a", nested: { enabled: false, keep: true } })}\n`);
		const proposal = approve(
			fixture.store,
			settingsProposal({
				patch: { model: "b", nested: { enabled: true } },
				rollback: { model: "a", nested: { enabled: false } },
			}),
		);

		const result = await applyProposal({
			store: fixture.store,
			db: fixture.db,
			proposalId: proposal.id,
			settingsPath,
		});

		expect(result.version).toBeString();
		expect(result.snapshotRef).toBe(`${proposal.id}:${result.version}`);
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({
			model: "b",
			nested: { enabled: true, keep: true },
		});
		expect(fixture.store.get(proposal.id)?.status).toBe("applied");

		await rollbackProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id });

		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({
			model: "a",
			nested: { enabled: false, keep: true },
		});
		expect(fixture.store.get(proposal.id)?.status).toBe("rolled-back");
	});

	test("skill proposal creates missing skill file and rollback deletes it", async () => {
		const fixture = await createFixture();
		const skillsDir = path.join(fixture.dir, "skills");
		const proposal = approve(
			fixture.store,
			skillProposal({ name: "debug-helper", bodyMarkdown: "# Debug Helper\n" }),
		);
		const skillPath = path.join(skillsDir, "debug-helper", "SKILL.md");

		await applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, skillsDir });

		expect(await fs.readFile(skillPath, "utf8")).toBe("# Debug Helper\n");
		expect(fixture.store.get(proposal.id)?.status).toBe("applied");

		await rollbackProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id });

		expect(await exists(skillPath)).toBe(false);
		expect(fixture.store.get(proposal.id)?.status).toBe("rolled-back");
	});

	test("rule proposal replaces existing rule file and rollback restores it", async () => {
		const fixture = await createFixture();
		const rulesDir = path.join(fixture.dir, "rules");
		await fs.mkdir(rulesDir, { recursive: true });
		const proposal = approve(fixture.store, ruleProposal({ ruleMarkdown: "# New Rule\n" }));
		const rulePath = path.join(rulesDir, `${proposal.id}.rule.md`);
		await fs.writeFile(rulePath, "# Old Rule\n");

		await applyProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id, rulesDir });

		expect(await fs.readFile(rulePath, "utf8")).toBe("# New Rule\n");
		expect(fixture.store.get(proposal.id)?.status).toBe("applied");

		await rollbackProposal({ store: fixture.store, db: fixture.db, proposalId: proposal.id });

		expect(await fs.readFile(rulePath, "utf8")).toBe("# Old Rule\n");
		expect(fixture.store.get(proposal.id)?.status).toBe("rolled-back");
	});

	test("markApplied rejects a second applied transition", async () => {
		const fixture = await createFixture();
		const settingsPath = path.join(fixture.dir, "settings.json");
		await fs.writeFile(settingsPath, "{}\n");
		const proposal = approve(fixture.store, settingsProposal({ patch: { enabled: true }, rollback: {} }));
		const { version } = await applyProposal({
			store: fixture.store,
			db: fixture.db,
			proposalId: proposal.id,
			settingsPath,
		});

		expect(() => fixture.store.markApplied(proposal.id, version)).toThrow(
			/Invalid learning proposal transition: applied -> applied/,
		);
	});
});

async function createFixture(): Promise<{ dir: string; store: ProposalStore; db: Database }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-rollback-"));
	const dbPath = path.join(dir, "proposals.db");
	const store = new ProposalStore(dbPath);
	const db = new Database(dbPath, { create: true, strict: true });
	cleanups.push(() => db.close());
	cleanups.push(() => store.close());
	cleanups.push(() => fs.rm(dir, { force: true, recursive: true }));
	return { dir, store, db };
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

function skillProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "skill",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1 },
		provenance: { source: "manual" },
		name: "debug-helper",
		sourceMemoryIds: ["memory-1", "memory-2"],
		bodyMarkdown: "# Debug Helper\n",
		...overrides,
	} as NewLearningProposal;
}

function ruleProposal(overrides: Partial<NewLearningProposal> = {}): NewLearningProposal {
	return {
		type: "rule",
		gate: "review",
		evidence: { sessionIds: ["session-1"], eventRefs: ["events.jsonl:1"], sampleN: 1 },
		provenance: { source: "manual" },
		ruleMarkdown: "# New Rule\n",
		replaySessions: ["session-1"],
		expectedImpact: "test",
		...overrides,
	} as NewLearningProposal;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}
