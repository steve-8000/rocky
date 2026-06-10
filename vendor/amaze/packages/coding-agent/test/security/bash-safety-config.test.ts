import { describe, expect, test } from "bun:test";
import type { Settings } from "../../src/config/settings";
import { resolveBashSafetyOptions } from "../../src/security/bash-safety-config";

function stubSettings(values: Record<string, unknown>): Settings {
	return {
		get: (path: string) => values[path],
	} as unknown as Settings;
}

describe("resolveBashSafetyOptions", () => {
	test("returns the configured bash safety policy values", () => {
		const settings = stubSettings({
			"bash.safety.enabled": false,
			"bash.safety.mode": "ask",
			"bash.safety.allowPatterns": ["^safe"],
			"bash.safety.denyPatterns": ["danger"],
		});

		expect(resolveBashSafetyOptions(settings)).toEqual({
			enabled: false,
			mode: "ask",
			allowPatterns: ["^safe"],
			denyPatterns: ["danger"],
		});
	});

	test("falls back to empty pattern arrays when pattern settings are nullish", () => {
		const settings = stubSettings({
			"bash.safety.enabled": true,
			"bash.safety.mode": "block",
			"bash.safety.allowPatterns": undefined,
			"bash.safety.denyPatterns": null,
		});

		expect(resolveBashSafetyOptions(settings)).toEqual({
			enabled: true,
			mode: "block",
			allowPatterns: [],
			denyPatterns: [],
		});
	});
});
