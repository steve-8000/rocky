import { describe, expect, it, vi } from "bun:test";
import type { BrowserHandle } from "../../src/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import { acquireTab, releaseAllTabs, releaseTabsForOwner } from "../../src/tools/browser/tab-supervisor";

class FakeWorker {
	readonly mode = "worker" as const;
	readonly sent: WorkerInbound[] = [];
	terminate = vi.fn(async () => {});
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
		if (msg.type === "init") queueMicrotask(() => this.emit({ type: "ready", info: readyInfo("target") }));
		if (msg.type === "close") queueMicrotask(() => this.emit({ type: "closed" }));
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	emit(msg: WorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(msg);
	}
}

function readyInfo(targetId: string): ReadyInfo {
	return {
		targetId,
		url: "about:blank",
		title: "",
		viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
	};
}

function makeBrowser(key: string): BrowserHandle {
	return {
		key,
		kind: { kind: "headless", headless: true },
		browser: {
			connected: true,
			wsEndpoint: () => `ws://127.0.0.1/devtools/browser/${key}`,
			close: vi.fn(async () => {}),
		} as unknown as BrowserHandle["browser"],
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

describe("browser session cleanup", () => {
	it("releases only tabs owned by the requested session", async () => {
		const originalWorker = globalThis.Worker;
		const workers: FakeWorker[] = [];
		(globalThis as typeof globalThis & { Worker: typeof Worker }).Worker = class {
			readonly fake = new FakeWorker();
			constructor() {
				workers.push(this.fake);
			}
			postMessage(msg: WorkerInbound): void {
				this.fake.send(msg);
			}
			addEventListener(type: string, handler: EventListener): void {
				if (type === "message") {
					this.fake.onMessage(msg => handler({ data: msg } as MessageEvent<WorkerOutbound>));
				}
			}
			removeEventListener(): void {}
			terminate(): void {
				void this.fake.terminate();
			}
		} as unknown as typeof Worker;

		try {
			await acquireTab("owned", makeBrowser("owned-browser"), { timeoutMs: 1_000, ownerId: "owner-a" });
			await acquireTab("other", makeBrowser("other-browser"), { timeoutMs: 1_000, ownerId: "owner-b" });

			const released = await releaseTabsForOwner("owner-a", { kill: true });

			expect(released).toBe(1);
			expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
			expect(workers[1]?.terminate).not.toHaveBeenCalled();
			expect(workers[0]?.sent.some(msg => msg.type === "close")).toBe(true);
			expect(workers[1]?.sent.some(msg => msg.type === "close")).toBe(false);
		} finally {
			globalThis.Worker = originalWorker;
			await releaseAllTabs({ kill: true });
		}
	});
});
