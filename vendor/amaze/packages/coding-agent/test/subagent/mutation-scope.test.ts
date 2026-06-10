import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@amaze/coding-agent/config/settings";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";
import { enforceMutationScope } from "@amaze/coding-agent/subagent/mutation-scope";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { ConflictHistory } from "@amaze/coding-agent/tools/conflict-detect";

function createSession(cwd: string, contract: SubagentContract): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getSubagentContract: () => contract,
	};
}

const contract: SubagentContract = {
	role: "canonical-mutation-scope-test",
	scope: {
		include: ["allowed/**"],
		exclude: [],
	},
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
};

describe("canonical mutation scope", () => {
	let cwd: string;
	let outside: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-scope-cwd-"));
		outside = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-scope-outside-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("throws when an absolute path resolves outside cwd", async () => {
		const session = createSession(cwd, contract);
		const target = path.join(outside, "leak.ts");

		await expect(enforceMutationScope(session, target, { op: "update", source: "test" })).rejects.toThrow(
			/resolves outside cwd/,
		);
	});

	it("throws when a parent-relative path escapes cwd", async () => {
		const session = createSession(cwd, contract);
		const escapingPath = path.relative(cwd, path.join(outside, "escape.ts"));
		expect(escapingPath.startsWith("..")).toBe(true);

		await expect(enforceMutationScope(session, escapingPath, { op: "create", source: "test" })).rejects.toThrow(
			/resolves outside cwd/,
		);
	});

	it("throws when a symlink inside cwd targets outside cwd", async () => {
		const session = createSession(cwd, contract);
		const outsideTarget = path.join(outside, "real.ts");
		const symlinkPath = path.join(cwd, "allowed", "link.ts");
		await fs.writeFile(outsideTarget, "outside");
		await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
		await fs.symlink(outsideTarget, symlinkPath);

		await expect(enforceMutationScope(session, "allowed/link.ts", { op: "update", source: "test" })).rejects.toThrow(
			/resolves outside cwd/,
		);
	});

	it("allows cwd-relative paths matching scope.include", async () => {
		const session = createSession(cwd, contract);

		await expect(
			enforceMutationScope(session, "allowed/ok.ts", { op: "create", source: "test" }),
		).resolves.toBeUndefined();
	});

	it("enforces mission scope (not goal scope) when a mission scope is present and no contract", async () => {
		// Mission is the canonical authority when present.
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getActiveMissionScope: () => ({ allowedPaths: ["src/**"], deniedPaths: ["src/secret/**"] }),
		};

		await expect(
			enforceMutationScope(session, "src/ok.ts", { op: "update", source: "test" }),
		).resolves.toBeUndefined();
		await expect(
			enforceMutationScope(session, "src/secret/key.ts", { op: "update", source: "test" }),
		).rejects.toThrow(/Mission scope violation/);
	});

	it("treats empty mission allowedPaths as unrestricted (deniedPaths still block)", async () => {
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getActiveMissionScope: () => ({ allowedPaths: [], deniedPaths: ["vendor/**"] }),
		};

		await expect(
			enforceMutationScope(session, "anywhere/file.ts", { op: "create", source: "test" }),
		).resolves.toBeUndefined();
		await expect(enforceMutationScope(session, "vendor/dep.ts", { op: "update", source: "test" })).rejects.toThrow(
			/Mission scope violation/,
		);
	});

	it("applies conflict://N using the registered backing file path", async () => {
		const session = createSession(cwd, contract);
		const backingPath = path.join(cwd, "allowed", "conflicted.ts");
		await fs.mkdir(path.dirname(backingPath), { recursive: true });
		await fs.writeFile(backingPath, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
		const history = new ConflictHistory();
		session.conflictHistory = history;
		history.register({
			absolutePath: backingPath,
			displayPath: "allowed/conflicted.ts",
			startLine: 1,
			endLine: 5,
			separatorLine: 3,
			oursLines: ["ours"],
			theirsLines: ["theirs"],
			baseLines: [],
		});

		await enforceMutationScope(session, "conflict://1", { op: "update", source: "test" });
	});
});
