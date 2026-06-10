import type { Component } from "@amaze/tui";
import type { MissionEventBus, Unsubscribe } from "../../mission/event-bus";
import { MissionReadModel, type MissionView } from "../../mission/read-model";
import { getMissionEventBus } from "../../mission/runtime";

export type MissionControlDisplayMode = "off" | "compact" | "expanded";

/** Cycle order for the on-demand toggle. */
const DISPLAY_MODE_CYCLE: readonly MissionControlDisplayMode[] = ["off", "compact", "expanded"];

export class MissionControlView implements Component {
	#readModel: MissionReadModel;
	#getPreferredMissionInput:
		| (() => { objectiveId?: string; briefId?: string; title?: string } | undefined)
		| undefined;
	#missions: MissionView[] = [];
	#mission: MissionView | null = null;
	#selectedMissionId: string | undefined;
	#unsubscribe: Unsubscribe | undefined;
	#disposed = false;
	#displayMode: MissionControlDisplayMode = "off";

	constructor(
		opts: {
			dbPath?: string;
			getPreferredMissionInput?: () => { objectiveId?: string; briefId?: string; title?: string } | undefined;
			missionEventBus?: MissionEventBus;
			onRefresh?: () => void;
			initialMode?: MissionControlDisplayMode;
		} = {},
	) {
		this.#readModel = new MissionReadModel({ dbPath: opts.dbPath });
		this.#getPreferredMissionInput = opts.getPreferredMissionInput;
		if (opts.initialMode) this.#displayMode = opts.initialMode;
		const bus = opts.missionEventBus ?? getMissionEventBus();
		if (bus) {
			this.#unsubscribe = bus.subscribe(event => {
				if (this.#selectedMissionId === undefined || event.missionId === this.#selectedMissionId) {
					this.refresh();
					opts.onRefresh?.();
				}
			});
		}
		this.refresh();
	}

	refresh(): void {
		if (this.#disposed) return;
		this.#missions = this.#readModel.listMissionViews();
		const selected = this.#selectedMissionId
			? this.#missions.find(view => view.mission.id === this.#selectedMissionId)
			: undefined;
		const preferred =
			selected ??
			this.#readModel.getPreferredMissionView(this.#getPreferredMissionInput?.()) ??
			this.#missions[0] ??
			null;
		this.#mission = preferred;
		this.#selectedMissionId = selected ? selected.mission.id : undefined;
	}

	selectNextMission(): boolean {
		return this.#selectMission(1);
	}

	selectPreviousMission(): boolean {
		return this.#selectMission(-1);
	}

	getSelectedMissionLabel(): string | undefined {
		if (!this.#mission) return undefined;
		const index = this.#missions.findIndex(view => view.mission.id === this.#mission?.mission.id);
		const position = index >= 0 ? `${index + 1}/${this.#missions.length}` : "preferred";
		return `${position} ${this.#mission.mission.title}`;
	}

	getDisplayMode(): MissionControlDisplayMode {
		return this.#displayMode;
	}

	toggleDisplayMode(): MissionControlDisplayMode {
		// Cycle off → compact → expanded → off. "off" renders nothing, keeping the terminal lean;
		// mission data continues to flow to the headless gateway regardless of this surface toggle.
		const next = (DISPLAY_MODE_CYCLE.indexOf(this.#displayMode) + 1) % DISPLAY_MODE_CYCLE.length;
		this.#displayMode = DISPLAY_MODE_CYCLE[next] ?? "off";
		return this.#displayMode;
	}

	setDisplayMode(mode: MissionControlDisplayMode): MissionControlDisplayMode {
		this.#displayMode = mode;
		return this.#displayMode;
	}

	#selectMission(direction: 1 | -1): boolean {
		this.refresh();
		if (this.#missions.length <= 1 || !this.#mission) return false;
		const currentIndex = Math.max(
			0,
			this.#missions.findIndex(view => view.mission.id === this.#mission?.mission.id),
		);
		const nextIndex = (currentIndex + direction + this.#missions.length) % this.#missions.length;
		if (nextIndex === currentIndex) return false;
		this.#mission = this.#missions[nextIndex] ?? null;
		this.#selectedMissionId = this.#mission?.mission.id;
		return Boolean(this.#mission);
	}

	getPreferredInspectorTarget(): { sessionId?: string; sessionFile?: string } | undefined {
		const target = this.#mission?.preferredInspectorTarget;
		if (!target) return undefined;
		return {
			sessionId: target.taskId ?? undefined,
			sessionFile: target.sessionFile ?? undefined,
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#readModel.close();
	}

	invalidate(): void {}

	render(width: number): string[] {
		// "off": render nothing — no box, full vertical space reclaimed for the tool-centric stream.
		if (this.#displayMode === "off") return [];
		const innerWidth = Math.max(20, width - 2);
		const lines = this.#mission
			? buildMissionControlLines(this.#mission, {
					missionStrip: getMissionStrip(this.#missions, this.#mission),
					mode: this.#displayMode,
				})
			: buildMissionControlEmptyLines();
		return [
			`┌${"─".repeat(innerWidth)}┐`,
			...lines.map(line => `│${padLine(line, innerWidth)}│`),
			`└${"─".repeat(innerWidth)}┘`,
		];
	}
}

export function buildMissionControlEmptyLines(): string[] {
	return [
		"Mission Control",
		"No active mission yet.",
		"Mission Inspector: Ctrl+S for tool traces, artifacts, and subagent details",
	];
}

export function buildMissionControlLines(
	view: MissionView,
	opts: string | { missionStrip?: string; mode?: MissionControlDisplayMode } = {},
): string[] {
	const mission = view.mission;
	const headerLabel = formatHeaderLabel(view.objective?.title ?? mission.title);
	const objectiveLine = formatObjectiveLine(view.objective?.title ?? mission.title);
	const confidence = mission.confidence ?? "unknown";
	const snapshot = mission.snapshotRef ? "available" : "unavailable";
	const researchRun = view.researchRun ? `${view.researchRun.status} (${view.researchRun.id})` : "<none>";
	const laneSummary = summarizeLaneRuns(view);
	const evidenceSummary = summarizeEvidence(view);
	const mode = typeof opts === "string" ? "compact" : (opts.mode ?? "compact");
	const missionStrip = typeof opts === "string" ? opts : opts.missionStrip;
	const hasOrchestration = view.laneRuns.length > 0;
	const hasEvidence = view.evidenceCards.length > 0;
	const hasSynthesisCritique = Boolean(view.latestSynthesis || view.latestCritique);
	const criticChecks = view.runtimeCriticChecks ?? [];
	const hasRuntimeCritic = criticChecks.length > 0 || view.criticDialogue.length > 0;
	const hasDecisionContract = Boolean(view.decisionSummary) || view.contracts.length > 0;
	const hasVerificationRollback = Boolean(view.latestVerification) || (view.rollbacks?.length ?? 0) > 0;
	const lines: string[] = [
		`Mission Control — ${headerLabel}`,
		...(missionStrip ? [missionStrip] : []),
		`Objective: ${objectiveLine}`,
		`State: ${mission.state} | confidence ${confidence} | risk ${mission.riskLevel}`,
		`Execution: lanes ${laneSummary} | evidence ${evidenceSummary}`,
		`Research run: ${researchRun}`,
		`Snapshot: ${snapshot}`,
	];

	if (mode === "expanded" || hasOrchestration) {
		lines.push(section("Orchestration"));
		if (view.laneRuns.length === 0) {
			lines.push("  <none>");
		} else {
			for (const lane of view.laneRuns) {
				const emptyReason = lane.emptyReason ? ` | empty: ${lane.emptyReason}` : "";
				lines.push(
					`  ${epistemicBadge(lane.epistemicRole)} ${lane.agent} | ${lane.lane} | ${lane.status} | evidence ${lane.evidenceCount}${emptyReason}`,
				);
			}
		}

		lines.push(`  Summary: ${laneSummary}`);
	}

	if (mode === "expanded" || hasEvidence) {
		lines.push(section("Evidence Board"));
		const evidenceLimit = mode === "expanded" ? 8 : 4;
		const evidenceCards = view.evidenceCards.slice(0, evidenceLimit);
		if (evidenceCards.length === 0) {
			lines.push("  <none>");
		} else {
			for (const card of evidenceCards) {
				lines.push(formatEvidenceCard(card, mode));
			}
		}
		lines.push(`  Summary: ${evidenceSummary}`);
	}

	if (mode === "expanded" || hasSynthesisCritique) {
		lines.push(section("Synthesis / Critique"));
		lines.push(
			view.latestSynthesis
				? `  Synthesis: ${view.latestSynthesis.summary} | hypotheses ${view.latestSynthesis.hypothesisCount}${view.latestSynthesis.recommended ? ` | recommended ${view.latestSynthesis.recommended}` : ""}`
				: "  Synthesis: <none>",
		);
		lines.push(
			view.latestCritique
				? `  Critique: ${view.latestCritique.verdict} | blockers ${view.latestCritique.blockingCount} | soft concerns ${view.latestCritique.softCount} | ${view.latestCritique.summary}`
				: "  Critique: <none>",
		);
	}

	if (mode === "expanded" || hasRuntimeCritic) {
		lines.push(section("Runtime Critic"));
		const blockingChecks = criticChecks.filter(check => check.severity === "blocking");
		lines.push(
			`  Checks: ${criticChecks.length} total | blocked ${blockingChecks.length} | soft ${criticChecks.length - blockingChecks.length}`,
		);
		if (criticChecks.length === 0) {
			lines.push("  Status: satisfied");
		} else {
			const visibleChecks = mode === "expanded" ? criticChecks : criticChecks.slice(0, 3);
			for (const check of visibleChecks) {
				lines.push(
					`  ${formatCriticCheckStatus(check.severity)} ${check.trigger}${check.lane ? `/${check.lane}` : ""} -> ${check.requiredAction}: ${check.message}`,
				);
			}
			if (visibleChecks.length < criticChecks.length)
				lines.push(`  … ${criticChecks.length - visibleChecks.length} more checks`);
		}
		if (view.criticDialogue.length === 0) {
			lines.push("  Dialogue: <none>");
		} else {
			const latestDialogue = view.criticDialogue.at(-1)!;
			lines.push(
				`  Dialogue: ${view.criticDialogue.length} turns | latest ${latestDialogue.role}: ${latestDialogue.summary}`,
			);
		}
	}

	if (mode === "expanded" || hasDecisionContract) {
		lines.push(section("Decision Contract"));
		if (view.decisionSummary) {
			lines.push(
				`  Decision: ${view.decisionSummary.kind} | ${view.decisionSummary.confidence} | ${view.decisionSummary.hypothesis}`,
			);
			lines.push(
				`  Evidence refs: ${formatList(view.decisionSummary.evidenceRefs)} | rejected options ${view.decision?.rejectedOptions.length ?? 0} | next actions ${view.decision?.nextActions.length ?? 0}`,
			);
			if (mode === "expanded" && view.decision?.rejectedOptions.length) {
				for (const option of view.decision.rejectedOptions.slice(0, 3)) {
					lines.push(`    Rejected ${option.id}: ${option.reason}`);
				}
			}
			if (view.decision?.nextActions.length) {
				lines.push(
					`  Next actions (${view.decision.nextActions.length}): ${formatList(view.decision.nextActions)}`,
				);
			}
		} else {
			lines.push("  Decision: <none>");
		}
		const latestContract = view.contracts.at(-1);
		lines.push(
			latestContract
				? `  Execution contract: ${latestContract.role} | scope +${latestContract.include.length}/-${latestContract.exclude.length} | criteria ${latestContract.successCriteria.length} | outputs ${latestContract.mustProduce.length} | escalation ${latestContract.escalation.onUncertainty}`
				: "  Execution contract: <none>",
		);
		if (mode === "expanded" && latestContract) {
			lines.push(`    Outputs: ${formatList(latestContract.mustProduce)}`);
			lines.push(`    Criteria: ${formatList(latestContract.successCriteria)}`);
		}
		if (view.preferredInspectorTarget) {
			lines.push(`  Linked trace: ${view.preferredInspectorTarget.label}`);
		}
	}
	if (mode === "expanded") {
		lines.push(section("Inspector Targets"));
		if (view.inspectorTargets.length === 0) {
			lines.push("  <none>");
		} else {
			view.inspectorTargets.forEach((target, index) => {
				const preferred = index === 0 ? "preferred" : "available";
				const file = target.sessionFile ? ` | file ${target.sessionFile}` : "";
				lines.push(`  ${index + 1}. ${target.label} | ${preferred} | source ${target.source}${file}`);
			});
		}
	}

	if (mode === "expanded" || hasVerificationRollback) {
		lines.push(section("Verification / Rollback"));
		lines.push(
			view.latestVerification
				? `  Verification: ${view.latestVerification.status} | failed ${view.latestVerification.failedCount} | uncertain ${view.latestVerification.uncertainCount} | ${view.latestVerification.summary}`
				: "  Verification: <none>",
		);
		const latestRollback = view.rollbacks.at(-1);
		lines.push(
			latestRollback
				? `  Rollback: ${latestRollback.summary} | snapshots ${countRollbackSnapshots(view.rollbacks)}`
				: `  Rollback: <none> | snapshots ${countRollbackSnapshots(view.rollbacks)}`,
		);
	}
	lines.push(
		view.preferredInspectorTarget
			? "Mission Inspector: Ctrl+S opens linked contract trace first"
			: "Mission Inspector: Ctrl+S for tool traces, artifacts, and subagent details",
	);
	return lines;
}

function padLine(line: string, width: number): string {
	const clipped = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
	return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

function section(title: string): string {
	return `── ${title} ──`;
}

function formatCriticCheckStatus(severity: string): string {
	return severity === "blocking" ? "[blocked]" : "[waived]";
}

function formatList(items: string[]): string {
	return items.length > 0 ? items.join(", ") : "<none>";
}

function countRollbackSnapshots(rollbacks: MissionView["rollbacks"]): number {
	return rollbacks.filter(rollback => rollback.snapshotRef).length;
}

function formatEvidenceCard(card: MissionView["evidenceCards"][number], mode: MissionControlDisplayMode): string {
	const base = `  ${laneBadge(card.lane)} ${card.id} | grade ${card.grade} | ${card.sourceRef}`;
	if (mode === "compact") return base;
	const claims = card.claims.length > 0 ? ` | claims ${card.claims.slice(0, 2).join("; ")}` : "";
	const excerpt = card.excerpt ? ` | ${card.excerpt}` : "";
	return `${base}${claims}${excerpt}`;
}

function getMissionStrip(missions: MissionView[], selected: MissionView): string | undefined {
	if (missions.length <= 1) return undefined;
	const index = missions.findIndex(view => view.mission.id === selected.mission.id);
	const position = index >= 0 ? index + 1 : 1;
	// Short, single-line label — never lets a multi-line objective bleed across rows.
	const label = formatHeaderLabel(selected.mission.title);
	return `Missions: ${missions.length} total | selected ${position}/${missions.length} | ${label}`;
}

/** Single-line, length-capped label for the panel header — never lets a multi-line objective bleed across rows. */
function formatHeaderLabel(raw: string): string {
	return truncateForHeader(firstLine(raw), 60);
}

/** Single-line, length-capped label for the Objective row — same cleanup, slightly more room. */
function formatObjectiveLine(raw: string): string {
	return truncateForHeader(firstLine(raw), 96);
}

function firstLine(value: string): string {
	const cleaned = value.replace(/\r\n?/g, "\n").trim();
	const newlineIdx = cleaned.indexOf("\n");
	return (newlineIdx === -1 ? cleaned : cleaned.slice(0, newlineIdx)).trim();
}

function truncateForHeader(value: string, max: number): string {
	if (value.length <= max) return value || "(no title)";
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeLaneRuns(view: MissionView): string {
	if (view.laneRuns.length === 0) return "0 lanes";
	const counts = new Map<string, number>();
	for (const lane of view.laneRuns) {
		counts.set(lane.status, (counts.get(lane.status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(", ");
}

function summarizeEvidence(view: MissionView): string {
	if (view.evidenceCards.length === 0) return "0 cards";
	const lanes = new Set(view.evidenceCards.map(card => card.lane));
	return `${view.evidenceCards.length} cards across ${lanes.size} lanes`;
}

function laneBadge(lane: string): string {
	if (lane === "repo") return "[repo]";
	if (lane === "source") return "[source]";
	if (lane === "social") return "[social]";
	return "[lane]";
}

function epistemicBadge(role: string): string {
	if (role === "repo_truth") return "[repo truth]";
	if (role === "source_harvest") return "[source]";
	if (role === "social_signal") return "[social]";
	if (role === "synthesis") return "[synth]";
	if (role === "critic") return "[critic]";
	return "[unknown]";
}
