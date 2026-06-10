import type { Settings } from "../config/settings";
import type { LocalLlmRuntimeConfig, LocalLlmUseCase } from "./types";

export const LOCAL_LLM_MODEL_ROLE = "Resercher";

export function getLocalLlmConfig(settings: Settings): LocalLlmRuntimeConfig {
	return {
		enabled: settings.get("localLlm.enabled"),
		required: settings.get("localLlm.required"),
		modelRole: settings.get("localLlm.modelRole") ?? LOCAL_LLM_MODEL_ROLE,
		structuredOutput: settings.get("localLlm.structuredOutput"),
		disableThinking: settings.get("localLlm.disableThinking"),
		maxInputTokens: settings.get("localLlm.maxInputTokens"),
		maxOutputTokens: settings.get("localLlm.maxOutputTokens"),
		timeoutMs: settings.get("localLlm.timeoutMs"),
		useForLogSummarizer: settings.get("localLlm.useForLogSummarizer"),
		useForContextCompressor: settings.get("localLlm.useForContextCompressor"),
	};
}

export function isLocalLlmUseCaseEnabled(config: LocalLlmRuntimeConfig, useCase: LocalLlmUseCase): boolean {
	if (!config.enabled) return false;
	switch (useCase) {
		case "log_summarizer":
			return config.useForLogSummarizer;
		case "context_compressor":
			return config.useForContextCompressor;
	}
}

export function getLocalLlmRoleAlias(config: Pick<LocalLlmRuntimeConfig, "modelRole">): string {
	return config.modelRole.trim() || LOCAL_LLM_MODEL_ROLE;
}
