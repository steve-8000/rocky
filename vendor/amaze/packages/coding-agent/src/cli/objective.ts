import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { type Objective, type ObjectiveStatus, ObjectiveStore } from "../autonomy";
import type { EvoTrace } from "../autonomy/evo-trace";
import { type ProposalLimitDecision, shouldEmitProposal } from "../autonomy/limits";
import { planFromMetrics } from "../autonomy/planner";
import { Settings } from "../config/settings";
import { type LearningProposal, ProposalStore } from "../learning";
import { computeMetric, registerDefaultMetrics, registeredMetrics } from "../metrics";
import type { SessionEvent } from "../observability";

export interface ObjectiveBaseArgs {
	db?: string;
}

export interface ObjectiveCreateArgs extends ObjectiveBaseArgs {
	title: string;
	metric: string;
	target: number;
	direction: "up" | "down";
	deadline?: number;
}

export interface ObjectiveIdArgs extends ObjectiveBaseArgs {
	id: string;
}

export interface ObjectivePreviewArgs extends ObjectiveIdArgs {
	metrics?: string;
	json?: boolean;
	window?: string;
	proposalsDb?: string;
}

const STATUSES: ObjectiveStatus[] = ["active", "paused", "completed", "cancelled"];

export function isObjectiveDirection(value: string | undefined): value is "up" | "down" {
	return value === "up" || value === "down";
}

export function isObjectiveStatus(value: string | undefined): value is ObjectiveStatus {
	return STATUSES.includes(value as ObjectiveStatus);
}

export async function runObjectiveCreateCommand(args: ObjectiveCreateArgs): Promise<void> {
	withStore(args.db, store => {
		const objective = store.create({
			title: args.title,
			metricTargets: [
				{ metric: args.metric, target: args.target, direction: args.direction, deadline: args.deadline },
			],
			budget: {},
		});
		process.stdout.write(`${formatObjective(objective)}\n`);
	});
}

export async function runObjectiveListCommand(args: ObjectiveBaseArgs): Promise<void> {
	withStore(args.db, store => {
		process.stdout.write(`${formatTable(store.list())}\n`);
	});
}

export async function runObjectiveShowCommand(args: ObjectiveIdArgs): Promise<void> {
	withStore(args.db, store => {
		const objective = requireObjective(store, args.id);
		process.stdout.write(`${JSON.stringify(objective, null, 2)}\n`);
	});
}

export async function runObjectivePreviewCommand(args: ObjectivePreviewArgs): Promise<void> {
	const settings = await Settings.init();
	const objective = withStore(args.db, store => requireObjective(store, args.id));
	const metrics = args.metrics ? await loadMetricsFile(args.metrics) : await computeMetrics(args.window ?? "7d");
	const { proposal, trace } = planFromMetrics(objective, metrics, { settings });

	if (!proposal) {
		process.stdout.write(`no remediation needed for objective ${args.id}\n`);
		return;
	}
	const proposalStore = new ProposalStore(args.proposalsDb);
	try {
		const startOfTodayUtc = new Date();
		startOfTodayUtc.setUTCHours(0, 0, 0, 0);
		const sinceMs = startOfTodayUtc.getTime();
		const todayCount = proposalStore.countByObjectiveSince(objective.id, sinceMs);
		const limitDecision = shouldEmitProposal(objective, proposal, {
			todayCount,
			// TODO: observability JSONL aggregation for token/usd history
			usedTokens: 0,
			usedUsdCents: 0,
		});

		if (!limitDecision.allow && limitDecision.reason) {
			trace.guardrailBlocks = [limitDecision.reason];
			trace.stage = "blocked";
		}

		if (args.json) {
			process.stdout.write(`${JSON.stringify({ proposal, limitDecision, trace }, null, 2)}\n`);
			return;
		}

		process.stdout.write(`${formatProposalPreview(objective, metrics, proposal, limitDecision, trace)}\n`);
	} finally {
		proposalStore.close();
	}
}

export async function runObjectivePauseCommand(args: ObjectiveIdArgs): Promise<void> {
	updateStatus(args, "paused");
}

export async function runObjectiveCancelCommand(args: ObjectiveIdArgs): Promise<void> {
	updateStatus(args, "cancelled");
}

export async function runObjectiveSetEnabledCommand(enabled: boolean): Promise<void> {
	try {
		const settings = await Settings.init();
		settings.set("autonomy.enabled", enabled);
		await settings.flush();
		process.stdout.write(`autonomy.enabled=${enabled}\n`);
	} catch (error) {
		process.stdout.write(
			`Unable to write autonomy.enabled automatically. Edit your Amaze config manually and set autonomy.enabled: ${enabled}.\n${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function updateStatus(args: ObjectiveIdArgs, status: ObjectiveStatus): void {
	withStore(args.db, store => {
		const objective = store.updateStatus(args.id, status);
		process.stdout.write(`${formatObjective(objective)}\n`);
	});
}

function withStore<T>(dbPath: string | undefined, callback: (store: ObjectiveStore) => T): T {
	const store = new ObjectiveStore(dbPath);
	try {
		return callback(store);
	} finally {
		store.close?.();
	}
}

function requireObjective(store: ObjectiveStore, id: string): Objective {
	const objective = store.get(id);
	if (!objective) throw new Error(`Objective not found: ${id}`);
	return objective;
}

async function loadMetricsFile(metricsPath: string): Promise<Record<string, number>> {
	const parsed = JSON.parse(await fs.readFile(metricsPath, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("--metrics must contain a JSON object of metric names to numeric values");
	}
	const metrics: Record<string, number> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`Metric ${name} must be a finite number`);
		}
		metrics[name] = value;
	}
	return metrics;
}

async function computeMetrics(windowValue: string): Promise<Record<string, number>> {
	registerDefaultMetrics();
	const events = await loadEvents(defaultSinkDir());
	const window = parseWindow(windowValue);
	return Object.fromEntries(
		registeredMetrics().map(metric => [metric.name, computeMetric(metric.name, events, { window }).value]),
	);
}

async function loadEvents(target: string): Promise<SessionEvent[]> {
	const stat = await fs.stat(target).catch(() => undefined);
	if (!stat) return [];
	const files = stat.isDirectory() ? await collectJsonlFiles(target) : [target];
	const events: SessionEvent[] = [];
	for (const file of files.sort()) {
		const content = await fs.readFile(file, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			events.push(JSON.parse(line) as SessionEvent);
		}
	}
	return events.sort((a, b) => a.ts - b.ts);
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectJsonlFiles(fullPath)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(fullPath);
		}
	}
	return files;
}

function parseWindow(value: string | undefined): { since?: number } | undefined {
	if (!value) return undefined;
	const match = /^(\d+)([dhm])$/.exec(value);
	if (!match) throw new Error("--window must use <number><m|h|d>, for example 7d");
	const amount = Number(match[1]);
	const unit = match[2];
	const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
	return { since: Date.now() - amount * multiplier };
}

function defaultSinkDir(): string {
	return path.join(process.env.HOME || homedir(), ".amaze", "observability");
}

function formatProposalPreview(
	objective: Objective,
	metrics: Record<string, number>,
	proposal: LearningProposal,
	limitDecision: ProposalLimitDecision,
	trace: EvoTrace,
): string {
	const mismatch = objective.metricTargets.find(target => {
		const value = metrics[target.metric];
		if (value === undefined || !Number.isFinite(value)) return false;
		return target.direction === "down" ? value > target.target : value < target.target;
	});
	const lines = [`type: ${proposal.type}`];
	if (proposal.type === "rule") {
		lines.push(
			`patch: ${JSON.stringify({ ruleMarkdown: proposal.ruleMarkdown })}`,
			"rollback: {}",
			`reason: ${proposal.expectedImpact}`,
		);
	} else if (proposal.type === "settings") {
		lines.push(
			`patch: ${JSON.stringify(proposal.patch)}`,
			`rollback: ${JSON.stringify(proposal.rollback)}`,
			`reason: ${proposal.reason}`,
		);
	} else if (proposal.type === "skill") {
		lines.push(
			`patch: ${JSON.stringify({ name: proposal.name, bodyMarkdown: proposal.bodyMarkdown })}`,
			"rollback: {}",
			`reason: generated from memories ${proposal.sourceMemoryIds.join(", ")}`,
		);
	} else {
		lines.push(
			`patch: ${JSON.stringify({
				content: proposal.content,
				memoryType: proposal.memoryType,
				confidence: proposal.confidence,
			})}`,
			"rollback: {}",
			"reason: captured memory proposal",
		);
	}
	if (mismatch) {
		lines.push(
			`mismatch: ${mismatch.metric}=${metrics[mismatch.metric]} target ${mismatch.direction} ${mismatch.target}`,
		);
	}
	if (limitDecision.allow) {
		lines.push("guardrail: allowed");
	} else {
		lines.push("guardrail: blocked", `reason: ${limitDecision.reason}`);
	}
	lines.push("evo-trace:", `  stage: ${trace.stage}`, "  nextActions:");
	for (const action of trace.nextActions) {
		lines.push(`    - ${action}`);
	}
	if (trace.guardrailBlocks && trace.guardrailBlocks.length > 0) {
		lines.push("  guardrailBlocks:");
		for (const block of trace.guardrailBlocks) {
			lines.push(`    - ${block}`);
		}
	}
	return lines.join("\n");
}

function formatObjective(objective: Objective): string {
	const target = objective.metricTargets[0];
	return `${objective.id}\t${objective.status}\t${objective.title}\t${target.metric} ${target.direction} ${target.target}`;
}

function formatTable(objectives: Objective[]): string {
	if (objectives.length === 0) return "No objectives";
	return [
		["ID", "STATUS", "TITLE", "TARGET"],
		...objectives.map(objective => {
			const target = objective.metricTargets[0];
			return [
				objective.id,
				objective.status,
				objective.title,
				`${target.metric} ${target.direction} ${target.target}`,
			];
		}),
	]
		.map(row => row.join("\t"))
		.join("\n");
}
