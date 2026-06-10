import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@amaze/agent-core";
import { getBundledModel } from "@amaze/ai";
import { createMockModel } from "@amaze/ai/providers/mock";
import { ModelRegistry } from "@amaze/coding-agent/config/model-registry";
import { Settings } from "@amaze/coding-agent/config/settings";
import { AgentSession } from "@amaze/coding-agent/session/agent-session";
import { AuthStorage } from "@amaze/coding-agent/session/auth-storage";
import { SessionManager } from "@amaze/coding-agent/session/session-manager";
import { TempDir } from "@amaze/utils";

// Regression guard for the before_agent_start system-prompt path silently dropping the
// STABLE_CORE cache breakpoint. The path appends a (possibly volatile) memory-recall tail to
// #baseSystemPrompt and re-sets the system prompt every turn; if it omits the breakpoint index,
// the provider falls back to last-block caching, parking cache_control on the volatile tail and
// busting the cached prefix every turn. See AGENTS.md:39 ("Do not move volatile content into
// STABLE_CORE").
describe("AgentSession cache breakpoint preservation across prompts", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-cache-breakpoint-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("keeps the STABLE_CORE breakpoint pinned after a prompt turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["STABLE_CORE", "DYNAMIC_TAIL"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		// Pin cache_control on the STABLE_CORE block (index 0), leaving the volatile tail uncached.
		agent.setSystemPrompt(["STABLE_CORE", "DYNAMIC_TAIL"], 0);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(agent.state.systemPromptCacheBreakpointIndex).toBe(0);

		await session.prompt("hello");

		// Before the fix this reset to `undefined`, collapsing to provider last-block caching.
		expect(agent.state.systemPromptCacheBreakpointIndex).toBe(0);
	});
});
