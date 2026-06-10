import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@amaze/coding-agent/config/settings";
import { EditTool } from "@amaze/coding-agent/edit";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";
import type { ToolSession } from "@amaze/coding-agent/tools";

function createSession(cwd: string, contract: SubagentContract): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getSubagentContract: () => contract,
	} as unknown as ToolSession;
}

const contract: SubagentContract = {
	role: "apply-patch-scope-test",
	scope: {
		include: ["src/foo/**"],
		exclude: [],
	},
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
};

const patch = (files: string[]) => ["*** Begin Patch", ...files, "*** End Patch"].join("\n");
const addFile = (filePath: string) => [`*** Add File: ${filePath}`, "+export const value = 1;"].join("\n");

describe("apply_patch scope guard", () => {
	let tool: EditTool;
	let tmpCwd = "";

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-scope-"));
		tool = new EditTool(createSession(tmpCwd, contract));
	});

	afterEach(async () => {
		await fs.rm(tmpCwd, { recursive: true, force: true });
	});

	it("rejects an apply_patch envelope containing an out-of-scope file entry", async () => {
		await expect(
			tool.execute("call-apply-patch-scope-deny", {
				input: patch([addFile("src/foo/a.ts"), addFile("src/bar/b.ts")]),
			}),
		).rejects.toThrow(/SubagentContract scope violation/);
	});

	it("allows an apply_patch envelope when every file entry is in scope", async () => {
		await expect(
			tool.execute("call-apply-patch-scope-allow", {
				input: patch([addFile("src/foo/a.ts"), addFile("src/foo/c.ts")]),
			}),
		).resolves.toBeDefined();
	});
});
