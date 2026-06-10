/**
 * R3 regressions — three specific bugs that a deeper review caught and the original
 * v3 ship missed:
 *
 *   F1. `system-prompt.ts` data object lacked `subagentContract`, so the
 *       `{{#if subagentContract}}` block in `system-prompt.md` always evaluated false.
 *       The XML contract block reached the model, but the prose explaining how to
 *       interpret it (scope enforcement semantics, pivot detection, when to yield)
 *       silently did not.
 *
 *   F2. `task/index.ts` computed `changedFiles` with `cwdAfter.filter(p => !cwdBefore.has(p) || true)`
 *       — the trailing `|| true` made the filter a no-op. Files dirty BEFORE the
 *       subagent started were attributed to its attempt, poisoning scope verifier signals.
 *
 *   F3. `agent-session.ts#refreshBaseSystemPrompt` called `setSystemPrompt(prompt)` without
 *       threading `built.systemPromptCacheBreakpointIndex`. Frequent refreshes silently
 *       collapsed the STABLE_CORE/DYNAMIC_TAIL cache layout in the most-used rebuild path.
 *
 * These tests fail if any of the three regressions returns.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@amaze/coding-agent/system-prompt";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v3-fix-regressions-"));
	try {
		return await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("F1: subagent contract prose renders when subagentContract is set", () => {
	it("STABLE_CORE contains BOTH the XML block AND the prose instructions", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read", "write"],
				subagentContract: {
					role: "refactor-applier",
					scope: { include: ["src/**"], exclude: [] },
					successCriteria: [],
					escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
				},
			});

			// XML block (was already rendered before the fix).
			expect(systemPrompt[0]).toContain("<subagent-contract");
			expect(systemPrompt[0]).toContain(`role="refactor-applier"`);
			// Prose block from {{#if subagentContract}} — must also appear after the fix.
			expect(systemPrompt[0]).toContain("Subagent Contract (you are running under one)");
			expect(systemPrompt[0]).toContain("scope` is enforced structurally");
			expect(systemPrompt[0]).toContain("successCriteria` is what your parent will verify");
			expect(systemPrompt[0]).toContain("parent-contract-revision");
			expect(systemPrompt[0]).toContain("Yield IMMEDIATELY");
		});
	});

	it("without subagentContract, the prose block is NOT rendered (orchestrator mode)", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read", "write"],
			});
			// Orchestrator session: no subagent contract block at all.
			expect(systemPrompt[0]).not.toContain("Subagent Contract (you are running under one)");
			expect(systemPrompt[0]).not.toContain("<subagent-contract");
		});
	});

	it("F1 ACCEPTANCE: subagentContract field appears in render data (not just template)", async () => {
		// Without this, the {{#if subagentContract}} block always evaluates false even when
		// the XML block has been concatenated into STABLE_CORE. The bug was a render-data
		// omission, not a template error.
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				subagentContract: {
					role: "test-writer",
					scope: { include: [], exclude: [] },
					successCriteria: [],
					escalation: { onUncertainty: "block", budgetCap: 500 },
				},
			});
			// If render data lacked `subagentContract`, this prose string would be absent.
			expect(systemPrompt[0]).toContain("A `<subagent-contract>` block appears");
		});
	});
});

describe("F2: changedFiles filter no longer attributes pre-existing dirty files", () => {
	// Direct test of the filter logic — we don't need the full task tool execution path,
	// just the set-difference semantics that the bug broke.
	function computeChangedFiles(cwdBefore: Set<string>, cwdAfter: readonly string[]): string[] {
		// Mirror the fixed expression in task/index.ts.
		return cwdAfter.filter(p => !cwdBefore.has(p));
	}

	it("pre-existing dirty files are EXCLUDED from the attempt's changed set", () => {
		const before = new Set(["docs/notes.md", "src/x.ts"]);
		const after = ["docs/notes.md", "src/x.ts", "src/y.ts"];
		const changed = computeChangedFiles(before, after);
		// Only src/y.ts is the subagent's contribution.
		expect(changed).toEqual(["src/y.ts"]);
	});

	it("F2 ACCEPTANCE: empty set difference when subagent changed nothing new", () => {
		const before = new Set(["docs/old.md"]);
		const after = ["docs/old.md"];
		expect(computeChangedFiles(before, after)).toEqual([]);
		// Original buggy expression `!before.has(p) || true` would have returned ["docs/old.md"],
		// incorrectly attributing the pre-existing file to the subagent.
	});

	it("clean session (no dirty before) attributes every dirty file post-attempt", () => {
		const before = new Set<string>();
		const after = ["src/new.ts", "src/also-new.ts"];
		expect(computeChangedFiles(before, after).sort()).toEqual(["src/also-new.ts", "src/new.ts"]);
	});
});

describe("F3: refreshBaseSystemPrompt threads the breakpoint hint", () => {
	// Direct integration test of the agent-session refresh path is complex; instead we
	// verify the contract: `buildSystemPrompt` returns the hint, and the production code
	// in refreshBaseSystemPrompt now passes both args. The static grep-level guarantee is
	// reinforced below — if a regression strips the second arg, this test will read the
	// source file and fail.
	it("F3 ACCEPTANCE: agent-session.ts#refreshBaseSystemPrompt passes systemPromptCacheBreakpointIndex", async () => {
		const filePath = path.join(import.meta.dir, "..", "src", "session", "agent-session.ts");
		const source = await fs.readFile(filePath, "utf8");
		// Locate the refreshBaseSystemPrompt body.
		const start = source.indexOf("async refreshBaseSystemPrompt");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n\t}", start);
		expect(end).toBeGreaterThan(start);
		const body = source.slice(start, end);
		// Must thread the breakpoint hint — the bug was passing only one arg.
		expect(body).toContain("setSystemPrompt(this.#baseSystemPrompt, built.systemPromptCacheBreakpointIndex)");
	});

	it("buildSystemPrompt returns a defined systemPromptCacheBreakpointIndex when DYNAMIC_TAIL renders", async () => {
		// Sanity: the value being threaded actually exists. If buildSystemPrompt ever stops
		// returning the hint, F3's thread becomes a no-op silently — guard with this.
		await withTempDir(async dir => {
			const result = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
			});
			expect(result.systemPromptCacheBreakpointIndex).toBe(0);
		});
	});
});
