import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, INTENT_FIELD } from "@amaze/agent-core";
import { buildSystemPrompt, buildSystemPromptToolMetadata } from "@amaze/coding-agent/system-prompt";
import { prompt } from "@amaze/utils";
import Handlebars from "handlebars";
import * as z from "zod/v4";

const baseGitContext = {
	isRepo: true,
	currentBranch: "feature/tests",
	mainBranch: "main",
	status: "M packages/coding-agent/src/prompts/system/custom-system-prompt.md",
	commits: "abc123 Fix tests",
};

const systemPromptsDir = path.resolve(import.meta.dir, "../src/prompts/system");

const baseRenderContext: prompt.TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "alpha beta",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "Appendix instructions",
	arguments: "alpha beta",
	base: "Base system prompt",
	content: "Rule content",
	context: "Background context",
	contextFile: "/tmp/context.md",
	contextFiles: [{ path: "/tmp/context/a.md", content: "Alpha context" }],
	customPrompt: "Custom prompt body",
	cwd: "/tmp/amaze-issue-147",
	date: "2026-02-24",
	dateTime: "2026-02-24T12:00:00Z",
	editToolName: "edit",
	environment: [{ label: "OS", value: "Darwin" }],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	git: baseGitContext,
	intentField: INTENT_FIELD,
	intentTracing: true,
	iterative: true,
	maxRetries: 3,
	modifiedFiles: ["packages/coding-agent/src/config/prompt-templates.ts"],
	name: "rs-no-unwrap",
	path: "packages/coding-agent/src/config/prompt-templates.ts",
	planContent: "1. Read code\n2. Add tests",
	planExists: true,
	planFilePath: "local://PLAN.md",
	readFiles: ["packages/coding-agent/src/prompts/system/custom-system-prompt.md"],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Create an agent to review prompt templates",
	retryCount: 1,
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", globs: ["**/*.rs"] }],
	skills: [{ name: "system-prompts", description: "Prompt design skill" }],
	systemPromptCustomization: "System customization",
	toolInfo: [{ name: "read", label: "Read", description: "Reads files" }],
	toolRefs: {
		read: "read",
		search: "search",
		find: "find",
		edit: "edit",
		task: "task",
		web_search: "web_search",
		todo_write: "todo_write",
		todo_read: "todo_read",
		inspect_image: "inspect_image",
		search_tool_bm25: "search_tool_bm25",
		lsp: "lsp",
		ast_grep: "ast_grep",
		ast_edit: "ast_edit",
		grep: "grep",
		write: "write",
	},
	tools: ["read", "search", "find", "edit", "task", "web_search", "todo_write", "todo_read"],
	worktree: "/tmp/amaze-issue-147",
	writeToolName: "write",
};

async function loadSystemPromptTemplates(): Promise<Map<string, string>> {
	const templates = new Map<string, string>();
	const glob = new Bun.Glob("*.md");

	for await (const fileName of glob.scan({ cwd: systemPromptsDir, onlyFiles: true })) {
		const templatePath = path.join(systemPromptsDir, fileName);
		templates.set(fileName, await Bun.file(templatePath).text());
	}

	return templates;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	return text.split(needle).length - 1;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("system Handlebars prompt templates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("parses and compiles every system template", async () => {
		const templates = await loadSystemPromptTemplates();
		expect(templates.size).toBeGreaterThan(0);

		for (const [fileName, template] of templates) {
			expect(() => Handlebars.parse(template), `Failed parsing ${fileName}`).not.toThrow();
			expect(() => Handlebars.compile(template), `Failed compiling ${fileName}`).not.toThrow();
		}
	});

	test("custom-system-prompt renders project section for context and git combinations", async () => {
		const templatePath = path.join(systemPromptsDir, "custom-system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const both = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { ...baseGitContext, isRepo: true },
		});
		expect(both).toContain("<project>");
		expect(both).toContain("## Context");
		expect(both).toContain("## Version Control");

		const contextOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { isRepo: false },
		});
		expect(contextOnly).toContain("<project>");
		expect(contextOnly).toContain("## Context");
		expect(contextOnly).not.toContain("## Version Control");

		const gitOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: {
				isRepo: true,
				currentBranch: "feature/tests",
				mainBranch: "main",
				status: "clean",
				commits: "abc123 test commit",
			},
		});
		expect(gitOnly).toContain("<project>");
		expect(gitOnly).not.toContain("## Context");
		expect(gitOnly).toContain("## Version Control");

		const neither = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: { isRepo: false },
		});
		expect(neither).not.toContain("<project>");
		expect(neither).not.toContain("## Context");
		expect(neither).not.toContain("## Version Control");
	});

	test("subagent system owns shared context while user prompt only owns assignment", async () => {
		const systemTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-system-prompt.md")).text();
		const userTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-user-prompt.md")).text();

		const subagentSystem = prompt.render(systemTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			agent: "You are a task agent.",
		});
		const subagentUser = prompt.render(userTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			assignment: "Do the task.",
		});

		expect(subagentSystem).toContain("[CONTEXT]\nShared task background\n[/CONTEXT]");
		expect(subagentSystem).toContain("[ROLE]");
		expect(subagentUser).toContain("Complete the assignment below, thoroughly:");
		expect(subagentUser).toContain("Do the task.");
		expect(subagentUser).not.toContain("[CONTEXT]");
		expect(subagentUser).not.toContain("Shared task background");
	});
	test("system-prompt renders MCP discovery hint when enabled", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = prompt.render(template, {
			...baseRenderContext,
			mcpDiscoveryMode: true,
			hasMCPDiscoveryServers: true,
			mcpDiscoveryServerSummaries: ["github (2 tools)", "slack (1 tool)"],
		});

		expect(rendered).toContain("## Discovery");
		expect(rendered).toContain("Discoverable MCP servers in this session: github (2 tools), slack (1 tool).");
		expect(rendered).not.toContain("Example discoverable MCP tools:");
		expect(rendered).toContain("call `search_tool_bm25` to discover and activate it");
	});

	test("system-prompt renders parent orchestration guidance", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = prompt.render(template, {
			...baseRenderContext,
		});

		expect(rendered).toContain("You are the orchestrator for non-trivial work.");
		expect(rendered).toContain("Use `todo_write` as the parent orchestration ledger.");
		expect(rendered).toContain("call `todo_read` before mutating it from memory.");
		expect(rendered).toContain("subagents execute assigned tickets");
		expect(rendered).toContain("Pass large context through `local://` artifacts");
	});

	test("buildSystemPrompt emits [STABLE_CORE, DYNAMIC_TAIL] with breakpoint hint on STABLE_CORE", async () => {
		await withTempDir(async dir => {
			const { systemPrompt, systemPromptCacheBreakpointIndex } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
			});

			expect(systemPrompt).toHaveLength(2);
			// STABLE_CORE: session-invariant. Contains the harness contract AND project-static
			// (workstation, context files, critical rules) — anything that doesn't change per turn.
			expect(systemPrompt[0]).toContain("[CONTRACT]");
			expect(systemPrompt[0]).toContain("[PROJECT-STATIC]");
			expect(systemPrompt[0]).toContain("<workstation>");
			expect(systemPrompt[0]).not.toContain("current working directory");
			expect(systemPrompt[0]).not.toContain("<workspace-tree>");
			// DYNAMIC_TAIL: per-turn volatile context (workspace tree, date, cwd, goal/todo).
			expect(systemPrompt[1]).toContain("[PROJECT-LIVE]");
			expect(systemPrompt[1]).toContain("<workspace-tree>");
			expect(systemPrompt[1]).toContain("Today is ");
			expect(systemPrompt[1]).toContain(`current working directory is '${dir}'.`);
			expect(systemPrompt[1].indexOf("</workspace-tree>")).toBeLessThan(systemPrompt[1].indexOf("Today is "));
			// Goal block: emits stable "no goal" sentinel even when no goal is active so the
			// prompt structure is identical between no-goal and has-goal turns (cache stability).
			expect(systemPrompt[1]).toContain(`<goal status="none"/>`);
			// Cache hint: STABLE_CORE (index 0) is the cacheable prefix; DYNAMIC_TAIL stays fresh.
			expect(systemPromptCacheBreakpointIndex).toBe(0);
		});
	});

	test("buildSystemPrompt injects subagent contract into STABLE_CORE (Phase 2.1)", async () => {
		// Contract MUST land in the cached prefix so compaction can't drop the role/scope
		// boundary mid-session. The dynamic tail stays as before (goal block, workspace tree).
		await withTempDir(async dir => {
			const { systemPrompt, systemPromptCacheBreakpointIndex } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read", "edit", "write"],
				subagentContract: {
					role: "refactor-applier",
					scope: { include: ["src/**"], exclude: ["**/CHANGELOG.md"] },
					successCriteria: [
						{
							id: "tests-pass",
							description: "all tests green",
							check: { type: "command-exit", command: "bun test", expected: 0 },
						},
					],
					escalation: { onUncertainty: "ask-parent", budgetCap: 50000 },
				},
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
			});

			expect(systemPrompt).toHaveLength(2);
			// Contract lands inside STABLE_CORE (index 0), not DYNAMIC_TAIL.
			expect(systemPrompt[0]).toContain("<subagent-contract");
			expect(systemPrompt[0]).toContain(`role="refactor-applier"`);
			expect(systemPrompt[0]).toContain("<include>src/**</include>");
			expect(systemPrompt[0]).toContain("<exclude>**/CHANGELOG.md</exclude>");
			expect(systemPrompt[0]).toContain(`<criterion id="tests-pass"`);
			// DYNAMIC_TAIL stays uncached and contract-free.
			expect(systemPrompt[1]).not.toContain("<subagent-contract");
			// Breakpoint still on STABLE_CORE.
			expect(systemPromptCacheBreakpointIndex).toBe(0);
		});
	});

	test("buildSystemPrompt is byte-stable for identical subagent contracts (cache hit prerequisite)", async () => {
		// Two calls with identical contracts MUST produce byte-identical STABLE_CORE.
		// Drift here = cache thrash on the subagent's session.
		await withTempDir(async dir => {
			const contract = {
				role: "test-writer",
				scope: { include: ["test/**"], exclude: [] },
				successCriteria: [
					{
						id: "coverage",
						description: "new test added",
						check: { type: "file-exists" as const, path: "test/new.test.ts" },
					},
				],
				escalation: { onUncertainty: "ask-parent" as const, budgetCap: 25000 },
			};
			const optsA = {
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read", "edit"],
				subagentContract: contract,
			};
			const a = await buildSystemPrompt(optsA);
			const b = await buildSystemPrompt(optsA);
			// STABLE_CORE byte-identical = same cache prefix = cache hit.
			expect(a.systemPrompt[0]).toBe(b.systemPrompt[0]);
		});
	});

	test("buildSystemPrompt with customPrompt collapses to single block (no auto-injected dynamic tail)", async () => {
		// Custom-prompt callers (--system-prompt) get EXACTLY the prompt they provided. The harness
		// MUST NOT silently inject workspace tree, goal, or cwd context — that would surprise users
		// and break the "this is my prompt" contract. Result: single block, no cache breakpoint hint.
		await withTempDir(async dir => {
			const { systemPrompt, systemPromptCacheBreakpointIndex } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				customPrompt: "Operate as a code reviewer. Be terse.",
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
			});

			expect(systemPrompt).toHaveLength(1);
			// Custom prompt fully replaces the default template; no PROJECT-STATIC or PROJECT-LIVE wrappers.
			expect(systemPrompt[0]).not.toContain("[PROJECT-STATIC]");
			expect(systemPrompt[0]).not.toContain("[PROJECT-LIVE]");
			expect(systemPrompt[0]).not.toContain("<workstation>");
			expect(systemPrompt[0]).not.toContain("<workspace-tree>");
			expect(systemPrompt[0]).not.toContain(`<goal id="g-x"`);
			expect(systemPrompt[0]).not.toContain(`<goal status="none"/>`);
			// No breakpoint hint: single-block prompt, provider's default last-block placement is correct.
			expect(systemPromptCacheBreakpointIndex).toBeUndefined();
		});
	});

	test("buildSystemPrompt renders active mission block into DYNAMIC_TAIL", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				activeMission: {
					objective: "Wire mission block",
					state: "executing",
					decision: null,
					activeContract: null,
					evidenceClaims: [],
					blockingCritique: null,
					nextActions: [],
					omitted: {
						evidenceClaims: 0,
						evidenceCards: 0,
						contracts: 0,
						contractIncludes: 0,
						contractCriteria: 0,
						nextActions: 0,
					},
				},
			});

			expect(systemPrompt[0]).not.toContain("Wire mission block");
			expect(systemPrompt[1]).toContain("<active-mission>");
			expect(systemPrompt[1]).toContain("Objective: Wire mission block");
		});
	});
	test("buildSystemPrompt renders workspace tree after directory context in project prompt", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: true,
					totalLines: 2,
					agentsMdFiles: ["packages/coding-agent/AGENTS.md"],
				},
			});

			const projectPrompt = systemPrompt[1] ?? "";

			expect(projectPrompt).toContain("<workspace-tree>");
			expect(projectPrompt).toContain("Working directory layout (sorted by mtime, recent first; depth ≤ 3):");
			expect(projectPrompt).toContain("(some entries elided to keep the tree short");
			expect(projectPrompt.indexOf("</dir-context>")).toBeLessThan(projectPrompt.indexOf("<workspace-tree>"));
		});
	});

	test("buildSystemPrompt compact mode keeps only the nearest context file and hides workspace tree and skills", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [
					{ path: path.join(dir, "root", "AGENTS.md"), content: "Root context instructions", depth: 2 },
					{ path: path.join(dir, "app", "AGENTS.md"), content: "Nearest context instructions", depth: 0 },
				],
				skills: [
					{
						name: "sample-skill",
						description: "Skill description",
						filePath: path.join(dir, "skills", "sample", "SKILL.md"),
						baseDir: path.join(dir, "skills"),
						source: "project",
					},
				],
				rules: [],
				toolNames: ["read"],
				projectContextMode: "compact",
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: ["packages/coding-agent/AGENTS.md", "packages/tui/AGENTS.md"],
				},
			});
			const promptText = systemPrompt.join("\n\n");
			expect(promptText).toContain("Nearest context instructions");
			expect(promptText).not.toContain("Root context instructions");
			expect(promptText).not.toContain("<workspace-tree>");
			expect(promptText).not.toContain("sample-skill");
			expect(promptText).toContain("<dir-context>");
		});
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in SYSTEM.md", async () => {
		const duplicateRule = ["Use static imports.", "", "Do not use dynamic loading."].join("\n");
		const distinctRule = "Validate inputs at boundaries.";

		await withTempDir(async dir => {
			const configDir = path.join(dir, ".agent");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "SYSTEM.md"),
				["Project instructions", "", duplicateRule, "", "Trailing note"].join("\n"),
			);

			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				customPrompt: "Custom prompt body",
				alwaysApplyRules: [
					{ name: "no-dynamic-loading", content: duplicateRule, path: "/tmp/no-dynamic-loading.md" },
					{ name: "validate-boundaries", content: distinctRule, path: "/tmp/validate-boundaries.md" },
				],
			});

			const prompt = systemPrompt.join("\n\n");

			expect(countOccurrences(prompt, "Use static imports.")).toBe(1);
			expect(countOccurrences(prompt, "Do not use dynamic loading.")).toBe(1);
			expect(countOccurrences(prompt, distinctRule)).toBe(1);
		});
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in customPrompt", async () => {
		const duplicateRule = ["Keep functions small.", "", "Extract shared helpers on the second use."].join("\n");
		const distinctRule = "Surface failures explicitly to callers.";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			customPrompt: ["Custom guidance", "", duplicateRule, "", "More custom guidance"].join("\n"),
			alwaysApplyRules: [
				{ name: "small-functions", content: duplicateRule, path: "/tmp/small-functions.md" },
				{ name: "truthful-failures", content: distinctRule, path: "/tmp/truthful-failures.md" },
			],
		});

		const prompt = systemPrompt.join("\n\n");

		expect(countOccurrences(prompt, "Keep functions small.")).toBe(1);
		expect(countOccurrences(prompt, "Extract shared helpers on the second use.")).toBe(1);
		expect(countOccurrences(prompt, distinctRule)).toBe(1);
	});

	test("buildSystemPromptToolMetadata captures custom wire names", () => {
		const editTool = {
			name: "edit",
			label: "Edit",
			description: "Edits files",
			parameters: z.object({}),
			customWireName: "apply_patch",
			execute: async () => ({ content: [] }),
		} satisfies AgentTool;

		const metadata = buildSystemPromptToolMetadata(new Map([["edit", editTool]]));

		expect(metadata.get("edit")?.wireName).toBe("apply_patch");
	});

	test("buildSystemPrompt references overridden tool wire names", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "search", "find", "edit", "lsp", "bash", "eval"],
			tools: new Map([
				["read", { label: "Read", description: "Reads files" }],
				["search", { label: "Search", description: "Searches files" }],
				["find", { label: "Find", description: "Finds files" }],
				["edit", { label: "Edit", description: "Edits files", wireName: "apply_patch" }],
				["lsp", { label: "LSP", description: "Queries language servers" }],
				["bash", { label: "Bash", description: "Runs shell commands" }],
				["eval", { label: "Eval", description: "Runs eval cells" }],
			]),
		});

		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Edit: `apply_patch`");
		expect(promptText).toContain("surgical text edits → `apply_patch`");
		expect(promptText).not.toContain("Edit: `edit`");
	});

	test("buildSystemPrompt omits CPU info when os.cpus fails", async () => {
		vi.spyOn(os, "cpus").mockImplementation(() => {
			throw new Error("os.cpus() failed");
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
		});

		// In the v2 layout, <workstation> lives in STABLE_CORE (systemPrompt[0]) alongside the
		// harness contract — it's session-invariant, so it belongs in the cached prefix.
		const stableCore = systemPrompt[0] ?? "";

		const workstation = /<workstation>\n(?<content>[\s\S]*?)\n<\/workstation>/u.exec(stableCore)?.groups?.content;
		expect(workstation).toContain("OS:");
		expect(workstation).not.toContain("CPU:");
	});
});
