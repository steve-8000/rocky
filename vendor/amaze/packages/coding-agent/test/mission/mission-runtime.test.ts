import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceCriterion } from "../../src/mission/core/acceptance-criteria";
import type { Mission, MissionReview } from "../../src/mission/core/mission";
import type { MissionInput } from "../../src/mission/core/mission-input";
import type { MissionOutcome } from "../../src/mission/core/mission-outcome";
import {
	MissionAcceptanceFailureError,
	MissionRuntimeImpl,
	missionTokenDelta,
} from "../../src/mission/core/mission-runtime";
import {
	type DispatchContext,
	MissionTaskDispatcher,
	type MissionTaskDispatchResult,
} from "../../src/mission/core/mission-task-dispatcher";
import { MissionEventBus } from "../../src/mission/event-bus";
import type { MissionEvent } from "../../src/mission/events";
import { MissionStore } from "../../src/mission/store";

const runtimes: MissionRuntimeImpl[] = [];
const stores: MissionStore[] = [];

class CompletingDispatcher extends MissionTaskDispatcher {
	override async run(tasks: Mission["tasks"], _ctx: DispatchContext): Promise<MissionTaskDispatchResult> {
		return { completedTaskIds: tasks.map(task => task.id), failedTaskIds: [], blocked: false };
	}
}

const completingDispatcher = new CompletingDispatcher();

function createRuntime(options: ConstructorParameters<typeof MissionRuntimeImpl>[0] = {}): {
	runtime: MissionRuntimeImpl;
	bus: MissionEventBus;
	events: MissionEvent[];
} {
	const bus = new MissionEventBus();
	const events: MissionEvent[] = [];
	bus.subscribe(e => events.push(e));
	const store = new MissionStore(":memory:", bus);
	stores.push(store);
	const runtime = new MissionRuntimeImpl({ store, eventBus: bus, now: () => Date.now(), ...options });
	runtimes.push(runtime);
	return { runtime, bus, events };
}

function baseInput(overrides: Partial<MissionInput> = {}): MissionInput {
	return {
		title: "Ship the thing",
		objective: "Deliver a working feature",
		riskLevel: "low",
		budget: { tokenBudget: 10_000, tokensUsed: 0 },
		...overrides,
	};
}

function outcome(): MissionOutcome {
	return { status: "success", summary: "done", recordedAt: Date.now() };
}

function passingReview(sourceFiles: string[] = ["src/feature.ts"]): MissionReview {
	return {
		status: "pass",
		verdict: "pass",
		summary: "review passed",
		failedCount: 0,
		uncertainCount: 0,
		sourceFiles,
		excludedMarkdownFiles: [],
		createdAt: Date.now(),
		reviewedAt: Date.now(),
	};
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// already closed by the owning runtime
		}
	}
});

describe("missionTokenDelta", () => {
	test("counts input + cacheWrite + output, excludes cacheRead", () => {
		const delta = missionTokenDelta(
			{ input: 100, output: 50, cacheRead: 999, cacheWrite: 30 },
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 5 },
		);
		expect(delta).toBe(90 + 45 + 25);
	});

	test("clamps negative components to zero", () => {
		const delta = missionTokenDelta(
			{ input: 5, output: 5, cacheRead: 0, cacheWrite: 5 },
			{ input: 10, output: 10, cacheRead: 0, cacheWrite: 10 },
		);
		expect(delta).toBe(0);
	});
});

describe("MissionRuntime lifecycle", () => {
	test("full lifecycle create -> classify -> plan -> execute -> verify -> complete", async () => {
		const { runtime, events } = createRuntime({ dispatcher: completingDispatcher });
		const mission = await runtime.create(baseInput());
		expect(mission.lifecycle).toBe("created");

		const classified = await runtime.classify(mission.id);
		expect(classified.riskLevel).toBe("low");
		expect(classified.intent).toBe("code_change");
		expect((await runtime.get(mission.id))?.lifecycle).toBe("classified");

		// Seed a plan so plan() derives tasks.
		const got = await runtime.get(mission.id);
		if (got) {
			got.plan = {
				steps: [
					{ id: "s1", description: "step one" },
					{ id: "s2", description: "step two" },
				],
			};
		}
		const planResult = await runtime.plan(mission.id);
		expect(planResult.plan.steps).toHaveLength(2);
		expect((await runtime.get(mission.id))?.lifecycle).toBe("planning");
		expect((await runtime.get(mission.id))?.tasks).toHaveLength(2);

		const exec = await runtime.execute(mission.id);
		expect(exec.completedTaskIds).toHaveLength(2);
		expect(exec.blocked).toBe(false);
		expect((await runtime.get(mission.id))?.lifecycle).toBe("executing");

		const verify = await runtime.verify(mission.id);
		expect(verify.verification.status).toBe("pass");
		runtime.recordReview(mission.id, passingReview(["src/mission-runtime.ts"]));

		const completed = await runtime.complete(mission.id, { outcome: outcome() });
		expect(completed.lifecycle).toBe("completed");
		expect(completed.outcome?.status).toBe("success");

		const types = events.map(e => e.type);
		expect(types).toContain("mission.created");
		expect(types).toContain("mission.classified");
		expect(types).toContain("mission.planned");
		expect(types).toContain("mission.task.completed");
		expect(types).toContain("mission.verification.completed");
		expect(types).toContain("mission.completed");
	});

	test("execute respects taskIds subset", async () => {
		const { runtime } = createRuntime({ dispatcher: completingDispatcher });
		const mission = await runtime.create(baseInput());
		const got = await runtime.get(mission.id);
		if (got)
			got.plan = {
				steps: [
					{ id: "s1", description: "one" },
					{ id: "s2", description: "two" },
				],
			};
		await runtime.plan(mission.id);
		const onlyFirst = got?.tasks[0]?.id;
		const exec = await runtime.execute(mission.id, { taskIds: onlyFirst ? [onlyFirst] : [] });
		expect(exec.completedTaskIds).toEqual(onlyFirst ? [onlyFirst] : []);
	});

	test("block transitions to blocked and records evidence", async () => {
		const { runtime, events } = createRuntime();
		const mission = await runtime.create(baseInput());
		const blocked = await runtime.block(mission.id, { reason: "waiting on input", evidenceRefs: ["ev-1"] });
		expect(blocked.lifecycle).toBe("blocked");
		expect(blocked.evidenceRefs).toContain("ev-1");
		expect(events.some(e => e.type === "mission.blocked")).toBe(true);
	});

	test("cancel transitions to cancelled", async () => {
		const { runtime, events } = createRuntime();
		const mission = await runtime.create(baseInput());
		const cancelled = await runtime.cancel(mission.id, { reason: "abandoned" });
		expect(cancelled.lifecycle).toBe("cancelled");
		const cancelEvent = events.find(e => e.type === "mission.cancelled");
		expect(cancelEvent && "reason" in cancelEvent ? cancelEvent.reason : undefined).toBe("abandoned");
	});

	test("get returns undefined for unknown mission", async () => {
		const { runtime } = createRuntime();
		expect(await runtime.get("missing")).toBeUndefined();
	});
});

describe("MissionRuntime acceptance verification parity", () => {
	const passing: AcceptanceCriterion[] = [{ id: "c1", description: "all good", satisfied: true }];
	const failing: AcceptanceCriterion[] = [
		{ id: "c1", description: "tests pass", satisfied: false, verificationMethod: "command-exit" },
	];

	test("complete passes when all criteria satisfied", async () => {
		const { runtime } = createRuntime();
		const mission = await runtime.create(baseInput({ acceptanceCriteria: passing }));
		const completed = await runtime.complete(mission.id, { outcome: outcome() });
		expect(completed.lifecycle).toBe("completed");
		expect(completed.verification?.status).toBe("pass");
	});

	test("complete throws MissionAcceptanceFailureError on a failing criterion", async () => {
		const { runtime } = createRuntime();
		const mission = await runtime.create(baseInput({ acceptanceCriteria: failing }));
		let thrown: unknown;
		try {
			await runtime.complete(mission.id, { outcome: outcome() });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MissionAcceptanceFailureError);
		const error = thrown as MissionAcceptanceFailureError;
		expect(error.failedCriteria.map(c => c.id)).toEqual(["c1"]);
		expect(error.verification.status).toBe("fail");
		// Mission stays uncompleted.
		expect((await runtime.get(mission.id))?.lifecycle).not.toBe("completed");
	});

	test("force bypass completes despite failing criteria", async () => {
		const { runtime } = createRuntime();
		const mission = await runtime.create(baseInput({ acceptanceCriteria: failing }));
		// verify(force) sets a force verdict that complete() honors.
		const verify = await runtime.verify(mission.id, { force: true });
		expect(verify.verification.status).toBe("force");
		const completed = await runtime.complete(mission.id, { outcome: outcome() });
		expect(completed.lifecycle).toBe("completed");
	});

	test("unsatisfied criterion without verification method is uncertain, not fail", async () => {
		const { runtime } = createRuntime();
		const mission = await runtime.create(
			baseInput({ acceptanceCriteria: [{ id: "c1", description: "manual", satisfied: false }] }),
		);
		const completed = await runtime.complete(mission.id, { outcome: outcome() });
		expect(completed.lifecycle).toBe("completed");
		expect(completed.verification?.status).toBe("uncertain");
	});
});

describe("MissionRuntime token accounting", () => {
	test("accountTokens accrues delta onto the mission budget and emits tool event", async () => {
		const { runtime, events } = createRuntime();
		const mission = await runtime.create(baseInput());
		const baseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const d1 = runtime.accountTokens(mission.id, {
			usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 10 },
			baseline,
			tool: "Edit",
		});
		expect(d1).toBe(150);
		const d2 = runtime.accountTokens(mission.id, {
			usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
			baseline,
			tool: "Read",
		});
		expect(d2).toBe(25);
		expect((await runtime.get(mission.id))?.budget.tokensUsed).toBe(175);
		expect(events.filter(e => e.type === "mission.tool.completed")).toHaveLength(2);
	});
});

describe("MissionRuntime.emit subscription seam", () => {
	test("emit records runtime events and notifies subscribers", () => {
		const { runtime } = createRuntime();
		const received: string[] = [];
		const unsub = runtime.emit({
			missionId: "m",
			lifecycle: "created",
			at: Date.now(),
			detail: { listener: (e: { missionId: string }) => received.push(e.missionId) },
		});
		expect(typeof unsub).toBe("function");
		runtime.emit({ missionId: "m2", lifecycle: "executing", at: Date.now() });
		expect(received).toEqual(["m2"]);
		expect(runtime.runtimeEvents()).toHaveLength(1);
		unsub?.();
		runtime.emit({ missionId: "m3", lifecycle: "completed", at: Date.now() });
		expect(received).toEqual(["m2"]);
	});
});
