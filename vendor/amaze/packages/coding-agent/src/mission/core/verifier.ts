/**
 * AcceptanceVerifier — Primitive A of the v3 team coordination layer.
 *
 * Verifies whether a candidate completion (a set of changed files plus optional command
 * outcomes) satisfies a list of `AcceptanceCriterion`s. Backends are intentionally simple
 * and composable: scope (glob membership), file existence, command exit code, and a manual
 * placeholder that always returns `uncertain` so closing audits surface human-judged items.
 *
 * Design contract:
 *   - `verify` MUST be deterministic for deterministic backends. The same input MUST
 *     produce byte-identical output so callers can cache safely.
 *   - `verify` MUST NOT mutate state. Side effects (shell exec) are scoped to the call
 *     itself; nothing persists.
 *   - Verdicts have two summarization modes. In `audit` mode, `uncertain` does not
 *     block completion; only `fail` blocks. Runtime uses this for
 *     `goal.uncertainPolicy === "allow"` and for `"warn"` after emitting warning events.
 *     In `contract` mode, criteria whose blocking policy is `uncertain-blocks` treat
 *     `uncertain` as a fail. Runtime uses this for `"block-manual"` (force-complete
 *     remains available) and `"block-all"` (no force-complete path).
 *   - Confidence is reported as 0..1. Deterministic backends report 1.0 on a clean
 *     check, lower on ambiguous data (e.g. glob match against zero files).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { procmgr } from "@amaze/utils";
import { Glob } from "bun";
import { settings } from "../../config/settings";

export type CriterionStatus = "pass" | "fail" | "uncertain";

/** Discriminated union of supported check kinds. Add new backends here. */
export type CriterionKind =
	| { type: "scope-include"; globs: string[] }
	| { type: "scope-exclude"; globs: string[] }
	| { type: "file-exists"; path: string }
	| { type: "command-exit"; argv?: string[]; command?: string; expected: number; cwd?: string; timeoutMs?: number }
	/**
	 * Tool-driven richer check: run a command and assert patterns against its output.
	 * `stdoutPattern` / `stderrPattern` MUST match (regex strings); `mustNotMatch` patterns
	 * MUST NOT appear. `expected` exit code defaults to 0. Useful for "all tests pass" /
	 * "0 lint warnings" / "build succeeded" criteria where exit code alone is too loose.
	 */
	| {
			type: "command-output";
			command?: string;
			argv?: string[];
			expected?: number;
			cwd?: string;
			timeoutMs?: number;
			stdoutPattern?: string;
			stderrPattern?: string;
			mustNotMatch?: string[];
	  }
	/**
	 * LSP-driven check: queries a diagnostics provider for the given file (or workspace when
	 * omitted). Passes when no `severity: "error"` diagnostics are present. Returns `uncertain`
	 * when no `lspDiagnostics` provider is configured on the context — distinguishes "LSP says
	 * clean" from "LSP wasn't asked".
	 */
	| { type: "lsp-clean"; file?: string; maxWarnings?: number }
	/**
	 * LLM-judged check: a question + candidate combination passed to an isolated mini-agent.
	 * The mini-agent returns pass/fail/uncertain + evidence. Backend looks up the runner in
	 * `VerificationContext.llmJudge`; when unset, returns `uncertain` (NULL implementation).
	 * Real LLM wiring is a follow-up — the interface is the seam.
	 */
	| { type: "llm-judged"; question: string; candidate: string }
	| { type: "manual"; description: string };

export interface AcceptanceCriterion {
	id: string;
	description: string;
	check: CriterionKind;
	blocking?: "fail-only" | "uncertain-blocks";
}

export function defaultBlockingPolicy(criterion: AcceptanceCriterion): "fail-only" | "uncertain-blocks" {
	switch (criterion.check.type) {
		case "scope-include":
		case "lsp-clean":
		case "llm-judged":
			return "uncertain-blocks";
		default:
			return "fail-only";
	}
}

/**
 * LSP diagnostic shape consumed by `lsp-clean` criteria. Aligned with the
 * minimal subset needed by the verifier; richer LSP fields (range, code, source)
 * are surfaced through `evidence` strings when present.
 */
export interface LspDiagnostic {
	file: string;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	line?: number;
}

/**
 * Pluggable LLM runner for `llm-judged` criteria. Implementations:
 *
 *   - **NULL** (default when unset): the criterion returns `uncertain` with explanation.
 *     No call goes out, no cost incurred. Closing audit treats it like manual review.
 *   - **DeterministicTestRunner**: in-process, returns scripted verdicts. Used by tests
 *     to lock the verifier path without flaky LLM calls.
 *   - **Production**: wires a real Claude session with minimal tool set (read, search).
 *     Implementation lives in follow-up work; this interface is the seam.
 */
export interface LlmJudgeRunner {
	judge(prompt: { question: string; candidate: string }): Promise<{
		status: CriterionStatus;
		evidence: string;
		confidence: number;
		tokensUsed?: number;
	}>;
}

export interface VerificationContext {
	/** Working directory for file-exists and command-exit checks. */
	cwd: string;
	/**
	 * Files that the candidate completion claims to have changed. The verifier compares
	 * against this list — it does NOT compute its own diff. Callers (e.g. closing audit)
	 * gather this via `git diff --name-only` or session tracking and pass it in.
	 */
	changedFiles: string[];
	/**
	 * Optional LSP diagnostics provider for `lsp-clean` criteria. When omitted, lsp-clean
	 * returns `uncertain` rather than asserting a clean tree it didn't actually check.
	 */
	lspDiagnostics?: (file: string | undefined) => Promise<LspDiagnostic[]>;
	/**
	 * Optional LLM judge for `llm-judged` criteria. When omitted, llm-judged returns
	 * `uncertain` — never silently assumes a verdict the model wasn't asked to provide.
	 */
	llmJudge?: LlmJudgeRunner;
}

export interface CriterionResult {
	id: string;
	description: string;
	status: CriterionStatus;
	/** Human-readable explanation of how the verdict was reached. Always populated. */
	evidence: string;
	/** 0..1. Deterministic checks report 1.0. Reserved for future llm-judged backend. */
	confidence: number;
}

/**
 * Match a path against a list of globs (Bun's matcher). Returns true on first match.
 * Empty glob list returns false (no criteria == no match).
 */
function matchesAnyGlob(filePath: string, globs: string[]): boolean {
	if (globs.length === 0) return false;
	const normalized = filePath.replace(/\\/g, "/");
	for (const pattern of globs) {
		const glob = new Glob(pattern);
		if (glob.match(normalized)) return true;
	}
	return false;
}

/** Truncate evidence strings to keep tool output reasonable. */
function truncateForEvidence(text: string, maxLength = 400): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}... (truncated)`;
}

type CommandCheck = Extract<CriterionKind, { type: "command-exit" | "command-output" }>;

function shellCriteriaEnabled(): boolean {
	try {
		return settings.get("verifier.allowShellCriteria");
	} catch {
		return false;
	}
}

function resolveCommandArgv(check: CommandCheck): string[] | undefined {
	if (check.argv) return check.argv;
	if (!check.command) return undefined;
	if (!shellCriteriaEnabled()) return undefined;
	return ["sh", "-c", check.command];
}

function commandDescription(check: CommandCheck): string {
	return check.argv ? check.argv.join(" ") : (check.command ?? "(missing command)");
}

async function checkScopeInclude(
	criterion: AcceptanceCriterion & { check: { type: "scope-include" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	const { globs } = criterion.check;
	if (ctx.changedFiles.length === 0) {
		// No changes at all — can't verify that they were "in scope". Uncertain, not fail:
		// the closing audit may legitimately fire on a goal whose only deliverable is a
		// command-exit check (e.g. "tests pass") with no file edits.
		return {
			id: criterion.id,
			description: criterion.description,
			status: "uncertain",
			evidence: "No changed files to evaluate against scope-include globs.",
			confidence: 0.5,
		};
	}
	const violators = ctx.changedFiles.filter(f => !matchesAnyGlob(f, globs));
	if (violators.length === 0) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "pass",
			evidence: `All ${ctx.changedFiles.length} changed file(s) match include globs: ${globs.join(", ")}`,
			confidence: 1.0,
		};
	}
	return {
		id: criterion.id,
		description: criterion.description,
		status: "fail",
		evidence: truncateForEvidence(
			`${violators.length} file(s) outside include globs [${globs.join(", ")}]: ${violators.join(", ")}`,
		),
		confidence: 1.0,
	};
}

async function checkScopeExclude(
	criterion: AcceptanceCriterion & { check: { type: "scope-exclude" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	const { globs } = criterion.check;
	const violators = ctx.changedFiles.filter(f => matchesAnyGlob(f, globs));
	if (violators.length === 0) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "pass",
			evidence:
				ctx.changedFiles.length === 0
					? "No changes at all; trivially respects exclude globs."
					: `No changed file matches exclude globs: ${globs.join(", ")}`,
			confidence: 1.0,
		};
	}
	return {
		id: criterion.id,
		description: criterion.description,
		status: "fail",
		evidence: truncateForEvidence(
			`${violators.length} file(s) hit exclude globs [${globs.join(", ")}]: ${violators.join(", ")}`,
		),
		confidence: 1.0,
	};
}

async function checkFileExists(
	criterion: AcceptanceCriterion & { check: { type: "file-exists" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	const targetPath = path.isAbsolute(criterion.check.path)
		? criterion.check.path
		: path.join(ctx.cwd, criterion.check.path);
	const file = Bun.file(targetPath);
	const exists = await file.exists();
	return {
		id: criterion.id,
		description: criterion.description,
		status: exists ? "pass" : "fail",
		evidence: exists ? `File present at ${targetPath}` : `File missing at ${targetPath}`,
		confidence: 1.0,
	};
}

async function checkCommandExit(
	criterion: AcceptanceCriterion & { check: { type: "command-exit" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	const { expected, cwd, timeoutMs } = criterion.check;
	const workdir = cwd ?? ctx.cwd;
	const argv = resolveCommandArgv(criterion.check);
	if (!argv) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: criterion.check.command ? "shell criteria disabled by policy" : "Command criterion is missing argv.",
			confidence: 1.0,
		};
	}
	const controller = new AbortController();
	const timeout = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
	try {
		const proc = Bun.spawn(argv, {
			cwd: workdir,
			env: procmgr.scrubProcessEnv(Bun.env),
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const matched = exitCode === expected;
		return {
			id: criterion.id,
			description: criterion.description,
			status: matched ? "pass" : "fail",
			evidence: matched
				? `Exit code ${exitCode} matched expected ${expected}.`
				: truncateForEvidence(
						`Exit code ${exitCode} != expected ${expected}. stderr: ${stderr.trim() || "(empty)"} stdout tail: ${stdout.trim().slice(-200) || "(empty)"}`,
					),
			confidence: 1.0,
		};
	} catch (error) {
		const aborted = controller.signal.aborted;
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: aborted
				? `Command timed out after ${timeoutMs}ms: ${commandDescription(criterion.check)}`
				: `Command failed to run: ${String(error)}`,
			confidence: 1.0,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function checkCommandOutput(
	criterion: AcceptanceCriterion & { check: { type: "command-output" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	const { expected = 0, cwd, timeoutMs, stdoutPattern, stderrPattern, mustNotMatch } = criterion.check;
	const workdir = cwd ?? ctx.cwd;
	const argv = resolveCommandArgv(criterion.check);
	if (!argv) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: criterion.check.command ? "shell criteria disabled by policy" : "Command criterion is missing argv.",
			confidence: 1.0,
		};
	}
	const controller = new AbortController();
	const timeout = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
	try {
		const proc = Bun.spawn(argv, {
			cwd: workdir,
			env: procmgr.scrubProcessEnv(Bun.env),
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		// Validate each constraint in declaration order so the first failure gets surfaced
		// with the most specific reason. Exit code is checked first because it's the broadest
		// signal (a nonzero exit usually invalidates stdout/stderr semantics anyway).
		if (exitCode !== expected) {
			return {
				id: criterion.id,
				description: criterion.description,
				status: "fail",
				evidence: truncateForEvidence(
					`Exit code ${exitCode} != expected ${expected}. stderr: ${stderr.trim() || "(empty)"} stdout tail: ${stdout.trim().slice(-200) || "(empty)"}`,
				),
				confidence: 1.0,
			};
		}
		if (stdoutPattern) {
			const re = new RegExp(stdoutPattern);
			if (!re.test(stdout)) {
				return {
					id: criterion.id,
					description: criterion.description,
					status: "fail",
					evidence: truncateForEvidence(
						`stdout did NOT match /${stdoutPattern}/. stdout: ${stdout.slice(0, 300)}`,
					),
					confidence: 1.0,
				};
			}
		}
		if (stderrPattern) {
			const re = new RegExp(stderrPattern);
			if (!re.test(stderr)) {
				return {
					id: criterion.id,
					description: criterion.description,
					status: "fail",
					evidence: truncateForEvidence(
						`stderr did NOT match /${stderrPattern}/. stderr: ${stderr.slice(0, 300)}`,
					),
					confidence: 1.0,
				};
			}
		}
		if (mustNotMatch) {
			for (const pattern of mustNotMatch) {
				const re = new RegExp(pattern);
				if (re.test(stdout) || re.test(stderr)) {
					return {
						id: criterion.id,
						description: criterion.description,
						status: "fail",
						evidence: truncateForEvidence(
							`forbidden pattern /${pattern}/ appeared in output. combined: ${(stdout + stderr).slice(0, 300)}`,
						),
						confidence: 1.0,
					};
				}
			}
		}
		return {
			id: criterion.id,
			description: criterion.description,
			status: "pass",
			evidence: `Exit code ${exitCode} matched expected; all output patterns satisfied.`,
			confidence: 1.0,
		};
	} catch (error) {
		const aborted = controller.signal.aborted;
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: aborted
				? `Command timed out after ${timeoutMs}ms: ${commandDescription(criterion.check)}`
				: `Command failed: ${String(error)}`,
			confidence: 1.0,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function checkLspClean(
	criterion: AcceptanceCriterion & { check: { type: "lsp-clean" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	if (!ctx.lspDiagnostics) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "uncertain",
			evidence: "No LSP diagnostics provider configured on the verification context.",
			confidence: 0.0,
		};
	}
	const { file, maxWarnings } = criterion.check;
	let diagnostics: LspDiagnostic[];
	try {
		diagnostics = await ctx.lspDiagnostics(file);
	} catch (error) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: `LSP provider threw: ${String(error)}`,
			confidence: 1.0,
		};
	}
	const errors = diagnostics.filter(d => d.severity === "error");
	if (errors.length > 0) {
		const sample = errors
			.slice(0, 3)
			.map(d => `${d.file}${d.line ? `:${d.line}` : ""} ${d.message}`)
			.join(" | ");
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: truncateForEvidence(`${errors.length} LSP error(s): ${sample}`),
			confidence: 1.0,
		};
	}
	const warnings = diagnostics.filter(d => d.severity === "warning");
	if (maxWarnings !== undefined && warnings.length > maxWarnings) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: `${warnings.length} warnings exceed maxWarnings=${maxWarnings}`,
			confidence: 1.0,
		};
	}
	return {
		id: criterion.id,
		description: criterion.description,
		status: "pass",
		evidence: `LSP clean: 0 errors${maxWarnings !== undefined ? `, ${warnings.length} warnings (cap ${maxWarnings})` : ""}.`,
		confidence: 1.0,
	};
}

async function checkLlmJudged(
	criterion: AcceptanceCriterion & { check: { type: "llm-judged" } },
	ctx: VerificationContext,
): Promise<CriterionResult> {
	if (!ctx.llmJudge) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "uncertain",
			evidence: "No LLM judge runner configured. Wire `VerificationContext.llmJudge` to enable this criterion.",
			confidence: 0.0,
		};
	}
	try {
		const verdict = await ctx.llmJudge.judge({
			question: criterion.check.question,
			candidate: criterion.check.candidate,
		});
		return {
			id: criterion.id,
			description: criterion.description,
			status: verdict.status,
			evidence: truncateForEvidence(
				verdict.tokensUsed !== undefined
					? `${verdict.evidence} (cost: ${verdict.tokensUsed} tokens)`
					: verdict.evidence,
			),
			confidence: verdict.confidence,
		};
	} catch (error) {
		return {
			id: criterion.id,
			description: criterion.description,
			status: "fail",
			evidence: `LLM judge threw: ${String(error)}`,
			confidence: 1.0,
		};
	}
}

function checkManual(criterion: AcceptanceCriterion & { check: { type: "manual" } }): CriterionResult {
	// Manual criteria are placeholders for human judgement. They always return uncertain
	// so closing audit surfaces them without blocking. Operator decides via force override
	// or by replacing the criterion with a verifiable backend.
	return {
		id: criterion.id,
		description: criterion.description,
		status: "uncertain",
		evidence: `Manual check: ${criterion.check.description}`,
		confidence: 0.0,
	};
}

/**
 * Optional cache layer for Verifier results. Key = stable hash of (criterion + ctx-sketch +
 * file mtime snapshot of any path mentioned in the criterion). Invalidates automatically
 * when a referenced file's mtime advances — agnostic to which backend produced the result.
 *
 * Design choices:
 *   - In-memory only. Persistent cache across restarts would risk staleness (file edits
 *     made outside the agent loop wouldn't invalidate) and the cache values are cheap to
 *     regenerate within a session.
 *   - mtime-based invalidation, NOT content-hash: cheaper, and false-positive
 *     invalidation (mtime touched but content same) is fine — we just re-run a check
 *     that would have passed anyway.
 *   - LRU bound via `maxEntries`: prevents unbounded growth on long sessions.
 */
export class VerifierResultCache {
	readonly #entries = new Map<string, { result: CriterionResult; mtimeSnapshot: string }>();
	readonly #maxEntries: number;

	constructor(maxEntries = 256) {
		this.#maxEntries = maxEntries;
	}

	/** Compute the stable cache key for a (criterion, ctx) pair. */
	keyFor(criterion: AcceptanceCriterion, ctx: VerificationContext): string {
		const hash = createHash("sha256");
		hash.update(JSON.stringify({ id: criterion.id, check: criterion.check }));
		hash.update("");
		hash.update(ctx.cwd);
		hash.update("");
		// Sort changedFiles so caller's iteration order does not perturb the key.
		hash.update([...ctx.changedFiles].sort().join(""));
		return hash.digest("hex");
	}

	/**
	 * Look up a cached result, returning undefined if absent OR if the mtime snapshot of
	 * referenced files has changed. Referenced files are derived from the criterion's check
	 * (file-exists path, command-output cwd, lsp-clean file, etc.) plus the ctx.changedFiles
	 * — anything that affects what the backend would observe.
	 */
	async get(criterion: AcceptanceCriterion, ctx: VerificationContext): Promise<CriterionResult | undefined> {
		const key = this.keyFor(criterion, ctx);
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		const currentSnapshot = await this.#snapshotMtimes(criterion, ctx);
		if (currentSnapshot !== entry.mtimeSnapshot) {
			this.#entries.delete(key);
			return undefined;
		}
		// LRU touch: re-insert to move to the end.
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.result;
	}

	async set(criterion: AcceptanceCriterion, ctx: VerificationContext, result: CriterionResult): Promise<void> {
		const key = this.keyFor(criterion, ctx);
		const snapshot = await this.#snapshotMtimes(criterion, ctx);
		this.#entries.set(key, { result, mtimeSnapshot: snapshot });
		while (this.#entries.size > this.#maxEntries) {
			const first = this.#entries.keys().next();
			if (first.done) break;
			this.#entries.delete(first.value);
		}
	}

	clear(): void {
		this.#entries.clear();
	}

	/** Snapshot mtimes of every path that affects the criterion's outcome. */
	async #snapshotMtimes(criterion: AcceptanceCriterion, ctx: VerificationContext): Promise<string> {
		const paths = new Set<string>();
		for (const file of ctx.changedFiles) paths.add(path.isAbsolute(file) ? file : path.join(ctx.cwd, file));
		const check = criterion.check;
		if (check.type === "file-exists") {
			paths.add(path.isAbsolute(check.path) ? check.path : path.join(ctx.cwd, check.path));
		}
		if (check.type === "lsp-clean" && check.file) {
			paths.add(path.isAbsolute(check.file) ? check.file : path.join(ctx.cwd, check.file));
		}
		const sorted = [...paths].sort();
		const parts: string[] = [];
		for (const p of sorted) {
			try {
				const stat = await fs.stat(p);
				parts.push(`${p}:${stat.mtimeMs}`);
			} catch {
				parts.push(`${p}:missing`);
			}
		}
		return parts.join("|");
	}
}

export class AcceptanceVerifier {
	readonly #cache: VerifierResultCache | undefined;

	/**
	 * Construct with an optional cache. Without a cache, each `verify` call runs every
	 * backend from scratch (deterministic backends are cheap; tool-driven and llm-judged
	 * are not). With a cache, identical (criterion, ctx) pairs hit memory; file mtime
	 * advances invalidate automatically.
	 */
	constructor(options?: { cache?: VerifierResultCache }) {
		this.#cache = options?.cache;
	}

	async verify(criteria: AcceptanceCriterion[], ctx: VerificationContext): Promise<CriterionResult[]> {
		const results: CriterionResult[] = [];
		for (const criterion of criteria) {
			// Cache lookup: deterministic backends (scope-*, file-exists, manual) are fast
			// enough to skip caching for, but uniform caching keeps the dispatch simple AND
			// helps when the same criterion is verified repeatedly during a long subagent run.
			if (this.#cache) {
				const cached = await this.#cache.get(criterion, ctx);
				if (cached) {
					results.push(cached);
					continue;
				}
			}
			let result: CriterionResult;
			switch (criterion.check.type) {
				case "scope-include":
					result = await checkScopeInclude(criterion as never, ctx);
					break;
				case "scope-exclude":
					result = await checkScopeExclude(criterion as never, ctx);
					break;
				case "file-exists":
					result = await checkFileExists(criterion as never, ctx);
					break;
				case "command-exit":
					result = await checkCommandExit(criterion as never, ctx);
					break;
				case "command-output":
					result = await checkCommandOutput(criterion as never, ctx);
					break;
				case "lsp-clean":
					result = await checkLspClean(criterion as never, ctx);
					break;
				case "llm-judged":
					result = await checkLlmJudged(criterion as never, ctx);
					break;
				case "manual":
					result = checkManual(criterion as never);
					break;
			}
			if (this.#cache) {
				await this.#cache.set(criterion, ctx, result);
			}
			results.push(result);
		}
		return results;
	}
}

/**
 * Convenience: summarize verifier results into a verdict. In `mode: "audit"`,
 * `uncertain` results are counted and surfaced but do not block; only `fail`
 * blocks. In `mode: "contract"`, an `uncertain` result also counts as failing
 * when the matching criterion's blocking policy is `uncertain-blocks`.
 */
export interface VerificationVerdict {
	verdict: "pass" | "fail";
	failedCount: number;
	uncertainCount: number;
	passedCount: number;
	results: CriterionResult[];
}

export function summarize(
	results: CriterionResult[],
	criteria?: AcceptanceCriterion[],
	mode: "audit" | "contract" = "audit",
): VerificationVerdict {
	let failedCount = 0;
	let uncertainCount = 0;
	let passedCount = 0;
	const criteriaById = new Map(criteria?.map(criterion => [criterion.id, criterion]));
	for (const r of results) {
		if (r.status === "fail") failedCount++;
		else if (r.status === "uncertain") {
			uncertainCount++;
			const criterion = criteriaById.get(r.id);
			if (
				mode === "contract" &&
				criterion &&
				(criterion.blocking ?? defaultBlockingPolicy(criterion)) === "uncertain-blocks"
			) {
				failedCount++;
			}
		} else passedCount++;
	}
	return {
		verdict: failedCount > 0 ? "fail" : "pass",
		failedCount,
		uncertainCount,
		passedCount,
		results,
	};
}
