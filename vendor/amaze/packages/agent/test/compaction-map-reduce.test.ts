import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@amaze/agent-core/compaction";
import type { AgentMessage } from "@amaze/agent-core/types";
import type { AssistantMessage, Model, Usage } from "@amaze/ai";
import * as ai from "@amaze/ai";

const REDUCE_MODEL: Model = {
	id: "gpt-5.4-mini",
	name: "gpt-5.4 mini",
	api: "mock",
	provider: "openai",
	baseUrl: "mock://reduce",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
};

const MAP_MODEL: Model = {
	...REDUCE_MODEL,
	id: "gpt-5.3-codex-spark",
	name: "gpt-5.3 codex spark",
	baseUrl: "mock://map",
};

function makeUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("alpha file src/a.ts"), makeUserMessage("beta file src/b.ts")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent suffix")],
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: createFileOps(),
		settings: {
			...DEFAULT_COMPACTION_SETTINGS,
			mode: "map-reduce",
			remoteEnabled: false,
			mapReduceSectionTokenBudget: 1,
			mapReduceMaxSections: 4,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("map-reduce compaction", () => {
	it("uses each section's resolved model before reducing with the compaction model", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeAssistantMessage("## 1. User Requests (Verbatim)\n- alpha"))
			.mockResolvedValueOnce(makeAssistantMessage("## 1. User Requests (Verbatim)\n- beta"))
			.mockResolvedValueOnce(
				makeAssistantMessage(
					"<summary>\n## 1. User Requests (Verbatim)\n- alpha\n- beta\n\n## 2. Final Goal\n- Preserve both chunks\n</summary>",
				),
			)
			.mockResolvedValueOnce(makeAssistantMessage("short summary"));

		const result = await compact(makePreparation(), REDUCE_MODEL, "reduce-key", undefined, undefined, {
			resolveSectionModel: async messages =>
				messages.some(message => message.role === "user" && String(message.content).includes("beta"))
					? { model: MAP_MODEL, apiKey: "map-key" }
					: undefined,
		});

		expect(result.summary).toContain("- alpha");
		expect(result.summary).toContain("- beta");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(4);
		expect(completeSimpleSpy.mock.calls[0]?.[0]).toBe(REDUCE_MODEL);
		expect(completeSimpleSpy.mock.calls[1]?.[0]).toBe(MAP_MODEL);
		expect(completeSimpleSpy.mock.calls[2]?.[0]).toBe(REDUCE_MODEL);
		expect(completeSimpleSpy.mock.calls[0]?.[2]).toMatchObject({ apiKey: "reduce-key" });
		expect(completeSimpleSpy.mock.calls[1]?.[2]).toMatchObject({ apiKey: "map-key" });
	});
});
