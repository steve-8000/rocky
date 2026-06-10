/**
 * V3 Phase 2.2 — tool-layer scope enforcement integration tests.
 *
 * These tests prove that the SubagentContract scope guard is STRUCTURAL, not
 * prompt-level: WriteTool and EditTool reject out-of-scope paths via thrown
 * ToolError BEFORE any filesystem mutation happens. A subagent under a contract
 * cannot edit outside its scope even if its system prompt is corrupted or its
 * model decides to ignore the contract block — the gate is in the tool layer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@amaze/coding-agent/config/settings";
import { EditTool } from "@amaze/coding-agent/edit";
import type { SubagentContract } from "@amaze/coding-agent/subagent/contract";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { WriteTool } from "@amaze/coding-agent/tools/write";

function createSession(cwd: string, contract?: SubagentContract): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getSubagentContract: contract ? () => contract : undefined,
	};
}

const refactorerContract: SubagentContract = {
	role: "refactor-applier",
	scope: {
		include: ["packages/coding-agent/**"],
		exclude: ["**/CHANGELOG.md"],
	},
	successCriteria: [],
	escalation: { onUncertainty: "ask-parent", budgetCap: 50000 },
};

describe("V3 Phase 2.2 — tool-layer scope enforcement", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-guard-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("WriteTool rejects paths matching scope.exclude (CHANGELOG.md hardstop)", async () => {
		const session = createSession(tmpDir, refactorerContract);
		const tool = new WriteTool(session);

		// CHANGELOG.md hits the exclude glob — the tool MUST reject before writing.
		const result = await tool
			.execute("call-1", { path: "packages/coding-agent/CHANGELOG.md", content: "tampered" })
			.then(
				r => ({ ok: true as const, r }),
				err => ({ ok: false as const, err }),
			);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(String(result.err)).toContain("scope.exclude");
			expect(String(result.err)).toContain("CHANGELOG.md");
		}
		// File MUST NOT have been created — the gate fires before any filesystem mutation.
		const created = await Bun.file(path.join(tmpDir, "packages/coding-agent/CHANGELOG.md")).exists();
		expect(created).toBe(false);
	});

	it("WriteTool rejects paths outside scope.include (positive whitelist)", async () => {
		const session = createSession(tmpDir, refactorerContract);
		const tool = new WriteTool(session);

		const result = await tool.execute("call-2", { path: "packages/ai/src/leak.ts", content: "out of scope" }).then(
			r => ({ ok: true as const, r }),
			err => ({ ok: false as const, err }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(String(result.err)).toContain("outside contract scope.include");
		}
	});

	it("WriteTool allows in-scope writes (positive control — guard does not over-reject)", async () => {
		// Use a relative path: contract globs are matched against the path as the model
		// writes it. Most models work with project-relative paths; the guard is intentionally
		// literal (no path-relativization heuristic that could disagree with the model's view).
		const session = createSession(tmpDir, refactorerContract);
		const targetDir = path.join(tmpDir, "packages/coding-agent/src");
		await fs.mkdir(targetDir, { recursive: true });
		const tool = new WriteTool(session);

		await tool.execute(
			"call-3",
			// Provide both a relative path (matches the glob) AND the actual filesystem
			// destination by working from tmpDir as cwd. WriteTool resolves the relative
			// path against the session cwd internally.
			{ path: "packages/coding-agent/src/ok.ts", content: "valid in-scope" },
		);
		const written = await Bun.file(path.join(targetDir, "ok.ts")).text();
		expect(written).toBe("valid in-scope");
	});

	it("WriteTool with no contract behaves as before (backward compat)", async () => {
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const filePath = "anywhere.txt";

		await tool.execute("call-4", { path: filePath, content: "no contract" });
		const written = await Bun.file(path.join(tmpDir, filePath)).text();
		expect(written).toBe("no contract");
	});

	it("EditTool rejects edits to paths violating scope.exclude", async () => {
		const session = createSession(tmpDir, refactorerContract);
		const targetPath = path.join(tmpDir, "packages/coding-agent/CHANGELOG.md");
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, "# original\n");

		const tool = new EditTool(session);

		const result = await tool
			.execute("call-5", {
				path: "packages/coding-agent/CHANGELOG.md",
				edits: [{ old: "# original", new: "# tampered" }],
			} as never)
			.then(
				r => ({ ok: true as const, r }),
				err => ({ ok: false as const, err }),
			);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(String(result.err)).toContain("scope.exclude");
		}
		// File contents MUST be untouched.
		const after = await fs.readFile(targetPath, "utf8");
		expect(after).toBe("# original\n");
	});

	it("PHASE 2.2 ACCEPTANCE: structural enforcement (tool layer, not prompt) — guard fires regardless of whether the model 'sees' the contract", async () => {
		// The point of moving enforcement to the tool layer is that prompt-level rules
		// ("don't edit X") can be ignored under pressure. The guard runs based on session
		// state, not on any prompt input. To prove this, we construct a session whose
		// contract is set but verify the rejection comes from the tool — not from any
		// prompt rendering.
		const session = createSession(tmpDir, refactorerContract);
		const tool = new WriteTool(session);

		await expect(tool.execute("call-6", { path: "external/leak.ts", content: "anywhere" })).rejects.toThrow(
			/SubagentContract scope violation/,
		);
	});
});
