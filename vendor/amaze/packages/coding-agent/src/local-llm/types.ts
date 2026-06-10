import type { Usage } from "@amaze/ai";

export type LocalLlmUseCase = "log_summarizer" | "context_compressor";
export type LocalEvidenceConfidence = "low" | "medium" | "high";

export interface LocalLlmRuntimeConfig {
	enabled: boolean;
	required: boolean;
	modelRole: string;
	structuredOutput: boolean;
	disableThinking: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	timeoutMs: number;
	useForLogSummarizer: boolean;
	useForContextCompressor: boolean;
}

export interface LocalEvidenceRef {
	id: string;
	source: string;
	quote?: string;
}

export interface LocalEvidenceFileCandidate {
	path: string;
	reason: string;
	evidenceRefs: string[];
	confidence: LocalEvidenceConfidence;
}

export interface LocalEvidenceClaim {
	claim: string;
	evidenceRefs: string[];
	confidence: LocalEvidenceConfidence;
}

export interface LocalEvidenceRisk {
	risk: string;
	evidenceRefs: string[];
}

export interface LocalEvidenceBundle {
	version: 1;
	producedBy: {
		provider?: string;
		model?: string;
		role: LocalLlmUseCase;
	};
	relevantFiles: LocalEvidenceFileCandidate[];
	claims: LocalEvidenceClaim[];
	risks: LocalEvidenceRisk[];
	unsupported: string[];
	nextReads: string[];
	compression: {
		inputTokens?: number;
		outputTokens?: number;
		estimatedRawChars: number;
		outputChars: number;
	};
}

export interface LocalLlmHealth {
	available: boolean;
	modelRole: string;
	provider?: string;
	model?: string;
	supportsJsonObject?: boolean;
	supportsDisableThinking?: boolean;
	promptCacheObserved?: boolean;
	latencyMs?: number;
	reason?: string;
}

export interface LocalLlmMetrics {
	localCalls: number;
	localFailures: number;
	localLatencyMs: number;
	localPromptTokens: number;
	localCompletionTokens: number;
	localCachedTokens: number;
	rawInputChars: number;
	bundleOutputChars: number;
	compressionRatio: number;
}

export interface LocalLlmCallUsage {
	usage?: Usage | null;
	cachedTokens?: number;
	latencyMs?: number;
}
