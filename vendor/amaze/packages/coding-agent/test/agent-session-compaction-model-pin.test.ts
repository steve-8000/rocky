import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@amaze/agent-core";
import * as compactionModule from "@amaze/agent-core/compaction";
import { getBundledModel } from "@amaze/ai";
import { ModelRegistry } from "@amaze/coding-agent/config/model-registry";
import { Settings } from "@amaze/coding-agent/config/settings";
import { AgentSession } from "@amaze/coding-agent/session/agent-session";
import { AuthStorage } from "@amaze/coding-agent/session/auth-storage";
import { SessionManager } from "@amaze/coding-agent/session/session-manager";
import { TempDir } from "@amaze/utils";
import { assistantMsg, userMsg } from "./utilities";

describe("AgentSession compaction model pinning", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-model-pin-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	it("uses the live session model for compaction when available", async () => {
		const currentModel = getBundledModel("github-copilot", "gpt-4o");
		const pinnedModel = getBundledModel("openai", "gpt-5.4-mini");
		if (!currentModel || !pinnedModel) {
			throw new Error("Expected bundled compaction models to exist");
		}

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "copilot-token");
		authStorage.setRuntimeApiKey(pinnedModel.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, pinnedModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === pinnedModel.provider && model.id === pinnedModel.id) return "openai-token";
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "copilot-token";
			return undefined;
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [u, a] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(u);
			const assistant = assistantMsg(a);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: `summary via ${model.provider}/${model.id}`,
			shortSummary: "short summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider, id: model.id },
		}));

		const result = await session.compact();
		expect(result.summary).toContain(`${currentModel.provider}/${currentModel.id}`);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]).toMatchObject({ provider: currentModel.provider, id: currentModel.id });
	});

	it("does not force a separate map model by default", async () => {
		const currentModel = getBundledModel("openai-codex", "gpt-5.5");
		const reduceModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		if (!currentModel || !reduceModel) throw new Error("Expected bundled compaction models to exist");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "current-key");
		authStorage.setRuntimeApiKey(reduceModel.provider, "reduce-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, reduceModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === reduceModel.provider && model.id === reduceModel.id) return "reduce-key";
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "current-key";
			return undefined;
		});

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.mode": "map-reduce",
			"compaction.remoteEnabled": false,
			"compaction.mapReduceSectionTokenBudget": 1,
			"compaction.mapReduceMaxSections": 4,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [u, a] of [
			["first question", "first answer"],
			["second question", "second answer"],
			["third question", "third answer"],
		] as const) {
			const user = userMsg(u);
			const assistant = assistantMsg(a);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, model, _apiKey, _instructions, _signal, options) => ({
				summary: `reduce=${model.provider}/${model.id}; resolver=${typeof options?.resolveSectionModel}`,
				shortSummary: "short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: {},
			}));

		const result = await session.compact();
		expect(result.summary).toContain(`reduce=${currentModel.provider}/${currentModel.id}`);
		expect(result.summary).toContain("resolver=function");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]).toMatchObject({ provider: currentModel.provider, id: currentModel.id });
		expect(compactSpy.mock.calls[0]?.[5]?.resolveSectionModel).toBeFunction();
	});
});
