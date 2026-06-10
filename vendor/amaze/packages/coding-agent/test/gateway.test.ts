import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadGatewayConfig, validateGatewayConfig } from "@amaze/coding-agent/gateway/config";
import { deliverGatewayText, splitGatewayText } from "@amaze/coding-agent/gateway/delivery";
import { normalizeDiscordMessage } from "@amaze/coding-agent/gateway/platforms/discord";
import { normalizeTelegramUpdate } from "@amaze/coding-agent/gateway/platforms/telegram";
import { GatewayRunner } from "@amaze/coding-agent/gateway/runner";
import { buildGatewaySessionKey, GatewaySessionStore } from "@amaze/coding-agent/gateway/session-store";
import type {
	GatewayAdapter,
	GatewayAdapterContext,
	GatewayMessage,
	GatewayRuntimeConfig,
	GatewaySessionLike,
} from "@amaze/coding-agent/gateway/types";

function baseConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
	return {
		agentDir: "/tmp/amaze-agent",
		cwd: "/tmp/project",
		sessionDir: "/tmp/amaze-agent/gateway/sessions",
		allowAllUsers: true,
		busyBehavior: "reject",
		platforms: {
			telegram: {
				enabled: true,
				token: "telegram-token",
				allowedUsers: [],
				allowedChats: [],
				streamingMode: "final",
				sessionScope: "chat",
				ignoreBots: true,
			},
			discord: {
				enabled: false,
				allowedUsers: [],
				allowedChats: [],
				streamingMode: "final",
				sessionScope: "chat",
				ignoreBots: true,
			},
		},
		...overrides,
	};
}

class FakeSession implements GatewaySessionLike {
	readonly listeners: Array<(event: any) => void> = [];
	isStreaming = false;
	prompts: string[] = [];

	subscribe(listener: (event: any) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		for (const listener of this.listeners) {
			listener({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] },
			});
		}
	}
}

class FakeAdapter implements GatewayAdapter {
	readonly platform = "telegram" as const;
	context: GatewayAdapterContext | undefined;
	sent: string[] = [];

	async start(context: GatewayAdapterContext): Promise<void> {
		this.context = context;
	}
	async stop(): Promise<void> {}
	async send(source: GatewayMessage["source"], text: string) {
		this.sent.push(text);
		return { platform: this.platform, chatId: source.chatId, messageId: String(this.sent.length) };
	}
}

describe("gateway config and routing", () => {
	it("loads JSON config with AMAZE env overrides", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-gateway-config-"));
		const configPath = path.join(dir, "gateway.json");
		await fs.writeFile(
			configPath,
			JSON.stringify({ platforms: { telegram: { enabled: false, token: "file-token" } } }),
			"utf8",
		);
		const config = await loadGatewayConfig({
			agentDir: dir,
			cwd: dir,
			configPath,
			env: {
				AMAZE_GATEWAY_TELEGRAM_ENABLED: "true",
				AMAZE_GATEWAY_TELEGRAM_TOKEN: "env-token",
				AMAZE_GATEWAY_TELEGRAM_ALLOWED_USERS: "1, 2",
			},
		});
		expect(config.platforms.telegram.enabled).toBe(true);
		expect(config.platforms.telegram.token).toBe("env-token");
		expect(config.platforms.telegram.allowedUsers).toEqual(["1", "2"]);
		expect(validateGatewayConfig(config)).toEqual([]);
	});

	it("reports missing enabled platform tokens", () => {
		const config = baseConfig({
			platforms: {
				...baseConfig().platforms,
				telegram: { ...baseConfig().platforms.telegram, token: undefined },
			},
		});
		expect(validateGatewayConfig(config)).toContain("telegram: token is required when enabled");
	});

	it("builds deterministic session keys by scope", () => {
		const source = {
			platform: "telegram" as const,
			chatId: "chat",
			chatType: "group" as const,
			userId: "user",
			threadId: "topic",
		};
		expect(buildGatewaySessionKey(source, "chat")).toBe("telegram:chat");
		expect(buildGatewaySessionKey(source, "user")).toBe("telegram:chat:user");
		expect(buildGatewaySessionKey(source, "thread")).toBe("telegram:chat:topic");
	});

	it("normalizes Telegram and Discord inbound messages", () => {
		const telegram = normalizeTelegramUpdate({
			update_id: 7,
			message: {
				message_id: 9,
				date: 10,
				chat: { id: 123, type: "private" },
				from: { id: 5, username: "amy" },
				text: "hello",
			},
		});
		expect(telegram?.id).toBe("telegram:7");
		expect(telegram?.source.userId).toBe("5");
		expect(telegram?.text).toBe("hello");

		const discord = normalizeDiscordMessage({
			id: "m1",
			channel_id: "c1",
			guild_id: "g1",
			content: "hi",
			author: { id: "u1", username: "max" },
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		expect(discord?.id).toBe("discord:m1");
		expect(discord?.source.chatType).toBe("group");
		expect(discord?.text).toBe("hi");
	});

	it("routes one adapter message through a reusable session", async () => {
		const config = baseConfig();
		const fakeSession = new FakeSession();
		const store = new GatewaySessionStore({ config, createSession: async () => fakeSession });
		const adapter = new FakeAdapter();
		const runner = new GatewayRunner({ config, adapters: [adapter], sessionStore: store });
		const result = await runner.handleMessage({
			id: "msg-1",
			source: { platform: "telegram", chatId: "chat", chatType: "private", messageId: "11", userId: "u1" },
			text: "hello",
			timestamp: Date.now(),
		});
		expect(fakeSession.prompts).toEqual(["hello"]);
		expect(result?.text).toBe("reply:hello");
		expect(adapter.sent).toEqual(["reply:hello"]);
	});

	it("splits long platform messages before delivery", async () => {
		const chunks = splitGatewayText("x".repeat(4100), "telegram");
		expect(chunks.length).toBe(2);
		const adapter = new FakeAdapter();
		await deliverGatewayText(
			adapter,
			{ platform: "telegram", chatId: "chat", chatType: "private" },
			"x".repeat(4100),
		);
		expect(adapter.sent.length).toBe(2);
	});
});
