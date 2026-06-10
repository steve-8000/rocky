/**
 * V3 T4-F — production LLM judge skeleton.
 *
 * `ProductionLlmJudgeRunner` is the seam between the verifier's `llm-judged` criterion
 * backend and a real Claude API call. It wraps a caller-injected `chat` function so the
 * heavy provider/session machinery lives outside this module — keeps the verifier core
 * free of provider-specific code, and lets the runner be tested deterministically.
 *
 * Production wiring (caller's responsibility):
 *   - Spawn an isolated mini-session OR a single one-shot `streamSimple` call
 *   - Tool set: minimal (read + search, no edit/write — judges look, they don't write)
 *   - Model: cheap one (haiku class) to keep cost ≤ acceptance threshold
 *   - Inject the `chat` function that takes the rendered prompt and returns the assistant text
 *
 * Built-in:
 *   - Focused prompt template that asks the judge to return a structured verdict
 *   - Robust JSON parser that recovers `{status, confidence, evidence}` from the model's
 *     reply, even when it wraps the JSON in prose or code-fence
 *   - Optional cost cap: if the chat function reports tokens used and exceeds `maxTokens`,
 *     the runner returns `uncertain` with a "cost cap" reason rather than risking a
 *     judgment based on truncated reasoning
 *
 * Why a skeleton vs a fully-wired class? The `chat` function is the entire integration
 * surface — `streamAnthropic` / `streamSimple` callers know their session, model, auth.
 * This module focuses on prompt template + parsing, which is the part that's *not*
 * obvious and benefits from unit testing.
 */

import type { CriterionStatus, LlmJudgeRunner } from "./verifier";

/**
 * Caller-injected chat function. Returns the assistant's reply text and an optional
 * token count. Implementations:
 *   - Production: wraps `streamSimple` or `streamAnthropic` with a focused prompt
 *   - Test: returns scripted text, used to lock parsing behavior
 *
 * The runner does not retry on its own — if the chat fails, the verdict surfaces as
 * `fail` with the error message in evidence. Retrying judgments is the higher-level
 * revision-loop's call, not this primitive's.
 */
export type LlmJudgeChat = (input: { prompt: string }) => Promise<{
	reply: string;
	tokensUsed?: number;
}>;

export interface ProductionLlmJudgeOptions {
	chat: LlmJudgeChat;
	/**
	 * Hard cap on tokens-per-judgment. When the chat reports more, the verdict downgrades
	 * to `uncertain` with the actual cost in evidence — protects against runaway prompts
	 * sneaking expensive judgments into the verification loop.
	 *
	 * Default: 500 — matches the Phase 4 acceptance bar.
	 */
	maxTokensPerCall?: number;
}

const VERDICT_PROMPT_TEMPLATE = `You are an acceptance-criterion judge. A subagent finished work and the parent needs to verify a single criterion before accepting the result. You receive:

  - QUESTION: the criterion phrased as a yes/no judgment (the parent's intent in their words)
  - CANDIDATE: the subagent's output / diff / artifact / claim to evaluate

Your ONLY job is to decide:
  - "pass": you are confident the candidate satisfies the question
  - "fail": you are confident the candidate does NOT satisfy the question
  - "uncertain": evidence is insufficient or contradictory — DO NOT guess

Return ONLY a single JSON object with this exact shape, no surrounding prose:
{
  "status": "pass" | "fail" | "uncertain",
  "confidence": 0.0 to 1.0,
  "evidence": "one short sentence citing what in the candidate led to your verdict"
}

Be ruthlessly literal — only mark "pass" when the candidate clearly satisfies the question. If you would need to ASSUME context not present in the candidate, return "uncertain".

QUESTION:
{{QUESTION}}

CANDIDATE:
{{CANDIDATE}}`;

/**
 * Parse the judge's reply into a structured verdict. Strategy:
 *   1. Strip code-fence wrappers if present (```json ... ```)
 *   2. Find the FIRST balanced top-level JSON object using a brace counter
 *   3. JSON.parse, validate fields against expected shape
 *   4. On any failure, return `null` so caller can fall back to `uncertain`
 *
 * Returns `null` rather than throwing so the runner can decide the fallback strategy.
 */
export function parseLlmVerdict(reply: string): {
	status: CriterionStatus;
	confidence: number;
	evidence: string;
} | null {
	// Strip common code-fence wrappers.
	const stripped = reply
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.trim();
	// Find the first balanced { ... } block. Naive bracket counter — sufficient for the
	// prompt-controlled output shape we expect.
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
			continue;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				const candidate = stripped.slice(start, i + 1);
				try {
					const parsed: unknown = JSON.parse(candidate);
					if (
						parsed &&
						typeof parsed === "object" &&
						"status" in parsed &&
						"confidence" in parsed &&
						"evidence" in parsed
					) {
						const obj = parsed as { status: unknown; confidence: unknown; evidence: unknown };
						const status = obj.status;
						const confidence = obj.confidence;
						const evidence = obj.evidence;
						if (
							(status === "pass" || status === "fail" || status === "uncertain") &&
							typeof confidence === "number" &&
							typeof evidence === "string"
						) {
							return {
								status,
								confidence: Math.max(0, Math.min(1, confidence)),
								evidence,
							};
						}
					}
				} catch {
					// Continue searching — maybe the first {} wasn't the verdict object.
					depth = 0;
					start = -1;
				}
			}
		}
	}
	return null;
}

export class ProductionLlmJudgeRunner implements LlmJudgeRunner {
	readonly #chat: LlmJudgeChat;
	readonly #maxTokens: number;

	constructor(options: ProductionLlmJudgeOptions) {
		this.#chat = options.chat;
		this.#maxTokens = options.maxTokensPerCall ?? 500;
	}

	async judge(input: { question: string; candidate: string }): Promise<{
		status: CriterionStatus;
		evidence: string;
		confidence: number;
		tokensUsed?: number;
	}> {
		const prompt = VERDICT_PROMPT_TEMPLATE.replace("{{QUESTION}}", input.question).replace(
			"{{CANDIDATE}}",
			input.candidate,
		);
		let reply: string;
		let tokensUsed: number | undefined;
		try {
			const out = await this.#chat({ prompt });
			reply = out.reply;
			tokensUsed = out.tokensUsed;
		} catch (error) {
			// Chat failure → fail-closed with evidence pointing at the chat error. Verifier
			// surfaces this so revision-loop or operator can route around it.
			return {
				status: "fail",
				confidence: 1.0,
				evidence: `LLM judge chat failed: ${String(error)}`,
			};
		}

		// Cost cap — protect against expensive judgments that miss the acceptance bar.
		if (tokensUsed !== undefined && tokensUsed > this.#maxTokens) {
			return {
				status: "uncertain",
				confidence: 0.0,
				evidence: `LLM judge exceeded cost cap (used ${tokensUsed} tokens, cap ${this.#maxTokens}). Reduce candidate size or raise cap.`,
				tokensUsed,
			};
		}

		const parsed = parseLlmVerdict(reply);
		if (!parsed) {
			// Unparseable reply → uncertain, never invent a verdict. Evidence preserves the
			// raw reply so the operator can debug the prompt drift.
			return {
				status: "uncertain",
				confidence: 0.0,
				evidence: `LLM judge returned unparseable reply (no JSON verdict found). Raw: ${reply.slice(0, 200)}`,
				tokensUsed,
			};
		}

		return { ...parsed, tokensUsed };
	}
}
