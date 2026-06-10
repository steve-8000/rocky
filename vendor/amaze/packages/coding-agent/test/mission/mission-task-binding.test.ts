import { describe, expect, test } from "bun:test";
import type { MissionTask } from "../../src/mission/core";
import {
	bindContractToMission,
	enforceMissionBinding,
	MissionBindingError,
	type SubagentContract,
} from "../../src/subagent/contract";
import { deriveEvidenceRefs, MissionTaskRunner, type RunSubprocessFn } from "../../src/task/mission-task-runner";
import type { AgentDefinition, SingleResult } from "../../src/task/types";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-applier",
		description: "applies refactors",
		systemPrompt: "do the thing",
		source: "bundled",
		...overrides,
	};
}

function executorOptions(overrides: Partial<Parameters<MissionTaskRunner["run"]>[0]> = {}) {
	return {
		cwd: "/tmp/work",
		agent: agent(),
		task: "Rename Foo to Bar across src",
		description: "rename refactor",
		index: 0,
		id: "run-1",
		...overrides,
	} as Parameters<MissionTaskRunner["run"]>[0];
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "run-1",
		agent: "refactor-applier",
		agentSource: "bundled",
		task: "Rename Foo to Bar across src",
		exitCode: 0,
		output: "done: renamed 3 files",
		stderr: "",
		truncated: false,
		durationMs: 1234,
		tokens: 500,
		...overrides,
	};
}

function contract(overrides: Partial<SubagentContract> = {}): SubagentContract {
	return {
		role: "refactor-applier",
		scope: { include: ["src/**"], exclude: ["src/legacy/**"] },
		successCriteria: [],
		escalation: { onUncertainty: "ask-parent", budgetCap: 10_000 },
		...overrides,
	};
}

describe("MissionTaskRunner mission binding", () => {
	test("threads missionId/taskId through a delegated executor run", async () => {
		let seen: { contract?: SubagentContract } | undefined;
		const fakeRun: RunSubprocessFn = async opts => {
			seen = { contract: opts.contract };
			return singleResult();
		};

		const runner = new MissionTaskRunner({ missionId: "m-1", taskId: "t-1" }, fakeRun);
		const out = await runner.run(executorOptions({ contract: contract() }));

		// Mission identifiers threaded onto the contract passed to the real executor.
		expect(seen?.contract?.missionId).toBe("m-1");
		expect(seen?.contract?.taskId).toBe("t-1");
		// And surfaced on the runner result.
		expect(out.binding).toEqual({ missionId: "m-1", taskId: "t-1" });
		expect(out.task.missionId).toBe("m-1");
		expect(out.task.id).toBe("t-1");
	});

	test("links task output to mission evidence refs", async () => {
		const fakeRun: RunSubprocessFn = async () =>
			singleResult({ outputPath: "/out/run-1.md", patchPath: "/patches/run-1.patch", branchName: "amaze/run-1" });
		const runner = new MissionTaskRunner({ missionId: "m-2", taskId: "t-2" }, fakeRun);

		const out = await runner.run(executorOptions({ contract: contract() }));

		expect(out.evidenceRefs).toContain("task-output:///out/run-1.md");
		expect(out.evidenceRefs).toContain("task-patch:///patches/run-1.patch");
		expect(out.evidenceRefs).toContain("task-branch://amaze/run-1");
		expect(out.evidenceRefs).toContain("task-run://run-1");
		// Evidence is reflected onto the MissionTask snapshot.
		expect(out.task.evidenceRefs).toEqual(out.evidenceRefs);
		expect(out.task.output).toBe("done: renamed 3 files");
		expect(out.task.status).toBe("completed");
	});

	test("merges evidence onto a seeded MissionTask without mutating the seed", async () => {
		const fakeRun: RunSubprocessFn = async () => singleResult({ outputPath: "/out/run-1.md" });
		const seed: MissionTask = {
			id: "t-3",
			title: "seeded title",
			status: "pending",
			planStepId: "step-2",
			evidenceRefs: ["prior://evidence"],
		};
		const runner = new MissionTaskRunner({ missionId: "m-3", taskId: "t-3" }, fakeRun);

		const out = await runner.run(executorOptions({ contract: contract() }), seed);

		expect(out.task.title).toBe("seeded title");
		expect(out.task.planStepId).toBe("step-2");
		expect(out.task.evidenceRefs).toContain("prior://evidence");
		expect(out.task.evidenceRefs).toContain("task-output:///out/run-1.md");
		// Seed object untouched.
		expect(seed.evidenceRefs).toEqual(["prior://evidence"]);
		expect(seed.status).toBe("pending");
	});

	test("maps executor failure / abort onto task status", async () => {
		const failRunner = new MissionTaskRunner({ missionId: "m", taskId: "t" }, async () =>
			singleResult({ exitCode: 1, error: "boom" }),
		);
		expect((await failRunner.run(executorOptions())).task.status).toBe("failed");

		const abortRunner = new MissionTaskRunner({ missionId: "m", taskId: "t" }, async () =>
			singleResult({ aborted: true }),
		);
		expect((await abortRunner.run(executorOptions())).task.status).toBe("cancelled");
	});

	test("runs contract-less tasks (delegates verbatim, no contract stamping)", async () => {
		let calledWithContract = true;
		const fakeRun: RunSubprocessFn = async opts => {
			calledWithContract = opts.contract !== undefined;
			return singleResult();
		};
		const runner = new MissionTaskRunner({ missionId: "m-5", taskId: "t-5" }, fakeRun);
		const out = await runner.run(executorOptions());
		expect(calledWithContract).toBe(false);
		expect(out.task.missionId).toBe("m-5");
	});
});

describe("SubagentContract mission identifiers (OPTIONAL-with-enforcement)", () => {
	test("legacy direct use: no mission context → binding not required", () => {
		const c = contract();
		expect(c.missionId).toBeUndefined();
		expect(c.taskId).toBeUndefined();
		// No mission context → no-op, no throw.
		expect(() => enforceMissionBinding(c, undefined)).not.toThrow();
		expect(bindContractToMission(c, undefined)).toBe(c);
	});

	test("mission context present: identifiers are stamped and enforced", () => {
		const bound = bindContractToMission(contract(), { missionId: "m-9", taskId: "t-9" });
		expect(bound.missionId).toBe("m-9");
		expect(bound.taskId).toBe("t-9");
		expect(() => enforceMissionBinding(bound, { missionId: "m-9", taskId: "t-9" })).not.toThrow();
	});

	test("mission context present but contract unbound → throws MissionBindingError", () => {
		expect(() => enforceMissionBinding(contract(), { missionId: "m-9", taskId: "t-9" })).toThrow(MissionBindingError);
	});

	test("contract bound to a different mission/task → throws", () => {
		const bound = bindContractToMission(contract(), { missionId: "other", taskId: "other-t" });
		expect(() => enforceMissionBinding(bound, { missionId: "m-9", taskId: "t-9" })).toThrow(MissionBindingError);
	});

	test("deriveEvidenceRefs always includes a stable run handle", () => {
		expect(deriveEvidenceRefs(singleResult({ id: "abc" }))).toEqual(["task-run://abc"]);
	});
});
