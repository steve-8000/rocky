import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@amaze/utils";

/**
 * Skill activation telemetry sidecar.
 *
 * `amaze` exposes skills through `/skill:<name>` slash-command activation.
 * That single activation event is what we count; there is no distinct "view"
 * step in the runtime, so the schema stays narrow: one counter + timestamp.
 *
 * Stored as a single JSON file at `<agentDir>/skills/.usage.json`. Writes
 * serialize per process via an in-memory queue keyed on the file path to
 * prevent lost updates from concurrent bumps; cross-process safety is not
 * required because amaze runs one agent process per agentDir at a time.
 */

export interface SkillUsageRecord {
	use_count: number;
	last_used_at: string | null;
	created_at: string;
}

export type SkillUsageMap = Record<string, SkillUsageRecord>;

export function getSkillUsagePath(agentDir: string): string {
	return path.join(agentDir, "skills", ".usage.json");
}

async function readSkillUsage(filePath: string): Promise<SkillUsageMap> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SkillUsageMap;
		return {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		logger.debug("Skill usage read failed; resetting in-memory", { error: String(error) });
		return {};
	}
}

async function writeSkillUsageAtomic(filePath: string, data: SkillUsageMap): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await fs.rename(tmp, filePath);
}

const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const prev = queues.get(filePath) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(fn);
	queues.set(
		filePath,
		next.catch(() => undefined),
	);
	return next;
}

export function bumpSkillUse(agentDir: string, name: string): Promise<void> {
	const filePath = getSkillUsagePath(agentDir);
	return enqueue(filePath, async () => {
		const data = await readSkillUsage(filePath);
		const now = new Date().toISOString();
		const record = data[name] ?? { use_count: 0, last_used_at: null, created_at: now };
		record.use_count += 1;
		record.last_used_at = now;
		data[name] = record;
		await writeSkillUsageAtomic(filePath, data);
	}).catch(error => {
		logger.debug("Skill usage bump failed", { error: String(error) });
	});
}

export async function readSkillUsageSnapshot(agentDir: string): Promise<SkillUsageMap> {
	return readSkillUsage(getSkillUsagePath(agentDir));
}
