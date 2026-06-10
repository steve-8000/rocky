import { describe, expect, test } from "bun:test";
import { MISSION_INTENT_REQUIRES_MISSION } from "../../src/mission/policy/intent";

describe("MISSION_INTENT_REQUIRES_MISSION", () => {
	test("architecture_change is in MISSION_INTENT_REQUIRES_MISSION", () => {
		expect(MISSION_INTENT_REQUIRES_MISSION.has("architecture_change")).toBe(true);
	});

	test("runtime_refactor is in MISSION_INTENT_REQUIRES_MISSION", () => {
		expect(MISSION_INTENT_REQUIRES_MISSION.has("runtime_refactor")).toBe(true);
	});

	test("external_side_effect is in MISSION_INTENT_REQUIRES_MISSION", () => {
		expect(MISSION_INTENT_REQUIRES_MISSION.has("external_side_effect")).toBe(true);
	});

	test("code_change is in MISSION_INTENT_REQUIRES_MISSION", () => {
		expect(MISSION_INTENT_REQUIRES_MISSION.has("code_change")).toBe(true);
	});

	test("conversation / question_answering / repo_exploration are NOT in the set", () => {
		expect(MISSION_INTENT_REQUIRES_MISSION.has("conversation")).toBe(false);
		expect(MISSION_INTENT_REQUIRES_MISSION.has("question_answering")).toBe(false);
		expect(MISSION_INTENT_REQUIRES_MISSION.has("repo_exploration")).toBe(false);
	});
});
