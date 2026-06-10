import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { Mission } from "../../src/mission/core/mission";
import type { MissionControlRuntime } from "../../src/mission/core/mission-control-runtime";
import { TaskTool } from "../../src/task";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const workerAgent: AgentDefinition = {
	name: "Builder",
	description: "test Builder agent",
	systemPrompt: "test",
	source: "project",
	spawns: "*",
};

const activeMission: Mission = {
	id: "mission-active",
	title: "Active mission",
	objective: "Ship the mission-bound task",
	mode: "auto",
	lifecycle: "executing",
	riskLevel: "medium",
	constraints: [],
	acceptanceCriteria: [],
	scopeGuard: { allowedPaths: ["packages/coding-agent/**"], deniedPaths: [] },
	budget: { tokenBudget: 100_000, tokensUsed: 0 },
	contextBudget: { maxContextTokens: 100_000, contextTokensUsed: 0 },
	contractRevision: 7,
	tasks: [],
	evidenceRefs: [],
	createdAt: 1,
	updatedAt: 1,
	revision: 0,
};

const runSubprocessMock = mock(
	async (options: { contract?: { missionId?: string; taskId?: string; parentMissionRev?: number } }) => ({
		id: "agent-result",
		agent: "Builder",
		agentSource: "project" as const,
		status: "completed" as const,
		output: "ok",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		cost: 0,
		exitCode: 0,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 2,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		completion: { hasYield: true, verified: true },
		observedContract: options.contract,
	}),
);

vi.mock("../../src/task/discovery", () => ({
	discoverAgents: async () => ({ agents: [workerAgent], projectAgentsDir: null }),
	getAgent: (agents: AgentDefinition[], name: string) => agents.find(agent => agent.name === name),
}));

vi.mock("../../src/task/executor", () => ({
	runSubprocess: runSubprocessMock,
}));

describe("TaskTool mission contract stamping", () => {
	afterEach(() => {
		runSubprocessMock.mockClear();
	});

	it("records mission-bound contract revision and usage under the active mission", async () => {
		const recordTaskUsage = mock(() => {});
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getActiveMission: () => activeMission,
			missionControl: { recordTaskUsage } as unknown as MissionControlRuntime,
		} satisfies Partial<ToolSession> as ToolSession;

		const tool = await TaskTool.create(session);
		await tool.execute("call-1", {
			agent: "Builder",
			tasks: [
				{
					id: "mission-task",
					description: "Do mission work",
					assignment: "Return success",
					contract: {
						role: "mission-worker",
						scope: { include: ["packages/coding-agent/**"], exclude: [] },
						successCriteria: [],
						escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
					},
				},
			],
		});

		expect(runSubprocessMock).toHaveBeenCalledTimes(1);
		const contract = runSubprocessMock.mock.calls[0]?.[0]?.contract;
		expect(contract?.missionId).toBe("mission-active");
		expect(contract?.taskId).toBe("mission-task");
		expect(contract?.parentMissionRev).toBe(7);
		expect(recordTaskUsage).toHaveBeenCalledWith("mission-active", 17);
	});
});
