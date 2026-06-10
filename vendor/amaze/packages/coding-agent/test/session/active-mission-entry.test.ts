import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@amaze/agent-core";
import { createMockModel } from "@amaze/ai/providers/mock";
import { Settings } from "@amaze/coding-agent/config/settings";
import { buildSystemPrompt } from "@amaze/coding-agent/sdk";
import { AgentSession } from "@amaze/coding-agent/session/agent-session";
import { SessionManager } from "@amaze/coding-agent/session/session-manager";

const sessions: AgentSession[] = [];

function createSession(): AgentSession {
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
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: () => "test-key" } as never,
	});
	sessions.push(session);
	return session;
}

describe("active mission entry", () => {
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	test("creates an active mission for a mutating user turn", async () => {
		const session = createSession();

		await session.prompt("fix the auth bug");

		expect(session.getActiveMission()?.intent).toBe("code_change");
	});

	test("does not create an active mission for an ambient question", async () => {
		const session = createSession();

		await session.prompt("what does the auth module do?");

		expect(session.getActiveMission()).toBeUndefined();
	});

	test("renders the same active mission packet bytes through the SDK path", async () => {
		const session = createSession();
		await session.prompt("fix the auth bug");
		const mission = session.getActiveMission();
		expect(mission?.id).toBeDefined();

		const direct = await buildSystemPrompt({
			activeMissionId: mission!.id,
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
		});
		const viaSession = await buildSystemPrompt({
			activeMissionId: session.getActiveMission()?.id,
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
		});

		expect(viaSession.systemPrompt).toEqual(direct.systemPrompt);
	});
});
