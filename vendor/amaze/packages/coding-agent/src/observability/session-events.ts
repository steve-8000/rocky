/**
 * Public reader for persisted session events (the JSONL the {@link JsonlSessionSink}
 * writes under `~/.amaze/observability/sessions/*.jsonl`). Used by the rules engine and
 * the self-improvement loop to analyze cross-session history. Malformed lines are skipped
 * rather than throwing, so a single corrupt record can't break analysis.
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "./event-schema";

/** Resolve the sessions directory, honoring AMAZE_OBSERVABILITY_DIR / HOME. */
export function sessionsDir(observabilityDir?: string): string {
	const base =
		observabilityDir ??
		process.env.AMAZE_OBSERVABILITY_DIR ??
		path.join(process.env.HOME || homedir(), ".amaze", "observability");
	return path.join(base, "sessions");
}

/**
 * Read all persisted session events (optionally only those at/after `since`), sorted by
 * timestamp ascending. Returns `[]` when the directory does not exist yet.
 */
export async function readSessionEvents(
	opts: { observabilityDir?: string; since?: number } = {},
): Promise<SessionEvent[]> {
	const dir = sessionsDir(opts.observabilityDir);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const events: SessionEvent[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".jsonl")) continue;
		const text = await fs.readFile(path.join(dir, entry), "utf8");
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // skip syntactically-corrupt line
			}
			// Guard SHAPE too, not just parse: a valid-JSON line that isn't an event object
			// or lacks a numeric `ts` (e.g. `{}`, `123`, a partially-flushed record) would
			// otherwise escape the `since` filter and inject NaN into the sort comparator,
			// corrupting ordering for the whole analysis.
			if (typeof parsed !== "object" || parsed === null || typeof (parsed as { ts?: unknown }).ts !== "number") {
				continue;
			}
			const event = parsed as SessionEvent;
			if (opts.since !== undefined && event.ts < opts.since) continue;
			events.push(event);
		}
	}
	return events.sort((a, b) => a.ts - b.ts);
}
