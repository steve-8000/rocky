import { describe, expect, it } from "bun:test";
import { __BUILTIN_REMEDIATIONS } from "../../src/autonomy/planner";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { metricDefinitions } from "../../src/metrics/definitions";

type ValidatedSchemaEntry =
	| { type: "enum"; values: readonly string[] }
	| { type: "boolean" }
	| { type: Exclude<string, "enum" | "boolean"> };

const schema = SETTINGS_SCHEMA as unknown as Record<string, ValidatedSchemaEntry>;

function assertValidSettingValue(settingKey: string, value: unknown, source: string): void {
	const entry = schema[settingKey];
	if (!entry) {
		throw new Error(`${source} references unknown setting ${settingKey}`);
	}

	if (entry.type === "enum") {
		const values = "values" in entry ? entry.values : [];
		if (typeof value !== "string" || !values.includes(value)) {
			throw new Error(`${source} sets ${settingKey}=${String(value)}, but expected one of: ${values.join(", ")}`);
		}
		return;
	}

	if (entry.type === "boolean") {
		if (typeof value !== "boolean") {
			throw new Error(`${source} sets ${settingKey}=${String(value)}, but expected a boolean`);
		}
		return;
	}

	throw new Error(`${source} references unsupported ${entry.type} setting ${settingKey}`);
}

describe("built-in planner remediations", () => {
	it("are keyed by registered metric names", () => {
		const registeredMetricNames = new Set(metricDefinitions.map(definition => definition.name));

		for (const metric of Object.keys(__BUILTIN_REMEDIATIONS)) {
			expect(registeredMetricNames.has(metric), `${metric} is not registered in metricDefinitions`).toBe(true);
		}
	});

	it("only patch and rollback valid settings values", () => {
		for (const [metric, remediation] of Object.entries(__BUILTIN_REMEDIATIONS)) {
			for (const [settingKey, value] of Object.entries(remediation.patch)) {
				assertValidSettingValue(settingKey, value, `${metric}.patch`);
			}

			for (const [settingKey, value] of Object.entries(remediation.rollback)) {
				assertValidSettingValue(settingKey, value, `${metric}.rollback`);
			}
		}
	});
});
