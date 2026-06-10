/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@amaze/ai";
import type { AgentMessage } from "../types";
import { estimateTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool names that should never be pruned. */
	protectedTools: string[];
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", "read"],
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/**
 * Per-tool TTL policy for continuous (post-turn) demotion.
 *
 * Each entry maps a `toolName` to a max age in seconds. Tool results older than
 * their TTL are demoted to a truncation notice. Tools without an entry are not
 * aged out by this policy (use `pruneToolOutputs` for budget-driven pruning).
 *
 * Special key `*` is the fallback TTL for any tool not explicitly listed; omit
 * to disable fallback behavior.
 */
export interface ContinuousDemotionConfig {
	/** Map of toolName → max age in seconds before demotion. Use "*" for default. */
	ttlSeconds: Record<string, number>;
	/** Tokens worth of newest tool output kept intact regardless of TTL. */
	protectTokens: number;
	/** Tool names that are never demoted by TTL (still subject to budget-prune). */
	protectedTools: string[];
	/**
	 * For `read` specifically: outputs at or below this token estimate are never
	 * demoted, since small file contents are cheap and frequently re-referenced.
	 * Set to 0 to disable.
	 */
	readSmallThresholdTokens: number;
}

export const DEFAULT_CONTINUOUS_DEMOTION_CONFIG: ContinuousDemotionConfig = {
	ttlSeconds: {
		bash: 60,
		grep: 180,
		search: 180,
		tree: 180,
		ls: 180,
		find: 180,
		read: 600,
	},
	protectTokens: 8_000,
	protectedTools: ["skill"],
	readSmallThresholdTokens: 2_000,
};

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number): number {
	const noticeTokens = Math.ceil(createPrunedNotice(tokens).length / 4);
	return Math.max(0, tokens - noticeTokens);
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number }> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isProtected = config.protectedTools.includes(message.toolName);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		if (accumulatedTokens < config.protectTokens || isProtected) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(candidate.tokens);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: createPrunedNotice(candidate.tokens) }];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

function parseTimestampMs(value: string): number {
	const t = Date.parse(value);
	return Number.isFinite(t) ? t : 0;
}

/**
 * Demote stale tool outputs based on per-tool TTL.
 *
 * Walks entries newest → oldest. The newest `protectTokens` of tool output
 * stay intact regardless of age (debugging headroom for the current turn).
 * Older entries whose tool has a TTL and whose age exceeds it are demoted.
 *
 * Pure function: mutates `entries[i].message.content/prunedAt` only on demotion;
 * callers persist via `sessionManager.rewriteEntries()` if `prunedCount > 0`.
 *
 * Designed for `session.turn_end` invocation. Skill outputs and small reads are
 * preserved by default — see `DEFAULT_CONTINUOUS_DEMOTION_CONFIG`.
 */
export function pruneToolOutputsByAge(
	entries: SessionEntry[],
	config: ContinuousDemotionConfig = DEFAULT_CONTINUOUS_DEMOTION_CONFIG,
	now: number = Date.now(),
): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const fallbackTtl = config.ttlSeconds["*"];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		if (accumulatedTokens < config.protectTokens) {
			accumulatedTokens += tokens;
			continue;
		}
		accumulatedTokens += tokens;

		if (config.protectedTools.includes(message.toolName)) continue;
		if (
			message.toolName === "read" &&
			config.readSmallThresholdTokens > 0 &&
			tokens <= config.readSmallThresholdTokens
		) {
			continue;
		}

		const ttlSeconds = config.ttlSeconds[message.toolName] ?? fallbackTtl;
		if (ttlSeconds === undefined) continue;

		const ageMs = now - parseTimestampMs((entry as SessionMessageEntry).timestamp);
		if (ageMs < ttlSeconds * 1000) continue;

		const savings = estimatePrunedSavings(tokens);
		(message as ToolResultMessage).content = [{ type: "text", text: createPrunedNotice(tokens) }];
		(message as ToolResultMessage).prunedAt = now;
		prunedCount++;
		tokensSaved += savings;
	}

	return { prunedCount, tokensSaved };
}
