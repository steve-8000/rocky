import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { MissionEvent } from "./events";

export type ReadMissionEventsOptions = {
	baseDir?: string;
};

export async function readMissionEvents(
	missionId: string,
	opts: ReadMissionEventsOptions = {},
): Promise<MissionEvent[]> {
	const baseDir = opts.baseDir ?? path.join(process.env.HOME || homedir(), ".amaze", "observability", "missions");
	const filePaths = await missionEventSegmentPaths(baseDir, missionId);
	if (filePaths.length === 0) return [];

	const events: MissionEvent[] = [];
	for (const filePath of filePaths) {
		const content = await fs.readFile(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			events.push(JSON.parse(line) as MissionEvent);
		}
	}
	return events;
}

async function missionEventSegmentPaths(baseDir: string, missionId: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(baseDir);
		return entries
			.map(fileName => ({ fileName, index: parseMissionSegmentIndex(missionId, fileName) }))
			.filter((entry): entry is { fileName: string; index: number } => entry.index !== null)
			.sort((a, b) => a.index - b.index)
			.map(entry => path.join(baseDir, entry.fileName));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function parseMissionSegmentIndex(missionId: string, fileName: string): number | null {
	if (fileName === `${missionId}.jsonl`) return 0;
	const prefix = `${missionId}.`;
	const suffix = ".jsonl";
	if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;
	const value = fileName.slice(prefix.length, -suffix.length);
	if (!/^[1-9]\d*$/.test(value)) return null;
	return Number(value);
}
