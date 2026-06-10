import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SettingsSnapshot = {
	type: "settings";
	path: string;
	contents: string | null;
};

export type SkillSnapshot = {
	type: "skill";
	path: string;
	contents: string | null;
};

export type RuleSnapshot = {
	type: "rule";
	path: string;
	contents: string | null;
};

export type MemorySnapshot = {
	type: "memory";
	mode: "noop";
};

export type PromotionSnapshot = SettingsSnapshot | SkillSnapshot | RuleSnapshot | MemorySnapshot;

export async function snapshotFile(type: "settings" | "skill" | "rule", filePath: string): Promise<PromotionSnapshot> {
	return {
		type,
		path: filePath,
		contents: await readExistingFile(filePath),
	} as PromotionSnapshot;
}

export async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmpPath, contents, "utf8");
	await fs.rename(tmpPath, filePath);
}

export async function restoreSnapshot(snapshot: PromotionSnapshot): Promise<void> {
	if (snapshot.type === "memory") {
		return;
	}
	if (snapshot.contents === null) {
		await fs.rm(snapshot.path, { force: true });
		return;
	}
	await writeFileAtomically(snapshot.path, snapshot.contents);
}

async function readExistingFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}
