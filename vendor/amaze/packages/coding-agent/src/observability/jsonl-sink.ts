import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { EventBus, Unsubscribe } from "./event-bus";
import type { SessionEvent } from "./event-schema";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;

type SinkOptions = {
	baseDir?: string;
	batchSize?: number;
	flushIntervalMs?: number;
	maxBytes?: number;
	maxAgeMs?: number;
	now?: () => number;
};

export class JsonlSessionSink {
	#baseDir: string;
	#batchSize: number;
	#flushIntervalMs: number;
	#maxBytes: number;
	#maxAgeMs: number;
	#now: () => number;
	#unsubscribe: Unsubscribe;
	#sessionId: string | null = null;
	#openedAt = 0;
	#currentBytes = 0;
	#rollover = 0;
	#pending: SessionEvent[] = [];
	#timer: Timer | null = null;
	#flushChain: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(bus: EventBus, options: SinkOptions = {}) {
		this.#baseDir = options.baseDir ?? path.join(process.env.HOME || homedir(), ".amaze", "observability");
		this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
		this.#now = options.now ?? Date.now;
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

	#enqueue(event: SessionEvent): void {
		if (this.#closed) return;
		if (event.type === "session.start") {
			if (this.#sessionId !== event.sessionId) {
				this.#sessionId = event.sessionId;
				this.#openedAt = event.ts;
				this.#currentBytes = 0;
				this.#rollover = 0;
			}
		} else if (!this.#sessionId) {
			return;
		}

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
		if (!this.#sessionId || this.#pending.length === 0) return;
		const batch = this.#pending.splice(0, this.#pending.length);
		await fs.mkdir(this.#sessionsDir(), { recursive: true });

		let lines = "";
		for (const event of batch) {
			const line = `${JSON.stringify(event)}\n`;
			if (this.#shouldRollover(event.ts, line.length)) {
				await this.#append(lines);
				lines = "";
				this.#rollover += 1;
				this.#openedAt = event.ts;
				this.#currentBytes = 0;
			}
			lines += line;
			this.#currentBytes += Buffer.byteLength(line);
		}
		await this.#append(lines);
	}

	#shouldRollover(ts: number, nextLineBytes: number): boolean {
		return (
			this.#currentBytes > 0 &&
			(this.#currentBytes + nextLineBytes > this.#maxBytes || ts - this.#openedAt >= this.#maxAgeMs)
		);
	}

	async #append(content: string): Promise<void> {
		if (!content || !this.#sessionId) return;
		await fs.appendFile(this.#currentPath(), content, "utf8");
	}

	#sessionsDir(): string {
		return path.join(this.#baseDir, "sessions");
	}

	#currentPath(): string {
		const suffix = this.#rollover === 0 ? "" : `.${this.#rollover}`;
		return path.join(this.#sessionsDir(), `${this.#sessionId}${suffix}.jsonl`);
	}
}
