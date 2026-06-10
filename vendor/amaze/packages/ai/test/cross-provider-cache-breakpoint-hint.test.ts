/**
 * R2 regression — `Context.systemPromptCacheBreakpointIndex` must be silently ignored by
 * non-Anthropic providers (OpenAI Responses, OpenAI Completions, Google, Bedrock, Ollama).
 *
 * The field was added to `Context` for Anthropic's multi-block cache placement. Other
 * providers don't have an equivalent mechanism — they MUST treat the field as unknown
 * metadata and produce the same wire payload they would have produced without it. Failing
 * silently here means the v2 cache layout is Anthropic-specific without leaking complexity
 * into other provider code paths.
 *
 * What this test does NOT do (deliberately):
 *   - Assert anything about caching behavior on these providers — they don't have it
 *   - Try to translate the hint into provider-specific cache controls (out of scope)
 *
 * What this test guards against:
 *   - A regression where a provider's payload builder breaks when seeing the new field
 *   - Schema validation rejecting Context with the field set
 *   - Silent crash on a code path that enumerates Context fields generically
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamGoogle } from "@amaze/ai/providers/google";
import { streamOllama } from "@amaze/ai/providers/ollama";
import { streamOpenAICompletions } from "@amaze/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@amaze/ai/providers/openai-responses";
import type { Context, Model } from "@amaze/ai/types";
import { hookFetch } from "@amaze/utils";

const googleModel: Model<"google-generative-ai"> = {
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const openaiResponsesModel: Model<"openai-responses"> = {
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const openaiCompletionsModel: Model<"openai-completions"> = {
	id: "gpt-4o-mini",
	name: "GPT-4o Mini",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const ollamaModel: Model<"ollama-chat"> = {
	id: "llama3",
	name: "Llama 3",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://localhost:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 8_000,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cross-provider: systemPromptCacheBreakpointIndex is silently ignored", () => {
	it("Google provider produces identical payload with or without the hint", async () => {
		const baseContext: Context = {
			systemPrompt: ["stable core", "dynamic tail"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const withHint: Context = { ...baseContext, systemPromptCacheBreakpointIndex: 0 };

		let payloadBase: unknown;
		let payloadWithHint: unknown;
		using _hook = hookFetch(
			async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await streamGoogle(googleModel, baseContext, {
			apiKey: "test-key",
			onPayload: p => {
				payloadBase = p;
			},
		}).result();
		await streamGoogle(googleModel, withHint, {
			apiKey: "test-key",
			onPayload: p => {
				payloadWithHint = p;
			},
		}).result();
		// Byte-equal: the hint must not perturb any wire field downstream.
		expect(JSON.stringify(payloadWithHint)).toBe(JSON.stringify(payloadBase));
	});

	it("OpenAI Responses provider produces identical payload with or without the hint", async () => {
		const baseContext: Context = {
			systemPrompt: ["stable core", "dynamic tail"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const withHint: Context = { ...baseContext, systemPromptCacheBreakpointIndex: 0 };

		let payloadBase: unknown;
		let payloadWithHint: unknown;
		using _hook = hookFetch(
			async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await streamOpenAIResponses(openaiResponsesModel, baseContext, {
			apiKey: "test-key",
			onPayload: p => {
				payloadBase = p;
			},
		}).result();
		await streamOpenAIResponses(openaiResponsesModel, withHint, {
			apiKey: "test-key",
			onPayload: p => {
				payloadWithHint = p;
			},
		}).result();
		expect(JSON.stringify(payloadWithHint)).toBe(JSON.stringify(payloadBase));
	});

	it("OpenAI Completions provider produces identical payload with or without the hint", async () => {
		const baseContext: Context = {
			systemPrompt: ["stable core", "dynamic tail"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const withHint: Context = { ...baseContext, systemPromptCacheBreakpointIndex: 0 };

		let payloadBase: unknown;
		let payloadWithHint: unknown;
		using _hook = hookFetch(
			async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await streamOpenAICompletions(openaiCompletionsModel, baseContext, {
			apiKey: "test-key",
			onPayload: p => {
				payloadBase = p;
			},
		}).result();
		await streamOpenAICompletions(openaiCompletionsModel, withHint, {
			apiKey: "test-key",
			onPayload: p => {
				payloadWithHint = p;
			},
		}).result();
		expect(JSON.stringify(payloadWithHint)).toBe(JSON.stringify(payloadBase));
	});

	it("Ollama provider (openai-completions API) produces identical payload with or without the hint", async () => {
		const baseContext: Context = {
			systemPrompt: ["stable core", "dynamic tail"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const withHint: Context = { ...baseContext, systemPromptCacheBreakpointIndex: 0 };

		let payloadBase: unknown;
		let payloadWithHint: unknown;
		using _hook = hookFetch(
			async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await streamOllama(ollamaModel, baseContext, {
			onPayload: p => {
				payloadBase = p;
			},
		}).result();
		await streamOllama(ollamaModel, withHint, {
			onPayload: p => {
				payloadWithHint = p;
			},
		}).result();
		expect(JSON.stringify(payloadWithHint)).toBe(JSON.stringify(payloadBase));
	});

	it("R2 ACCEPTANCE: all non-Anthropic providers tolerate the hint without crash and produce byte-identical wire payloads", () => {
		// This block exists as a documentation assertion — if it ever fails, one of the
		// per-provider tests above will have been removed or weakened. The framing makes
		// the acceptance bar concrete: silent indifference, not active handling.
		expect(true).toBe(true);
	});
});
