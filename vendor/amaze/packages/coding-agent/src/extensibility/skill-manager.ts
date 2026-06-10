import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@amaze/utils";

export type SkillManageAction = "create" | "inspect" | "list" | "write_file" | "remove_file" | "patch" | "delete";

export interface SkillManagerOptions {
	agentDir?: string;
	skillsDir?: string;
}

export interface SkillManageResult {
	action: SkillManageAction;
	path?: string;
	name?: string;
	changed: boolean;
	message: string;
	entries?: Array<{ name: string; path: string; description?: string }>;
	content?: string;
}

export interface CreateSkillInput {
	name: string;
	description: string;
	body: string;
	overwrite?: boolean;
}

export interface SkillFileInput {
	name: string;
	relativePath: string;
	content?: string;
	overwrite?: boolean;
}

export interface PatchSkillInput {
	name: string;
	relativePath?: string;
	oldText: string;
	newText: string;
}

export interface DeleteSkillInput {
	name: string;
	absorbedInto?: string;
}

export class SkillManager {
	readonly skillsDir: string;

	constructor(options: SkillManagerOptions = {}) {
		this.skillsDir = path.resolve(options.skillsDir ?? path.join(options.agentDir ?? getAgentDir(), "skills"));
	}

	async list(): Promise<SkillManageResult> {
		const entries: Array<{ name: string; path: string; description?: string }> = [];
		try {
			for (const dirent of await fs.readdir(this.skillsDir, { withFileTypes: true })) {
				if (!dirent.isDirectory()) continue;
				const skillFile = path.join(this.skillsDir, dirent.name, "SKILL.md");
				try {
					const content = await fs.readFile(skillFile, "utf8");
					const frontmatter = parseFrontmatter(content);
					entries.push({
						name: frontmatter.name ?? dirent.name,
						description: frontmatter.description,
						path: skillFile,
					});
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		return { action: "list", changed: false, message: `${entries.length} skills`, entries };
	}

	async inspect(name: string): Promise<SkillManageResult> {
		const skillDir = this.resolveSkillDir(name);
		const skillFile = path.join(skillDir, "SKILL.md");
		const content = await fs.readFile(skillFile, "utf8");
		return { action: "inspect", name, path: skillFile, changed: false, message: `Read ${name}`, content };
	}

	async create(input: CreateSkillInput): Promise<SkillManageResult> {
		const skillDir = this.resolveSkillDir(input.name);
		const skillFile = path.join(skillDir, "SKILL.md");
		if (!input.overwrite && (await exists(skillFile))) {
			throw new Error(`Skill already exists: ${input.name}`);
		}
		const body = normalizeSkillBody(input.body);
		const content = `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${body}\n`;
		validateSkillMarkdown(content, input.name);
		await fs.mkdir(skillDir, { recursive: true });
		await writeFileAtomic(skillFile, content);
		return { action: "create", name: input.name, path: skillFile, changed: true, message: `Created ${input.name}` };
	}

	async writeFile(input: SkillFileInput): Promise<SkillManageResult> {
		if (input.content === undefined) throw new Error("content is required for write_file");
		const filePath = this.resolveSkillFile(input.name, input.relativePath);
		if (!input.overwrite && (await exists(filePath))) {
			throw new Error(`File already exists: ${input.relativePath}`);
		}
		if (path.basename(filePath) === "SKILL.md") validateSkillMarkdown(input.content, input.name);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await writeFileAtomic(filePath, input.content);
		return {
			action: "write_file",
			name: input.name,
			path: filePath,
			changed: true,
			message: `Wrote ${input.relativePath}`,
		};
	}

	async removeFile(input: SkillFileInput): Promise<SkillManageResult> {
		const filePath = this.resolveSkillFile(input.name, input.relativePath);
		if (path.basename(filePath) === "SKILL.md") throw new Error("Use delete to remove a skill");
		await fs.rm(filePath, { force: true });
		return {
			action: "remove_file",
			name: input.name,
			path: filePath,
			changed: true,
			message: `Removed ${input.relativePath}`,
		};
	}

	async patch(input: PatchSkillInput): Promise<SkillManageResult> {
		if (!input.oldText) throw new Error("oldText is required for patch");
		const relativePath = input.relativePath ?? "SKILL.md";
		const filePath = this.resolveSkillFile(input.name, relativePath);
		const content = await fs.readFile(filePath, "utf8");
		const first = content.indexOf(input.oldText);
		if (first === -1) throw new Error("Patch oldText was not found");
		if (content.indexOf(input.oldText, first + input.oldText.length) !== -1) {
			throw new Error("Patch oldText matched more than once");
		}
		const next = `${content.slice(0, first)}${input.newText}${content.slice(first + input.oldText.length)}`;
		if (path.basename(filePath) === "SKILL.md") validateSkillMarkdown(next, input.name);
		await writeFileAtomic(filePath, next);
		return { action: "patch", name: input.name, path: filePath, changed: true, message: `Patched ${relativePath}` };
	}

	async delete(input: DeleteSkillInput): Promise<SkillManageResult> {
		const skillDir = this.resolveSkillDir(input.name);
		if (input.absorbedInto) assertSafeSkillName(input.absorbedInto);
		await fs.rm(skillDir, { recursive: true, force: true });
		const suffix = input.absorbedInto ? `; absorbed into ${input.absorbedInto}` : "";
		return {
			action: "delete",
			name: input.name,
			path: skillDir,
			changed: true,
			message: `Deleted ${input.name}${suffix}`,
		};
	}

	resolveSkillDir(name: string): string {
		assertSafeSkillName(name);
		return path.join(this.skillsDir, name);
	}

	resolveSkillFile(name: string, relativePath: string): string {
		const skillDir = this.resolveSkillDir(name);
		const normalized = normalizeSkillRelativePath(relativePath);
		const filePath = path.resolve(skillDir, normalized);
		if (!isPathInside(skillDir, filePath)) throw new Error("Skill file path escapes the skill directory");
		return filePath;
	}
}

export function assertSafeSkillName(name: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(name)) {
		throw new Error("Skill name must be lower-case letters, numbers, and hyphens only");
	}
	if (name.includes("--")) throw new Error("Skill name cannot contain consecutive hyphens");
}

export function normalizeSkillRelativePath(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized || normalized.endsWith("/")) throw new Error("Skill file path must target a file");
	const parts = normalized.split("/");
	if (parts.some(part => part === "" || part === "." || part === "..")) {
		throw new Error("Skill file path cannot contain traversal segments");
	}
	if (normalized !== "SKILL.md") {
		const [top] = parts;
		if (!top || !["references", "templates", "scripts", "assets"].includes(top)) {
			throw new Error("Support files must be under references, templates, scripts, or assets");
		}
	}
	return parts.join("/");
}

export function validateSkillMarkdown(content: string, expectedName?: string): void {
	const frontmatter = parseFrontmatter(content);
	if (!frontmatter.name) throw new Error("SKILL.md frontmatter requires name");
	if (!frontmatter.description) throw new Error("SKILL.md frontmatter requires description");
	assertSafeSkillName(frontmatter.name);
	if (expectedName && frontmatter.name !== expectedName) {
		throw new Error(`SKILL.md name ${frontmatter.name} does not match ${expectedName}`);
	}
}

export function parseFrontmatter(content: string): { name?: string; description?: string } {
	if (!content.startsWith("---\n")) throw new Error("SKILL.md must start with frontmatter");
	const end = content.indexOf("\n---", 4);
	if (end === -1) throw new Error("SKILL.md frontmatter is not closed");
	const raw = content.slice(4, end).split("\n");
	const result: { name?: string; description?: string } = {};
	for (const line of raw) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line
			.slice(idx + 1)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if (key === "name") result.name = value;
		if (key === "description") result.description = value;
	}
	return result;
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, content, "utf8");
	await fs.rename(tmp, filePath);
}

function normalizeSkillBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) throw new Error("Skill body is required");
	return trimmed;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
