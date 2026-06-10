import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@amaze/coding-agent/config/settings";
import { enforceMutationScope } from "@amaze/coding-agent/subagent/mutation-scope";
import type { ToolSession } from "@amaze/coding-agent/tools";
import type { MissionScopeGuard } from "../../src/mission/core/mission-scope";

function createSession(cwd: string, missionScope: MissionScopeGuard | undefined): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getActiveMissionScope: () => missionScope,
	};
}

describe("active mission scope", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "active-mission-scope-cwd-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("rejects paths outside the active mission scope", async () => {
		const session = createSession(cwd, { allowedPaths: ["src/foo/**"], deniedPaths: [] });

		await expect(enforceMutationScope(session, "src/bar/baz.ts", { op: "update", source: "test" })).rejects.toThrow(
			/Mission scope violation:.*mission-level guard/,
		);
	});

	it("falls back to goal scope when no active mission scope exists", async () => {
		const session = createSession(cwd, undefined);

		await expect(
			enforceMutationScope(session, "src/anything.ts", { op: "update", source: "test" }),
		).resolves.toBeUndefined();
	});
});
