import type { LocalEvidenceBundle, LocalLlmCallUsage, LocalLlmMetrics } from "./types";

export function createLocalLlmMetrics(): LocalLlmMetrics {
	return {
		localCalls: 0,
		localFailures: 0,
		localLatencyMs: 0,
		localPromptTokens: 0,
		localCompletionTokens: 0,
		localCachedTokens: 0,
		rawInputChars: 0,
		bundleOutputChars: 0,
		compressionRatio: 1,
	};
}

export function recordLocalLlmCall(metrics: LocalLlmMetrics, call: LocalLlmCallUsage): LocalLlmMetrics {
	const usage = call.usage;
	return {
		...metrics,
		localCalls: metrics.localCalls + 1,
		localLatencyMs: metrics.localLatencyMs + (call.latencyMs ?? 0),
		localPromptTokens: metrics.localPromptTokens + (usage?.input ?? 0),
		localCompletionTokens: metrics.localCompletionTokens + (usage?.output ?? 0),
		localCachedTokens: metrics.localCachedTokens + (call.cachedTokens ?? usage?.cacheRead ?? 0),
	};
}

export function recordLocalLlmFailure(metrics: LocalLlmMetrics): LocalLlmMetrics {
	return { ...metrics, localFailures: metrics.localFailures + 1 };
}

export function recordLocalEvidenceCompression(
	metrics: LocalLlmMetrics,
	bundle: Pick<LocalEvidenceBundle, "compression">,
): LocalLlmMetrics {
	const rawInputChars = metrics.rawInputChars + bundle.compression.estimatedRawChars;
	const bundleOutputChars = metrics.bundleOutputChars + bundle.compression.outputChars;
	return {
		...metrics,
		rawInputChars,
		bundleOutputChars,
		compressionRatio: bundleOutputChars > 0 ? rawInputChars / bundleOutputChars : metrics.compressionRatio,
	};
}
