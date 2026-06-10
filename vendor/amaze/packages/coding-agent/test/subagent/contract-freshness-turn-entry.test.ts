import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@amaze/agent-core";
import { Agent } from "@amaze/agent-core";
import { createMockModel } from "@amaze/ai/providers/mock";
import { Settings } from "@amaze/coding-agent/config/settings";
import type { Mission } from "@amaze/coding-agent/mission/core/mission";
import { AgentSession, type AgentSessionEvent } from "@amaze/coding-agent/session/agent-session";
import { SessionManager } from "@amaze/coding-agent/session/session-manager";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";

function makeMission(revision: number): Mission {
	return {
		id: "mission-parent",
		title: "Parent mission",
		objective: "Keep child contracts fresh",
		mode: "auto",
		intent: "code_change",
		lifecycle: "executing",
		riskLevel: "low",
		constraints: [],
		acceptanceCriteria: [],
		budget: { tokenBudget: 0, tokensUsed: 0 },
		contextBudget: { maxContextTokens: 0, contextTokensUsed: 0 },
		tasks: [],
		evidenceRefs: [],
		createdAt: 1,
		updatedAt: 1,
		revision,
		contractRevision: revision,
	};
}

function makeContract(parentMissionRev: number): SubagentContract {
	return {
		missionId: "mission-parent",
		taskId: "task-child",
		role: "test-child",
		parentMissionRev,
		scope: { include: [], exclude: [] },
		successCriteria: [],
		escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
	};
}

function createSubagentSession(args: { parentRevision: number; stampedRevision: number }): {
	session: AgentSession;
	notices: AgentSessionEvent[];
	setParentRevision: (revision: number) => void;
} {
	let parentMission = makeMission(args.parentRevision);
	const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock.model,
			systemPrompt: ["Test"],
			tools: [],
		},
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		role: "subagent",
		subagentContract: makeContract(args.stampedRevision),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: () => "test-key" } as never,
	});
	session.missionControl.ensureActiveMission = async () => ({
		missionId: parentMission.id,
		intent: parentMission.intent as "code_change",
		created: false,
	});
	session.missionControl.getActiveMission = () => parentMission;
	const notices: AgentSessionEvent[] = [];
	session.subscribe(event => {
		if (event.type === "notice") notices.push(event);
	});
	return {
		session,
		notices,
		setParentRevision: revision => {
			parentMission = makeMission(revision);
		},
	};
}

function developerTexts(messages: AgentMessage[]): string[] {
	return messages
		.filter(message => message.role === "developer")
		.flatMap(message => (Array.isArray(message.content) ? message.content : []))
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text);
}

describe("subagent contract freshness at turn entry", () => {
	test("stale parent mission revision emits a warning notice and injects a developer re-read instruction", async () => {
		const { session, notices, setParentRevision } = createSubagentSession({ parentRevision: 7, stampedRevision: 7 });
		try {
			setParentRevision(8);

			await session.prompt("continue delegated work", { synthetic: true });

			expect(notices).toContainEqual({
				type: "notice",
				level: "warning",
				source: "subagent-contract-freshness",
				message: "Parent mission moved from rev 7 to rev 8; re-fetching latest contract.",
			});
			expect(developerTexts(session.messages)).toContain(
				"Parent mission contract revision changed from 7 to 8. Re-read the mission packet before acting.",
			);
		} finally {
			await session.dispose();
		}
	});

	test("matching parent mission revision does not emit a notice or inject a re-read instruction", async () => {
		const { session, notices } = createSubagentSession({ parentRevision: 7, stampedRevision: 7 });
		try {
			await session.prompt("continue delegated work", { synthetic: true });

			expect(
				notices.filter(event => event.type === "notice" && event.source === "subagent-contract-freshness"),
			).toHaveLength(0);
			expect(developerTexts(session.messages)).not.toContain(
				"Parent mission contract revision changed from 7 to 7. Re-read the mission packet before acting.",
			);
			expect(
				developerTexts(session.messages).some(text => text.includes("Re-read the mission packet before acting.")),
			).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
