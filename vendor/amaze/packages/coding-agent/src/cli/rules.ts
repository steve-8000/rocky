import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { getPackageDir } from "../config";
import type { SessionEvent } from "../observability";
import { evaluateRule } from "../rules/evaluator";
import { type LoadedRule, loadRules } from "../rules/loader";
import { parseRuleMarkdown } from "../rules/parser";

export interface RulesCommandOptions {
	builtinDir?: string;
	userDir?: string;
	projectDir?: string;
	observabilityDir?: string;
}

export interface RulesShowArgs extends RulesCommandOptions {
	id: string;
}

export interface RulesRunArgs extends RulesCommandOptions {
	since?: number;
}

export async function runRulesListCommand(args: RulesCommandOptions = {}): Promise<void> {
	const rules = await loadConfiguredRules(args);
	for (const loaded of rules) {
		process.stdout.write(`${loaded.rule.id}\t${loaded.source}\t${loaded.rule.severity}\n`);
	}
}

export async function runRulesShowCommand(args: RulesShowArgs): Promise<void> {
	const loaded = (await loadConfiguredRules(args)).find(candidate => candidate.rule.id === args.id);
	if (!loaded) throw new Error(`Rule not found: ${args.id}`);
	process.stdout.write(renderRule(loaded));
}

export async function runRulesRunCommand(args: RulesRunArgs = {}): Promise<void> {
	const [rules, events] = await Promise.all([loadConfiguredRules(args), readSessionEvents(args)]);
	for (const loaded of rules) {
		const finding = evaluateRule(loaded.rule, events);
		if (finding) process.stdout.write(`${JSON.stringify(finding)}\n`);
	}
}

export async function runRulesLintCommand(filePath: string): Promise<void> {
	try {
		const rule = parseRuleMarkdown(await fs.readFile(filePath, "utf8"));
		process.stdout.write(`ok\t${rule.id}\n`);
	} catch (error) {
		process.stdout.write(`error\t${error instanceof Error ? error.message : String(error)}\n`);
		throw error;
	}
}

export async function runRulesApproveCommand(filePath: string): Promise<void> {
	const text = await fs.readFile(filePath, "utf8");
	parseRuleMarkdown(text);
	const hash = createHash("sha256").update(text).digest("hex");
	const trusted = await readTrustedHashes();
	trusted.add(hash);
	await writeTrustedHashes(trusted);
	process.stdout.write(`approved\t${hash}\t${filePath}\n`);
}

function renderRule(loaded: LoadedRule): string {
	return [
		`${loaded.rule.id}\t${loaded.source}\t${loaded.rule.severity}`,
		"",
		"# Description",
		loaded.rule.description,
		"",
		"# Examples",
		loaded.rule.examples,
		"",
		"```detect",
		JSON.stringify(loaded.rule.detect, null, 2),
		"```",
		"",
	].join("\n");
}

async function loadConfiguredRules(args: RulesCommandOptions): Promise<LoadedRule[]> {
	return loadRules({
		builtinDir:
			args.builtinDir ??
			process.env.AMAZE_RULES_BUILTIN_DIR ??
			path.join(getPackageDir(), "src", "rules", "builtin"),
		userDir:
			args.userDir ??
			process.env.AMAZE_RULES_USER_DIR ??
			path.join(process.env.HOME || homedir(), ".amaze", "rules"),
		projectDir: args.projectDir ?? process.env.AMAZE_RULES_PROJECT_DIR ?? path.join(process.cwd(), ".amaze", "rules"),
	});
}

async function readSessionEvents(args: RulesRunArgs): Promise<SessionEvent[]> {
	const sessionsDir = path.join(
		args.observabilityDir ??
			process.env.AMAZE_OBSERVABILITY_DIR ??
			path.join(process.env.HOME || homedir(), ".amaze", "observability"),
		"sessions",
	);
	let entries: string[];
	try {
		entries = await fs.readdir(sessionsDir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const events: SessionEvent[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".jsonl")) continue;
		const text = await fs.readFile(path.join(sessionsDir, entry), "utf8");
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue;
			const event = JSON.parse(line) as SessionEvent;
			if (args.since !== undefined && event.ts < args.since) continue;
			events.push(event);
		}
	}
	return events.sort((a, b) => a.ts - b.ts);
}

async function readTrustedHashes(): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await fs.readFile(trustedPath(), "utf8")) as { hashes?: unknown };
		return new Set(Array.isArray(parsed.hashes) ? parsed.hashes.filter(hash => typeof hash === "string") : []);
	} catch (error) {
		if (isNotFound(error)) return new Set();
		throw error;
	}
}

async function writeTrustedHashes(hashes: Set<string>): Promise<void> {
	const filePath = trustedPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify({ hashes: [...hashes].sort() }, null, 2)}\n`, "utf8");
}

function trustedPath(): string {
	return path.join(process.env.HOME || homedir(), ".amaze", "rules", ".trusted.json");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
