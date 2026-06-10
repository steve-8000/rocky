import { describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";

describe("mission budget accounting", () => {
	test("recordTaskUsage updates active mission budget", async () => {
		const store = new MissionStore(":memory:");
		let activeId: string | undefined;
		const control = new MissionControlRuntime({
			store,
			getActiveMissionId: () => activeId,
			setActiveMissionId: id => {
				activeId = id;
			},
		});
		const mission = await control.createMission({ title: "Budget", objective: "Track usage", riskLevel: "low" });

		control.recordTaskUsage(mission.id, 250);

		expect(control.getActiveMission()?.budget.tokensUsed).toBe(250);
		store.close();
	});
});
