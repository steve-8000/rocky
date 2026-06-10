import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@amaze/ai";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { EventBus, type SessionEvent } from "../../src/observability";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import type { SubagentContract } from "../../src/subagent/contract";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus as UtilityEventBus } from "../../src/utils/event-bus";

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage('{"ok":true}'));
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-call",
					toolName: "yield",
					result: { result: { data: { ok: true } } },
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function mockCreateAgentSession(): void {
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
		async () =>
			({
				session: createYieldingSession(),
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new UtilityEventBus(),
			}) as CreateAgentSessionResult,
	);
}

const agent: AgentDefinition = {
	name: "stub",
	description: "test",
	systemPrompt: "test",
	source: "project",
};

const contract: SubagentContract = {
	role: "test",
	scope: { include: [], exclude: [] },
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
};

describe("subagent.start hasContract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits whether the launched subagent has a structured contract", async () => {
		mockCreateAgentSession();
		const eventBus = new EventBus();
		const events: SessionEvent[] = [];
		eventBus.subscribe(event => {
			events.push(event);
		});
		const baseOptions = {
			cwd: "/tmp",
			agent,
			task: "do work",
			index: 0,
			settings: Settings.isolated(),
			enableLsp: false,
			sessionEventBus: eventBus,
		};

		await runSubprocess({ ...baseOptions, id: "with-contract", contract });
		await runSubprocess({ ...baseOptions, id: "without-contract" });

		const starts = events.filter(event => event.type === "subagent.start");
		expect(starts.map(event => event.hasContract)).toEqual([true, false]);
	});
});
