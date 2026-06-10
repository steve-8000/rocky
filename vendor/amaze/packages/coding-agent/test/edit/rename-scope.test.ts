import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@amaze/coding-agent/config/settings";
import { EditTool } from "@amaze/coding-agent/edit";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";
import type { ToolSession } from "@amaze/coding-agent/tools";

function createSession(cwd: string, contract: SubagentContract): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getSubagentContract: () => contract,
	} as unknown as ToolSession;
}

const contract: SubagentContract = {
	role: "rename-scope-test",
	scope: {
		include: ["src/foo/**"],
		exclude: [],
	},
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 1000 },
};

describe("patch rename destination scope guard", () => {
	let tool: EditTool;
	let tmpCwd = "";

	beforeEach(async () => {
		resetSettingsForTest();
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rename-scope-"));
		await Settings.init({ inMemory: true, cwd: tmpCwd });
		tool = new EditTool(createSession(tmpCwd, contract));
	});

	afterEach(async () => {
		resetSettingsForTest();
		await fs.rm(tmpCwd, { recursive: true, force: true });
	});

	it("rejects a rename whose source is in scope but destination is out of scope", async () => {
		await expect(
			tool.execute("call-rename-scope-deny", {
				path: "src/foo/a.ts",
				edits: [{ op: "update", rename: "src/bar/b.ts", diff: "" }],
			}),
		).rejects.toThrow(/SubagentContract scope violation/);
	});

	it("allows a rename when source and destination are both in scope", async () => {
		await fs.mkdir(path.join(tmpCwd, "src/foo"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, "src/foo/a.ts"), "export const value = 1;\n");

		await expect(
			tool.execute("call-rename-scope-allow", {
				path: "src/foo/a.ts",
				edits: [
					{ op: "update", rename: "src/foo/b.ts", diff: "@@\n-export const value = 1;\n+export const value = 2;" },
				],
			}),
		).resolves.toBeDefined();
	});
});
