import * as path from "node:path";
import { createAgentSession } from "../sdk";
import { SessionManager } from "../session/session-manager";
import type {
	GatewayRuntimeConfig,
	GatewaySessionFactory,
	GatewaySessionHandle,
	GatewaySessionLike,
	GatewaySource,
} from "./types";

export interface GatewaySessionStoreOptions {
	config: GatewayRuntimeConfig;
	createSession?: GatewaySessionFactory;
}

export class GatewaySessionStore {
	readonly #config: GatewayRuntimeConfig;
	readonly #createSession: GatewaySessionFactory;
	readonly #handles = new Map<string, GatewaySessionHandle>();
	readonly #forceNew = new Set<string>();

	constructor(options: GatewaySessionStoreOptions) {
		this.#config = options.config;
		this.#createSession = options.createSession ?? this.#createAmazeSession;
	}

	get activeKeys(): string[] {
		return [...this.#handles.keys()].sort();
	}

	buildKey(source: GatewaySource): string {
		return buildGatewaySessionKey(source, this.#config.platforms[source.platform]?.sessionScope ?? "chat");
	}

	async get(source: GatewaySource): Promise<GatewaySessionHandle> {
		const key = this.buildKey(source);
		const existing = this.#handles.get(key);
		if (existing && !this.#forceNew.has(key)) {
			existing.lastUsedAt = Date.now();
			return existing;
		}
		if (existing) {
			await existing.session.dispose?.();
			this.#handles.delete(key);
		}
		const sessionDir = this.sessionDirForKey(key);
		const forceNew = this.#forceNew.has(key);
		const session = await this.#createSession({ key, source, sessionDir, forceNew });
		const handle = { key, session, createdAt: Date.now(), lastUsedAt: Date.now() };
		this.#handles.set(key, handle);
		this.#forceNew.delete(key);
		return handle;
	}

	async reset(source: GatewaySource): Promise<void> {
		const key = this.buildKey(source);
		const existing = this.#handles.get(key);
		if (existing) {
			await existing.session.dispose?.();
			this.#handles.delete(key);
		}
		this.#forceNew.add(key);
	}

	async dispose(): Promise<void> {
		const handles = [...this.#handles.values()];
		this.#handles.clear();
		await Promise.all(handles.map(handle => handle.session.dispose?.()));
	}

	sessionDirForKey(key: string): string {
		return path.join(this.#config.sessionDir, encodeSessionKey(key));
	}

	#createAmazeSession: GatewaySessionFactory = async ({ sessionDir, forceNew }) => {
		const sessionManager = forceNew
			? SessionManager.create(this.#config.cwd, sessionDir)
			: await SessionManager.continueRecent(this.#config.cwd, sessionDir);
		const { session } = await createAgentSession({
			cwd: this.#config.cwd,
			agentDir: this.#config.agentDir,
			sessionManager,
			hasUI: false,
		});
		return session as GatewaySessionLike;
	};
}

export function buildGatewaySessionKey(source: GatewaySource, scope: "chat" | "user" | "thread" = "chat"): string {
	const parts: string[] = [source.platform];
	if (scope === "thread") {
		parts.push(source.chatId, source.threadId ?? "main");
	} else if (scope === "user") {
		parts.push(source.chatId, source.userId ?? "anonymous");
	} else {
		parts.push(source.chatId);
	}
	return parts.map(normalizeKeyPart).join(":");
}

export function encodeSessionKey(key: string): string {
	return encodeURIComponent(key).replace(/%/g, "_");
}

function normalizeKeyPart(part: string): string {
	return part.replace(/[\r\n\t]/g, " ").trim() || "unknown";
}
