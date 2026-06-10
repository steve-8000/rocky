import { describe, expect, it } from "bun:test";
import { EventBus, type SessionEvent } from "../../src/observability";
import { emitPromptCacheEventIfPossible } from "../../src/observability/prompt-cache-emit";

function emittedPromptCacheEvents(bus: EventBus): Array<SessionEvent & { type: "prompt.cache" }> {
	return bus
		.snapshot()
		.filter((event): event is SessionEvent & { type: "prompt.cache" } => event.type === "prompt.cache");
}

describe("emitPromptCacheEventIfPossible", () => {
	it("emits one prompt.cache event for an Anthropic-shaped response with cache fields", () => {
		const bus = new EventBus();
		emitPromptCacheEventIfPossible({
			sessionId: "session-cache",
			response: { usage: { cache_read_input_tokens: 12, cache_creation_input_tokens: 3 } },
			bus,
			policyResolver: { classifyMiss: () => "tail-change" },
		});

		const events = emittedPromptCacheEvents(bus);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "prompt.cache",
			sessionId: "session-cache",
			readTokens: 12,
			writeTokens: 3,
			missReason: "tail-change",
		});
		expect(events[0].ts).toBeGreaterThan(0);
	});

	it("does not emit when cache token metadata is absent", () => {
		const bus = new EventBus();
		emitPromptCacheEventIfPossible({
			sessionId: "session-cache",
			response: { usage: { input: 10, output: 5 } },
			bus,
		});

		expect(emittedPromptCacheEvents(bus)).toHaveLength(0);
	});

	it("classifies read-only cache usage as none", () => {
		const bus = new EventBus();
		emitPromptCacheEventIfPossible({
			sessionId: "session-cache",
			response: { usage: { cache_read_input_tokens: 21, cache_creation_input_tokens: 0 } },
			bus,
			policyResolver: { classifyMiss: () => "prefix-change" },
		});

		expect(emittedPromptCacheEvents(bus)[0]).toMatchObject({
			readTokens: 21,
			writeTokens: 0,
			missReason: "none",
		});
	});

	it("classifies write-only cache usage without a policy resolver as unknown", () => {
		const bus = new EventBus();
		emitPromptCacheEventIfPossible({
			sessionId: "session-cache",
			response: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 8 } },
			bus,
		});

		expect(emittedPromptCacheEvents(bus)[0]).toMatchObject({
			readTokens: 0,
			writeTokens: 8,
			missReason: "unknown",
		});
	});
});
