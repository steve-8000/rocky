/**
 * readSessionEvents robustness: skips syntactically-corrupt AND shape-invalid lines
 * (valid JSON lacking a numeric `ts`), so a partially-flushed/hand-edited JSONL can't
 * inject undefined-ts records that escape the `since` filter or NaN-corrupt the sort.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionEvents } from "../../src/observability/session-events";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-events-"));
	await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("readSessionEvents", () => {
	it("keeps well-formed events and drops corrupt + shape-invalid lines", async () => {
		const lines = [
			JSON.stringify({
				type: "goal.complete",
				sessionId: "s",
				ts: 2,
				goalId: "g2",
				verdict: "pass",
				failedCount: 0,
				uncertainCount: 0,
			}),
			"{ not json", // syntactically corrupt
			"{}", // valid JSON, no ts
			"123", // valid JSON, not an object
			"null", // valid JSON, null
			JSON.stringify({ type: "turn.start", sessionId: "s", ts: 1, turn: 1 }),
		].join("\n");
		await fs.writeFile(path.join(dir, "sessions", "s.jsonl"), `${lines}\n`);

		const events = await readSessionEvents({ observabilityDir: dir });
		// Only the 2 well-formed events survive, sorted by ts ascending (no NaN corruption).
		expect(events.map(e => e.ts)).toEqual([1, 2]);
		expect(events.every(e => typeof e.ts === "number")).toBe(true);
	});

	it("returns [] when the sessions dir does not exist", async () => {
		expect(await readSessionEvents({ observabilityDir: path.join(dir, "nope") })).toEqual([]);
	});

	it("honors the since filter", async () => {
		const lines = [
			JSON.stringify({ type: "turn.start", sessionId: "s", ts: 1, turn: 1 }),
			JSON.stringify({ type: "turn.start", sessionId: "s", ts: 5, turn: 2 }),
		].join("\n");
		await fs.writeFile(path.join(dir, "sessions", "s.jsonl"), `${lines}\n`);
		const events = await readSessionEvents({ observabilityDir: dir, since: 3 });
		expect(events.map(e => e.ts)).toEqual([5]);
	});
});
