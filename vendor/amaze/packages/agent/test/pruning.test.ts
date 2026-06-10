import { describe, expect, it } from "bun:test";
import type { SessionEntry, SessionMessageEntry } from "@amaze/agent-core/compaction/entries";
import {
	type ContinuousDemotionConfig,
	DEFAULT_CONTINUOUS_DEMOTION_CONFIG,
	pruneToolOutputs,
	pruneToolOutputsByAge,
} from "@amaze/agent-core/compaction/pruning";
import type { ToolResultMessage } from "@amaze/ai";

let counter = 0;
function makeToolEntry(opts: {
	toolName: string;
	text: string;
	ageSeconds: number;
	now?: number;
	prunedAt?: number;
}): SessionMessageEntry {
	counter++;
	const now = opts.now ?? Date.now();
	const ts = now - opts.ageSeconds * 1000;
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: `tc-${counter}`,
		toolName: opts.toolName,
		content: [{ type: "text", text: opts.text }],
		isError: false,
		timestamp: ts,
		prunedAt: opts.prunedAt,
	};
	return {
		type: "message",
		id: `e-${counter}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message,
	};
}

// Predictable, non-compressing text payload. Avoids the BPE tokenizer compressing
// repeated chars into a handful of tokens, which would invalidate token-budget
// assumptions in tests.
function payload(approxTokens: number): string {
	// cl100k_base averages ~1 token per ~4 chars of varied text. Generate that
	// many chars from a rotating alphabet so the tokenizer doesn't compress runs.
	const out: string[] = [];
	for (let i = 0; i < approxTokens * 4; i++) {
		out.push(String.fromCharCode(97 + (i % 26)));
		if (i % 5 === 4) out.push(" ");
	}
	return out.join("");
}

function textOf(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const m = entry.message;
	if (m.role !== "toolResult") return "";
	const c = (m as ToolResultMessage).content;
	if (!Array.isArray(c)) return "";
	return c.map(b => (b.type === "text" ? b.text : "")).join("");
}

// Tight protect window for deterministic tests independent of tokenizer drift.
const TIGHT: ContinuousDemotionConfig = {
	...DEFAULT_CONTINUOUS_DEMOTION_CONFIG,
	protectTokens: 50,
};

describe("pruneToolOutputsByAge", () => {
	const now = 1_700_000_000_000;

	it("returns no-op when no entries are past TTL", () => {
		const entries: SessionEntry[] = [makeToolEntry({ toolName: "bash", text: payload(200), ageSeconds: 5, now })];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(0);
		expect(textOf(entries[0]).length).toBeGreaterThan(100);
	});

	it("demotes bash output older than its TTL once protect window is past", () => {
		const oldBash = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 600, now });
		const recentFiller = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldBash, recentFiller];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(1);
		expect(textOf(oldBash)).toMatch(/Output truncated/);
		expect(textOf(recentFiller)).not.toMatch(/Output truncated/);
	});

	it("demotes stale search and find outputs using the grep/list TTL bucket", () => {
		const oldSearch = makeToolEntry({ toolName: "search", text: payload(500), ageSeconds: 600, now });
		const oldFind = makeToolEntry({ toolName: "find", text: payload(500), ageSeconds: 600, now });
		const recentFiller = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldSearch, oldFind, recentFiller];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(2);
		expect(textOf(oldSearch)).toMatch(/Output truncated/);
		expect(textOf(oldFind)).toMatch(/Output truncated/);
		expect(textOf(recentFiller)).not.toMatch(/Output truncated/);
	});

	it("applies protectTokens and protectedTools to configured search and find demotion", () => {
		const cfg: ContinuousDemotionConfig = {
			...TIGHT,
			protectedTools: [...TIGHT.protectedTools, "search"],
		};
		const protectedSearch = makeToolEntry({ toolName: "search", text: payload(500), ageSeconds: 600, now });
		const oldFind = makeToolEntry({ toolName: "find", text: payload(500), ageSeconds: 600, now });
		const protectWindowFind = makeToolEntry({ toolName: "find", text: payload(500), ageSeconds: 600, now });
		const entries: SessionEntry[] = [protectedSearch, oldFind, protectWindowFind];
		const result = pruneToolOutputsByAge(entries, cfg, now);
		expect(result.prunedCount).toBe(1);
		expect(textOf(protectedSearch)).not.toMatch(/Output truncated/);
		expect(textOf(oldFind)).toMatch(/Output truncated/);
		expect(textOf(protectWindowFind)).not.toMatch(/Output truncated/);
	});

	it("never demotes protected tools (skill)", () => {
		const oldSkill = makeToolEntry({ toolName: "skill", text: payload(500), ageSeconds: 999_999, now });
		const recentFiller = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldSkill, recentFiller];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(0);
		expect(textOf(oldSkill)).not.toMatch(/Output truncated/);
	});

	it("never demotes small reads (≤ readSmallThresholdTokens)", () => {
		// Use a tight config with a small read threshold for determinism.
		const cfg: ContinuousDemotionConfig = { ...TIGHT, readSmallThresholdTokens: 100 };
		const smallRead = makeToolEntry({ toolName: "read", text: payload(50), ageSeconds: 999_999, now });
		const filler = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [smallRead, filler];
		const result = pruneToolOutputsByAge(entries, cfg, now);
		expect(result.prunedCount).toBe(0);
		expect(textOf(smallRead)).not.toMatch(/Output truncated/);
	});

	it("demotes large reads past TTL (> readSmallThresholdTokens)", () => {
		const cfg: ContinuousDemotionConfig = { ...TIGHT, readSmallThresholdTokens: 100 };
		const largeRead = makeToolEntry({ toolName: "read", text: payload(500), ageSeconds: 1_200, now });
		const filler = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [largeRead, filler];
		const result = pruneToolOutputsByAge(entries, cfg, now);
		expect(result.prunedCount).toBe(1);
		expect(textOf(largeRead)).toMatch(/Output truncated/);
	});

	it("skips already-pruned entries (no double-prune)", () => {
		const oldBash = makeToolEntry({
			toolName: "bash",
			text: payload(500),
			ageSeconds: 600,
			now,
			prunedAt: now - 1000,
		});
		const filler = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldBash, filler];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(0);
	});

	it("ignores tools without an explicit TTL and no '*' fallback", () => {
		const oldCustom = makeToolEntry({
			toolName: "custom-tool",
			text: payload(500),
			ageSeconds: 999_999,
			now,
		});
		const filler = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldCustom, filler];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(0);
	});

	it("uses '*' fallback TTL when present", () => {
		const cfg: ContinuousDemotionConfig = {
			...TIGHT,
			ttlSeconds: { ...TIGHT.ttlSeconds, "*": 60 },
		};
		const oldCustom = makeToolEntry({
			toolName: "custom-tool",
			text: payload(500),
			ageSeconds: 600,
			now,
		});
		const filler = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 1, now });
		const entries: SessionEntry[] = [oldCustom, filler];
		const result = pruneToolOutputsByAge(entries, cfg, now);
		expect(result.prunedCount).toBe(1);
	});

	it("keeps the newest protectTokens worth of tool output intact", () => {
		// Three old bash entries. With protectTokens=50, the newest one (≈500
		// tokens of payload) already exceeds the protect window, so the next two
		// older entries are eligible for demotion.
		const a = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 600, now });
		const b = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 600, now });
		const c = makeToolEntry({ toolName: "bash", text: payload(500), ageSeconds: 600, now });
		const entries: SessionEntry[] = [a, b, c];
		const result = pruneToolOutputsByAge(entries, TIGHT, now);
		expect(result.prunedCount).toBe(2);
		expect(textOf(c)).not.toMatch(/Output truncated/);
		expect(textOf(b)).toMatch(/Output truncated/);
		expect(textOf(a)).toMatch(/Output truncated/);
	});
});

describe("pruneToolOutputs (budget-driven, unchanged)", () => {
	it("still requires minimum savings before pruning", () => {
		// Single tiny old output is below default minimumSavings (20K). No-op.
		const old = makeToolEntry({ toolName: "bash", text: payload(100), ageSeconds: 999, now: Date.now() });
		const result = pruneToolOutputs([old]);
		expect(result.prunedCount).toBe(0);
	});
});
