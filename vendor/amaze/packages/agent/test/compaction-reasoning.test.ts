import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@amaze/agent-core";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@amaze/agent-core/compaction";
import type { AssistantMessage, Model } from "@amaze/ai";
import * as ai from "@amaze/ai";
import { Effort, getBundledModel } from "@amaze/ai";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getTestModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model to exist");
	return model;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction reasoning policy", () => {
	test("uses low reasoning effort for summary and short summary generation", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantMessage("## Summary\nCompacted history"))
			.mockResolvedValueOnce(createAssistantMessage("short summary"));
		const model = getTestModel();
		const messagesToSummarize: AgentMessage[] = [{ role: "user", content: "first question", timestamp: 1 }];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "keep-1",
			messagesToSummarize,
			turnPrefixMessages: [],
			recentMessages: messagesToSummarize,
			isSplitTurn: false,
			tokensBefore: 2048,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		};

		await compact(preparation, model, "test-key");

		expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
		expect(completeSimpleSpy.mock.calls[0]?.[2]).toMatchObject({ reasoning: Effort.Low });
		expect(completeSimpleSpy.mock.calls[1]?.[2]).toMatchObject({ reasoning: Effort.Low });
	});
});
