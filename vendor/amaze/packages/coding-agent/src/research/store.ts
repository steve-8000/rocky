import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MissionEventBus } from "../mission/event-bus";
import { getMissionEventBus } from "../mission/runtime";
import { MissionStore } from "../mission/store";
import type { ResearchCampaign } from "../mission/types";
import { evidenceContradictsAny } from "./scoring";
import {
	CONFIDENCE_LEVELS,
	type ConfidenceLevel,
	CRITIQUE_FINDING_REQUIRED_ACTIONS,
	CRITIQUE_FINDING_SEVERITIES,
	CRITIQUE_VERDICTS,
	type CritiqueFinding,
	type CritiqueRecord,
	type CritiqueVerdict,
	DECISION_KINDS,
	type DecisionKind,
	type DecisionRecord,
	EVIDENCE_GRADES,
	type EvidenceCard,
	type EvidenceGrade,
	type NewCritiqueRecord,
	type NewDecisionRecord,
	type NewEvidenceCard,
	type NewResearchBrief,
	type NewRuntimeCriticCheck,
	type NewSynthesisRecord,
	RESEARCH_LANES,
	type ResearchAssessment,
	type ResearchBrief,
	type ResearchLane,
	RUNTIME_CRITIC_REQUIRED_ACTIONS,
	RUNTIME_CRITIC_SEVERITIES,
	RUNTIME_CRITIC_TRIGGERS,
	type RuntimeCriticCheck,
	type RuntimeCriticRequiredAction,
	type RuntimeCriticSeverity,
	type RuntimeCriticTrigger,
	type SynthesisRecord,
	type UncertaintyMap,
} from "./types";
import { buildUncertaintyMap } from "./uncertainty-map";

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".amaze", "autonomy", "autonomy.db");

const VALID_LANES = new Set<ResearchLane>(RESEARCH_LANES);
const VALID_GRADES = new Set<EvidenceGrade>(EVIDENCE_GRADES);
const VALID_CONFIDENCE = new Set<ConfidenceLevel>(CONFIDENCE_LEVELS);
const VALID_DECISION_KINDS = new Set<DecisionKind>(DECISION_KINDS);
const VALID_CRITIQUE_VERDICTS = new Set<CritiqueVerdict>(CRITIQUE_VERDICTS);
const VALID_CRITIC_TRIGGERS = new Set<RuntimeCriticTrigger>(RUNTIME_CRITIC_TRIGGERS);
const VALID_CRITIC_SEVERITIES = new Set<RuntimeCriticSeverity>(RUNTIME_CRITIC_SEVERITIES);
const VALID_CRITIC_ACTIONS = new Set<RuntimeCriticRequiredAction>(RUNTIME_CRITIC_REQUIRED_ACTIONS);
const VALID_CRITIQUE_FINDING_SEVERITIES = new Set(CRITIQUE_FINDING_SEVERITIES);
const VALID_CRITIQUE_FINDING_ACTIONS = new Set(CRITIQUE_FINDING_REQUIRED_ACTIONS);

type ResearchBriefRow = {
	id: string;
	objective_id: string | null;
	question: string;
	lanes: string;
	required_evidence: string;
	disallowed_evidence: string;
	risk_level: ResearchBrief["riskLevel"];
	stop_criteria: string;
	created_at: number;
	updated_at: number;
};

type EvidenceCardRow = {
	id: string;
	brief_id: string;
	lane: ResearchLane;
	grade: EvidenceGrade;
	source_ref: string;
	excerpt: string;
	claims: string;
	captured_at: number;
	directness: number;
	specificity: number;
	recency: number;
	reproducibility: number;
};

type DecisionRecordRow = {
	id: string;
	brief_id: string;
	hypothesis: string;
	rationale: string;
	kind: DecisionKind;
	confidence: ConfidenceLevel;
	evidence_refs: string;
	rejected_options: string;
	next_actions: string;
	created_at: number;
};

type SynthesisRecordRow = {
	id: string;
	brief_id: string;
	hypothesis_count: number;
	recommended: string | null;
	summary: string;
	raw_output: string;
	created_at: number;
};

type CritiqueRecordRow = {
	id: string;
	brief_id: string;
	blocking_count: number;
	soft_count: number;
	verdict: CritiqueVerdict;
	summary: string;
	raw_output: string;
	created_at: number;
	findings: string;
};

type RuntimeCriticCheckRow = {
	id: string;
	brief_id: string;
	mission_id: string | null;
	lane: ResearchLane | null;
	trigger: RuntimeCriticTrigger;
	severity: RuntimeCriticSeverity;
	required_action: RuntimeCriticRequiredAction;
	source: "research-assessment";
	message: string;
	evidence_refs: string;
	created_at: number;
};

export class ResearchStore {
	readonly dbPath: string;
	readonly #db: Database;
	#missionEventBus: MissionEventBus | undefined;

	constructor(dbPath = DEFAULT_DB_PATH, missionEventBus?: MissionEventBus) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		}
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#db.run("PRAGMA busy_timeout = 3000");
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#missionEventBus = missionEventBus ?? (dbPath === ":memory:" ? undefined : getMissionEventBus());
		this.#init();
	}

	close(): void {
		this.#db.close();
	}

	createBrief(input: NewResearchBrief): ResearchBrief {
		for (const lane of input.lanes) {
			assertResearchLane(lane);
		}
		const now = Date.now();
		const brief: ResearchBrief = {
			...input,
			id: input.id ?? generateId("research", now),
			createdAt: now,
			updatedAt: now,
		};
		this.#db
			.query(
				`INSERT INTO research_briefs
					(id, objective_id, question, lanes, required_evidence, disallowed_evidence, risk_level, stop_criteria, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				brief.id,
				brief.objectiveId,
				brief.question,
				JSON.stringify(brief.lanes),
				JSON.stringify(brief.requiredEvidence),
				JSON.stringify(brief.disallowedEvidence),
				brief.riskLevel,
				JSON.stringify(brief.stopCriteria),
				brief.createdAt,
				brief.updatedAt,
			);
		const mission = this.#createMissionForBrief(brief);
		this.#missionEventBus?.emit({
			type: "research.brief.created",
			missionId: mission.id,
			briefId: brief.id,
			objectiveId: brief.objectiveId,
			lanes: brief.lanes,
			ts: brief.createdAt,
		});
		return brief;
	}

	getBrief(id: string): ResearchBrief | undefined {
		const row = this.#db.query("SELECT * FROM research_briefs WHERE id = ?").get(id) as ResearchBriefRow | null;
		return row ? rowToBrief(row) : undefined;
	}

	listBriefs(opts: { objectiveId?: string } = {}): ResearchBrief[] {
		const rows = opts.objectiveId
			? (this.#db
					.query("SELECT * FROM research_briefs WHERE objective_id = ? ORDER BY created_at DESC, id DESC")
					.all(opts.objectiveId) as ResearchBriefRow[])
			: (this.#db
					.query("SELECT * FROM research_briefs ORDER BY created_at DESC, id DESC")
					.all() as ResearchBriefRow[]);
		return rows.map(rowToBrief);
	}

	addEvidence(input: NewEvidenceCard): EvidenceCard {
		if (!this.getBrief(input.briefId)) {
			throw new Error(`Research brief not found: ${input.briefId}`);
		}
		assertResearchLane(input.lane);
		assertEvidenceGrade(input.grade);
		const now = Date.now();
		const evidence: EvidenceCard = {
			...input,
			id: input.id ?? generateId("ev", now),
			capturedAt: input.capturedAt ?? now,
			directness: clamp01(input.directness),
			specificity: clamp01(input.specificity),
			recency: clamp01(input.recency),
			reproducibility: clamp01(input.reproducibility),
		};
		this.#db
			.query(
				`INSERT INTO evidence_cards
					(id, brief_id, lane, grade, source_ref, excerpt, claims, captured_at, directness, specificity, recency, reproducibility)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				evidence.id,
				evidence.briefId,
				evidence.lane,
				evidence.grade,
				evidence.sourceRef,
				evidence.excerpt,
				JSON.stringify(evidence.claims),
				evidence.capturedAt,
				evidence.directness,
				evidence.specificity,
				evidence.recency,
				evidence.reproducibility,
			);
		const mission = this.getMissionForBrief(evidence.briefId);
		if (mission) {
			this.#updateLiveLaneRunForEvidence(mission.id, evidence.briefId, evidence.lane, evidence.capturedAt);
			this.#missionEventBus?.emit({
				type: "research.evidence.added",
				missionId: mission.id,
				briefId: evidence.briefId,
				evidenceId: evidence.id,
				lane: evidence.lane,
				grade: evidence.grade,
				ts: evidence.capturedAt,
			});
		}
		return evidence;
	}

	listEvidence(briefId: string): EvidenceCard[] {
		const rows = this.#db
			.query("SELECT * FROM evidence_cards WHERE brief_id = ? ORDER BY captured_at ASC, id ASC")
			.all(briefId) as EvidenceCardRow[];
		return rows.map(rowToEvidence);
	}

	getMissionForBrief(briefId: string): ResearchCampaign | undefined {
		return this.#withMissionStore(missions => missions.listMissions({ briefId })[0]);
	}

	recordDecision(input: NewDecisionRecord): DecisionRecord {
		if (!this.getBrief(input.briefId)) {
			throw new Error(`Research brief not found: ${input.briefId}`);
		}
		const kind = input.kind ?? "select";
		assertConfidence(input.confidence);
		assertDecisionKind(kind);
		const mission = this.getMissionForBrief(input.briefId);
		this.#assertResearchRunAllowsDecision(mission?.id, input.briefId, kind);
		const now = Date.now();
		const decision: DecisionRecord = {
			...input,
			kind,
			id: input.id ?? generateId("dec", now),
			createdAt: now,
		};
		this.#db
			.query(
				`INSERT INTO decision_records
					(id, brief_id, hypothesis, rationale, kind, confidence, evidence_refs, rejected_options, next_actions, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				decision.id,
				decision.briefId,
				decision.hypothesis,
				decision.rationale,
				decision.kind,
				decision.confidence,
				JSON.stringify(decision.evidenceRefs),
				JSON.stringify(decision.rejectedOptions),
				JSON.stringify(decision.nextActions),
				decision.createdAt,
			);
		if (mission) {
			const missions = this.#createMissionStore();
			try {
				missions.updateMission(mission.id, {
					decisionId: decision.id,
					state: "deciding",
					confidence: decision.confidence,
				});
				this.#missionEventBus?.emit({
					type: "decision.recorded",
					missionId: mission.id,
					briefId: decision.briefId,
					decisionId: decision.id,
					confidence: decision.confidence,
					ts: decision.createdAt,
				});
			} finally {
				missions.close();
			}
		}
		return decision;
	}

	recordSynthesis(input: NewSynthesisRecord): SynthesisRecord {
		if (!this.getBrief(input.briefId)) {
			throw new Error(`Research brief not found: ${input.briefId}`);
		}
		const now = Date.now();
		const synthesis: SynthesisRecord = {
			...input,
			id: input.id ?? generateId("syn", now),
			createdAt: input.createdAt ?? now,
		};
		this.#db
			.query(
				`INSERT INTO research_syntheses
					(id, brief_id, hypothesis_count, recommended, summary, raw_output, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				synthesis.id,
				synthesis.briefId,
				synthesis.hypothesisCount,
				synthesis.recommended,
				synthesis.summary,
				synthesis.rawOutput,
				synthesis.createdAt,
			);
		const mission = this.getMissionForBrief(synthesis.briefId);
		if (mission) {
			const missions = this.#createMissionStore();
			try {
				missions.updateMission(mission.id, { state: "synthesizing" });
				this.#missionEventBus?.emit({
					type: "research.synthesis.proposed",
					missionId: mission.id,
					briefId: synthesis.briefId,
					hypothesisCount: synthesis.hypothesisCount,
					recommended: synthesis.recommended,
					ts: synthesis.createdAt,
				});
			} finally {
				missions.close();
			}
		}
		return synthesis;
	}

	getLatestSynthesis(briefId: string): SynthesisRecord | undefined {
		const row = this.#db
			.query("SELECT * FROM research_syntheses WHERE brief_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
			.get(briefId) as SynthesisRecordRow | null;
		return row ? rowToSynthesis(row) : undefined;
	}

	listSyntheses(briefId: string): SynthesisRecord[] {
		const rows = this.#db
			.query("SELECT * FROM research_syntheses WHERE brief_id = ? ORDER BY created_at ASC, id ASC")
			.all(briefId) as SynthesisRecordRow[];
		return rows.map(rowToSynthesis);
	}

	recordCritique(input: NewCritiqueRecord): CritiqueRecord {
		if (!this.getBrief(input.briefId)) {
			throw new Error(`Research brief not found: ${input.briefId}`);
		}
		assertCritiqueVerdict(input.verdict);
		const findings = normalizeCritiqueFindings(input);
		const now = Date.now();
		const critique: CritiqueRecord = {
			...input,
			blockingCount: findings.filter(finding => finding.severity === "blocking").length,
			softCount: findings.filter(finding => finding.severity === "soft").length,
			findings,
			id: input.id ?? generateId("crit", now),
			createdAt: input.createdAt ?? now,
		};
		this.#db
			.query(
				`INSERT INTO research_critiques
					(id, brief_id, blocking_count, soft_count, verdict, summary, raw_output, findings, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				critique.id,
				critique.briefId,
				critique.blockingCount,
				critique.softCount,
				critique.verdict,
				critique.summary,
				critique.rawOutput,
				JSON.stringify(critique.findings),
				critique.createdAt,
			);
		const mission = this.getMissionForBrief(critique.briefId);
		if (mission) {
			const missions = this.#createMissionStore();
			try {
				const runStatus =
					critique.blockingCount > 0 || critique.verdict === "reject" || critique.verdict === "needs-more-research"
						? "blocked"
						: "completed";
				missions.updateMission(mission.id, {
					state: runStatus === "blocked" ? "blocked" : "critiquing",
				});
				this.#finalizeLatestResearchRun(missions, mission.id, critique.briefId, runStatus, critique.createdAt);
				this.#missionEventBus?.emit({
					type: "research.critique.completed",
					missionId: mission.id,
					briefId: critique.briefId,
					blockingCount: critique.blockingCount,
					softCount: critique.softCount,
					verdict: critique.verdict,
					ts: critique.createdAt,
				});
			} finally {
				missions.close();
			}
		}
		return critique;
	}

	getLatestCritique(briefId: string): CritiqueRecord | undefined {
		const row = this.#db
			.query("SELECT * FROM research_critiques WHERE brief_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
			.get(briefId) as CritiqueRecordRow | null;
		return row ? rowToCritique(row) : undefined;
	}

	listCritiques(briefId: string): CritiqueRecord[] {
		const rows = this.#db
			.query("SELECT * FROM research_critiques WHERE brief_id = ? ORDER BY created_at ASC, id ASC")
			.all(briefId) as CritiqueRecordRow[];
		return rows.map(rowToCritique);
	}

	getDecision(briefId: string): DecisionRecord | undefined {
		const row = this.#db
			.query("SELECT * FROM decision_records WHERE brief_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
			.get(briefId) as DecisionRecordRow | null;
		return row ? rowToDecision(row) : undefined;
	}

	listDecisions(briefId: string): DecisionRecord[] {
		const rows = this.#db
			.query("SELECT * FROM decision_records WHERE brief_id = ? ORDER BY created_at ASC, id ASC")
			.all(briefId) as DecisionRecordRow[];
		return rows.map(rowToDecision);
	}

	assessBrief(briefId: string): ResearchAssessment {
		const brief = this.getBrief(briefId);
		if (!brief) {
			throw new Error(`Research brief not found: ${briefId}`);
		}
		const evidence = this.listEvidence(brief.id);
		const synthesis = this.getLatestSynthesis(brief.id);
		const critique = this.getLatestCritique(brief.id);
		const decision = this.getDecision(brief.id);
		const policyIssues = assessBriefPolicy(brief, evidence);
		const incompleteLanes = [
			...brief.lanes.filter(lane => !evidence.some(card => card.lane === lane)),
			...policyIssues.requiredMissingLanes,
		].filter((lane, index, lanes) => lanes.indexOf(lane) === index);
		const speculativeEvidenceIds = [
			...evidence
				.filter(card => card.grade === "D" || card.grade === "E" || card.directness < 0.4 || card.specificity < 0.4)
				.map(card => card.id),
			...policyIssues.disallowedEvidenceIds,
		].filter((id, index, ids) => ids.indexOf(id) === index);
		const conflictingEvidenceIds = evidence
			.filter(card => evidenceContradictsAny(card, evidence))
			.map(card => card.id);
		const blockingCount =
			(critique?.findings.filter(finding => finding.severity === "blocking").length ?? 0) +
			policyIssues.blockingCount;

		if (decision) {
			return {
				briefId: brief.id,
				readiness: "decided",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: "none",
			};
		}
		if (
			critique &&
			(critique.findings.some(finding => finding.severity === "blocking") ||
				critique.verdict === "reject" ||
				critique.verdict === "needs-more-research")
		) {
			const action = critique.findings.find(finding => finding.severity === "blocking")?.requiredAction;
			return {
				briefId: brief.id,
				readiness: "blocked",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: action === "defer" || critique.verdict === "reject" ? "defer" : "collect-evidence",
			};
		}
		if (critique && (critique.verdict === "accept" || critique.verdict === "accept-with-modifications")) {
			return {
				briefId: brief.id,
				readiness: "ready-to-decide",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: "record-decision",
			};
		}
		if (policyIssues.blockingCount > 0) {
			return {
				briefId: brief.id,
				readiness: "insufficient",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: policyIssues.stopCriteriaMet ? "run-synthesis" : "collect-evidence",
			};
		}
		if (synthesis) {
			return {
				briefId: brief.id,
				readiness: "ready-to-critique",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: "run-critique",
			};
		}
		if (incompleteLanes.length > 0 || evidence.length === 0) {
			return {
				briefId: brief.id,
				readiness: "insufficient",
				incompleteLanes,
				speculativeEvidenceIds,
				conflictingEvidenceIds,
				blockingCount,
				recommendedNextAction: "collect-evidence",
			};
		}
		return {
			briefId: brief.id,
			readiness: "researching",
			incompleteLanes,
			speculativeEvidenceIds,
			conflictingEvidenceIds,
			blockingCount,
			recommendedNextAction: "run-synthesis",
		};
	}

	deriveRuntimeCriticChecks(briefId: string): RuntimeCriticCheck[] {
		const brief = this.getBrief(briefId);
		if (!brief) throw new Error(`Research brief not found: ${briefId}`);
		const assessment = this.assessBrief(briefId);
		const mission = this.getMissionForBrief(briefId);
		const evidence = this.listEvidence(briefId);
		const now = Date.now();
		const policyIssues = assessBriefPolicy(brief, evidence);
		const critique = this.getLatestCritique(briefId);
		const checks: RuntimeCriticCheck[] = [];
		for (const lane of assessment.incompleteLanes) {
			checks.push({
				id: `runtime-critic:${briefId}:missing-lane-evidence:${lane}`,
				briefId,
				missionId: mission?.id ?? null,
				lane,
				trigger: "missing-lane-evidence",
				severity: "blocking",
				requiredAction: "collect-evidence",
				source: "research-assessment",
				message: `Required research lane has no evidence: ${lane}`,
				evidenceRefs: [],
				createdAt: now,
			});
		}
		for (const evidenceId of assessment.speculativeEvidenceIds) {
			const card = evidence.find(item => item.id === evidenceId);
			checks.push({
				id: `runtime-critic:${briefId}:speculative-evidence:${evidenceId}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: card?.lane ?? null,
				trigger: "speculative-evidence",
				severity: "soft",
				requiredAction: "collect-evidence",
				source: "research-assessment",
				message: `Evidence is too speculative for a durable decision: ${evidenceId}`,
				evidenceRefs: [evidenceId],
				createdAt: now,
			});
		}
		for (const evidenceId of assessment.conflictingEvidenceIds) {
			const card = evidence.find(item => item.id === evidenceId);
			checks.push({
				id: `runtime-critic:${briefId}:conflicting-evidence:${evidenceId}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: card?.lane ?? null,
				trigger: "conflicting-evidence",
				severity: "blocking",
				requiredAction: "resolve-conflict",
				source: "research-assessment",
				message: `Evidence conflicts with another captured source: ${evidenceId}`,
				evidenceRefs: [evidenceId],
				createdAt: now,
			});
		}
		for (const issue of policyIssues.requiredMissing) {
			checks.push({
				id: `runtime-critic:${briefId}:policy-required-evidence:${issue.id}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: issue.lane,
				trigger: "policy-required-evidence",
				severity: "blocking",
				requiredAction: "collect-evidence",
				source: "research-assessment",
				message: `Required evidence not satisfied: ${issue.requirement}`,
				evidenceRefs: [],
				createdAt: now,
			});
		}
		for (const issue of policyIssues.disallowedHits) {
			checks.push({
				id: `runtime-critic:${briefId}:policy-disallowed-evidence:${issue.evidenceId}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: issue.lane,
				trigger: "policy-disallowed-evidence",
				severity: "blocking",
				requiredAction: "collect-evidence",
				source: "research-assessment",
				message: `Disallowed evidence matched policy "${issue.policy}": ${issue.evidenceId}`,
				evidenceRefs: [issue.evidenceId],
				createdAt: now,
			});
		}
		for (const issue of policyIssues.unmetStopCriteria) {
			checks.push({
				id: `runtime-critic:${briefId}:policy-stop-criteria:${issue.id}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: null,
				trigger: "policy-stop-criteria",
				severity: "blocking",
				requiredAction: "collect-evidence",
				source: "research-assessment",
				message: `Stop criterion not satisfied: ${issue.criterion}`,
				evidenceRefs: [],
				createdAt: now,
			});
		}
		for (const finding of critique?.findings ?? []) {
			checks.push({
				id: `runtime-critic:${briefId}:critique-finding:${finding.id}`,
				briefId,
				missionId: mission?.id ?? null,
				lane: null,
				trigger: "critique-finding",
				severity: finding.severity,
				requiredAction: finding.requiredAction,
				source: "research-assessment",
				message: finding.message,
				evidenceRefs: finding.evidenceRefs,
				createdAt: now,
			});
		}
		if (assessment.readiness === "blocked" && assessment.blockingCount > 0) {
			checks.push({
				id: `runtime-critic:${briefId}:blocked-assessment`,
				briefId,
				missionId: mission?.id ?? null,
				lane: null,
				trigger: "blocked-assessment",
				severity: "blocking",
				requiredAction: assessment.recommendedNextAction === "defer" ? "defer" : "run-critique",
				source: "research-assessment",
				message: `Research assessment is blocked by ${assessment.blockingCount} critique finding(s)`,
				evidenceRefs: [],
				createdAt: now,
			});
		}
		return checks;
	}

	refreshRuntimeCriticChecks(briefId: string): RuntimeCriticCheck[] {
		if (!this.getBrief(briefId)) throw new Error(`Research brief not found: ${briefId}`);
		const checks = this.deriveRuntimeCriticChecks(briefId);
		this.#db
			.query("DELETE FROM runtime_critic_checks WHERE brief_id = ? AND source = 'research-assessment'")
			.run(briefId);
		for (const check of checks) this.recordRuntimeCriticCheck(check);
		const blockingCount = checks.filter(check => check.severity === "blocking").length;
		const softCount = checks.length - blockingCount;
		const missionId = checks.find(check => check.missionId)?.missionId ?? this.getMissionForBrief(briefId)?.id;
		if (missionId) {
			this.#missionEventBus?.emit({
				type: "runtime_critic.checks.completed",
				missionId,
				briefId,
				blockingCount,
				softCount,
				ts: Date.now(),
			});
		}
		return this.listRuntimeCriticChecks(briefId);
	}

	recordRuntimeCriticCheck(input: NewRuntimeCriticCheck): RuntimeCriticCheck {
		if (!this.getBrief(input.briefId)) throw new Error(`Research brief not found: ${input.briefId}`);
		if (input.lane !== null) assertResearchLane(input.lane);
		assertCriticTrigger(input.trigger);
		assertCriticSeverity(input.severity);
		assertCriticAction(input.requiredAction);
		const now = Date.now();
		const check: RuntimeCriticCheck = {
			...input,
			id: input.id ?? generateId("runtime-critic", now),
			source: input.source ?? "research-assessment",
			createdAt: input.createdAt ?? now,
		};
		this.#db
			.query(
				`INSERT OR REPLACE INTO runtime_critic_checks
					(id, brief_id, mission_id, lane, trigger, severity, required_action, source, message, evidence_refs, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				check.id,
				check.briefId,
				check.missionId,
				check.lane,
				check.trigger,
				check.severity,
				check.requiredAction,
				check.source,
				check.message,
				JSON.stringify(check.evidenceRefs),
				check.createdAt,
			);
		return check;
	}

	listRuntimeCriticChecks(briefId: string): RuntimeCriticCheck[] {
		const rows = this.#db
			.query("SELECT * FROM runtime_critic_checks WHERE brief_id = ? ORDER BY created_at ASC, id ASC")
			.all(briefId) as RuntimeCriticCheckRow[];
		return rows.map(rowToRuntimeCriticCheck);
	}

	getUncertaintyMap(briefId: string, opts: { requiredLanes?: ResearchLane[] } = {}): UncertaintyMap {
		const brief = this.getBrief(briefId);
		if (!brief) throw new Error(`Research brief not found: ${briefId}`);
		for (const lane of opts.requiredLanes ?? []) assertResearchLane(lane);
		return buildUncertaintyMap({
			brief,
			evidence: this.listEvidence(briefId),
			assessment: this.assessBrief(briefId),
			criticChecks: this.listRuntimeCriticChecks(briefId),
			requiredLanes: opts.requiredLanes,
		});
	}

	#updateLiveLaneRunForEvidence(missionId: string, briefId: string, lane: ResearchLane, ts: number): void {
		const missions = this.#createMissionStore();
		try {
			const run = missions.getLatestResearchRunForMissionBrief(missionId, briefId);
			if (!run || run.status !== "running") return;
			const laneRun = missions.getLatestLaneRunForMissionLane(missionId, lane);
			if (!laneRun) return;
			const evidenceCount = this.#countEvidenceForLane(briefId, lane);
			missions.updateLaneRun(laneRun.id, {
				status: laneRun.status === "pending" ? "running" : laneRun.status,
				evidenceCount,
				startedAt: laneRun.startedAt ?? ts,
				emptyReason: evidenceCount > 0 ? null : laneRun.emptyReason,
			});
		} finally {
			missions.close();
		}
	}

	#finalizeLatestResearchRun(
		missions: MissionStore,
		missionId: string,
		briefId: string,
		status: "completed" | "blocked",
		completedAt: number,
	): void {
		const run = missions.getLatestResearchRunForMissionBrief(missionId, briefId);
		if (!run || run.status !== "running") return;
		const brief = this.getBrief(briefId);
		if (!brief) return;
		for (const laneRun of missions.listLatestLaneRunsForMissionLanes(missionId, brief.lanes)) {
			if (laneRun.status === "completed" || laneRun.status === "empty") continue;
			if (laneRun.evidenceCount > 0) {
				missions.updateLaneRun(laneRun.id, {
					status: "completed",
					endedAt: laneRun.endedAt ?? completedAt,
				});
			} else {
				missions.updateLaneRun(laneRun.id, {
					status: "empty",
					emptyReason: laneRun.emptyReason ?? "no evidence recorded",
					endedAt: laneRun.endedAt ?? completedAt,
				});
			}
		}
		missions.updateResearchRun(run.id, { status, completedAt: run.completedAt ?? completedAt });
	}

	#countEvidenceForLane(briefId: string, lane: ResearchLane): number {
		const row = this.#db
			.query("SELECT COUNT(*) AS count FROM evidence_cards WHERE brief_id = ? AND lane = ?")
			.get(briefId, lane) as { count: number } | null;
		return row?.count ?? 0;
	}

	#createMissionForBrief(brief: ResearchBrief): ResearchCampaign {
		const missions = this.#createMissionStore();
		try {
			const linkedMission = brief.objectiveId ? missions.getMission(brief.objectiveId) : undefined;
			if (linkedMission) {
				return missions.updateMission(linkedMission.id, {
					title: brief.question,
					objectiveId: linkedMission.objectiveId ?? brief.objectiveId,
					briefId: linkedMission.briefId ?? brief.id,
					riskLevel: brief.riskLevel,
					state: linkedMission.state === "drafting" ? "researching" : linkedMission.state,
				});
			}
			return missions.createMission({
				title: brief.question,
				objectiveId: brief.objectiveId,
				briefId: brief.id,
				decisionId: null,
				riskLevel: brief.riskLevel,
				state: "researching",
				confidence: null,
				snapshotRef: null,
			});
		} finally {
			missions.close();
		}
	}

	#createMissionStore(): MissionStore {
		return new MissionStore(this.dbPath, this.#missionEventBus);
	}

	#withMissionStore<T>(run: (missions: MissionStore) => T): T {
		const missions = this.#createMissionStore();
		try {
			return run(missions);
		} finally {
			missions.close();
		}
	}

	#assertResearchRunAllowsDecision(missionId: string | undefined, briefId: string, kind: DecisionKind): void {
		if (!missionId) return;
		this.#withMissionStore(missions => {
			const run = missions.getLatestResearchRunForMissionBrief(missionId, briefId);
			if (!run) return;
			if (run.status === "running") {
				throw new Error("Cannot record decision while research run is running");
			}
			if (run.status === "completed" && kind !== "select") {
				throw new Error(`Decision kind ${kind} is not allowed for completed research run`);
			}
			if (run.status === "blocked" && kind === "select") {
				throw new Error("Decision kind select is not allowed for blocked research run");
			}
			if (run.status === "cancelled") {
				throw new Error("Cannot record decision while research run is cancelled");
			}
		});
	}

	#init(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS research_briefs (
				id TEXT PRIMARY KEY,
				objective_id TEXT,
				question TEXT NOT NULL,
				lanes TEXT NOT NULL,
				required_evidence TEXT NOT NULL,
				disallowed_evidence TEXT NOT NULL,
				risk_level TEXT NOT NULL,
				stop_criteria TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS research_briefs_objective_idx ON research_briefs(objective_id);

			CREATE TABLE IF NOT EXISTS evidence_cards (
				id TEXT PRIMARY KEY,
				brief_id TEXT NOT NULL,
				lane TEXT NOT NULL,
				grade TEXT NOT NULL,
				source_ref TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				claims TEXT NOT NULL,
				captured_at INTEGER NOT NULL,
				directness REAL NOT NULL,
				specificity REAL NOT NULL,
				recency REAL NOT NULL,
				reproducibility REAL NOT NULL,
				FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS evidence_cards_brief_idx ON evidence_cards(brief_id);
			CREATE INDEX IF NOT EXISTS evidence_cards_lane_idx ON evidence_cards(brief_id, lane);

			CREATE TABLE IF NOT EXISTS decision_records (
				id TEXT PRIMARY KEY,
				brief_id TEXT NOT NULL,
				hypothesis TEXT NOT NULL,
				rationale TEXT NOT NULL,
				confidence TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'select',
				evidence_refs TEXT NOT NULL,
				rejected_options TEXT NOT NULL,
				next_actions TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS decision_records_brief_idx ON decision_records(brief_id);

			CREATE TABLE IF NOT EXISTS research_syntheses (
				id TEXT PRIMARY KEY,
				brief_id TEXT NOT NULL,
				hypothesis_count INTEGER NOT NULL,
				recommended TEXT,
				summary TEXT NOT NULL,
				raw_output TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS research_syntheses_brief_idx ON research_syntheses(brief_id);

			CREATE TABLE IF NOT EXISTS research_critiques (
				id TEXT PRIMARY KEY,
				brief_id TEXT NOT NULL,
				blocking_count INTEGER NOT NULL,
				soft_count INTEGER NOT NULL,
				verdict TEXT NOT NULL,
				summary TEXT NOT NULL,
				raw_output TEXT NOT NULL,
				findings TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS research_critiques_brief_idx ON research_critiques(brief_id);

			CREATE TABLE IF NOT EXISTS runtime_critic_checks (
				id TEXT PRIMARY KEY,
				brief_id TEXT NOT NULL,
				mission_id TEXT,
				lane TEXT,
				trigger TEXT NOT NULL,
				severity TEXT NOT NULL,
				required_action TEXT NOT NULL,
				source TEXT NOT NULL,
				message TEXT NOT NULL,
				evidence_refs TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (brief_id) REFERENCES research_briefs(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS runtime_critic_checks_brief_idx ON runtime_critic_checks(brief_id);
		`);
		this.#ensureDecisionKindColumn();
		this.#ensureCritiqueFindingsColumn();
	}

	#ensureDecisionKindColumn(): void {
		const columns = this.#db.query("PRAGMA table_info(decision_records)").all() as Array<{ name: string }>;
		if (!columns.some(column => column.name === "kind")) {
			this.#db.run("ALTER TABLE decision_records ADD COLUMN kind TEXT NOT NULL DEFAULT 'select'");
		}
	}

	#ensureCritiqueFindingsColumn(): void {
		const columns = this.#db.query("PRAGMA table_info(research_critiques)").all() as Array<{ name: string }>;
		if (!columns.some(column => column.name === "findings")) {
			this.#db.run("ALTER TABLE research_critiques ADD COLUMN findings TEXT NOT NULL DEFAULT '[]'");
		}
	}
}

function generateId(prefix: string, now: number): string {
	return `${prefix}-${now}-${randomBytes(4).toString("hex")}`;
}

function assertResearchLane(lane: ResearchLane): void {
	if (!VALID_LANES.has(lane)) {
		throw new Error(`Invalid research lane: ${lane}`);
	}
}

function assertEvidenceGrade(grade: EvidenceGrade): void {
	if (!VALID_GRADES.has(grade)) {
		throw new Error(`Invalid evidence grade: ${grade}`);
	}
}

function assertConfidence(confidence: ConfidenceLevel): void {
	if (!VALID_CONFIDENCE.has(confidence)) {
		throw new Error(`Invalid decision confidence: ${confidence}`);
	}
}

function assertDecisionKind(kind: DecisionKind): void {
	if (!VALID_DECISION_KINDS.has(kind)) {
		throw new Error(`Invalid decision kind: ${kind}`);
	}
}

function assertCritiqueVerdict(verdict: CritiqueVerdict): void {
	if (!VALID_CRITIQUE_VERDICTS.has(verdict)) {
		throw new Error(`Invalid critique verdict: ${verdict}`);
	}
}

function assertCriticTrigger(trigger: RuntimeCriticTrigger): void {
	if (!VALID_CRITIC_TRIGGERS.has(trigger)) {
		throw new Error(`Invalid runtime critic trigger: ${trigger}`);
	}
}

function assertCriticSeverity(severity: RuntimeCriticSeverity): void {
	if (!VALID_CRITIC_SEVERITIES.has(severity)) {
		throw new Error(`Invalid runtime critic severity: ${severity}`);
	}
}

function assertCriticAction(action: RuntimeCriticRequiredAction): void {
	if (!VALID_CRITIC_ACTIONS.has(action)) {
		throw new Error(`Invalid runtime critic required action: ${action}`);
	}
}

function assertCritiqueFinding(finding: CritiqueFinding): void {
	if (!VALID_CRITIQUE_FINDING_SEVERITIES.has(finding.severity)) {
		throw new Error(`Invalid critique finding severity: ${finding.severity}`);
	}
	if (!VALID_CRITIQUE_FINDING_ACTIONS.has(finding.requiredAction)) {
		throw new Error(`Invalid critique finding required action: ${finding.requiredAction}`);
	}
}

function normalizeCritiqueFindings(input: NewCritiqueRecord): CritiqueFinding[] {
	const explicit = (input.findings ?? []).map(finding => ({
		...finding,
		evidenceRefs: [...finding.evidenceRefs],
	}));
	if (explicit.length === 0 && (input.blockingCount > 0 || input.softCount > 0)) {
		for (let index = 0; index < input.blockingCount; index += 1) {
			explicit.push({
				id: `blocking-${index + 1}`,
				severity: "blocking",
				message: input.summary,
				evidenceRefs: [],
				requiredAction: input.verdict === "reject" ? "defer" : "run-critique",
			});
		}
		for (let index = 0; index < input.softCount; index += 1) {
			explicit.push({
				id: `soft-${index + 1}`,
				severity: "soft",
				message: input.summary,
				evidenceRefs: [],
				requiredAction: "run-critique",
			});
		}
	}
	for (const finding of explicit) assertCritiqueFinding(finding);
	return explicit;
}

type BriefPolicyAssessment = {
	requiredMissing: Array<{ id: string; requirement: string; lane: ResearchLane }>;
	requiredMissingLanes: ResearchLane[];
	disallowedHits: Array<{ policy: string; evidenceId: string; lane: ResearchLane }>;
	disallowedEvidenceIds: string[];
	unmetStopCriteria: Array<{ id: string; criterion: string }>;
	stopCriteriaMet: boolean;
	blockingCount: number;
};

function assessBriefPolicy(brief: ResearchBrief, evidence: EvidenceCard[]): BriefPolicyAssessment {
	const requiredMissing = brief.requiredEvidence
		.filter(requirement => !evidence.some(card => evidenceMatchesPolicy(card, requirement)))
		.map((requirement, index) => ({
			id: slugPolicy(requirement, index),
			requirement,
			lane: laneForPolicyRequirement(brief, requirement, index),
		}));
	const requiredMissingLanes = requiredMissing.map(issue => issue.lane);
	const disallowedHits = brief.disallowedEvidence.flatMap(policy =>
		evidence
			.filter(card => evidenceMatchesPolicy(card, policy))
			.map(card => ({ policy, evidenceId: card.id, lane: card.lane })),
	);
	const unmetStopCriteria = brief.stopCriteria
		.filter(criterion => !stopCriterionSatisfied(criterion, brief, evidence))
		.map((criterion, index) => ({ id: slugPolicy(criterion, index), criterion }));
	return {
		requiredMissing,
		requiredMissingLanes,
		disallowedHits,
		disallowedEvidenceIds: disallowedHits.map(hit => hit.evidenceId),
		unmetStopCriteria,
		stopCriteriaMet: unmetStopCriteria.length === 0,
		blockingCount: requiredMissing.length + disallowedHits.length + unmetStopCriteria.length,
	};
}

function evidenceMatchesPolicy(card: EvidenceCard, policy: string): boolean {
	const needle = normalizePolicyText(policy);
	if (needle.length === 0) return false;
	const haystack = normalizePolicyText([card.sourceRef, card.excerpt, ...card.claims].join(" "));
	return haystack.includes(needle);
}

function stopCriterionSatisfied(criterion: string, brief: ResearchBrief, evidence: EvidenceCard[]): boolean {
	if (evidence.some(card => evidenceMatchesPolicy(card, criterion))) return true;
	const text = normalizePolicyText(criterion);
	const laneCoverageMatch = text.match(/(\d+)\s+lanes?\s+covered/);
	if (laneCoverageMatch) {
		const requiredCount = Number.parseInt(laneCoverageMatch[1] ?? "0", 10);
		const covered = new Set(evidence.map(card => card.lane));
		return brief.lanes.filter(lane => covered.has(lane)).length >= requiredCount;
	}
	return false;
}

function laneForPolicyRequirement(brief: ResearchBrief, requirement: string, index: number): ResearchLane {
	const text = normalizePolicyText(requirement);
	return brief.lanes.find(lane => text.includes(lane)) ?? brief.lanes[index % brief.lanes.length] ?? "repo";
}

function normalizePolicyText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function slugPolicy(value: string, index: number): string {
	const slug = normalizePolicyText(value)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return slug || `policy-${index + 1}`;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function rowToBrief(row: ResearchBriefRow): ResearchBrief {
	return {
		id: row.id,
		objectiveId: row.objective_id,
		question: row.question,
		lanes: JSON.parse(row.lanes) as ResearchLane[],
		requiredEvidence: JSON.parse(row.required_evidence) as string[],
		disallowedEvidence: JSON.parse(row.disallowed_evidence) as string[],
		riskLevel: row.risk_level,
		stopCriteria: JSON.parse(row.stop_criteria) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToEvidence(row: EvidenceCardRow): EvidenceCard {
	return {
		id: row.id,
		briefId: row.brief_id,
		lane: row.lane,
		grade: row.grade,
		sourceRef: row.source_ref,
		excerpt: row.excerpt,
		claims: JSON.parse(row.claims) as string[],
		capturedAt: row.captured_at,
		directness: row.directness,
		specificity: row.specificity,
		recency: row.recency,
		reproducibility: row.reproducibility,
	};
}

function rowToDecision(row: DecisionRecordRow): DecisionRecord {
	return {
		id: row.id,
		briefId: row.brief_id,
		hypothesis: row.hypothesis,
		rationale: row.rationale,
		kind: row.kind ?? "select",
		confidence: row.confidence,
		evidenceRefs: JSON.parse(row.evidence_refs) as string[],
		rejectedOptions: JSON.parse(row.rejected_options) as Array<{ id: string; reason: string }>,
		nextActions: JSON.parse(row.next_actions) as string[],
		createdAt: row.created_at,
	};
}

function rowToSynthesis(row: SynthesisRecordRow): SynthesisRecord {
	return {
		id: row.id,
		briefId: row.brief_id,
		hypothesisCount: row.hypothesis_count,
		recommended: row.recommended,
		summary: row.summary,
		rawOutput: row.raw_output,
		createdAt: row.created_at,
	};
}

function rowToCritique(row: CritiqueRecordRow): CritiqueRecord {
	const findings = JSON.parse(row.findings ?? "[]") as CritiqueFinding[];
	return {
		id: row.id,
		briefId: row.brief_id,
		blockingCount: findings.filter(finding => finding.severity === "blocking").length || row.blocking_count,
		softCount: findings.filter(finding => finding.severity === "soft").length || row.soft_count,
		verdict: row.verdict,
		summary: row.summary,
		rawOutput: row.raw_output,
		findings,
		createdAt: row.created_at,
	};
}

function rowToRuntimeCriticCheck(row: RuntimeCriticCheckRow): RuntimeCriticCheck {
	return {
		id: row.id,
		briefId: row.brief_id,
		missionId: row.mission_id,
		lane: row.lane,
		trigger: row.trigger,
		severity: row.severity,
		requiredAction: row.required_action,
		source: row.source,
		message: row.message,
		evidenceRefs: JSON.parse(row.evidence_refs) as string[],
		createdAt: row.created_at,
	};
}
