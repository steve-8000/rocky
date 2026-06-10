import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { $env, getProjectDir, isEnoent, prompt } from "@amaze/utils";
import { applyChangelogProposals } from "../../commit/changelog";
import { detectChangelogBoundaries } from "../../commit/changelog/detect";
import { parseUnreleasedSection } from "../../commit/changelog/parse";
import { formatCommitMessage } from "../../commit/message";
import { resolvePrimaryModel, resolveSmolModel } from "../../commit/model-selection";
import type { CommitCommandArgs, ConventionalAnalysis } from "../../commit/types";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage, discoverContextFiles } from "../../sdk";
import { getBundledAgent } from "../../task/agents";
import { runSubprocess } from "../../task/executor";
import type { ReviewSummary, SingleResult } from "../../task/types";
import { isMarkdownPath, type ReportFindingDetails as ReviewFinding } from "../../tools/review";
import * as git from "../../utils/git";
import { type ExistingChangelogEntries, runCommitAgentSession } from "./agent";
import { generateFallbackProposal } from "./fallback";
import splitConfirmPrompt from "./prompts/split-confirm.md" with { type: "text" };
import type { CommitAgentState, CommitProposal, HunkSelector, SplitCommitPlan } from "./state";
import { computeDependencyOrder } from "./topo-sort";
import { detectTrivialChange } from "./trivial";

interface CommitExecutionContext {
	cwd: string;
	dryRun: boolean;
	push: boolean;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>;
}

export async function runAgenticCommit(args: CommitCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);

	process.stdout.write("● Resolving model...\n");
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const stagedFilesPromise = (async () => {
		let stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
		if (stagedFiles.length === 0) {
			process.stdout.write("No staged changes detected, staging all changes...\n");
			await git.stage.files(cwd);
			stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
		}
		return stagedFiles;
	})();

	const primaryModelPromise = resolvePrimaryModel(args.model, settings, modelRegistry);
	const [primaryModelResult, stagedFiles] = await Promise.all([primaryModelPromise, stagedFilesPromise]);
	const { model: primaryModel, apiKey: primaryApiKey } = primaryModelResult;
	process.stdout.write(`  └─ ${primaryModel.name}\n`);

	const { model: agentModel, thinkingLevel: agentThinkingLevel } = await resolveSmolModel(
		settings,
		modelRegistry,
		primaryModel,
		primaryApiKey,
	);

	if (stagedFiles.length === 0) {
		process.stderr.write("No changes to commit.\n");
		return;
	}

	if (!args.noChangelog) {
		process.stdout.write("● Detecting changelog targets...\n");
	}
	const [changelogBoundaries, contextFiles, numstat, diff] = await Promise.all([
		args.noChangelog ? [] : detectChangelogBoundaries(cwd, stagedFiles),
		discoverContextFiles(cwd),
		git.diff.numstat(cwd, { cached: true }),
		git.diff(cwd, { cached: true }),
	]);
	const changelogTargets = changelogBoundaries.map(boundary => boundary.changelogPath);
	if (!args.noChangelog) {
		if (changelogTargets.length > 0) {
			for (const path of changelogTargets) {
				process.stdout.write(`  └─ ${path}\n`);
			}
		} else {
			process.stdout.write("  └─ (none found)\n");
		}
	}

	process.stdout.write("● Discovering context files...\n");
	const agentsMdFiles = contextFiles.filter(file => file.path.endsWith("AGENTS.md"));
	if (agentsMdFiles.length > 0) {
		for (const file of agentsMdFiles) {
			process.stdout.write(`  └─ ${file.path}\n`);
		}
	} else {
		process.stdout.write("  └─ (none found)\n");
	}
	const forceFallback = $env.AMAZE_COMMIT_TEST_FALLBACK?.toLowerCase() === "true";
	const commitCtx: CommitExecutionContext = {
		cwd,
		dryRun: args.dryRun,
		push: args.push,
		settings,
		modelRegistry,
		authStorage,
	};
	if (forceFallback) {
		process.stdout.write("● Forcing fallback commit generation...\n");
		const fallbackProposal = generateFallbackProposal(numstat);
		await runSingleCommit(fallbackProposal, commitCtx);
		return;
	}

	const trivialChange = detectTrivialChange(diff);
	if (trivialChange) {
		process.stdout.write(`● Detected trivial change: ${trivialChange.summary}\n`);
		const trivialProposal: CommitProposal = {
			analysis: {
				type: trivialChange.type,
				scope: null,
				details: [],
				issueRefs: [],
			},
			summary: trivialChange.summary,
			warnings: [],
		};
		await runSingleCommit(trivialProposal, commitCtx);
		return;
	}

	let existingChangelogEntries: ExistingChangelogEntries[] | undefined;
	if (!args.noChangelog && changelogTargets.length > 0) {
		existingChangelogEntries = await loadExistingChangelogEntries(changelogTargets);
		if (existingChangelogEntries.length === 0) {
			existingChangelogEntries = undefined;
		}
	}

	process.stdout.write("● Starting commit agent...\n");
	let commitState: CommitAgentState;
	let usedFallback = false;

	try {
		commitState = await runCommitAgentSession({
			cwd,
			model: agentModel,
			thinkingLevel: agentThinkingLevel,
			settings,
			modelRegistry,
			authStorage,
			userContext: args.context,
			contextFiles,
			changelogTargets,
			requireChangelog: !args.noChangelog && changelogTargets.length > 0,
			diffText: diff,
			existingChangelogEntries,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Agent error: ${errorMessage}\n`);
		if (error instanceof Error && error.stack && $env.DEBUG) {
			process.stderr.write(`${error.stack}\n`);
		}
		process.stdout.write("● Using fallback commit generation...\n");
		commitState = { proposal: generateFallbackProposal(numstat) };
		usedFallback = true;
	}

	if (!usedFallback && !commitState.proposal && !commitState.splitProposal) {
		if ($env.AMAZE_COMMIT_NO_FALLBACK?.toLowerCase() !== "true") {
			process.stdout.write("● Agent did not provide proposal, using fallback...\n");
			commitState.proposal = generateFallbackProposal(numstat);
			usedFallback = true;
		}
	}

	let updatedChangelogFiles: string[] = [];
	if (!args.noChangelog && changelogTargets.length > 0 && !usedFallback) {
		if (!commitState.changelogProposal) {
			process.stderr.write("Commit agent did not provide changelog entries.\n");
			return;
		}
		process.stdout.write("● Applying changelog entries...\n");
		const updated = await applyChangelogProposals({
			cwd,
			proposals: commitState.changelogProposal.entries,
			dryRun: args.dryRun,
			onProgress: message => {
				process.stdout.write(`  ├─ ${message}\n`);
			},
		});
		updatedChangelogFiles = updated.map(filePath => path.relative(cwd, filePath));
		if (updated.length > 0) {
			for (const filePath of updated) {
				process.stdout.write(`  └─ ${filePath}\n`);
			}
		} else {
			process.stdout.write("  └─ (no changes)\n");
		}
	}

	if (commitState.proposal) {
		await runSingleCommit(commitState.proposal, commitCtx);
		return;
	}

	if (commitState.splitProposal) {
		await runSplitCommit(commitState.splitProposal, {
			...commitCtx,
			additionalFiles: updatedChangelogFiles,
		});
		return;
	}

	process.stderr.write("Commit agent did not provide a proposal.\n");
}

async function runSingleCommit(proposal: CommitProposal, ctx: CommitExecutionContext): Promise<void> {
	if (proposal.warnings.length > 0) {
		process.stdout.write(formatWarnings(proposal.warnings));
	}
	const commitMessage = formatCommitMessage(proposal.analysis, proposal.summary);
	if (ctx.dryRun) {
		process.stdout.write("\nGenerated commit message:\n");
		process.stdout.write(`${commitMessage}\n`);
		return;
	}
	await enforcePreCommitReview(ctx);
	await git.commit(ctx.cwd, commitMessage);
	process.stdout.write("Commit created.\n");
	if (ctx.push) {
		await git.push(ctx.cwd);
		process.stdout.write("Pushed to remote.\n");
	}
}

export async function getReviewableStagedFiles(cwd: string): Promise<string[]> {
	const stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	return stagedFiles.filter(file => !isMarkdownPath(file));
}

function getLastReviewSummary(result: SingleResult): ReviewSummary | undefined {
	const yieldItems = result.extractedToolData?.yield as Array<{ data?: unknown }> | undefined;
	const data = yieldItems?.at(-1)?.data;
	if (!data || typeof data !== "object") return undefined;
	const record = data as Partial<ReviewSummary>;
	if (record.overall_correctness !== "correct" && record.overall_correctness !== "incorrect") return undefined;
	if (typeof record.explanation !== "string") return undefined;
	if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return undefined;
	return {
		overall_correctness: record.overall_correctness,
		explanation: record.explanation,
		confidence: record.confidence,
	};
}

export function getBlockingReviewFindings(result: SingleResult): ReviewFinding[] {
	const findings = (result.extractedToolData?.report_finding as ReviewFinding[] | undefined) ?? [];
	return findings.filter(
		finding => (finding.priority === "P0" || finding.priority === "P1") && !isMarkdownPath(finding.file_path),
	);
}

export function isPreCommitReviewResultPassing(result: SingleResult): boolean {
	const summary = getLastReviewSummary(result);
	return summary?.overall_correctness === "correct" && getBlockingReviewFindings(result).length === 0;
}

function formatReviewFailure(summary: ReviewSummary | undefined, blockers: ReviewFinding[]): string {
	const lines = ["Pre-commit Reviewer gate failed."];
	if (!summary) {
		lines.push("Reviewer did not provide a valid final verdict.");
	} else if (summary.overall_correctness !== "correct") {
		lines.push(`Reviewer verdict: ${summary.overall_correctness}. ${summary.explanation}`);
	}
	if (blockers.length > 0) {
		lines.push("Blocking non-Markdown findings:");
		for (const finding of blockers) {
			lines.push(`- ${finding.priority} ${finding.file_path}:${finding.line_start} ${finding.title}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function buildPreCommitReviewAssignment(reviewableFiles: string[]): string {
	return [
		"# Target",
		"Review the currently staged non-Markdown source changes before commit.",
		"",
		"# Required procedure",
		"1. Run `git diff --cached` to inspect exactly the staged patch that will be committed.",
		"2. Treat these staged non-Markdown files as the reviewable source set:",
		...reviewableFiles.map(file => `   - ${file}`),
		"3. For each reviewable source file, read whole-file/source context and trace whole-source impact, including callsites, dispatch/consumer paths, and cross-module contracts affected by the staged patch.",
		"4. You are read-only. Do not edit files, stage files, unstage files, commit, run formatters, or run tests/builds.",
		"5. Markdown/docs files are explicitly excluded from review authority. They may be mentioned if useful, but they cannot satisfy this gate, cannot count as source coverage, and Markdown-only findings must not affect the gate verdict.",
		"",
		"# Blocking rules",
		"- Report findings only with `report_finding`.",
		"- P0/P1 findings on non-Markdown files are blockers.",
		"- P0/P1 findings on Markdown/docs files are non-authoritative for this gate.",
		"- Final `yield` must set `overall_correctness` to `correct` only when there are no blocking non-Markdown findings and the staged non-Markdown patch is correct.",
	].join("\n");
}

async function enforcePreCommitReview(ctx: CommitExecutionContext): Promise<void> {
	const reviewableFiles = await getReviewableStagedFiles(ctx.cwd);
	if (reviewableFiles.length === 0) return;

	const stagedTreeBefore = await git.writeTree(ctx.cwd);
	const reviewer = getBundledAgent("Reviewer");
	const assignment = buildPreCommitReviewAssignment(reviewableFiles);
	if (!reviewer) {
		throw new Error("Bundled Reviewer agent is unavailable");
	}

	process.stdout.write("● Running pre-commit Reviewer gate...\n");
	const result = await runSubprocess({
		cwd: ctx.cwd,
		agent: reviewer,
		task: assignment,
		assignment,
		description: "Pre-commit staged source review",
		index: 0,
		id: "precommit-reviewer",
		modelOverride: reviewer.model,
		thinkingLevel: reviewer.thinkingLevel,
		outputSchema: reviewer.output,
		authStorage: ctx.authStorage,
		modelRegistry: ctx.modelRegistry,
		settings: ctx.settings,
		enableLsp: true,
	});
	const stagedTreeAfter = await git.writeTree(ctx.cwd);
	if (stagedTreeAfter !== stagedTreeBefore) {
		throw new Error("Pre-commit Reviewer modified the staged tree; commit blocked");
	}
	if (result.exitCode !== 0) {
		throw new Error(`Pre-commit Reviewer failed: ${result.stderr || result.error || "unknown error"}`);
	}

	const summary = getLastReviewSummary(result);
	const blockers = getBlockingReviewFindings(result);
	if (!isPreCommitReviewResultPassing(result)) {
		process.stderr.write(formatReviewFailure(summary, blockers));
		throw new Error("Pre-commit Reviewer gate failed");
	}
}

async function restoreStagedDiff(cwd: string, stagedDiff: string): Promise<void> {
	await git.stage.reset(cwd);
	if (stagedDiff.trim()) {
		await git.patch.applyText(cwd, stagedDiff, { cached: true });
	}
}

async function runSplitCommit(
	plan: SplitCommitPlan,
	ctx: CommitExecutionContext & { additionalFiles?: string[] },
): Promise<void> {
	if (plan.warnings.length > 0) {
		process.stdout.write(formatWarnings(plan.warnings));
	}
	if (ctx.additionalFiles && ctx.additionalFiles.length > 0) {
		appendFilesToLastCommit(plan, ctx.additionalFiles);
	}
	const stagedFiles = await git.diff.changedFiles(ctx.cwd, { cached: true });
	const plannedFiles = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const missingFiles = stagedFiles.filter(file => !plannedFiles.has(file));
	if (missingFiles.length > 0) {
		process.stderr.write(`Split commit plan missing staged files: ${missingFiles.join(", ")}\n`);
		return;
	}

	if (ctx.dryRun) {
		process.stdout.write("\nSplit commit plan (dry run):\n");
		for (const [index, commit] of plan.commits.entries()) {
			const analysis: ConventionalAnalysis = {
				type: commit.type,
				scope: commit.scope,
				details: commit.details,
				issueRefs: commit.issueRefs,
			};
			const message = formatCommitMessage(analysis, commit.summary);
			process.stdout.write(`Commit ${index + 1}:\n${message}\n`);
			const changeSummary = commit.changes
				.map(change => formatFileChangeSummary(change.path, change.hunks))
				.join(", ");
			process.stdout.write(`Changes: ${changeSummary}\n`);
		}
		return;
	}

	if (!(await confirmSplitCommitPlan(plan))) {
		process.stdout.write("Split commit aborted by user.\n");
		return;
	}

	const order = computeDependencyOrder(plan.commits);
	if ("error" in order) {
		throw new Error(order.error);
	}

	const stagedDiff = await git.diff(ctx.cwd, { binary: true, cached: true });
	try {
		await git.stage.reset(ctx.cwd);
		for (const commitIndex of order) {
			const commit = plan.commits[commitIndex];
			await git.stage.hunks(ctx.cwd, commit.changes, { rawDiff: stagedDiff, diffCached: true });
			await enforcePreCommitReview(ctx);
			await git.stage.reset(ctx.cwd);
		}
	} catch (error) {
		await restoreStagedDiff(ctx.cwd, stagedDiff);
		throw error;
	}

	await git.stage.reset(ctx.cwd);
	for (const commitIndex of order) {
		const commit = plan.commits[commitIndex];
		await git.stage.hunks(ctx.cwd, commit.changes, { rawDiff: stagedDiff, diffCached: true });
		const analysis: ConventionalAnalysis = {
			type: commit.type,
			scope: commit.scope,
			details: commit.details,
			issueRefs: commit.issueRefs,
		};
		const message = formatCommitMessage(analysis, commit.summary);
		await enforcePreCommitReview(ctx);
		await git.commit(ctx.cwd, message);
		await git.stage.reset(ctx.cwd);
	}
	process.stdout.write("Split commits created.\n");
	if (ctx.push) {
		await git.push(ctx.cwd);
		process.stdout.write("Pushed to remote.\n");
	}
}

function appendFilesToLastCommit(plan: SplitCommitPlan, files: string[]): void {
	if (plan.commits.length === 0) return;
	const planned = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const targetCommit = plan.commits[plan.commits.length - 1];
	for (const file of files) {
		if (planned.has(file)) continue;
		targetCommit.changes.push({ path: file, hunks: { type: "all" } });
		planned.add(file);
	}
}

async function confirmSplitCommitPlan(plan: SplitCommitPlan): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return true;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const splitConfirmQuestion = prompt.render(splitConfirmPrompt, { count: plan.commits.length });
		const answer = await rl.question(splitConfirmQuestion);
		return ["y", "yes"].includes(answer.trim().toLowerCase());
	} finally {
		rl.close();
	}
}

function formatWarnings(warnings: string[]): string {
	return `Warnings:\n${warnings.map(warning => `- ${warning}`).join("\n")}\n`;
}

function formatFileChangeSummary(path: string, hunks: HunkSelector): string {
	if (hunks.type === "all") {
		return `${path} (all)`;
	}
	if (hunks.type === "indices") {
		return `${path} (hunks ${hunks.indices.join(", ")})`;
	}
	return `${path} (lines ${hunks.start}-${hunks.end})`;
}

async function loadExistingChangelogEntries(paths: string[]): Promise<ExistingChangelogEntries[]> {
	const entries = await Promise.all(
		paths.map(async path => {
			let content: string;
			try {
				content = await Bun.file(path).text();
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
			try {
				const unreleased = parseUnreleasedSection(content);
				const sections = Object.entries(unreleased.entries)
					.filter(([, items]) => items.length > 0)
					.map(([name, items]) => ({ name, items }));
				if (sections.length > 0) {
					return { path, sections };
				}
			} catch {
				return null;
			}
			return null;
		}),
	);
	return entries.filter((entry): entry is ExistingChangelogEntries => entry !== null);
}
