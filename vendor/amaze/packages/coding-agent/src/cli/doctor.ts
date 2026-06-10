import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { getPackageDir } from "../config";
import { metricDefinitions } from "../metrics";
import type { SessionEvent } from "../observability";
import { evaluateRule } from "../rules";
import type { LoadedRule } from "../rules/loader";
import { loadRules } from "../rules/loader";
import type { DoctorStatus } from "./doctor-types";
import { getMemoryDoctorReport } from "./memory";

export type { DoctorStatus } from "./doctor-types";

export interface DoctorCommandOptions {
	json?: boolean;
	now?: number;
	observabilityDir?: string;
	builtinRulesDir?: string;
	userRulesDir?: string;
	projectRulesDir?: string;
}

interface MemorySection {
	status: DoctorStatus;
	text?: string;
	error?: string;
}

interface MetricsSection {
	status: DoctorStatus;
	registered: number;
	observabilityPath: string;
	recentJsonl: boolean;
	recentJsonlCount: number;
}

interface RulesSection {
	status: DoctorStatus;
	loaded: number;
	throwingRuleIds: string[];
	error?: string;
}

interface ObservabilitySection {
	status: DoctorStatus;
	path: string;
	writable: boolean;
	lastFlushTs?: number;
	error?: string;
}

export interface DoctorReport {
	status: DoctorStatus;
	memory: MemorySection;
	metrics: MetricsSection;
	rules: RulesSection;
	observability: ObservabilitySection;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runDoctorCommand(opts: DoctorCommandOptions = {}): Promise<DoctorReport> {
	const now = opts.now ?? Date.now();
	const observabilityPath = resolveObservabilityDir(opts);
	const [memory, observability, rules] = await Promise.all([
		checkMemory(),
		checkObservability(observabilityPath),
		checkRules(opts),
	]);
	const metrics = await checkMetrics(observabilityPath, now);
	const report: DoctorReport = {
		status: aggregateStatus([memory.status, metrics.status, rules.status, observability.status]),
		memory,
		metrics,
		rules,
		observability,
	};

	process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : renderText(report));
	return report;
}

async function checkMemory(): Promise<MemorySection> {
	try {
		const report = await getMemoryDoctorReport();
		return { status: report.status, text: report.text };
	} catch (error) {
		return { status: "failed", error: messageFor(error) };
	}
}

async function checkMetrics(observabilityPath: string, now: number): Promise<MetricsSection> {
	const recentJsonlCount = await countRecentJsonl(path.join(observabilityPath, "sessions"), now);
	return {
		status: recentJsonlCount > 0 ? "ok" : "degraded",
		registered: metricDefinitions.length,
		observabilityPath,
		recentJsonl: recentJsonlCount > 0,
		recentJsonlCount,
	};
}

async function checkRules(opts: DoctorCommandOptions): Promise<RulesSection> {
	let loaded: LoadedRule[];
	try {
		loaded = await loadRules({
			builtinDir:
				opts.builtinRulesDir ??
				process.env.AMAZE_RULES_BUILTIN_DIR ??
				path.join(getPackageDir(), "src", "rules", "builtin"),
			userDir:
				opts.userRulesDir ??
				process.env.AMAZE_RULES_USER_DIR ??
				path.join(process.env.HOME || homedir(), ".amaze", "rules"),
			projectDir:
				opts.projectRulesDir ?? process.env.AMAZE_RULES_PROJECT_DIR ?? path.join(process.cwd(), ".amaze", "rules"),
			approve: async () => false,
		});
	} catch (error) {
		return { status: "failed", loaded: 0, throwingRuleIds: [], error: messageFor(error) };
	}

	const throwingRuleIds: string[] = [];
	for (const candidate of loaded) {
		try {
			evaluateRule(candidate.rule, smokeEvents());
		} catch {
			throwingRuleIds.push(candidate.rule.id);
		}
	}
	return { status: throwingRuleIds.length > 0 ? "degraded" : "ok", loaded: loaded.length, throwingRuleIds };
}

async function checkObservability(observabilityPath: string): Promise<ObservabilitySection> {
	try {
		await fs.mkdir(observabilityPath, { recursive: true });
		const probe = path.join(observabilityPath, `.doctor-${process.pid}-${Date.now()}.tmp`);
		await fs.writeFile(probe, "ok", "utf8");
		await fs.rm(probe, { force: true });
		return {
			status: "ok",
			path: observabilityPath,
			writable: true,
			lastFlushTs: await latestMtime(path.join(observabilityPath, "sessions")),
		};
	} catch (error) {
		return { status: "degraded", path: observabilityPath, writable: false, error: messageFor(error) };
	}
}

async function countRecentJsonl(dir: string, now: number): Promise<number> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (isNotFound(error)) return 0;
		throw error;
	}
	let count = 0;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const stat = await fs.stat(path.join(dir, entry));
		if (now - stat.mtimeMs <= WEEK_MS) count += 1;
	}
	return count;
}

async function latestMtime(dir: string): Promise<number | undefined> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	let latest: number | undefined;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const stat = await fs.stat(path.join(dir, entry));
		latest = latest === undefined ? stat.mtimeMs : Math.max(latest, stat.mtimeMs);
	}
	return latest;
}

export function renderText(report: DoctorReport): string {
	const lines = [
		"Memory subsystem:",
		report.memory.error ? `  error: ${report.memory.error}` : indent(report.memory.text ?? "ok"),
		"Metrics availability:",
		`  registered: ${report.metrics.registered}`,
		`  observability sink: ${report.metrics.observabilityPath}`,
		`  recent session JSONL: ${report.metrics.recentJsonl ? "yes" : "no"} (${report.metrics.recentJsonlCount})`,
		"Rules engine:",
		`  loaded: ${report.rules.loaded}`,
		report.rules.error
			? `  error: ${report.rules.error}`
			: `  throwing rules: ${report.rules.throwingRuleIds.length > 0 ? report.rules.throwingRuleIds.join(", ") : "none"}`,
		"Observability sink:",
		`  path: ${report.observability.path}`,
		`  writable: ${report.observability.writable ? "yes" : "no"}`,
		report.observability.lastFlushTs === undefined
			? "  last flush: none"
			: `  last flush: ${new Date(report.observability.lastFlushTs).toISOString()}`,
		report.observability.error ? `  error: ${report.observability.error}` : undefined,
		`Status: ${report.status}`,
	];
	return `${lines.filter(line => line !== undefined).join("\n")}\n`;
}

function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map(line => `  ${line}`)
		.join("\n");
}

function aggregateStatus(statuses: DoctorStatus[]): DoctorStatus {
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("degraded")) return "degraded";
	return "ok";
}

function resolveObservabilityDir(opts: DoctorCommandOptions): string {
	return (
		opts.observabilityDir ??
		process.env.AMAZE_OBSERVABILITY_DIR ??
		path.join(process.env.HOME || homedir(), ".amaze", "observability")
	);
}

function smokeEvents(): SessionEvent[] {
	const ts = Date.now();
	return [
		{ type: "session.start", sessionId: "doctor-smoke", ts, cwd: process.cwd(), agent: "doctor" },
		{ type: "turn.start", sessionId: "doctor-smoke", ts: ts + 1, turn: 1 },
		{ type: "tool.call", sessionId: "doctor-smoke", ts: ts + 2, tool: "doctor", argsHash: "smoke" },
		{ type: "tool.result", sessionId: "doctor-smoke", ts: ts + 3, tool: "doctor", ok: true, durationMs: 1 },
		{ type: "turn.end", sessionId: "doctor-smoke", ts: ts + 4, turn: 1, usage: { total: 1 } },
	];
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
