import { afterEach, describe, expect, test } from "bun:test";
import { MissionStore } from "../../src/mission/store";
import type { NewResearchCampaign } from "../../src/mission/types";

const stores: MissionStore[] = [];

function createStore(): MissionStore {
	const store = new MissionStore(":memory:");
	stores.push(store);
	return store;
}

function newMission(overrides: Partial<NewResearchCampaign> = {}): NewResearchCampaign {
	return {
		title: "Ship X",
		objectiveId: "obj-1",
		briefId: "brief-1",
		decisionId: null,
		riskLevel: "medium",
		state: "drafting",
		confidence: null,
		snapshotRef: null,
		...overrides,
	};
}

function seedMission(store: MissionStore): string {
	return store.createMission(newMission()).id;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("mission continuation ledger", () => {
	test("ensureContinuation is idempotent and starts idle@0", () => {
		const store = createStore();
		const id = seedMission(store);
		const a = store.ensureContinuation(id);
		const b = store.ensureContinuation(id);
		expect(a.status).toBe("idle");
		expect(a.generation).toBe(0);
		expect(b.updatedAt).toBe(a.updatedAt);
	});

	test("scheduleNext CAS succeeds once then suppresses duplicates at the same generation", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);

		const first = store.scheduleNextContinuation(id, 0, "auto");
		expect(first?.status).toBe("scheduled");
		expect(first?.generation).toBe(1);

		// Duplicate writer using the stale expected generation is suppressed.
		const dup = store.scheduleNextContinuation(id, 0, "auto");
		expect(dup).toBeUndefined();
	});

	test("markRunning increments autoTurnCount exactly once on scheduled→running", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);
		const scheduled = store.scheduleNextContinuation(id, 0)!;

		const running = store.markContinuationRunning(id, scheduled.generation, "turn-1");
		expect(running?.status).toBe("running");
		expect(running?.autoTurnCount).toBe(1);

		// A second markRunning at the same generation no longer matches scheduled.
		const again = store.markContinuationRunning(id, scheduled.generation, "turn-1");
		expect(again).toBeUndefined();
		expect(store.getContinuation(id)?.autoTurnCount).toBe(1);
	});

	test("markIdleAfterEnd only matches the running generation", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);
		const g = store.scheduleNextContinuation(id, 0)!.generation;
		store.markContinuationRunning(id, g);

		expect(store.markContinuationIdleAfterEnd(id, g + 1)).toBeUndefined();
		const idle = store.markContinuationIdleAfterEnd(id, g);
		expect(idle?.status).toBe("idle");
	});

	test("reconcileRunningToIdle clears stale scheduled/running unconditionally", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);
		store.scheduleNextContinuation(id, 0);
		const reconciled = store.reconcileContinuationRunningToIdle(id, "restart");
		expect(reconciled?.status).toBe("idle");
		expect(reconciled?.lastReason).toBe("restart");
	});

	test("recordProgress advances no-progress count only on identical fingerprint", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);

		expect(store.recordContinuationProgress(id, "fp-a")?.noProgressCount).toBe(0);
		expect(store.recordContinuationProgress(id, "fp-a")?.noProgressCount).toBe(1);
		expect(store.recordContinuationProgress(id, "fp-a")?.noProgressCount).toBe(2);
		// Fingerprint changed → counter resets.
		expect(store.recordContinuationProgress(id, "fp-b")?.noProgressCount).toBe(0);
	});

	test("accountUsage adds only positive deltas", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);
		store.accountContinuationUsage(id, 100, 5);
		store.accountContinuationUsage(id, -50, -2);
		const rec = store.getContinuation(id);
		expect(rec?.tokensUsed).toBe(100);
		expect(rec?.timeUsedSeconds).toBe(5);
	});

	test("at most one scheduled|running row per mission across a full cycle", () => {
		const store = createStore();
		const id = seedMission(store);
		store.ensureContinuation(id);
		const g1 = store.scheduleNextContinuation(id, 0)!.generation;
		store.markContinuationRunning(id, g1);
		store.markContinuationIdleAfterEnd(id, g1);
		const g2 = store.scheduleNextContinuation(id, g1)!.generation;
		expect(g2).toBe(g1 + 1);
		// Cannot schedule again while already scheduled.
		expect(store.scheduleNextContinuation(id, g2)).toBeUndefined();
	});
});
