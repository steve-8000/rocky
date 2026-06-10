import { afterEach, describe, expect, test } from "bun:test";
import type { MissionReview } from "../../src/mission/core/mission";
import type { MissionInput } from "../../src/mission/core/mission-input";
import type { MissionOutcome } from "../../src/mission/core/mission-outcome";
import { MissionAcceptanceFailureError, MissionRuntimeImpl } from "../../src/mission/core/mission-runtime";
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

function createRuntime(): MissionRuntimeImpl {
	const store = new MissionStore(":memory:");
	stores.push(store);
	const runtime = new MissionRuntimeImpl({ store });
	runtimes.push(runtime);
	return runtime;
}

function baseInput(overrides: Partial<MissionInput> = {}): MissionInput {
	return { title: "Mission", objective: "Implement feature", ...overrides };
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

describe("MissionRuntimeImpl.complete lifecycle template gate", () => {
	test("architecture_change lists all missing completion artifacts", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "architecture_change" }));

		const completion = runtime.complete(mission.id, { outcome: outcome() });
		await expect(completion).rejects.toThrow(MissionAcceptanceFailureError);
		await expect(completion).rejects.toThrow(
			`Mission "${mission.id}" cannot complete: missing decisionId, regressionContractId, verification.verdict=pass, review.verdict=pass`,
		);
	});

	test("architecture_change completes when required artifacts are present", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "architecture_change" }));
		mission.decisionId = "decision-1";
		mission.regressionContractId = "contract-1";
		mission.verification = { status: "pass", verdict: "pass", summary: "passed" };
		runtime.recordReview(mission.id, passingReview(["src/runtime.ts"]));

		const completed = await runtime.complete(mission.id, { outcome: outcome() });

		expect(completed.lifecycle).toBe("completed");
	});

	test("code_change completes with passing verification without persisted mission review", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "code_change" }));
		runtime.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "passed" });

		const completed = await runtime.complete(mission.id, { outcome: outcome() });

		expect(completed.lifecycle).toBe("completed");
		expect(completed.review).toBeUndefined();
	});

	test("high-risk code_change blocks without persisted review", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "code_change", riskLevel: "high" }));
		runtime.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "passed" });

		const completion = runtime.complete(mission.id, { outcome: outcome() });

		await expect(completion).rejects.toThrow(MissionAcceptanceFailureError);
		await expect(completion).rejects.toThrow(`Mission "${mission.id}" cannot complete: missing review.verdict=pass`);
		expect(mission.review).toBeUndefined();
		expect((await runtime.get(mission.id))?.lifecycle).not.toBe("completed");
	});

	test("code_change completion does not depend on hydrated review coverage", async () => {
		const store = new MissionStore(":memory:");
		stores.push(store);
		const writer = new MissionRuntimeImpl({ store });
		runtimes.push(writer);
		const mission = await writer.create(baseInput({ intent: "code_change" }));
		writer.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "passed" });

		const reader = new MissionRuntimeImpl({ store });
		runtimes.push(reader);
		const completed = await reader.complete(mission.id, { outcome: outcome() });

		expect(completed.lifecycle).toBe("completed");
		expect(completed.review).toBeUndefined();
	});
	test("runtime_refactor blocks without persisted review even when other completion artifacts pass", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "runtime_refactor" }));
		mission.decisionId = "decision-1";
		mission.regressionContractId = "contract-1";
		runtime.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "passed" });

		const completion = runtime.complete(mission.id, { outcome: outcome() });

		await expect(completion).rejects.toThrow(MissionAcceptanceFailureError);
		await expect(completion).rejects.toThrow(`Mission "${mission.id}" cannot complete: missing review.verdict=pass`);
		expect(mission.review).toBeUndefined();
		expect((await runtime.get(mission.id))?.lifecycle).not.toBe("completed");
	});

	test("destructive external side effect blocks without persisted review", async () => {
		const runtime = createRuntime();
		const mission = await runtime.create(baseInput({ intent: "external_side_effect", riskLevel: "high" }));
		runtime.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "passed" });
		mission.decisionId = "decision-1";

		const completion = runtime.complete(mission.id, { outcome: outcome() });

		await expect(completion).rejects.toThrow(MissionAcceptanceFailureError);
		await expect(completion).rejects.toThrow(`Mission "${mission.id}" cannot complete: missing review.verdict=pass`);
		expect((await runtime.get(mission.id))?.lifecycle).not.toBe("completed");
	});
});
