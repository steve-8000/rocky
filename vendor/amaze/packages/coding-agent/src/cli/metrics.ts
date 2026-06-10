import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { computeMetric, type MetricResult, registerDefaultMetrics, registeredMetrics } from "../metrics";
import type { SessionEvent } from "../observability";

export interface MetricsShowArgs {
	window?: string;
	json?: boolean;
	sink?: string;
}

export interface MetricsDoctorArgs extends MetricsShowArgs {
	forceCompleteThreshold?: number;
}

const DEFAULT_FORCE_COMPLETE_THRESHOLD = 0.1;

export async function runMetricsShowCommand(args: MetricsShowArgs): Promise<void> {
	const results = await computeAllMetrics(args);
	if (args.json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${formatMetrics(results)}\n`);
}

export async function runMetricsWatchCommand(args: MetricsShowArgs): Promise<void> {
	await runMetricsShowCommand(args);
	setInterval(() => {
		void runMetricsShowCommand(args);
	}, 1000);
}

export async function runMetricsDoctorCommand(args: MetricsDoctorArgs = {}): Promise<void> {
	const results = await computeAllMetrics(args);
	const forceComplete = results.find(result => result.name === "goal.forceCompleteRate");
	const threshold = args.forceCompleteThreshold ?? DEFAULT_FORCE_COMPLETE_THRESHOLD;
	const lines = ["metrics", ...results.map(formatMetricLine)];
	if (forceComplete && forceComplete.value > threshold) {
		lines.push(
			`warning: goal.forceCompleteRate ${formatValue(forceComplete.value)} exceeds ${formatValue(threshold)}`,
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function computeAllMetrics(args: MetricsShowArgs): Promise<MetricResult[]> {
	registerDefaultMetrics();
	const events = await loadEvents(args.sink ?? defaultSinkDir());
	const window = parseWindow(args.window);
	return registeredMetrics().map(metric => computeMetric(metric.name, events, { window }));
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

function formatMetrics(results: MetricResult[]): string {
	if (results.length === 0) return "No metrics registered.";
	return results.map(formatMetricLine).join("\n");
}

function formatMetricLine(result: MetricResult): string {
	return `${result.name}: ${formatValue(result.value)} (n=${result.sampleN})`;
}

function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
