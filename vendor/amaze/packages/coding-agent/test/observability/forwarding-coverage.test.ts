import { describe, expect, it } from "bun:test";
import { MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";
import { getSessionEventBus } from "../../src/observability/session-bus";

describe("observability forwarding coverage", () => {
	it("forwards mission lifecycle events to the mission store bus", async () => {
		const session = {};
		const bus = getSessionEventBus(session);
		const store = new MissionStore(":memory:");
		const runtime = new MissionRuntimeImpl({ store });
		try {
			const mission = await runtime.create({
				title: "ship forwarding",
				objective: "ship forwarding",
				riskLevel: "low",
			});
			runtime.recordVerification(mission.id, { status: "pass", summary: "ok" });
			await runtime.complete(mission.id, { outcome: { status: "success", summary: "done", recordedAt: 1234 } });
			expect(runtime.runtimeEvents().some(event => event.detail?.kind === "mission_updated")).toBe(true);
			expect(bus.snapshot()).toEqual([]);
		} finally {
			runtime.close();
			store.close();
		}
	});

	it("uses a single event bus per session object", () => {
		const session = {};
		expect(getSessionEventBus(session)).toBe(getSessionEventBus(session));
	});
});
