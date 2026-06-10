import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@amaze/ai";
import { ModelRegistry } from "@amaze/coding-agent/config/model-registry";
import { Settings } from "@amaze/coding-agent/config/settings";
import type { Skill } from "@amaze/coding-agent/extensibility/skills";
import { createAgentSession } from "@amaze/coding-agent/sdk";
import { SessionManager } from "@amaze/coding-agent/session/session-manager";

function createSkill(root: string): Skill {
	return {
		name: "sample-skill",
		description: "Skill description",
		filePath: path.join(root, "skills", "sample", "SKILL.md"),
		baseDir: path.join(root, "skills"),
		source: "project",
	};
}

describe("main prompt context mode", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-context-mode-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the top-level orchestrator prompt compact by default", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [createSkill(tempDir)],
			contextFiles: [
				{ path: path.join(tempDir, "root", "AGENTS.md"), content: "Root context instructions" },
				{ path: path.join(tempDir, "app", "AGENTS.md"), content: "Nearest context instructions" },
			],
			workspaceTree: {
				rootPath: tempDir,
				rendered: ".\n  - src/        1m",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: ["packages/coding-agent/AGENTS.md"],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			const promptText = session.systemPrompt.join("\n\n");
			expect(promptText).toContain("Nearest context instructions");
			expect(promptText).not.toContain("Root context instructions");
			expect(promptText).not.toContain("<workspace-tree>");
			expect(promptText).not.toContain("sample-skill");
			expect(session.agent.cacheRetention).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps subagent prompts full even when the main setting is compact", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [createSkill(tempDir)],
			contextFiles: [
				{ path: path.join(tempDir, "root", "AGENTS.md"), content: "Root context instructions" },
				{ path: path.join(tempDir, "app", "AGENTS.md"), content: "Nearest context instructions" },
			],
			workspaceTree: {
				rootPath: tempDir,
				rendered: ".\n  - src/        1m",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: ["packages/coding-agent/AGENTS.md"],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			parentTaskPrefix: "0-Task",
			taskDepth: 1,
		});
		try {
			const promptText = session.systemPrompt.join("\n\n");
			expect(promptText).toContain("Root context instructions");
			expect(promptText).toContain("Nearest context instructions");
			expect(promptText).toContain("<workspace-tree>");
			expect(promptText).toContain("sample-skill");
			expect(session.agent.cacheRetention).toBe("short");
		} finally {
			await session.dispose();
		}
	});
});
