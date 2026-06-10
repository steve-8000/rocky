import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseRuleMarkdown } from "./parser";
import type { Rule, RuleDetect } from "./types";

export interface LoadedRule {
	rule: Rule;
	source: "builtin" | "personal" | "project";
	hash: string;
	path: string;
}

export interface LoadRulesOptions {
	builtinDir: string;
	userDir?: string;
	projectDir?: string;
	approve?: (path: string, hash: string) => Promise<boolean>;
}

interface TrustStore {
	hashes?: string[];
}

const TRUSTED_PATH = join(homedir(), ".amaze", "rules", ".trusted.json");

export async function loadRules(opts: LoadRulesOptions): Promise<LoadedRule[]> {
	const trusted = await readTrustedHashes();
	let trustChanged = false;
	const loaded: LoadedRule[] = [];

	loaded.push(...(await loadDirectory(opts.builtinDir, "builtin", async () => true)));

	if (opts.userDir) {
		loaded.push(
			...(await loadDirectory(opts.userDir, "personal", async (path, hash) => {
				const approved = await isTrustedOrApproved(path, hash, trusted, opts.approve);
				trustChanged ||= approved && !trusted.has(hash);
				if (approved) trusted.add(hash);
				return approved;
			})),
		);
	}

	if (opts.projectDir) {
		loaded.push(
			...(await loadDirectory(opts.projectDir, "project", async (path, hash) => {
				const approved = await isTrustedOrApproved(path, hash, trusted, opts.approve);
				trustChanged ||= approved && !trusted.has(hash);
				if (approved) trusted.add(hash);
				return approved;
			})),
		);
	}

	if (trustChanged) await writeTrustedHashes(trusted);

	return resolveInheritance(loaded);
}

async function loadDirectory(
	dir: string,
	source: LoadedRule["source"],
	allowed: (path: string, hash: string) => Promise<boolean>,
): Promise<LoadedRule[]> {
	const paths = await rulePaths(dir);
	const rules: LoadedRule[] = [];

	for (const path of paths) {
		const text = await readFile(path, "utf8");
		const hash = sha256(text);
		if (!(await allowed(path, hash))) continue;
		rules.push({ rule: parseRuleMarkdown(text), source, hash, path });
	}

	return rules;
}

async function rulePaths(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map(entry => {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) return rulePaths(path);
				return entry.isFile() && entry.name.endsWith(".rule.md") ? [path] : [];
			}),
		);
		return nested.flat().sort();
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

async function isTrustedOrApproved(
	path: string,
	hash: string,
	trusted: Set<string>,
	approve: LoadRulesOptions["approve"],
): Promise<boolean> {
	if (trusted.has(hash)) return true;
	return approve ? approve(path, hash) : false;
}

async function readTrustedHashes(): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await readFile(TRUSTED_PATH, "utf8")) as TrustStore;
		return new Set(Array.isArray(parsed.hashes) ? parsed.hashes.filter(hash => typeof hash === "string") : []);
	} catch (error) {
		if (isNotFound(error)) return new Set();
		throw error;
	}
}

async function writeTrustedHashes(hashes: Set<string>): Promise<void> {
	await mkdir(dirname(TRUSTED_PATH), { recursive: true });
	await writeFile(TRUSTED_PATH, `${JSON.stringify({ hashes: [...hashes].sort() }, null, 2)}\n`, "utf8");
}

function resolveInheritance(rules: LoadedRule[]): LoadedRule[] {
	const byId = new Map(rules.map(loaded => [loaded.rule.id, loaded.rule]));
	const resolved = new Map<string, Rule>();

	return rules.map(loaded => ({ ...loaded, rule: resolveRule(loaded.rule, byId, resolved, []) }));
}

function resolveRule(rule: Rule, byId: Map<string, Rule>, resolved: Map<string, Rule>, stack: string[]): Rule {
	const existing = resolved.get(rule.id);
	if (existing) return existing;
	if (stack.includes(rule.id)) throw new Error(`Rule inheritance cycle: ${[...stack, rule.id].join(" -> ")}`);

	const inherited = (rule.inherits ?? []).map(id => {
		const parent = byId.get(id);
		if (!parent) throw new Error(`Rule ${rule.id} inherits unknown rule ${id}`);
		return resolveRule(parent, byId, resolved, [...stack, rule.id]);
	});

	const merged = inherited.reduce((current, parent) => mergeRule(parent, current), rule);
	resolved.set(rule.id, merged);
	return merged;
}

function mergeRule(parent: Rule, child: Rule): Rule {
	return {
		...child,
		detect: mergeDetect(parent.detect, child.detect),
	};
}

function mergeDetect(parent: RuleDetect, child: RuleDetect): RuleDetect {
	return {
		...parent,
		...child,
		thresholds: { ...(parent.thresholds ?? {}), ...(child.thresholds ?? {}) },
	};
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
