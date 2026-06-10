import * as fs from "node:fs";
import { MissionStore } from "../mission/store";
import type { EpistemicRole } from "../mission/types";
import { renderCriticPrompt, renderSynthesizerPrompt } from "../research/prompts";
import { scoreComplementarity } from "../research/scoring";
import { ResearchStore } from "../research/store";
import {
	CONFIDENCE_LEVELS,
	type ConfidenceLevel,
	CRITIQUE_VERDICTS,
	type CritiqueVerdict,
	DECISION_KINDS,
	type DecisionKind,
	EVIDENCE_GRADES,
	type EvidenceGrade,
	RESEARCH_LANES,
	type ResearchAssessment,
	type ResearchLane,
	RISK_LEVELS,
	type RiskLevel,
} from "../research/types";

export interface ResearchCommandOptionsBase {
	db?: string;
}

export async function runResearchBriefCommand(
	opts: ResearchCommandOptionsBase & {
		question: string;
		objectiveId?: string;
		lanes?: string;
		risk?: string;
		required?: string;
		disallowed?: string;
		stop?: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const lanes = opts.lanes ? parseList(opts.lanes) : [...RESEARCH_LANES];
		for (const lane of lanes) validateLane(lane);
		const riskLevel = opts.risk ?? "medium";
		validateRisk(riskLevel);
		const brief = store.createBrief({
			objectiveId: opts.objectiveId ?? null,
			question: opts.question,
			lanes: lanes as ResearchLane[],
			requiredEvidence: parseList(opts.required),
			disallowedEvidence: parseList(opts.disallowed),
			riskLevel: riskLevel as RiskLevel,
			stopCriteria: parseSemicolonList(opts.stop),
		});
		if (opts.json) {
			writeJson(brief);
			return;
		}
		process.stdout.write(
			`created brief: ${brief.id}\nquestion: ${brief.question}\nlanes: ${brief.lanes.join(",")}\nrisk: ${brief.riskLevel}\n`,
		);
	} finally {
		store.close();
	}
}

export async function runResearchRunCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		json?: boolean;
	},
): Promise<void> {
	const research = new ResearchStore(opts.db);
	const missions = new MissionStore(opts.db);
	try {
		const brief = requireBrief(research, opts.briefId);
		const mission = research.getMissionForBrief(brief.id);
		if (!mission) throw new Error(`Mission not found for research brief: ${brief.id}`);
		const run = missions.createResearchRun({
			missionId: mission.id,
			briefId: brief.id,
			objectiveId: brief.objectiveId,
			status: "running",
			completedAt: null,
		});
		const laneRuns = brief.lanes.map(lane =>
			missions.createLaneRun({
				missionId: mission.id,
				lane,
				agent: agentForLane(lane),
				epistemicRole: epistemicRoleForLane(lane),
				status: "pending",
				evidenceCount: 0,
				emptyReason: null,
				taskId: null,
				startedAt: null,
				endedAt: null,
			}),
		);
		missions.updateMission(mission.id, { state: "researching" });
		const output = {
			missionId: mission.id,
			runId: run.id,
			laneRunIds: laneRuns.map(laneRun => laneRun.id),
			lanes: laneRuns.map(laneRun => laneRun.lane),
		};
		if (opts.json) {
			writeJson(output);
			return;
		}
		const lines = [
			`started research run: ${run.id} for mission ${mission.id}`,
			...laneRuns.map(
				laneRun => `  lane ${laneRun.lane}: ${laneRun.id} (${laneRun.agent}/${laneRun.epistemicRole})`,
			),
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		missions.close();
		research.close();
	}
}

export async function runResearchListCommand(
	opts: ResearchCommandOptionsBase & {
		objectiveId?: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const briefs = store.listBriefs({ objectiveId: opts.objectiveId });
		if (opts.json) {
			writeJson(briefs);
			return;
		}
		const lines = [
			"id  risk  question",
			...briefs.map(brief => `${brief.id}  ${brief.riskLevel}  ${truncate(brief.question, 60)}`),
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchShowCommand(
	opts: ResearchCommandOptionsBase & {
		id: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const brief = requireBrief(store, opts.id);
		const evidence = store.listEvidence(brief.id);
		const decision = store.getDecision(brief.id);
		const synthesis = store.getLatestSynthesis(brief.id);
		const critique = store.getLatestCritique(brief.id);
		const runtimeCriticChecks = store.deriveRuntimeCriticChecks(brief.id);
		if (opts.json) {
			writeJson({ brief, evidence, decision, synthesis, critique, runtimeCriticChecks });
			return;
		}
		const lines = [
			`id: ${brief.id}`,
			`question: ${brief.question}`,
			`objective: ${brief.objectiveId ?? "<none>"}`,
			`lanes: ${brief.lanes.join(",")}`,
			`risk: ${brief.riskLevel}`,
			`required: ${brief.requiredEvidence.join(",")}`,
			`disallowed: ${brief.disallowedEvidence.join(",")}`,
			`stop: ${brief.stopCriteria.join("; ")}`,
			``,
			`evidence (${evidence.length}):`,
			...evidence.map(
				card =>
					`  ${card.id}  ${card.lane}/${card.grade}  ${card.sourceRef}  excerpt: ${truncate(card.excerpt, 80)}`,
			),
			``,
			`synthesis:`,
			synthesis
				? `  ${synthesis.id}  hypotheses=${synthesis.hypothesisCount}  recommended=${synthesis.recommended ?? "<none>"}  summary: ${truncate(synthesis.summary, 80)}`
				: "  <none>",
			``,
			`critique:`,
			critique
				? [
						`  ${critique.id}  verdict=${critique.verdict}  blocking=${critique.blockingCount} soft=${critique.softCount}  summary: ${truncate(critique.summary, 80)}`,
						...critique.findings.map(
							finding =>
								`  finding ${finding.id}  ${finding.severity}/${finding.requiredAction}  evidence=${finding.evidenceRefs.join(",") || "<none>"}  ${truncate(finding.message, 80)}`,
						),
					].join("\n")
				: "  <none>",
			``,
			`runtime critic checks (${runtimeCriticChecks.length}):`,
			...runtimeCriticChecks.map(
				check =>
					`  ${check.id}  ${check.trigger}/${check.severity}/${check.requiredAction}  ${truncate(check.message, 80)}`,
			),
		];
		if (decision) {
			lines.push(
				"decision:",
				`  hypothesis: ${decision.hypothesis}`,
				`  kind: ${decision.kind}`,
				`  confidence: ${decision.confidence}`,
				`  rationale: ${decision.rationale}`,
				`  evidenceRefs: ${decision.evidenceRefs.join(",")}`,
			);
		} else {
			lines.push("decision: <none>");
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchAddEvidenceCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		lane: string;
		grade: string;
		source: string;
		excerpt: string;
		claim?: string;
		directness?: number;
		specificity?: number;
		recency?: number;
		reproducibility?: number;
		json?: boolean;
	},
): Promise<void> {
	validateLane(opts.lane);
	validateGrade(opts.grade);
	const store = new ResearchStore(opts.db);
	try {
		const evidence = store.addEvidence({
			briefId: opts.briefId,
			lane: opts.lane as ResearchLane,
			grade: opts.grade as EvidenceGrade,
			sourceRef: opts.source,
			excerpt: opts.excerpt,
			claims: parseList(opts.claim),
			directness: opts.directness ?? 0.5,
			specificity: opts.specificity ?? 0.5,
			recency: opts.recency ?? 0.5,
			reproducibility: opts.reproducibility ?? 0.5,
		});
		if (opts.json) {
			writeJson(evidence);
			return;
		}
		process.stdout.write(`added evidence: ${evidence.id} to brief ${opts.briefId}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchListEvidenceCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		requireBrief(store, opts.briefId);
		const evidence = store.listEvidence(opts.briefId);
		if (opts.json) {
			writeJson(evidence);
			return;
		}
		const lines = [
			"id  lane/grade  source",
			...evidence.map(card => `${card.id}  ${card.lane}/${card.grade}  ${card.sourceRef}`),
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchDecideCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		hypothesis: string;
		kind?: string;
		confidence: string;
		rationale: string;
		evidence?: string;
		next?: string;
		rejected?: string;
		json?: boolean;
	},
): Promise<void> {
	validateConfidence(opts.confidence);
	if (opts.kind) validateDecisionKind(opts.kind);
	const store = new ResearchStore(opts.db);
	try {
		const decision = store.recordDecision({
			briefId: opts.briefId,
			hypothesis: opts.hypothesis,
			rationale: opts.rationale,
			kind: opts.kind as DecisionKind | undefined,
			confidence: opts.confidence as ConfidenceLevel,
			evidenceRefs: parseList(opts.evidence),
			rejectedOptions: parseRejected(opts.rejected),
			nextActions: parseSemicolonList(opts.next),
		});
		if (opts.json) {
			writeJson(decision);
			return;
		}
		process.stdout.write(`recorded decision: ${decision.id} on brief ${opts.briefId}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchScoreCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const brief = requireBrief(store, opts.briefId);
		const evidence = store.listEvidence(brief.id);
		const score = scoreComplementarity(brief, evidence);
		if (opts.json) {
			writeJson(score);
			return;
		}
		process.stdout.write(
			`${[
				`total: ${score.total}`,
				`laneCoverage: ${score.laneCoverage}`,
				`sourceQuality: ${score.sourceQuality}`,
				`contradictionPenalty: ${score.contradictionPenalty}`,
				`stalenessPenalty: ${score.stalenessPenalty}`,
				`socialOverweightPenalty: ${score.socialOverweightPenalty}`,
				"breakdown:",
				...score.breakdown.map(
					item => `  ${item.lane}: cards=${item.cardCount} avgGradeWeight=${item.avgGradeWeight}`,
				),
			].join("\n")}\n`,
		);
	} finally {
		store.close();
	}
}

export async function runResearchStatusCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const assessment = store.assessBrief(opts.briefId);
		if (opts.json) {
			writeJson(assessment);
			return;
		}
		process.stdout.write(`${formatAssessment(assessment)}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchNextCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const assessment = store.assessBrief(opts.briefId);
		if (opts.json) {
			writeJson({
				briefId: assessment.briefId,
				recommendedNextAction: assessment.recommendedNextAction,
				assessment,
			});
			return;
		}
		process.stdout.write(`${assessment.recommendedNextAction}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchSynthesizeCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const brief = requireBrief(store, opts.briefId);
		const evidence = store.listEvidence(brief.id);
		process.stdout.write(`${renderSynthesizerPrompt(brief, evidence)}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchCritiqueCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		synthesisFile?: string;
		synthesis?: string;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const brief = requireBrief(store, opts.briefId);
		const evidence = store.listEvidence(brief.id);
		const synthesis = resolveSynthesis(opts.synthesis, opts.synthesisFile);
		process.stdout.write(`${renderCriticPrompt(brief, evidence, synthesis)}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchRecordSynthesisCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		hypothesisCount: number;
		summary: string;
		recommended?: string;
		rawFile?: string;
		rawText?: string;
		json?: boolean;
	},
): Promise<void> {
	const store = new ResearchStore(opts.db);
	try {
		const synthesis = store.recordSynthesis({
			briefId: opts.briefId,
			hypothesisCount: opts.hypothesisCount,
			recommended: opts.recommended ?? null,
			summary: opts.summary,
			rawOutput: resolveRawOutput(opts.summary, opts.rawText, opts.rawFile),
		});
		if (opts.json) {
			writeJson(synthesis);
			return;
		}
		process.stdout.write(`recorded synthesis: ${synthesis.id} on brief ${synthesis.briefId}\n`);
	} finally {
		store.close();
	}
}

export async function runResearchRecordCritiqueCommand(
	opts: ResearchCommandOptionsBase & {
		briefId: string;
		blockingCount: number;
		softCount: number;
		verdict: string;
		summary: string;
		rawFile?: string;
		rawText?: string;
		findings?: string;
		json?: boolean;
	},
): Promise<void> {
	validateCritiqueVerdict(opts.verdict);
	const store = new ResearchStore(opts.db);
	try {
		const critique = store.recordCritique({
			briefId: opts.briefId,
			blockingCount: opts.blockingCount,
			softCount: opts.softCount,
			verdict: opts.verdict as CritiqueVerdict,
			summary: opts.summary,
			rawOutput: resolveRawOutput(opts.summary, opts.rawText, opts.rawFile),
			findings: parseCritiqueFindings(opts.findings),
		});
		if (opts.json) {
			writeJson(critique);
			return;
		}
		process.stdout.write(`recorded critique: ${critique.id} on brief ${critique.briefId}\n`);
	} finally {
		store.close();
	}
}

function requireBrief(store: ResearchStore, id: string) {
	const brief = store.getBrief(id);
	if (!brief) throw new Error(`Research brief not found: ${id}`);
	return brief;
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function agentForLane(lane: ResearchLane): string {
	if (lane === "social") return "Resercher_X";
	return "Resercher";
}

function epistemicRoleForLane(lane: ResearchLane): EpistemicRole {
	if (lane === "repo") return "repo_truth";
	if (lane === "source") return "source_harvest";
	return "social_signal";
}

function parseList(value: string | undefined): string[] {
	return value
		? value
				.split(",")
				.map(item => item.trim())
				.filter(Boolean)
		: [];
}

function parseSemicolonList(value: string | undefined): string[] {
	return value
		? value
				.split(";")
				.map(item => item.trim())
				.filter(Boolean)
		: [];
}

function parseRejected(value: string | undefined): Array<{ id: string; reason: string }> {
	return parseSemicolonList(value).map(item => {
		const index = item.indexOf(":");
		const id = index === -1 ? item.trim() : item.slice(0, index).trim();
		const reason = index === -1 ? "" : item.slice(index + 1).trim();
		return { id, reason };
	});
}

function parseCritiqueFindings(value: string | undefined):
	| Array<{
			id: string;
			severity: "soft" | "blocking";
			message: string;
			evidenceRefs: string[];
			requiredAction: "collect-evidence" | "resolve-conflict" | "run-critique" | "defer";
	  }>
	| undefined {
	if (!value) return undefined;
	return parseSemicolonList(value).map((item, index) => {
		const [severity, requiredAction, evidenceText, ...messageParts] = item.split(":");
		const message = messageParts.join(":").trim();
		const normalizedSeverity = severity?.trim() as "soft" | "blocking";
		const normalizedAction = requiredAction?.trim() as
			| "collect-evidence"
			| "resolve-conflict"
			| "run-critique"
			| "defer";
		if (normalizedSeverity !== "soft" && normalizedSeverity !== "blocking") {
			throw new Error(`Invalid critique finding severity: ${severity}`);
		}
		if (!["collect-evidence", "resolve-conflict", "run-critique", "defer"].includes(normalizedAction)) {
			throw new Error(`Invalid critique finding required action: ${requiredAction}`);
		}
		if (!message) throw new Error("Critique finding requires message");
		return {
			id: `finding-${index + 1}`,
			severity: normalizedSeverity,
			requiredAction: normalizedAction,
			evidenceRefs: parseList(evidenceText),
			message,
		};
	});
}

function resolveSynthesis(inline: string | undefined, file: string | undefined): string {
	if (inline !== undefined) return inline;
	if (file !== undefined) return fs.readFileSync(file, "utf8");
	throw new Error("critique requires --synthesis <text> or --synthesis-file <path>");
}

function resolveRawOutput(summary: string, inline: string | undefined, file: string | undefined): string {
	if (inline !== undefined) return inline;
	if (file !== undefined) return fs.readFileSync(file, "utf8");
	return summary;
}

function validateLane(value: string): void {
	if (!RESEARCH_LANES.includes(value as ResearchLane)) throw new Error(`Invalid lane: ${value}`);
}

function validateGrade(value: string): void {
	if (!EVIDENCE_GRADES.includes(value as EvidenceGrade)) throw new Error(`Invalid grade: ${value}`);
}

function validateRisk(value: string): void {
	if (!RISK_LEVELS.includes(value as RiskLevel)) throw new Error(`Invalid risk: ${value}`);
}

function validateConfidence(value: string): void {
	if (!CONFIDENCE_LEVELS.includes(value as ConfidenceLevel)) throw new Error(`Invalid confidence: ${value}`);
}
function validateDecisionKind(value: string): void {
	if (!DECISION_KINDS.includes(value as DecisionKind)) throw new Error(`Invalid decision kind: ${value}`);
}

function validateCritiqueVerdict(value: string): void {
	if (!CRITIQUE_VERDICTS.includes(value as CritiqueVerdict)) throw new Error(`Invalid verdict: ${value}`);
}

function truncate(value: string, length: number): string {
	return value.length <= length ? value : value.slice(0, length);
}

function formatAssessment(assessment: ResearchAssessment): string {
	return [
		`briefId: ${assessment.briefId}`,
		`readiness: ${assessment.readiness}`,
		`recommendedNextAction: ${assessment.recommendedNextAction}`,
		`blockingCount: ${assessment.blockingCount}`,
		`incompleteLanes: ${assessment.incompleteLanes.join(",") || "<none>"}`,
		`speculativeEvidenceIds: ${assessment.speculativeEvidenceIds.join(",") || "<none>"}`,
		`conflictingEvidenceIds: ${assessment.conflictingEvidenceIds.join(",") || "<none>"}`,
	].join("\n");
}
