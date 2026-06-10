import type { Settings } from "../config/settings";
import type { BashSafetyPolicyOptions } from "./bash-safety-policy";

export function resolveBashSafetyOptions(settings: Settings): BashSafetyPolicyOptions {
	return {
		enabled: settings.get("bash.safety.enabled"),
		mode: settings.get("bash.safety.mode"),
		allowPatterns: settings.get("bash.safety.allowPatterns") ?? [],
		denyPatterns: settings.get("bash.safety.denyPatterns") ?? [],
	};
}
