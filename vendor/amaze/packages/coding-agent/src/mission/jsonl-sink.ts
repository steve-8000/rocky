import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { MissionEventBus, Unsubscribe } from "./event-bus";
import type { MissionEvent } from "./events";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_ROLLOVER_MAX_BYTES = Number.POSITIVE_INFINITY;
const DEFAULT_ROLLOVER_MAX_AGE_MS = Number.POSITIVE_INFINITY;

type Timer = ReturnType<typeof setTimeout>;

type MissionSegmentState = {
	index: number;
	startedAt: number;
	bytes: number;
};

type SinkOptions = {
	baseDir?: string;
	batchSize?: number;
	flushIntervalMs?: number;
	maxBytes?: number;
	maxAgeMs?: number;
};

export class MissionJsonlSink {
	#baseDir: string;
	#batchSize: number;
	#flushIntervalMs: number;
	#maxBytes: number;
	#maxAgeMs: number;
	#unsubscribe: Unsubscribe;
	#pending: MissionEvent[] = [];
	#timer: Timer | null = null;
	#flushChain: Promise<void> = Promise.resolve();
	#segments = new Map<string, MissionSegmentState>();
	#closed = false;

	constructor(bus: MissionEventBus, options: SinkOptions = {}) {
		this.#baseDir =
			options.baseDir ?? path.join(process.env.HOME || homedir(), ".amaze", "observability", "missions");
		this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.#maxBytes = options.maxBytes ?? DEFAULT_ROLLOVER_MAX_BYTES;
		this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_ROLLOVER_MAX_AGE_MS;
		this.#unsubscribe = bus.subscribe(event => this.#enqueue(event));
	}

	async flush(): Promise<void> {
		this.#scheduleFlush();
		await this.#flushChain;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#scheduleFlush();
		await this.#flushChain;
	}

	#enqueue(event: MissionEvent): void {
		if (this.#closed) return;
		this.#pending.push(event);
		if (this.#pending.length >= this.#batchSize) {
			this.#scheduleFlush();
		} else if (!this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = null;
				this.#scheduleFlush();
			}, this.#flushIntervalMs);
		}
	}

	#scheduleFlush(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#flushChain = this.#flushChain.then(() => this.#flushPending());
	}

	async #flushPending(): Promise<void> {
		if (this.#pending.length === 0) return;
		const batch = this.#pending.splice(0, this.#pending.length);
		const byMission = new Map<string, string[]>();
		for (const event of batch) {
			const lines = byMission.get(event.missionId) ?? [];
			lines.push(`${JSON.stringify(event)}\n`);
			byMission.set(event.missionId, lines);
		}

		await fs.mkdir(this.#baseDir, { recursive: true });
		for (const [missionId, lines] of byMission) {
			await this.#appendMissionLines(missionId, lines);
		}
	}

	async #appendMissionLines(missionId: string, lines: string[]): Promise<void> {
		for (const line of lines) {
			const segment = await this.#segmentForLine(missionId, Buffer.byteLength(line));
			await fs.appendFile(this.#missionPath(missionId, segment.index), line, "utf8");
			segment.bytes += Buffer.byteLength(line);
		}
	}

	async #segmentForLine(missionId: string, nextBytes: number): Promise<MissionSegmentState> {
		const now = Date.now();
		const current = await this.#currentSegment(missionId, now);
		if (current.bytes === 0) return current;
		const tooLarge = Number.isFinite(this.#maxBytes) && current.bytes + nextBytes > this.#maxBytes;
		const tooOld = Number.isFinite(this.#maxAgeMs) && now - current.startedAt >= this.#maxAgeMs;
		if (!tooLarge && !tooOld) return current;
		const next = { index: current.index + 1, startedAt: now, bytes: 0 };
		this.#segments.set(missionId, next);
		return next;
	}

	async #currentSegment(missionId: string, now: number): Promise<MissionSegmentState> {
		const cached = this.#segments.get(missionId);
		if (cached) return cached;
		const index = await this.#latestSegmentIndex(missionId);
		const filePath = this.#missionPath(missionId, index);
		let bytes = 0;
		let startedAt = now;
		try {
			const stat = await fs.stat(filePath);
			bytes = stat.size;
			startedAt = stat.birthtimeMs || stat.mtimeMs || now;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const segment = { index, startedAt, bytes };
		this.#segments.set(missionId, segment);
		return segment;
	}

	async #latestSegmentIndex(missionId: string): Promise<number> {
		try {
			const entries = await fs.readdir(this.#baseDir);
			let latest = 0;
			for (const entry of entries) {
				const index = parseMissionSegmentIndex(missionId, entry);
				if (index !== null && index > latest) latest = index;
			}
			return latest;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	}

	#missionPath(missionId: string, index = 0): string {
		return path.join(this.#baseDir, index === 0 ? `${missionId}.jsonl` : `${missionId}.${index}.jsonl`);
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
