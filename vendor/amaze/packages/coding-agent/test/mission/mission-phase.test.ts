import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcceptanceCriterion } from "../../src/mission/core/acceptance-criteria";
import { normalizePlanStepEdges } from "../../src/mission/core/mission";
import type { MissionInput } from "../../src/mission/core/mission-input";
import type { MissionOutcome } from "../../src/mission/core/mission-outcome";
import { MissionAcceptanceFailureError, MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionEventBus } from "../../src/mission/event-bus";
import { MissionStore } from "../../src/mission/store";

const runtimes: MissionRuntimeImpl[] = [];
const stores: MissionStore[] = [];
const dbPaths: string[] = [];

function createStore(dbPath = ":memory:"): MissionStore {
	const store = new MissionStore(dbPath, new MissionEventBus());
	stores.push(store);
	return store;
}

function createRuntime(store = createStore()): MissionRuntimeImpl {
	const runtime = new MissionRuntimeImpl({ store, eventBus: new MissionEventBus(), now: () => Date.now() });
	runtimes.push(runtime);
	return runtime;
}

function tmpDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-mission-phase-"));
	const dbPath = path.join(dir, "mission.db");
	dbPaths.push(dbPath, dir);
	return dbPath;
}

function baseInput(overrides: Partial<MissionInput> = {}): MissionInput {
	return {
		title: "Phase mission",
		objective: "Deliver phased work",
		riskLevel: "low",
		...overrides,
	};
}

function outcome(): MissionOutcome {
	return { status: "success", summary: "done", recordedAt: Date.now() };
}

const passing: AcceptanceCriterion[] = [{ id: "c1", description: "done", satisfied: true }];
const failing: AcceptanceCriterion[] = [
	{ id: "c1", description: "tests pass", satisfied: false, verificationMethod: "command-exit" },
];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// already closed by the owning runtime
		}
	}
	for (const target of dbPaths.splice(0)) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

describe("MissionPhase runtime", () => {
	test("declarePhases persists, hydrates, and rejects duplicate ordinals", async () => {
		const dbPath = tmpDbPath();
		const store = createStore(dbPath);
		const runtime = createRuntime(store);
		const mission = await runtime.create(baseInput());
		const phases = await runtime.declarePhases(mission.id, [
			{ id: "phase-discovery", ordinal: 0, name: "Discovery", planStepIds: ["s1"], acceptanceCriteria: passing },
			{ id: "phase-quarantine", ordinal: 1, name: "Quarantine" },
		]);

		expect(phases.map(phase => phase.name)).toEqual(["Discovery", "Quarantine"]);
		expect((await runtime.get(mission.id))?.phases).toHaveLength(2);
		await expect(
			runtime.declarePhases(mission.id, [
				{ ordinal: 2, name: "A" },
				{ ordinal: 2, name: "B" },
			]),
		).rejects.toThrow("Duplicate mission phase ordinal");

		runtime.close();
		store.close();
		const freshStore = createStore(dbPath);
		const freshRuntime = createRuntime(freshStore);
		const hydrated = await freshRuntime.get(mission.id);
		expect(hydrated?.phases?.map(phase => phase.id)).toEqual(["phase-discovery", "phase-quarantine"]);
	});

	test("verifyPhase passes satisfied criteria and persists a verification record", async () => {
		const store = createStore();
		const runtime = createRuntime(store);
		const mission = await runtime.create(baseInput());
		const [phase] = await runtime.declarePhases(mission.id, [
			{ ordinal: 0, name: "Discovery", acceptanceCriteria: passing },
		]);
		if (!phase) throw new Error("phase missing");

		const result = await runtime.verifyPhase(mission.id, phase.id);

		expect(result.verification.status).toBe("pass");
		expect(store.listPhaseVerifications(mission.id)).toHaveLength(1);
		expect((await runtime.get(mission.id))?.phases?.[0]?.verification?.status).toBe("pass");
	});

	test("verifyPhase fails unsatisfied criteria with verification methods", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput());
		const [phase] = await runtime.declarePhases(mission.id, [
			{ ordinal: 0, name: "Discovery", acceptanceCriteria: failing },
		]);
		if (!phase) throw new Error("phase missing");

		const result = await runtime.verifyPhase(mission.id, phase.id);

		expect(result.verification.status).toBe("fail");
		expect((await runtime.get(mission.id))?.phases?.[0]?.status).toBe("failed");
	});

	test("closePhase closes a verified phase", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput());
		const [phase] = await runtime.declarePhases(mission.id, [
			{ ordinal: 0, name: "Discovery", acceptanceCriteria: passing },
		]);
		if (!phase) throw new Error("phase missing");
		await runtime.verifyPhase(mission.id, phase.id);

		const closed = await runtime.closePhase(mission.id, phase.id);

		expect(closed.status).toBe("verified");
		expect(closed.closedAt).toBeNumber();
	});

	test("complete rejects when any declared phase is not verified", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput());
		await runtime.declarePhases(mission.id, [{ ordinal: 0, name: "Discovery", acceptanceCriteria: passing }]);

		await expect(runtime.complete(mission.id, { outcome: outcome() })).rejects.toBeInstanceOf(
			MissionAcceptanceFailureError,
		);
	});

	test("complete succeeds when all declared phases are verified", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ acceptanceCriteria: passing }));
		const [phase] = await runtime.declarePhases(mission.id, [
			{ ordinal: 0, name: "Discovery", acceptanceCriteria: passing },
		]);
		if (!phase) throw new Error("phase missing");
		await runtime.verifyPhase(mission.id, phase.id);
		await runtime.closePhase(mission.id, phase.id);
		await runtime.verify(mission.id);

		const completed = await runtime.complete(mission.id, { outcome: outcome() });

		expect(completed.lifecycle).toBe("completed");
	});
});

describe("normalizePlanStepEdges", () => {
	test("deduplicates dependsOn, preserves order, and handles absent edges", () => {
		expect(normalizePlanStepEdges({ id: "s0", description: "empty" })).toEqual([]);
		expect(
			normalizePlanStepEdges({
				id: "s1",
				description: "mixed",
				edges: [
					{ target: "b", kind: "produces", invariant: "artifact" },
					{ target: "a", kind: "depends-on" },
				],
				dependsOn: ["a", "c"],
			}),
		).toEqual([
			{ target: "b", kind: "produces", invariant: "artifact" },
			{ target: "a", kind: "depends-on" },
			{ target: "c", kind: "depends-on" },
		]);
	});

	test("normalizes duplicate dependsOn and edges to a single depends-on edge", () => {
		expect(
			normalizePlanStepEdges({
				id: "s1",
				description: "duplicate",
				dependsOn: ["a"],
				edges: [{ target: "a", kind: "depends-on" }],
			}),
		).toEqual([{ target: "a", kind: "depends-on" }]);
	});
});
