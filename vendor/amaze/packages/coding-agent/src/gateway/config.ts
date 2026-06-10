import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@amaze/utils";
import type {
	GatewayBusyBehavior,
	GatewayPlatform,
	GatewayPlatformRuntimeConfig,
	GatewayRuntimeConfig,
	GatewaySessionScope,
	GatewayStreamingMode,
} from "./types";

export interface LoadGatewayConfigOptions {
	agentDir?: string;
	cwd?: string;
	configPath?: string;
	env?: Record<string, string | undefined>;
}

type RawPlatformConfig = Partial<GatewayPlatformRuntimeConfig> & { tokenEnv?: string };

type RawGatewayConfig = {
	cwd?: string;
	sessionDir?: string;
	allowAllUsers?: boolean;
	busyBehavior?: GatewayBusyBehavior;
	platforms?: Partial<Record<GatewayPlatform, RawPlatformConfig>>;
};

const PLATFORMS: GatewayPlatform[] = ["telegram", "discord"];

const DEFAULT_PLATFORM: GatewayPlatformRuntimeConfig = {
	enabled: false,
	allowedUsers: [],
	allowedChats: [],
	streamingMode: "final",
	sessionScope: "chat",
	ignoreBots: true,
};

export function getDefaultGatewayConfigPaths(agentDir: string): string[] {
	return [path.join(agentDir, "gateway.json"), path.join(agentDir, "gateway", "config.json")];
}

export async function loadGatewayConfig(options: LoadGatewayConfigOptions = {}): Promise<GatewayRuntimeConfig> {
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const env = options.env ?? process.env;
	const fileConfig = await readGatewayConfigFile(agentDir, options.configPath);
	const cwd = path.resolve(options.cwd ?? env.AMAZE_GATEWAY_CWD ?? fileConfig.cwd ?? getProjectDir());
	const sessionDir = path.resolve(
		env.AMAZE_GATEWAY_SESSION_DIR ?? fileConfig.sessionDir ?? path.join(agentDir, "gateway", "sessions"),
	);
	const allowAllUsers = readBoolean(env.AMAZE_GATEWAY_ALLOW_ALL_USERS) ?? fileConfig.allowAllUsers ?? false;
	const busyBehavior = readBusyBehavior(env.AMAZE_GATEWAY_BUSY_BEHAVIOR) ?? fileConfig.busyBehavior ?? "reject";

	const platforms = Object.fromEntries(
		PLATFORMS.map(platform => {
			const raw = fileConfig.platforms?.[platform] ?? {};
			return [platform, mergePlatformConfig(platform, raw, env)];
		}),
	) as Record<GatewayPlatform, GatewayPlatformRuntimeConfig>;

	return { agentDir, cwd, sessionDir, allowAllUsers, busyBehavior, platforms };
}

export function validateGatewayConfig(config: GatewayRuntimeConfig): string[] {
	const errors: string[] = [];
	for (const platform of PLATFORMS) {
		const cfg = config.platforms[platform];
		if (cfg.enabled && !cfg.token) errors.push(`${platform}: token is required when enabled`);
		if (!isStreamingMode(cfg.streamingMode))
			errors.push(`${platform}: invalid streamingMode ${String(cfg.streamingMode)}`);
		if (!isSessionScope(cfg.sessionScope))
			errors.push(`${platform}: invalid sessionScope ${String(cfg.sessionScope)}`);
	}
	if (!isBusyBehavior(config.busyBehavior)) errors.push(`invalid busyBehavior ${String(config.busyBehavior)}`);
	return errors;
}

async function readGatewayConfigFile(agentDir: string, explicitPath?: string): Promise<RawGatewayConfig> {
	const candidates = explicitPath ? [explicitPath] : getDefaultGatewayConfigPaths(agentDir);
	for (const candidate of candidates) {
		try {
			const text = await fs.readFile(candidate, "utf8");
			const parsed = JSON.parse(text) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as RawGatewayConfig;
			}
			throw new Error(`Gateway config must be a JSON object: ${candidate}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	return {};
}

function mergePlatformConfig(
	platform: GatewayPlatform,
	raw: RawPlatformConfig,
	env: Record<string, string | undefined>,
): GatewayPlatformRuntimeConfig {
	const upper = platform.toUpperCase();
	const tokenEnvName = raw.tokenEnv ?? `AMAZE_GATEWAY_${upper}_TOKEN`;
	const token = env[tokenEnvName] ?? raw.token;
	const enabled = readBoolean(env[`AMAZE_GATEWAY_${upper}_ENABLED`]) ?? raw.enabled ?? Boolean(token);
	return {
		...DEFAULT_PLATFORM,
		...raw,
		enabled,
		token,
		allowedUsers: readCsv(env[`AMAZE_GATEWAY_${upper}_ALLOWED_USERS`]) ?? raw.allowedUsers ?? [],
		allowedChats: readCsv(env[`AMAZE_GATEWAY_${upper}_ALLOWED_CHATS`]) ?? raw.allowedChats ?? [],
		homeChatId: env[`AMAZE_GATEWAY_${upper}_HOME_CHAT_ID`] ?? raw.homeChatId,
		streamingMode:
			readStreamingMode(env[`AMAZE_GATEWAY_${upper}_STREAMING_MODE`]) ??
			raw.streamingMode ??
			DEFAULT_PLATFORM.streamingMode,
		sessionScope:
			readSessionScope(env[`AMAZE_GATEWAY_${upper}_SESSION_SCOPE`]) ??
			raw.sessionScope ??
			DEFAULT_PLATFORM.sessionScope,
		ignoreBots:
			readBoolean(env[`AMAZE_GATEWAY_${upper}_IGNORE_BOTS`]) ?? raw.ignoreBots ?? DEFAULT_PLATFORM.ignoreBots,
	};
}

function readCsv(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(",")
		.map(part => part.trim())
		.filter(Boolean);
}

function readBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`Invalid boolean value: ${value}`);
}

function readBusyBehavior(value: string | undefined): GatewayBusyBehavior | undefined {
	if (value === undefined) return undefined;
	if (isBusyBehavior(value)) return value;
	throw new Error(`Invalid gateway busy behavior: ${value}`);
}

function readStreamingMode(value: string | undefined): GatewayStreamingMode | undefined {
	if (value === undefined) return undefined;
	if (isStreamingMode(value)) return value;
	throw new Error(`Invalid gateway streaming mode: ${value}`);
}

function readSessionScope(value: string | undefined): GatewaySessionScope | undefined {
	if (value === undefined) return undefined;
	if (isSessionScope(value)) return value;
	throw new Error(`Invalid gateway session scope: ${value}`);
}

function isBusyBehavior(value: unknown): value is GatewayBusyBehavior {
	return value === "reject" || value === "follow-up" || value === "steer";
}

function isStreamingMode(value: unknown): value is GatewayStreamingMode {
	return value === "final" || value === "edit";
}

function isSessionScope(value: unknown): value is GatewaySessionScope {
	return value === "chat" || value === "user" || value === "thread";
}
