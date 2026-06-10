/**
 * V3 T4-H — structural stale-contract enforcement proof.
 *
 *   - `enforceContractFreshness`: reports stale metadata when parent has advanced past
 *     the stamped baseline; fresh on matching, missing data, or no stamped revision.
 *
 * Together these make staleness detection STRUCTURAL: parent stamps at spawn, subagent (or
 * any turn-start hook) calls enforce, mismatch yields a structured comparison result.
 */

import { describe, expect, it } from "bun:test";
import {
	enforceContractFreshness,
	type SubagentContract,
	stampContractRevision,
} from "@amaze/coding-agent/subagent/contract";

const blank = (overrides: Partial<SubagentContract> = {}): SubagentContract => ({
	role: "refactor-applier",
	scope: { include: [], exclude: [] },
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
	...overrides,
});

describe("stampContractRevision", () => {
	it("stamps current parent revision when contract baseline is missing", () => {
		const contract = blank();
		const stamped = stampContractRevision(contract, 5);
		expect(stamped.parentMissionRev).toBe(5);
		// Input not mutated (functional invariant).
		expect(contract.parentMissionRev).toBeUndefined();
	});

	it("preserves explicit baseline (idempotent — does not overwrite)", () => {
		const contract = blank({ parentMissionRev: 3 });
		const stamped = stampContractRevision(contract, 7);
		expect(stamped.parentMissionRev).toBe(3);
	});

	it("no-op when parent revision is undefined", () => {
		const contract = blank();
		const stamped = stampContractRevision(contract, undefined);
		expect(stamped).toBe(contract); // same reference: cheap when no-op
	});
});

describe("enforceContractFreshness", () => {
	it("reports stale metadata when parent revision exceeds baseline", () => {
		const result = enforceContractFreshness(2, 3);

		expect(result).toEqual({ stale: true, staleness: { stamped: 2, current: 3 } });
	});

	it("fresh when revisions match (equality is fresh, not stale)", () => {
		expect(enforceContractFreshness(5, 5)).toEqual({ stale: false });
	});

	it("fresh when parent is older than baseline (nonsense direction, treat as fresh)", () => {
		expect(enforceContractFreshness(5, 2)).toEqual({ stale: false });
	});

	it("fresh when contract has no baseline (back-compat path)", () => {
		expect(enforceContractFreshness(undefined, 99)).toEqual({ stale: false });
	});

	it("fresh when parent revision is undefined (no comparison possible)", () => {
		expect(enforceContractFreshness(1, undefined)).toEqual({ stale: false });
	});

	it("PHASE T4-H ACCEPTANCE: stale detection is STRUCTURAL — same input twice produces same result", () => {
		const result1 = enforceContractFreshness(1, 2);
		const result2 = enforceContractFreshness(1, 2);

		expect(result1).toEqual({ stale: true, staleness: { stamped: 1, current: 2 } });
		expect(result2).toEqual(result1);
	});
});
