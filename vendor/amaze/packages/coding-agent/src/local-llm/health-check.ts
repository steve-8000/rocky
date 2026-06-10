import type { Api, Model } from "@amaze/ai";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { getLocalLlmConfig, getLocalLlmRoleAlias } from "./config";
import type { LocalLlmHealth } from "./types";

export function resolveLocalLlmHealth(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	modelRegistry?: ModelRegistry;
}): LocalLlmHealth {
	const config = getLocalLlmConfig(options.settings);
	const roleAlias = getLocalLlmRoleAlias(config);
	if (!config.enabled) {
		return { available: false, modelRole: config.modelRole, reason: "localLlm.enabled is false" };
	}

	const resolved = resolveModelRoleValue(roleAlias, options.availableModels, {
		settings: options.settings,
		modelRegistry: options.modelRegistry,
	});
	const model = resolved.model;
	if (!model) {
		return {
			available: false,
			modelRole: config.modelRole,
			reason: resolved.warning ?? `No model resolved for ${roleAlias}`,
		};
	}

	return {
		available: true,
		modelRole: config.modelRole,
		provider: model.provider,
		model: model.id,
		supportsJsonObject: config.structuredOutput,
		supportsDisableThinking: config.disableThinking,
	};
}
