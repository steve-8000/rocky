import { describe, expect, it } from "bun:test";
import { parsePlanModeState } from "@amaze/coding-agent/plan-mode/state";

describe("plan-mode state", () => {
	it("parses persisted plan mode data", () => {
		const parsed = parsePlanModeState({ planFilePath: "local://PLAN.md", workflow: "parallel" });

		expect(parsed).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: undefined,
			goalId: undefined,
			goalObjective: undefined,
			goalTokenBudget: undefined,
			goalContractRevision: undefined,
		});
	});
});
