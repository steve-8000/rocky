import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { MissionEvent } from "../mission/events";
import { MissionReadModel, type MissionView } from "../mission/read-model";
import { readMissionEvents } from "../mission/reader";
import { MISSION_STATES, type MissionState } from "../mission/types";
import { evidenceContradictsAny } from "../research/scoring";
import { ResearchStore } from "../research/store";
import type { EvidenceCard } from "../research/types";

const DEFAULT_STREAM_POLL_INTERVAL_MS = 100;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

export async function runMissionListCommand(opts: {
	db?: string;
	objectiveId?: string;
	briefId?: string;
	state?: string;
	json?: boolean;
}): Promise<void> {
	const state = parseState(opts.state);
	const readModel = new MissionReadModel({ dbPath: opts.db });
	try {
		const views = readModel.listMissionViews({ objectiveId: opts.objectiveId, briefId: opts.briefId, state });
		if (opts.json) {
			writeJson(views.map(toMissionRow));
			return;
		}
		const lines = [
			"id  state  objective  brief  title",
			...views.map(view =>
				[
					view.mission.id,
					view.mission.state,
					view.mission.objectiveId ?? "<none>",
					view.mission.briefId ?? "<none>",
					truncate(view.mission.title, 80),
				].join("  "),
			),
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		readModel.close();
	}
}

export async function runMissionShowCommand(opts: { db?: string; id: string; json?: boolean }): Promise<void> {
	const { view, evidence, close } = loadMission(opts.db, opts.id);
	try {
		if (opts.json) {
			writeJson({ ...view, evidence });
			return;
		}
		process.stdout.write(`${renderShow(view)}\n`);
	} finally {
		close();
	}
}

export async function runMissionStreamCommand(opts: {
	db?: string;
	id: string;
	json?: boolean;
	follow?: boolean;
	baseDir?: string;
	pollIntervalMs?: number;
	idleTimeoutMs?: number;
	once?: boolean;
}): Promise<void> {
	const readModel = new MissionReadModel({ dbPath: opts.db });
	try {
		requireMission(readModel, opts.id);
		if (opts.follow) {
			await streamMissionEvents(opts.id, {
				json: opts.json,
				baseDir: opts.baseDir,
				pollIntervalMs: opts.pollIntervalMs,
				idleTimeoutMs: opts.idleTimeoutMs,
				once: opts.once,
			});
			return;
		}
		const events = await readMissionEvents(opts.id, { baseDir: opts.baseDir });
		if (opts.json) {
			writeJson(events);
			return;
		}
		const lines = events.map(event => `${event.ts}  ${event.type}  ${eventSummary(event)}`.trimEnd());
		process.stdout.write(`${lines.length > 0 ? lines.join("\n") : "<none>"}\n`);
	} finally {
		readModel.close();
	}
}

export async function runMissionLanesCommand(opts: { db?: string; id: string; json?: boolean }): Promise<void> {
	const { view, close } = loadMission(opts.db, opts.id);
	try {
		if (opts.json) {
			writeJson({ missionId: view.mission.id, lanes: view.laneRuns });
			return;
		}
		process.stdout.write(`${renderLanes(view)}\n`);
	} finally {
		close();
	}
}

export async function runMissionEvidenceCommand(opts: {
	db?: string;
	id: string;
	json?: boolean;
	lane?: string;
	grade?: string;
	status?: EvidenceStatus;
	query?: string;
}): Promise<void> {
	const { view, evidence, close } = loadMission(opts.db, opts.id);
	try {
		const filteredEvidence = filterEvidence(evidence, opts);
		const payload = { missionId: view.mission.id, evidenceByLane: view.evidenceByLane, evidence: filteredEvidence };
		if (opts.json) {
			writeJson(payload);
			return;
		}
		process.stdout.write(`${renderEvidence(view, filteredEvidence, evidence)}\n`);
	} finally {
		close();
	}
}

export async function runMissionDecisionCommand(opts: { db?: string; id: string; json?: boolean }): Promise<void> {
	const { view, close } = loadMission(opts.db, opts.id);
	try {
		if (opts.json) {
			writeJson({ missionId: view.mission.id, decision: view.decision, decisionSummary: view.decisionSummary });
			return;
		}
		process.stdout.write(`${renderDecision(view)}\n`);
	} finally {
		close();
	}
}

export async function runMissionVerifyCommand(opts: {
	db?: string;
	id: string;
	json?: boolean;
	events?: string;
}): Promise<void> {
	const { view, close } = loadMission(opts.db, opts.id);
	try {
		const events = await readMissionEvents(opts.id, { baseDir: opts.events });
		const relatedEvents = filterVerifyRelatedEvents(events);
		const laneCompleteness = view.laneRuns.map(lane => ({
			lane: lane.lane,
			status: lane.status,
			complete: lane.status === "completed" || lane.status === "empty",
		}));
		const runtimeCritic = summarizeRuntimeCritic(view);
		const payload = {
			missionId: view.mission.id,
			state: view.mission.state,
			decisionExists: view.decision !== null,
			proposalCounts: countProposals(view),
			laneCompleteness,
			verification: view.latestVerification,
			runtimeCritic,
			relatedEvents,
			replay: opts.events ? verifyEventReplay(view, events) : undefined,
		};
		if (opts.json) {
			writeJson(payload);
			return;
		}
		process.stdout.write(
			`${renderVerify(view, relatedEvents, opts.events ? verifyEventReplay(view, events) : undefined)}\n`,
		);
	} finally {
		close();
	}
}

export async function runMissionRollbackCommand(opts: { db?: string; id: string; json?: boolean }): Promise<void> {
	const { view, close } = loadMission(opts.db, opts.id);
	try {
		const candidates = view.proposals.filter(proposal => ["applied", "rolled-back"].includes(proposal.status));
		const payload = {
			missionId: view.mission.id,
			snapshotRef: view.mission.snapshotRef,
			decisionId: view.mission.decisionId,
			rollbackCandidates: candidates,
			recordedRollbacks: view.rollbacks,
			available: view.mission.snapshotRef !== null,
		};
		if (opts.json) {
			writeJson(payload);
			return;
		}
		process.stdout.write(`${renderRollback(view, candidates.length)}\n`);
	} finally {
		close();
	}
}

function loadMission(
	db: string | undefined,
	id: string,
): { view: MissionView; evidence: EvidenceCard[]; close: () => void } {
	const readModel = new MissionReadModel({ dbPath: db });
	const research = new ResearchStore(db);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		research.close();
		readModel.close();
	};
	try {
		const view = requireMission(readModel, id);
		const evidence = view.brief ? research.listEvidence(view.brief.id) : [];
		return { view, evidence, close };
	} catch (error) {
		close();
		throw error;
	}
}

function requireMission(readModel: MissionReadModel, id: string): MissionView {
	const view = readModel.getMissionView(id);
	if (!view) throw new Error(`Mission not found: ${id}`);
	return view;
}

function renderShow(view: MissionView): string {
	return [
		`Mission: ${view.mission.id}`,
		`Title: ${view.mission.title}`,
		`State: ${view.mission.state}`,
		`Objective: ${view.mission.objectiveId ?? "<none>"}`,
		`Brief: ${view.mission.briefId ?? "<none>"}`,
		`Decision: ${view.decisionSummary?.id ?? "<none>"}`,
		`Contracts: ${view.contracts.length}`,
		`Verification: ${view.latestVerification?.status ?? "not yet recorded"}`,
		`Rollbacks: ${view.rollbacks.length}`,
		`Runtime critic: ${summarizeRuntimeCritic(view).status} checks=${summarizeRuntimeCritic(view).checks.length} dialogue=${view.criticDialogue.length}`,
		"Lanes:",
		...laneLines(view),
		"Decision summary:",
		...(view.decisionSummary
			? [
					`  ${view.decisionSummary.id}  ${view.decisionSummary.confidence}  ${truncate(view.decisionSummary.hypothesis, 80)}`,
				]
			: ["  <none>"]),
		"Proposals:",
		...proposalLines(view),
		"Runtime critic:",
		...runtimeCriticLines(view),
	].join("\n");
}

function renderLanes(view: MissionView): string {
	return [`Mission: ${view.mission.id}`, "Lanes:", ...laneLines(view)].join("\n");
}

function renderEvidence(view: MissionView, evidence: EvidenceCard[], allEvidence: EvidenceCard[] = evidence): string {
	const lines = [`Mission: ${view.mission.id}`, "Evidence by lane:"];
	for (const item of view.evidenceByLane) lines.push(`  ${item.lane}: ${item.count}`);
	lines.push("Evidence:");
	if (evidence.length === 0) lines.push("  <none>");
	else {
		for (const card of evidence) {
			const status = classifyEvidence(card, allEvidence);
			const marker = status === "accepted" ? "" : ` [${status}]`;
			lines.push(
				`  ${card.id}${marker}  ${card.lane}/${card.grade}  ${card.sourceRef}  ${truncate(card.claims.join("; ") || card.excerpt, 100)}`,
			);
		}
	}
	return lines.join("\n");
}

function renderDecision(view: MissionView): string {
	const decision = view.decision;
	if (!decision) return [`Mission: ${view.mission.id}`, "Decision: <none>"].join("\n");
	return [
		`Mission: ${view.mission.id}`,
		`Decision: ${decision.id}`,
		`Hypothesis: ${decision.hypothesis}`,
		`Confidence: ${decision.confidence}`,
		`Rationale: ${truncate(decision.rationale, 160)}`,
		`Evidence refs: ${decision.evidenceRefs.length > 0 ? decision.evidenceRefs.join(",") : "<none>"}`,
		"Next actions:",
		...(decision.nextActions.length > 0 ? decision.nextActions.map(action => `  ${action}`) : ["  <none>"]),
	].join("\n");
}

function renderVerify(view: MissionView, relatedEvents: unknown[], replay?: MissionReplayVerification): string {
	const counts = countProposals(view);
	const lines = [
		`Mission: ${view.mission.id}`,
		`State: ${view.mission.state}`,
		`Decision: ${view.decisionSummary?.id ?? "<none>"}`,
		`Proposals: total=${counts.total} pending=${counts.pending} approved=${counts.approved} applied=${counts.applied} rejected=${counts.rejected} rolled_back=${counts.rolledBack}`,
		"Lane completeness:",
		...laneCompletenessLines(view),
		view.latestVerification
			? `verification: ${view.latestVerification.status} failed=${view.latestVerification.failedCount} uncertain=${view.latestVerification.uncertainCount} ${view.latestVerification.summary}`
			: "verification: not yet recorded",
		`Runtime critic: ${summarizeRuntimeCritic(view).status} checks=${summarizeRuntimeCritic(view).checks.length} dialogue=${view.criticDialogue.length}`,
		"Related mission events:",
		...(relatedEvents.length > 0 ? relatedEvents.map(event => `  ${JSON.stringify(event)}`) : ["  <none>"]),
	];
	if (replay) {
		lines.push("Event replay:");
		lines.push(`  status: ${replay.ok ? "consistent" : "inconsistent"}`);
		lines.push(
			`  decision: db=${replay.db.decision} events=${replay.events.decision} ${replay.matches.decision ? "ok" : "mismatch"}`,
		);
		lines.push(
			`  contracts: db=${replay.db.contracts} events=${replay.events.contracts} ${replay.matches.contracts ? "ok" : "mismatch"}`,
		);
		lines.push(
			`  verification: db=${replay.db.verification} events=${replay.events.verification} ${replay.matches.verification ? "ok" : "mismatch"}`,
		);
		lines.push(
			`  rollbacks: db=${replay.db.rollbacks} events=${replay.events.rollbacks} ${replay.matches.rollbacks ? "ok" : "mismatch"}`,
		);
		lines.push(`  chronology: ${replay.events.chronological ? "ok" : "mismatch"}`);
	}
	return lines.join("\n");
}

function renderRollback(view: MissionView, candidateCount: number): string {
	const lines = [
		`Mission: ${view.mission.id}`,
		"Recorded rollbacks:",
		...(view.rollbacks.length > 0
			? view.rollbacks.map(
					rollback =>
						`  ${rollback.id}  ${rollback.targetType}:${rollback.targetId}  snapshot=${rollback.snapshotRef ?? "<none>"}  ${rollback.summary}`,
				)
			: ["  <none>"]),
		`Snapshot: ${view.mission.snapshotRef ?? "<none>"}`,
		`Decision: ${view.mission.decisionId ?? "<none>"}`,
		`Proposal rollback candidates: ${candidateCount}`,
	];
	if (!view.mission.snapshotRef && view.rollbacks.length === 0) lines.splice(1, 0, "rollback: unavailable");
	return lines.join("\n");
}

function laneLines(view: MissionView): string[] {
	if (view.laneRuns.length === 0) return ["  <none>"];
	return view.laneRuns.map(
		lane =>
			`  ${lane.lane}  ${epistemicBadge(lane.epistemicRole)} ${lane.epistemicRole}  ${lane.status}  evidence=${lane.evidenceCount}`,
	);
}

function laneCompletenessLines(view: MissionView): string[] {
	if (view.laneRuns.length === 0) return ["  <none>"];
	return view.laneRuns.map(lane => {
		const complete = lane.status === "completed" || lane.status === "empty";
		return `  ${lane.lane}: ${complete ? "complete" : "incomplete"} (${lane.status})`;
	});
}

function proposalLines(view: MissionView): string[] {
	if (view.proposals.length === 0) return ["  <none>"];
	return view.proposals.map(proposal => `  ${proposal.id}  ${proposal.type}  ${proposal.status}  ${proposal.gate}`);
}

function countProposals(view: MissionView): {
	total: number;
	pending: number;
	approved: number;
	applied: number;
	rejected: number;
	rolledBack: number;
} {
	return {
		total: view.proposals.length,
		pending: view.proposals.filter(proposal => proposal.status === "pending").length,
		approved: view.proposals.filter(proposal => proposal.status === "approved").length,
		applied: view.proposals.filter(proposal => proposal.status === "applied").length,
		rejected: view.proposals.filter(proposal => proposal.status === "rejected").length,
		rolledBack: view.proposals.filter(proposal => proposal.status === "rolled-back").length,
	};
}

function summarizeRuntimeCritic(view: MissionView): {
	status: "satisfied" | "blocked";
	checks: Array<{
		id: string;
		status: "satisfied" | "waived" | "blocked";
		trigger: string;
		requiredAction: string;
		message: string;
	}>;
	dialogue: MissionView["criticDialogue"];
} {
	const checks = (view.runtimeCriticChecks ?? []).map(check => ({
		id: check.id,
		status: check.severity === "blocking" ? ("blocked" as const) : ("waived" as const),
		trigger: check.trigger,
		requiredAction: check.requiredAction,
		message: check.message,
	}));
	return {
		status: checks.some(check => check.status === "blocked") ? "blocked" : "satisfied",
		checks,
		dialogue: view.criticDialogue,
	};
}

function runtimeCriticLines(view: MissionView): string[] {
	const summary = summarizeRuntimeCritic(view);
	const lines = [`  status=${summary.status} checks=${summary.checks.length} dialogue=${summary.dialogue.length}`];
	for (const check of summary.checks) {
		lines.push(`  ${check.status} ${check.trigger} -> ${check.requiredAction}: ${truncate(check.message, 100)}`);
	}
	if (summary.dialogue.length > 0) {
		const latest = summary.dialogue.at(-1)!;
		lines.push(`  latest dialogue ${latest.role}: ${truncate(latest.summary, 100)}`);
	}
	return lines;
}

function toMissionRow(view: MissionView): unknown {
	return {
		id: view.mission.id,
		title: view.mission.title,
		state: view.mission.state,
		objectiveId: view.mission.objectiveId,
		briefId: view.mission.briefId,
		decisionId: view.mission.decisionId,
		evidenceCount: view.evidenceCount,
		laneCount: view.laneRuns.length,
		proposalCount: view.proposals.length,
		createdAt: view.mission.createdAt,
		updatedAt: view.mission.updatedAt,
	};
}

type EvidenceStatus = "accepted" | "speculative" | "conflicting";

function filterEvidence(
	evidence: EvidenceCard[],
	opts: { lane?: string; grade?: string; status?: EvidenceStatus; query?: string },
): EvidenceCard[] {
	const query = opts.query?.toLowerCase();
	return evidence.filter(card => {
		if (opts.lane && card.lane !== opts.lane) return false;
		if (opts.grade && card.grade !== opts.grade) return false;
		if (opts.status && classifyEvidence(card, evidence) !== opts.status) return false;
		if (query && !evidenceSearchText(card).includes(query)) return false;
		return true;
	});
}

function classifyEvidence(card: EvidenceCard, evidence: EvidenceCard[]): EvidenceStatus {
	if (evidenceContradictsAny(card, evidence)) return "conflicting";
	if (isSpeculativeEvidence(card)) return "speculative";
	return "accepted";
}

function isSpeculativeEvidence(card: EvidenceCard): boolean {
	const text = evidenceSearchText(card);
	return text.includes("speculative") || text.includes("exploratory");
}

function evidenceSearchText(card: EvidenceCard): string {
	return [card.sourceRef, card.excerpt, ...card.claims].join("\n").toLowerCase();
}

function epistemicBadge(role: string): string {
	if (role === "repo_truth") return "[repo truth]";
	if (role === "source_harvest") return "[source]";
	if (role === "social_signal") return "[social]";
	if (role === "synthesis") return "[synth]";
	if (role === "critic") return "[critic]";
	return "[unknown]";
}

type StreamMissionEventsOptions = {
	json?: boolean;
	baseDir?: string;
	pollIntervalMs?: number;
	idleTimeoutMs?: number;
	once?: boolean;
};

export async function streamMissionEvents(missionId: string, opts: StreamMissionEventsOptions = {}): Promise<void> {
	const filePath = missionEventsPath(missionId, opts.baseDir);
	let offset = 0;
	let buffer = "";
	let emitted = false;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS;
	const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	const deadline = opts.once ? Date.now() + idleTimeoutMs : Number.POSITIVE_INFINITY;

	while (true) {
		const chunk = await readNewBytes(filePath, offset);
		if (chunk) {
			offset += Buffer.byteLength(chunk);
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim() === "") continue;
				const event = JSON.parse(line) as MissionEvent;
				writeStreamEvent(event, opts.json);
				emitted = true;
			}
			if (opts.once && emitted) return;
		}
		if (opts.once && Date.now() >= deadline) return;
		await sleep(pollIntervalMs);
	}
}

type MissionReplayVerification = {
	ok: boolean;
	db: { decision: boolean; contracts: number; verification: boolean; rollbacks: number };
	events: { decision: boolean; contracts: number; verification: boolean; rollbacks: number; chronological: boolean };
	matches: { decision: boolean; contracts: boolean; verification: boolean; rollbacks: boolean; chronology: boolean };
};

function verifyEventReplay(view: MissionView, events: MissionEvent[]): MissionReplayVerification {
	const eventCounts = {
		decision: events.some(event => event.type === "decision.recorded"),
		contracts: events.filter(event => event.type === "contract.created").length,
		verification: events.some(event => event.type === "verification.completed"),
		rollbacks: events.filter(event => event.type === "rollback.snapshot.created").length,
		chronological: events.every((event, index) => index === 0 || events[index - 1]!.ts <= event.ts),
	};
	const dbCounts = {
		decision: view.decision !== null,
		contracts: view.contracts.length,
		verification: view.latestVerification !== null,
		rollbacks: view.rollbacks.length,
	};
	const matches = {
		decision: dbCounts.decision === eventCounts.decision,
		contracts: dbCounts.contracts === eventCounts.contracts,
		verification: dbCounts.verification === eventCounts.verification,
		rollbacks: dbCounts.rollbacks === eventCounts.rollbacks,
		chronology: eventCounts.chronological,
	};
	return {
		ok: Object.values(matches).every(Boolean),
		db: dbCounts,
		events: eventCounts,
		matches,
	};
}

function filterVerifyRelatedEvents(events: MissionEvent[]): MissionEvent[] {
	const relevant = new Set<MissionEvent["type"]>([
		"research.brief.created",
		"research.lane.started",
		"research.lane.completed",
		"research.evidence.added",
		"research.synthesis.proposed",
		"research.critique.completed",
		"decision.recorded",
		"contract.created",
		"verification.completed",
		"rollback.snapshot.created",
	]);
	return events.filter(event => relevant.has(event.type));
}

async function readNewBytes(filePath: string, offset: number): Promise<string> {
	try {
		const handle = await fs.open(filePath, "r");
		try {
			const stat = await handle.stat();
			if (stat.size <= offset) return "";
			const length = stat.size - offset;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function writeStreamEvent(event: MissionEvent, json: boolean | undefined): void {
	if (json) {
		writeJson(event);
		return;
	}
	process.stdout.write(`${`${event.ts}  ${event.type}  ${eventSummary(event)}`.trimEnd()}\n`);
}

function missionEventsPath(missionId: string, baseDir?: string): string {
	const root = baseDir ?? path.join(process.env.HOME || homedir(), ".amaze", "observability", "missions");
	return path.join(root, `${missionId}.jsonl`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function eventSummary(event: { type: string } & Record<string, unknown>): string {
	if (event.type === "research.brief.created") return `brief=${event.briefId}`;
	if (event.type === "research.evidence.added") return `brief=${event.briefId} evidence=${event.evidenceId}`;
	if (event.type === "decision.recorded") return `brief=${event.briefId} decision=${event.decisionId}`;
	if (event.type === "research.lane.started") return `lane=${event.lane} run=${event.laneRunId}`;
	if (event.type === "research.lane.completed") return `lane=${event.lane} status=${event.status}`;
	if (event.type === "contract.created") return `contract=${event.contractId} role=${event.role}`;
	if (event.type === "verification.completed") {
		return `verification=${event.verificationId} status=${event.status} failed=${event.failedCount} uncertain=${event.uncertainCount}`;
	}
	if (event.type === "rollback.snapshot.created") {
		return `rollback=${event.rollbackId} target=${event.targetType}:${event.targetId} snapshot=${event.snapshotRef ?? "<none>"}`;
	}
	if (event.type === "research.synthesis.proposed") {
		return `brief=${event.briefId} hypotheses=${event.hypothesisCount} recommended=${event.recommended ?? "<none>"}`;
	}
	if (event.type === "research.critique.completed") {
		return `brief=${event.briefId} verdict=${event.verdict} blocking=${event.blockingCount} soft=${event.softCount}`;
	}
	return "";
}

function parseState(value: string | undefined): MissionState | undefined {
	if (value === undefined) return undefined;
	if (!MISSION_STATES.includes(value as MissionState)) throw new Error(`Invalid mission state: ${value}`);
	return value as MissionState;
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function truncate(value: string, length: number): string {
	return value.length <= length ? value : value.slice(0, length);
}
