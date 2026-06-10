import type { EventBus } from "./event-bus";

export type PromptCacheMissReason = "none" | "unknown" | string;

export interface PromptCachePolicyResolver {
	classifyMiss?: (input: {
		readTokens: number;
		writeTokens: number;
		response: PromptCacheResponse;
	}) => PromptCacheMissReason;
}

export interface PromptCacheResponse {
	usage?:
		| {
				cache_read_input_tokens?: number;
				cache_creation_input_tokens?: number;
				[key: string]: unknown;
		  }
		| undefined;
}

export interface EmitPromptCacheEventOptions {
	sessionId: string;
	response: PromptCacheResponse;
	bus: EventBus;
	policyResolver?: PromptCachePolicyResolver;
}

export function emitPromptCacheEventIfPossible({
	sessionId,
	response,
	bus,
	policyResolver,
}: EmitPromptCacheEventOptions): void {
	const usage = response.usage;
	if (!usage) return;

	const hasAnthropicRead = usage.cache_read_input_tokens !== undefined;
	const hasAnthropicWrite = usage.cache_creation_input_tokens !== undefined;
	if (!hasAnthropicRead && !hasAnthropicWrite) return;

	const readTokens = usage.cache_read_input_tokens ?? 0;
	const writeTokens = usage.cache_creation_input_tokens ?? 0;
	const missReason =
		readTokens > 0 && writeTokens === 0
			? "none"
			: (policyResolver?.classifyMiss?.({ readTokens, writeTokens, response }) ?? "unknown");

	bus.emit({
		type: "prompt.cache",
		sessionId,
		ts: Date.now(),
		readTokens,
		writeTokens,
		missReason,
	});
}
