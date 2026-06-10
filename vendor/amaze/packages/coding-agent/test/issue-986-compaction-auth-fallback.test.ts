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

describe("issue #986 compaction auth fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: {
		fallbackModelRole?: string;
		configureFallbackAuth?: boolean;
		codexToken?: string;
	}) {
		const currentModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		if (options?.fallbackModelRole) {
			settings.setModelRole(options.fallbackModelRole, `${fallbackModel.provider}/${fallbackModel.id}`);
		}

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		if (options?.codexToken !== undefined) {
			authStorage.setRuntimeApiKey(currentModel.provider, options.codexToken);
		}
		if (options?.configureFallbackAuth !== false) {
			authStorage.setRuntimeApiKey(fallbackModel.provider, "anthropic-token");
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		return { currentModel, fallbackModel };
	}

	it("uses an authenticated role model instead of an unauthenticated current provider", async () => {
		const { fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("skips malformed current-provider credentials when an authenticated role model exists", async () => {
		const { fallbackModel } = await createSession({
			fallbackModelRole: "smol",
			codexToken: "codex-token-without-jwt",
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === "openai-codex") {
				throw new Error("Summarization failed: Failed to extract accountId from token");
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary without codex account id",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === "openai-codex") return "codex-token-without-jwt";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary without codex account id");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("uses the authenticated fallback role when current credentials are unavailable", async () => {
		const { fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "authenticated fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("authenticated fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("prefers authenticated fallback roles over the unauthenticated current model", async () => {
		const { currentModel, fallbackModel } = await createSession({
			fallbackModelRole: "smol",
			configureFallbackAuth: true,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(`Current model should have been skipped: ${model.provider}/${model.id}`);
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "authenticated fallback summary",
				shortSummary: "authenticated fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return undefined;
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("authenticated fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("fails fast with a clear provider-specific error when no authenticated fallback exists", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		const compactSpy = vi.spyOn(compactionModule, "compact");
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => undefined);

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
		expect(compactSpy).not.toHaveBeenCalled();
	});
});
