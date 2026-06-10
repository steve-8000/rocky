import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSkillCurator } from "@amaze/coding-agent/extensibility/skill-curator";
import { SkillManager } from "@amaze/coding-agent/extensibility/skill-manager";
import { loadSkillsFromDir } from "@amaze/coding-agent/extensibility/skills";

async function makeAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "amaze-skill-manager-"));
}

describe("SkillManager", () => {
	it("creates a local skill that the existing loader can discover", async () => {
		const agentDir = await makeAgentDir();
		const manager = new SkillManager({ agentDir });
		await manager.create({
			name: "sample-skill",
			description: "A managed skill for tests.",
			body: "# Sample Skill\n\nUse this skill when testing the manager.",
		});
		const result = await loadSkillsFromDir({ dir: path.join(agentDir, "skills"), source: "test:user" });
		expect(result.skills.map(skill => skill.name)).toContain("sample-skill");
	});

	it("rejects path traversal and unsupported support-file roots", async () => {
		const agentDir = await makeAgentDir();
		const manager = new SkillManager({ agentDir });
		await manager.create({
			name: "safe-skill",
			description: "Safe skill.",
			body: "# Safe\n\nStay inside the skill.",
		});
		await expect(
			manager.writeFile({ name: "safe-skill", relativePath: "../escape.txt", content: "bad" }),
		).rejects.toThrow("traversal");
		await expect(
			manager.writeFile({ name: "safe-skill", relativePath: "other/file.txt", content: "bad" }),
		).rejects.toThrow("Support files");
	});

	it("fails ambiguous patches without changing the skill", async () => {
		const agentDir = await makeAgentDir();
		const manager = new SkillManager({ agentDir });
		await manager.create({ name: "patch-skill", description: "Patch skill.", body: "# Patch\n\nRepeat\nRepeat" });
		await expect(manager.patch({ name: "patch-skill", oldText: "Repeat", newText: "Once" })).rejects.toThrow(
			"more than once",
		);
		const inspected = await manager.inspect("patch-skill");
		expect(inspected.content).toContain("Repeat\nRepeat");
	});

	it("curates skill usage into deterministic stale classifications", async () => {
		const agentDir = await makeAgentDir();
		const manager = new SkillManager({ agentDir });
		await manager.create({ name: "old-skill", description: "Old skill.", body: "# Old\n\nOld instructions." });
		await fs.writeFile(
			path.join(agentDir, "skills", ".usage.json"),
			JSON.stringify({
				"old-skill": {
					use_count: 3,
					created_at: "2025-01-01T00:00:00.000Z",
					last_used_at: "2025-01-01T00:00:00.000Z",
				},
			}),
			"utf8",
		);
		const report = await runSkillCurator({
			agentDir,
			now: new Date("2026-01-01T00:00:00.000Z"),
			staleAfterDays: 30,
			archiveAfterDays: 120,
		});
		expect(report.candidates).toEqual([
			expect.objectContaining({ name: "old-skill", status: "archive-candidate", useCount: 3 }),
		]);
		const state = JSON.parse(await fs.readFile(path.join(agentDir, "skills", ".curator_state.json"), "utf8"));
		expect(state.lastRunSummary).toContain("archive-candidate:1");
	});
});
