import type { GatewayRuntimeConfig, GatewaySource } from "./types";

export interface GatewayAuthorizationResult {
	allowed: boolean;
	reason?: string;
}

export function authorizeGatewaySource(
	config: GatewayRuntimeConfig,
	source: GatewaySource,
): GatewayAuthorizationResult {
	const platformConfig = config.platforms[source.platform];
	if (!platformConfig?.enabled) return { allowed: false, reason: `${source.platform} gateway is disabled` };
	if (platformConfig.ignoreBots && source.isBot) return { allowed: false, reason: "bot messages are ignored" };
	if (platformConfig.allowedChats.length > 0 && !platformConfig.allowedChats.includes(source.chatId)) {
		return { allowed: false, reason: "chat is not allowed" };
	}
	if (config.allowAllUsers) return { allowed: true };
	if (platformConfig.allowedUsers.length === 0) return { allowed: false, reason: "no allowed users configured" };
	if (!source.userId) return { allowed: false, reason: "message has no user id" };
	return platformConfig.allowedUsers.includes(source.userId)
		? { allowed: true }
		: { allowed: false, reason: "user is not allowed" };
}
