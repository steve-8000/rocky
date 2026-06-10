import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus, JsonlSessionSink, type SessionEvent } from "../../src/observability";

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

function turnEvent(turn: number): SessionEvent {
	return { type: "turn.start", sessionId: "session-1", ts: turn, turn };
}

let tmpDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tmpDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tmpDirs = [];
});

describe("JsonlSessionSink", () => {
	it("writes emitted session events as parseable JSONL", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-jsonl-sink-"));
		tmpDirs.push(tmpDir);
		const bus = new EventBus();
		const sink = new JsonlSessionSink(bus, { baseDir: tmpDir });

		bus.emit({ type: "session.start", sessionId: "session-1", ts: 0, cwd: "/tmp/project", agent: "test" });
		for (let turn = 1; turn < 100; turn += 1) {
			bus.emit(turnEvent(turn));
		}
		await tick();
		await sink.flush();

		const filePath = path.join(tmpDir, "sessions", "session-1.jsonl");
		const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");

		expect(lines).toHaveLength(100);
		expect(lines.map(line => JSON.parse(line)).at(0)).toEqual({
			type: "session.start",
			sessionId: "session-1",
			ts: 0,
			cwd: "/tmp/project",
			agent: "test",
		});
		expect(lines.map(line => JSON.parse(line)).at(-1)).toEqual(turnEvent(99));

		await sink.close();
	});
});
