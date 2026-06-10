import type { LocalEvidenceBundle, LocalEvidenceClaim, LocalEvidenceFileCandidate, LocalEvidenceRisk } from "./types";

const CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);
const LOCAL_LLM_USE_CASE_VALUES = new Set(["log_summarizer", "context_compressor"]);

export const LOCAL_EVIDENCE_BUNDLE_SCHEMA = {
	properties: {
		version: { type: "uint8" },
		producedBy: {
			properties: {
				role: { type: "string" },
			},
			optionalProperties: {
				provider: { type: "string" },
				model: { type: "string" },
			},
		},
		relevantFiles: {
			elements: {
				properties: {
					path: { type: "string" },
					reason: { type: "string" },
					evidenceRefs: { elements: { type: "string" } },
					confidence: { enum: ["low", "medium", "high"] },
				},
			},
		},
		claims: {
			elements: {
				properties: {
					claim: { type: "string" },
					evidenceRefs: { elements: { type: "string" } },
					confidence: { enum: ["low", "medium", "high"] },
				},
			},
		},
		risks: {
			elements: {
				properties: {
					risk: { type: "string" },
					evidenceRefs: { elements: { type: "string" } },
				},
			},
		},
		unsupported: { elements: { type: "string" } },
		nextReads: { elements: { type: "string" } },
		compression: {
			properties: {
				estimatedRawChars: { type: "uint32" },
				outputChars: { type: "uint32" },
			},
			optionalProperties: {
				inputTokens: { type: "uint32" },
				outputTokens: { type: "uint32" },
			},
		},
	},
	additionalProperties: false,
} as const;

export function createEmptyLocalEvidenceBundle(
	role: LocalEvidenceBundle["producedBy"]["role"],
	estimatedRawChars = 0,
): LocalEvidenceBundle {
	return {
		version: 1,
		producedBy: { role },
		relevantFiles: [],
		claims: [],
		risks: [],
		unsupported: [],
		nextReads: [],
		compression: {
			estimatedRawChars,
			outputChars: 0,
		},
	};
}

export function validateLocalEvidenceBundle(bundle: LocalEvidenceBundle): string[] {
	const errors: string[] = [];
	if (bundle.version !== 1) errors.push("version must be 1");
	if (!LOCAL_LLM_USE_CASE_VALUES.has(bundle.producedBy.role)) {
		errors.push(`producedBy.role must be one of ${Array.from(LOCAL_LLM_USE_CASE_VALUES).join(", ")}`);
	}
	if (bundle.compression.estimatedRawChars < 0) errors.push("compression.estimatedRawChars must be non-negative");
	if (bundle.compression.outputChars < 0) errors.push("compression.outputChars must be non-negative");
	for (const [index, file] of bundle.relevantFiles.entries()) {
		validateEvidenceRefs(file, `relevantFiles[${index}]`, errors);
		validateConfidence(file.confidence, `relevantFiles[${index}].confidence`, errors);
		if (!file.path.trim()) errors.push(`relevantFiles[${index}].path is required`);
	}
	for (const [index, claim] of bundle.claims.entries()) {
		validateEvidenceRefs(claim, `claims[${index}]`, errors);
		validateConfidence(claim.confidence, `claims[${index}].confidence`, errors);
		if (!claim.claim.trim()) errors.push(`claims[${index}].claim is required`);
	}
	for (const [index, risk] of bundle.risks.entries()) {
		validateEvidenceRefs(risk, `risks[${index}]`, errors);
		if (!risk.risk.trim()) errors.push(`risks[${index}].risk is required`);
	}
	return errors;
}

export function summarizeLocalEvidenceBundle(bundle: LocalEvidenceBundle): string {
	const lines = [
		`LocalEvidenceBundle v${bundle.version} (${bundle.producedBy.role})`,
		`Files: ${bundle.relevantFiles.length}; claims: ${bundle.claims.length}; risks: ${bundle.risks.length}; unsupported: ${bundle.unsupported.length}`,
	];
	if (bundle.relevantFiles.length > 0) {
		lines.push("Relevant files:");
		for (const file of bundle.relevantFiles) {
			lines.push(`- ${file.path} [${file.confidence}]: ${file.reason} (${file.evidenceRefs.join(", ")})`);
		}
	}
	if (bundle.claims.length > 0) {
		lines.push("Claims:");
		for (const claim of bundle.claims) {
			lines.push(`- [${claim.confidence}] ${claim.claim} (${claim.evidenceRefs.join(", ")})`);
		}
	}
	if (bundle.risks.length > 0) {
		lines.push("Risks:");
		for (const risk of bundle.risks) {
			lines.push(`- ${risk.risk} (${risk.evidenceRefs.join(", ")})`);
		}
	}
	if (bundle.unsupported.length > 0) {
		lines.push("Unsupported:");
		for (const item of bundle.unsupported) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}

function validateConfidence(value: string, path: string, errors: string[]): void {
	if (!CONFIDENCE_VALUES.has(value)) {
		errors.push(`${path} must be one of ${Array.from(CONFIDENCE_VALUES).join(", ")}`);
	}
}

function validateEvidenceRefs(
	item: LocalEvidenceClaim | LocalEvidenceFileCandidate | LocalEvidenceRisk,
	path: string,
	errors: string[],
): void {
	if (item.evidenceRefs.length === 0) {
		errors.push(`${path}.evidenceRefs must contain at least one evidence reference`);
	}
	for (const [index, ref] of item.evidenceRefs.entries()) {
		if (!ref.trim()) errors.push(`${path}.evidenceRefs[${index}] is empty`);
	}
}
