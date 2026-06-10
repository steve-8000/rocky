import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
} from "@amaze/agent-core/compaction";
import type { AgentMessage } from "@amaze/agent-core/types";
import type { AssistantMessage, Model, Usage } from "@amaze/ai";
import * as ai from "@amaze/ai";
import { mergeSplitTurnSummaries } from "../src/compaction/structured-summary";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
};

function makeUsage(input = 120, output = 80, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string, usage: Usage = makeUsage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("Hello"), makeAssistantMessage("Hi back")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("Next question")],
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("section-aware compaction summaries", () => {
	it("passes legacy summaries as legacy context and strips summary wrappers", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				makeAssistantMessage(
					'<summary>\n## 1. User Requests (Verbatim)\n- "Ship the change"\n\n## 2. Final Goal\n- Deliver the requested change\n\n## 3. Constraints & Preferences (Verbatim Only)\n- None.\n\n## 4. Work Completed\n- None.\n\n## 5. Active Working Context\n- src/index.ts\n\n## 6. Remaining Tasks\n- Run the targeted test\n\n## 7. Exact Next Steps\n- Run the targeted test now\n</summary>',
				),
			);

		const legacySummary = "## Goal\nShip the change\n\n## Next Steps\n1. Run the targeted test";
		const result = await generateSummary(
			[makeUserMessage("Please finish the compaction port")],
			MODEL,
			16_384,
			"test-api-key",
			undefined,
			undefined,
			legacySummary,
		);

		expect(result).not.toContain("<summary>");
		expect(result).toContain("## 1. User Requests (Verbatim)");
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const promptText = String(
			(call[1] as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]?.content[0]?.text,
		);
		expect(promptText).toContain("<legacy-summary>");
		expect(promptText).toContain(legacySummary);
		expect(promptText).not.toContain("<previous-summary>");
	});

	it("merges split-turn structured summaries into the seven-section format", () => {
		const historySummary = `## 1. User Requests (Verbatim)\n- "Port the compaction logic"\n\n## 2. Final Goal\n- Deliver the section-aware compaction port\n\n## 3. Constraints & Preferences (Verbatim Only)\n- "Do not regress existing sessions"\n\n## 4. Work Completed\n- Added prompt files\n\n## 5. Active Working Context\n- packages/agent/src/compaction/compaction.ts\n\n## 6. Remaining Tasks\n- Wire split-turn handling\n\n## 7. Exact Next Steps\n- Implement the merge helper`;
		const turnPrefixSummary = `## 1. User Requests (Verbatim)\n- "Port the compaction logic"\n- "Keep the old sessions working"\n\n## 2. Final Goal\n- Deliver the section-aware compaction port\n\n## 3. Constraints & Preferences (Verbatim Only)\n- "Do not regress existing sessions"\n\n## 5. Active Working Context\n- packages/agent/src/compaction/structured-summary.ts\n- Captured failing split-turn case`;

		const merged = mergeSplitTurnSummaries(historySummary, turnPrefixSummary);

		expect(merged).toContain("## 1. User Requests (Verbatim)");
		expect(merged).toContain('- "Keep the old sessions working"');
		expect(merged).toContain("packages/agent/src/compaction/compaction.ts");
		expect(merged).toContain("packages/agent/src/compaction/structured-summary.ts");
		expect(merged).toContain("## 6. Remaining Tasks");
		expect(merged).not.toContain("---");
	});

	it("synthesizes the full format when only structured turn-prefix context exists", () => {
		const turnPrefixSummary = `## 1. User Requests (Verbatim)\n- "Finish the compaction port"\n\n## 2. Final Goal\n- Deliver the section-aware compaction port\n\n## 3. Constraints & Preferences (Verbatim Only)\n- None.\n\n## 5. Active Working Context\n- Captured prefix-only context`;

		const merged = mergeSplitTurnSummaries(undefined, turnPrefixSummary);

		expect(merged).toContain("## 4. Work Completed");
		expect(merged).toContain("## 6. Remaining Tasks");
		expect(merged).toContain("## 7. Exact Next Steps");
		expect(merged).toContain("None.");
		expect(merged).not.toContain("---");
	});

	it("preserves the prior structured summary when only a turn prefix is compacted", async () => {
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				makeAssistantMessage(
					'<summary>\n## 1. User Requests (Verbatim)\n- "Port the compaction logic"\n\n## 2. Final Goal\n- Deliver the section-aware compaction port\n\n## 3. Constraints & Preferences (Verbatim Only)\n- "Do not regress existing sessions"\n\n## 5. Active Working Context\n- Captured split-turn output\n</summary>',
				),
			)
			.mockResolvedValueOnce(makeAssistantMessage("short summary"));

		const previousSummary = `## 1. User Requests (Verbatim)\n- "Port the compaction logic"\n\n## 2. Final Goal\n- Deliver the section-aware compaction port\n\n## 3. Constraints & Preferences (Verbatim Only)\n- "Do not regress existing sessions"\n\n## 4. Work Completed\n- Added the new prompts\n\n## 5. Active Working Context\n- packages/agent/src/compaction/prompts/compaction-summary.md\n\n## 6. Remaining Tasks\n- Wire split-turn handling\n\n## 7. Exact Next Steps\n- Merge the turn-prefix summary`;
		const result = await compact(
			makePreparation({
				messagesToSummarize: [],
				turnPrefixMessages: [makeUserMessage("Keep the compaction structure stable")],
				recentMessages: [makeAssistantMessage("Recent suffix")],
				isSplitTurn: true,
				previousSummary,
			}),
			MODEL,
			"test-api-key",
		);

		expect(result.summary).toContain("## 4. Work Completed");
		expect(result.summary).toContain("Added the new prompts");
		expect(result.summary).toContain("Captured split-turn output");
		expect(result.summary).not.toContain("No prior history.");
	});

	it("uses the Senpi immutable update prompt for structured previous summaries", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				makeAssistantMessage(
					'<summary>\n## 1. User Requests (Verbatim)\n- "Ship the change"\n\n## 2. Final Goal\n- Deliver the requested change\n\n## 3. Constraints & Preferences (Verbatim Only)\n- None.\n\n## 4. Work Completed\n- Updated prompts\n\n## 5. Active Working Context\n- packages/agent/src/compaction/prompts/compaction-update-summary.md\n\n## 6. Remaining Tasks\n- Run tests\n\n## 7. Exact Next Steps\n- Run targeted tests\n</summary>',
				),
			);

		const previousSummary = `## 1. User Requests (Verbatim)\n- "Ship the change"\n\n## 2. Final Goal\n- Deliver the requested change\n\n## 3. Constraints & Preferences (Verbatim Only)\n- "Keep constraints exact"\n\n## 4. Work Completed\n- Initial summary\n\n## 5. Active Working Context\n- packages/agent/src/compaction/structured-summary.ts\n\n## 6. Remaining Tasks\n- Update prompts\n\n## 7. Exact Next Steps\n- Port Senpi policy`;

		await generateSummary(
			[makeUserMessage("Also keep the next steps precise")],
			MODEL,
			16_384,
			"test-api-key",
			undefined,
			undefined,
			previousSummary,
		);

		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const promptText = String(
			(call[1] as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]?.content[0]?.text,
		);
		expect(promptText).toContain("<previous-summary>");
		expect(promptText).toContain("R3. Where a previous summary is supplied");
		expect(promptText).toContain("treat its User Requests, Final Goal, and Constraints fields as IMMUTABLE");
		expect(promptText).toContain("PASS 1 — Internal task-intent extraction");
		expect(promptText).toContain("PASS 2 — Emit summary biased toward Pass 1");
		expect(promptText).not.toContain("<legacy-summary>");
		expect(promptText.match(/^<previous-summary>$/gm)).toHaveLength(1);
	});
});
