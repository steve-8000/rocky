import { afterEach, describe, expect, test } from "bun:test";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import type { MissionTaskDispatcher } from "../../src/mission/core/mission-task-dispatcher";
import { MissionEventBus } from "../../src/mission/event-bus";
import type { MissionEvent } from "../../src/mission/events";
import { MissionStore } from "../../src/mission/store";

const runtimes: MissionRuntimeImpl[] = [];
const stores: MissionStore[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {}
	}
});

describe("MissionRuntimeImpl.execute", () => {
	test("dispatches selected mission tasks and records attempts", async () => {
		const bus = new MissionEventBus();
		const events: MissionEvent[] = [];
		bus.subscribe(e => events.push(e));
		const store = new MissionStore(":memory:", bus);
		stores.push(store);
		const calls: Parameters<MissionTaskDispatcher["run"]>[] = [];
		const dispatcher = {
			async run(...args: Parameters<MissionTaskDispatcher["run"]>) {
				calls.push(args);
				args[1].recordAttempt("t1", "success");
				return { completedTaskIds: ["t1"], failedTaskIds: [], blocked: false };
			},
		} satisfies Pick<MissionTaskDispatcher, "run">;
		const runtime = new MissionRuntimeImpl({
			store,
			eventBus: bus,
			dispatcher: dispatcher as unknown as MissionTaskDispatcher,
		});
		runtimes.push(runtime);

		const mission = await runtime.create({ title: "Run task", objective: "Implement feature" });
		mission.tasks = [{ id: "t1", missionId: mission.id, title: "task one", status: "pending" }];

		const result = await runtime.execute(mission.id);

		expect(result).toEqual({ completedTaskIds: ["t1"], failedTaskIds: [], blocked: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0].map(t => t.id)).toEqual(["t1"]);
		expect((await runtime.get(mission.id))?.tasks[0]?.status).toBe("completed");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "mission.task.attempt",
				missionId: mission.id,
				taskId: "t1",
				verdict: "success",
			}),
		);
	});
});
