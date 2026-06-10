import type { EvidenceCard, ResearchBrief } from "./types";

const EXCERPT_LIMIT = 240;

export function renderSynthesizerPrompt(brief: ResearchBrief, evidence: EvidenceCard[]): string {
	const lines = [
		"You are operating in RESEARCH SYNTHESIZER mode (oracle role).",
		"Do NOT propose implementation. Do NOT pick a winner without evidence.",
		"",
		`Question: ${brief.question}`,
		`Lanes covered: ${brief.lanes.join(", ")}`,
		`Risk level: ${brief.riskLevel}`,
		"",
		`Evidence cards (${evidence.length}):`,
	];
	for (const card of evidence) {
		lines.push(
			`\t- [${card.lane}/grade=${card.grade}] ${card.sourceRef}`,
			`\t\texcerpt: ${truncate(card.excerpt)}`,
			`\t\tclaims: ${card.claims.join("; ")}`,
		);
	}
	lines.push(
		"",
		"Produce:",
		"\t1. Up to 3 candidate hypotheses, each grounded in cited evidence ids.",
		"\t2. Explicit conflicts: which claims contradict which.",
		"\t3. Missing evidence: what would change your ranking.",
		"\t4. A single recommendedDecision with rationale, confidence (low|medium|high), and nextActions.",
		"",
		"Rules:",
		"\t- Cite evidence by id when making any claim.",
		"\t- NEVER use social-lane evidence as truth; treat it as signal only.",
		"\t- If evidence is insufficient, return needs-more-research with concrete next research tasks.",
	);
	return lines.join("\n");
}

export function renderCriticPrompt(brief: ResearchBrief, evidence: EvidenceCard[], synthesis: string): string {
	return [
		"You are operating in RESEARCH CRITIC mode (reviewer role).",
		"Your job is to attack the synthesis. blocking: true.",
		"",
		`Question: ${brief.question}`,
		`Evidence cards: ${evidence.length}`,
		"Synthesis:",
		synthesis,
		"",
		"Check for:",
		"\t- social-lane signal used as truth",
		"\t- source citations that are not primary",
		"\t- repo-lane contradictions ignored",
		"\t- memory-lane staleness vs current repo state",
		"\t- overgeneralization beyond evidence",
		"\t- recommended action that exceeds the brief scope",
		"",
		"Return:",
		"\t- blockingFindings: items the operator MUST address before applying",
		"\t- softFindings: items worth noting but non-blocking",
		"\t- nextResearchTasks: concrete lane + query suggestions if blocked",
	].join("\n");
}

function truncate(value: string): string {
	return value.length <= EXCERPT_LIMIT ? value : `${value.slice(0, EXCERPT_LIMIT)}`;
}
