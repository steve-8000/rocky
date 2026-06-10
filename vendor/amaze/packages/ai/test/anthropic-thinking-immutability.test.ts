import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@amaze/ai/providers/anthropic";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@amaze/ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

describe("Anthropic thinking replay immutability", () => {
	it("preserves signed-thinking blocks while normalizing non-thinking content", () => {
		const malformed = String.fromCharCode(0xd800);
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `analysis ${malformed}`, thinkingSignature: "sig_thinking" },
				{ type: "redactedThinking", data: "" },
				{ type: "text", text: `text ${malformed}` },
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: `analysis ${malformed}`, signature: "sig_thinking" },
			{ type: "text", text: `text ${malformed.toWellFormed()}` },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});

	it("drops stale omitted signed-thinking blocks instead of replaying mutated history", () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "stale_omitted_sig" },
				{ type: "text", text: "I'll inspect that." },
				{
					type: "toolCall",
					id: "toolu_stale",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const latestAssistant: AssistantMessage = {
			...staleAssistant,
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "latest_omitted_sig" },
				{ type: "text", text: "Done." },
			],
		};

		const params = convertAnthropicMessages([user, staleAssistant, user, latestAssistant], model, false);
		const assistantParams = params.filter(message => message.role === "assistant");

		expect(assistantParams[0]?.content).toEqual([
			{ type: "text", text: "I'll inspect that." },
			{ type: "tool_use", id: "toolu_stale", name: "read", input: { path: "README.md" } },
		]);
		expect(assistantParams[1]?.content).toEqual([
			{ type: "thinking", thinking: "", signature: "latest_omitted_sig" },
			{ type: "text", text: "Done." },
		]);
	});

	it("preserves omitted signed-thinking on the latest assistant tool-use turn", () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "stale_sig" },
				{ type: "text", text: "Old step" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const latestAssistant: AssistantMessage = {
			...staleAssistant,
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "latest_sig" },
				{ type: "toolCall", id: "toolu_latest", name: "read", arguments: { path: "package.json" } },
			],
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_latest",
			toolName: "read",
			content: [{ type: "text", text: "package body" }],
			isError: false,
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, staleAssistant, latestAssistant, toolResult], model, false);
		const assistantParams = params.filter(message => message.role === "assistant");

		expect(assistantParams).toHaveLength(2);
		expect(assistantParams[0]?.content).toEqual([{ type: "text", text: "Old step" }]);
		expect(assistantParams[1]?.content).toEqual([
			{ type: "thinking", thinking: "", signature: "latest_sig" },
			{ type: "tool_use", id: "toolu_latest", name: "read", input: { path: "package.json" } },
		]);
	});
});
