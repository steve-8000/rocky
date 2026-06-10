import type { SessionEvent } from "../../observability";
import type { EvalReport, LearningProposal } from "../types";
import { evaluateContradictionGate } from "./contradiction";
import { evaluateProvenanceGate } from "./provenance";
import { replaySession } from "./replay";
import { runSandboxReplay } from "./sandbox-replay";

export interface EvalContext {
	existingMemoryContent?: string[];
	existingSkill?: { name: string; bodyMarkdown: string } | null;
	replaySessions?: string[];
	replayBaseDir?: string;
	recentEvents?: SessionEvent[];
	baselinePassRate?: number;
	now?: number | (() => number);
	workspaceRoot?: string;
}

export async function evaluateProposal(proposal: LearningProposal, ctx: EvalContext = {}): Promise<EvalReport> {
	const startedAt = readNow(ctx);
	const signals: Record<string, unknown> = {};
	const patchHash = await computePatchHash(proposal);

	const provenance = evaluateProvenanceGate(proposal);
	signals.provenance = provenance;
	if (!provenance.passed) return report(false, "provenance", signals, startedAt, ctx, patchHash);

	const contradiction = evaluateContradictionGate(proposal, {
		existingMemoryContent: ctx.existingMemoryContent,
		existingSkill: ctx.existingSkill,
	});
	signals.contradiction = contradiction;
	if (!contradiction.passed) return report(false, "contradiction", signals, startedAt, ctx, patchHash);

	const replay = await evaluateReplay(ctx);
	signals.replay = replay;
	if (!replay.passed) return report(false, "replay", signals, startedAt, ctx, patchHash);

	let sandbox: EvalReport["sandbox"];
	if ((proposal.regressionCommands?.length ?? 0) > 0) {
		sandbox = await runSandboxReplay(proposal, { workspaceRoot: ctx.workspaceRoot ?? "." });
		signals.sandbox = sandbox;
	}

	return report(sandbox ? sandbox.ok : true, "done", signals, startedAt, ctx, patchHash, sandbox);
}

async function evaluateReplay(ctx: EvalContext): Promise<{
	passed: boolean;
	sessions: string[];
	baselinePassRate: number;
	passRate: number;
	allowedDrop: number;
	results: Array<{ sessionId: string; goalCompleteVerdict: string | null }>;
}> {
	const sessions = ctx.replaySessions ?? [];
	const results = [];

	for (const sessionId of sessions) {
		const events = ctx.recentEvents?.filter(event => event.sessionId === sessionId);
		const replayReport = await replaySession(sessionId, {
			baseDir: ctx.replayBaseDir ?? ".",
			...(events ? { events } : {}),
		});
		results.push({
			sessionId,
			goalCompleteVerdict: replayReport.decisions.goalCompleteVerdict,
		});
	}

	const passedCount = results.filter(result => result.goalCompleteVerdict === "pass").length;
	const passRate = results.length === 0 ? 1 : passedCount / results.length;
	const baselinePassRate = ctx.baselinePassRate ?? 0;
	const allowedDrop = 0.05;

	return {
		passed: passRate >= baselinePassRate - allowedDrop,
		sessions,
		baselinePassRate,
		passRate,
		allowedDrop,
		results,
	};
}

function report(
	passed: boolean,
	stage: EvalReport["stage"],
	signals: Record<string, unknown>,
	startedAt: number,
	ctx: EvalContext,
	patchHash: string,
	sandbox?: EvalReport["sandbox"],
): EvalReport {
	return {
		passed,
		stage,
		signals,
		durationMs: Math.max(0, readNow(ctx) - startedAt),
		patchHash,
		...(sandbox ? { sandbox } : {}),
	};
}

async function computePatchHash(proposal: LearningProposal): Promise<string> {
	const value =
		proposal.type === "settings"
			? proposal.patch
			: proposal.type === "rule"
				? proposal.ruleMarkdown
				: proposal.type === "skill"
					? proposal.bodyMarkdown
					: proposal.type === "memory"
						? [proposal.content]
						: null;
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function readNow(ctx: EvalContext): number {
	if (typeof ctx.now === "function") return ctx.now();
	return ctx.now ?? 0;
}
