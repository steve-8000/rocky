import { afterEach, describe, expect, test } from "bun:test";
import type { MissionInput } from "../../src/mission/core/mission-input";
import type { MissionOutcome } from "../../src/mission/core/mission-outcome";
import { MissionAcceptanceFailureError, MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
import { MissionStore } from "../../src/mission/store";

const runtimes: MissionRuntimeImpl[] = [];
const stores: MissionStore[] = [];

function createRuntime(): MissionRuntimeImpl {
	const store = new MissionStore(":memory:");
	stores.push(store);
	const runtime = new MissionRuntimeImpl({ store });
	runtimes.push(runtime);
	return runtime;
}

function baseInput(overrides: Partial<MissionInput> = {}): MissionInput {
	return {
		title: "Verifier authority",
		objective: "Honor verifier verdicts",
		riskLevel: "low",
		acceptanceCriteria: [
			{ id: "c1", description: "tests pass", satisfied: false, verificationMethod: "command-exit" },
			{ id: "c2", description: "review done", satisfied: false },
		],
		...overrides,
	};
}

function outcome(): MissionOutcome {
	return { status: "success", summary: "done", recordedAt: Date.now() };
}

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// Runtime may already own the close.
		}
	}
});

describe("verifier verdict authority", () => {
	test("recordVerification pass flips all criteria satisfied", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput());

		const updated = runtime.recordVerification(mission.id, {
			status: "pass",
			verdict: "pass",
			summary: "Verifier passed the mission.",
		});

		expect(updated.acceptanceCriteria.map(c => c.satisfied)).toEqual([true, true]);
	});

	test("complete succeeds when verdict is pass even if a criterion flag is later stale false", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput());
		runtime.recordVerification(mission.id, {
			status: "pass",
			verdict: "pass",
			summary: "Verifier passed the mission.",
		});
		mission.acceptanceCriteria[0]!.satisfied = false;

		const completed = await runtime.complete(mission.id, { outcome: outcome() });

		expect(completed.lifecycle).toBe("completed");
	});

	test("complete refuses fail verdict even when all criteria are satisfied, while force bypasses", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(
			baseInput({
				acceptanceCriteria: [
					{ id: "c1", description: "tests pass", satisfied: true, verificationMethod: "command-exit" },
				],
			}),
		);
		runtime.recordVerification(mission.id, {
			status: "fail",
			verdict: "fail",
			summary: "Verifier failed the mission.",
			failedCount: 1,
		});

		await expect(runtime.complete(mission.id, { outcome: outcome() })).rejects.toBeInstanceOf(
			MissionAcceptanceFailureError,
		);

		mission.verification = { status: "force", verdict: "pass", summary: "Forced by operator." };
		const completed = await runtime.complete(mission.id, { outcome: outcome() });
		expect(completed.lifecycle).toBe("completed");
	});
});
