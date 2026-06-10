import type { LocalLlmUseCase } from "./types";

export const LOCAL_LLM_STABLE_EVIDENCE_SYSTEM_PROMPT = `You are a local evidence collector for a coding-agent runtime.
Return compact JSON only when a schema is provided.
Use only supplied evidence and tool results.
Do not infer file existence, source existence, test results, or repository facts.
Every claim must cite evidence references supplied in the input.
Put uncertainty, missing coverage, and unsupported requests in unsupported/risks fields.
Remote models and repository tools remain authoritative; your output is a candidate evidence bundle.`;

export function buildLocalLlmEvidencePrompt(options: {
	useCase: LocalLlmUseCase;
	objective: string;
	evidence: string;
}): string {
	return [
		`Use case: ${options.useCase}`,
		`Objective: ${options.objective}`,
		"Evidence:",
		options.evidence,
		"Return only the requested structured output. Preserve evidence ids exactly.",
	].join("\n");
}
