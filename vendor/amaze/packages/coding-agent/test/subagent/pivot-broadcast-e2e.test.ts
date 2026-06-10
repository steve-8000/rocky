import { describe, expect, it } from "bun:test";
import { isSubagentContractStale, type SubagentContract } from "@amaze/coding-agent/subagent/contract";

describe("subagent contract revision", () => {
	it("detects stale parent mission revisions", () => {
		const contract: SubagentContract = {
			role: "refactor-applier",
			parentMissionRev: 1,
			scope: { include: ["src/**"], exclude: [] },
			successCriteria: [],
			escalation: { onUncertainty: "ask-parent", budgetCap: 25000 },
		};

		expect(isSubagentContractStale(contract, 1)).toBe(false);
		expect(isSubagentContractStale(contract, 2)).toBe(true);
	});
});
