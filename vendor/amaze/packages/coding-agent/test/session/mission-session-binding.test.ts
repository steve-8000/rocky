import { describe, expect, test } from "bun:test";
import { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { MissionStore } from "../../src/mission/store";
import { MissionSessionBinding } from "../../src/session/mission-session-binding";

describe("MissionSessionBinding", () => {
	test("constructs MissionStore + MissionControlRuntime and the runtime exposes getActiveMission()", () => {
		const binding = new MissionSessionBinding({ dbPath: ":memory:" });
		try {
			expect(binding.store).toBeInstanceOf(MissionStore);
			expect(binding.runtime).toBeInstanceOf(MissionControlRuntime);
			expect(binding.runtime.getActiveMission()).toBeUndefined();
		} finally {
			binding.dispose();
		}
	});

	test("binding.setActiveMissionId / getActiveMissionId roundtrip when no callbacks supplied", () => {
		const binding = new MissionSessionBinding({ dbPath: ":memory:" });
		try {
			binding.setActiveMissionId("mission-1");
			expect(binding.getActiveMissionId()).toBe("mission-1");
			binding.setActiveMissionId(undefined);
			expect(binding.getActiveMissionId()).toBeUndefined();
		} finally {
			binding.dispose();
		}
	});

	test("binding forwards setActiveMissionId / getActiveMissionId to caller-supplied callbacks", async () => {
		let active: string | undefined;
		const binding = new MissionSessionBinding({
			dbPath: ":memory:",
			setActiveMissionId: id => {
				active = id;
			},
			getActiveMissionId: () => active,
		});
		try {
			await binding.runtime.ensureActiveMission({ content: "아키텍처를 재설계하자" });

			expect(active).toBeString();
			expect(binding.getActiveMissionId()).toBe(active);
			expect(binding.runtime.getActiveMission()?.id).toBe(active);
		} finally {
			binding.dispose();
		}
	});

	test("binding.dispose() closes the store cleanly", () => {
		const binding = new MissionSessionBinding({ dbPath: ":memory:" });

		expect(() => binding.dispose()).not.toThrow();
		expect(() => binding.dispose()).not.toThrow();
	});
});
