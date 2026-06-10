import { describe, expect, test } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import {
	buildLocalLlmEvidencePrompt,
	createEmptyLocalEvidenceBundle,
	getLocalLlmConfig,
	getLocalLlmRoleAlias,
	isLocalLlmUseCaseEnabled,
	LOCAL_LLM_STABLE_EVIDENCE_SYSTEM_PROMPT,
	validateLocalEvidenceBundle,
} from "@amaze/coding-agent/local-llm";

describe("local LLM config", () => {
	test("defaults to disabled local LLM role", () => {
		const settings = Settings.isolated();
		const config = getLocalLlmConfig(settings);

		expect(config.enabled).toBe(false);
		expect(config.required).toBe(false);
		expect(config.modelRole).toBe("Resercher");
		expect(getLocalLlmRoleAlias(config)).toBe("Resercher");
		expect(isLocalLlmUseCaseEnabled(config, "log_summarizer")).toBe(false);
	});

	test("enables configured local LLM use cases", () => {
		const settings = Settings.isolated({
			"localLlm.enabled": true,
			"localLlm.modelRole": "custom_local",
		});
		const config = getLocalLlmConfig(settings);

		expect(getLocalLlmRoleAlias(config)).toBe("custom_local");
		expect(isLocalLlmUseCaseEnabled(config, "log_summarizer")).toBe(true);
		expect(isLocalLlmUseCaseEnabled(config, "context_compressor")).toBe(true);
	});
});

describe("local evidence bundle", () => {
	test("validates evidence refs conservatively", () => {
		const bundle = createEmptyLocalEvidenceBundle("context_compressor", 1000);
		bundle.claims.push({ claim: "A grounded claim", evidenceRefs: ["E1"], confidence: "high" });
		bundle.relevantFiles.push({
			path: "src/a.ts",
			reason: "Referenced by E1",
			evidenceRefs: ["E1"],
			confidence: "medium",
		});

		expect(validateLocalEvidenceBundle(bundle)).toEqual([]);

		bundle.risks.push({ risk: "Uncited risk", evidenceRefs: [] });
		expect(validateLocalEvidenceBundle(bundle)).toContain(
			"risks[0].evidenceRefs must contain at least one evidence reference",
		);
	});

	test("rejects invalid confidence and negative compression counts", () => {
		const bundle = createEmptyLocalEvidenceBundle("context_compressor", -1);
		bundle.compression.outputChars = -5;
		bundle.claims.push({ claim: "Bad confidence", evidenceRefs: ["E1"], confidence: "certain" as "high" });

		const errors = validateLocalEvidenceBundle(bundle);
		expect(errors).toContain("compression.estimatedRawChars must be non-negative");
		expect(errors).toContain("compression.outputChars must be non-negative");
		expect(errors).toContain("claims[0].confidence must be one of low, medium, high");
	});
});

describe("local LLM prompt", () => {
	test("keeps stable local evidence contract separate from volatile evidence", () => {
		const prompt = buildLocalLlmEvidencePrompt({
			useCase: "context_compressor",
			objective: "Compress evidence",
			evidence: "[E1] src/a.ts says cache prefix is stable",
		});

		expect(LOCAL_LLM_STABLE_EVIDENCE_SYSTEM_PROMPT).toContain("Use only supplied evidence");
		expect(LOCAL_LLM_STABLE_EVIDENCE_SYSTEM_PROMPT).not.toContain("[E1]");
		expect(prompt).toContain("Use case: context_compressor");
		expect(prompt).toContain("[E1] src/a.ts");
	});
});
