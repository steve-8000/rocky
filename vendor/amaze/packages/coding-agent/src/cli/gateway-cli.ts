import { loadGatewayConfig, validateGatewayConfig } from "../gateway/config";
import { DiscordAdapter } from "../gateway/platforms/discord";
import { TelegramAdapter } from "../gateway/platforms/telegram";
import { GatewayRunner } from "../gateway/runner";
import type { GatewayAdapter, GatewayPlatform, GatewaySource } from "../gateway/types";

export type GatewayCliAction = "check" | "start" | "send";

export interface GatewayCommandArgs {
	action: GatewayCliAction;
	config?: string;
	platform?: string;
	chat?: string;
	text?: string;
	json?: boolean;
}

export async function runGatewayCommand(args: GatewayCommandArgs): Promise<void> {
	const config = await loadGatewayConfig({ configPath: args.config });
	const errors = validateGatewayConfig(config);
	if (args.action === "check") {
		const enabled = Object.entries(config.platforms)
			.filter(([, platform]) => platform.enabled)
			.map(([name]) => name);
		const result = { ok: errors.length === 0, enabled, errors, sessionDir: config.sessionDir };
		process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatCheck(result));
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (errors.length > 0) throw new Error(errors.join("\n"));

	if (args.action === "send") {
		const platform = parsePlatform(args.platform);
		const chatId = required(args.chat, "--chat");
		const text = required(args.text, "--text");
		const adapter = createAdapter(platform, config.platforms[platform].token!);
		const source: GatewaySource = { platform, chatId, chatType: platform === "discord" ? "group" : "private" };
		const sent = await adapter.send(source, text);
		process.stdout.write(
			args.json
				? `${JSON.stringify(sent, null, 2)}\n`
				: `sent ${sent.platform}:${sent.chatId}:${sent.messageId ?? "unknown"}\n`,
		);
		return;
	}

	const adapters = Object.entries(config.platforms)
		.filter(([, platform]) => platform.enabled)
		.map(([platform, platformConfig]) => createAdapter(platform as GatewayPlatform, platformConfig.token!));
	if (adapters.length === 0) throw new Error("No gateway platforms are enabled");
	const runner = new GatewayRunner({ config, adapters });
	await runner.start();
	process.stdout.write(`gateway listening for ${adapters.map(adapter => adapter.platform).join(", ")}\n`);
	await waitForever();
}

function createAdapter(platform: GatewayPlatform, token: string): GatewayAdapter {
	if (platform === "telegram") return new TelegramAdapter({ token });
	if (platform === "discord") return new DiscordAdapter({ token });
	throw new Error(`Unsupported gateway platform: ${platform}`);
}

function parsePlatform(value: string | undefined): GatewayPlatform {
	if (value === "telegram" || value === "discord") return value;
	throw new Error("--platform must be telegram or discord");
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function formatCheck(result: { ok: boolean; enabled: string[]; errors: string[]; sessionDir: string }): string {
	const lines = [
		`gateway config: ${result.ok ? "ok" : "invalid"}`,
		`enabled: ${result.enabled.join(", ") || "none"}`,
		`sessions: ${result.sessionDir}`,
	];
	if (result.errors.length) lines.push(...result.errors.map(error => `error: ${error}`));
	return `${lines.join("\n")}\n`;
}

async function waitForever(): Promise<void> {
	await new Promise<void>(resolve => {
		const done = () => resolve();
		process.once("SIGINT", done);
		process.once("SIGTERM", done);
	});
}
