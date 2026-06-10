import type { AgentMessage } from "@amaze/agent-core";
import type { AgentSessionEvent, PromptOptions } from "../session/agent-session";

export type GatewayPlatform = "telegram" | "discord";
export type GatewayChatType = "private" | "group" | "channel" | "thread" | "unknown";
export type GatewayStreamingMode = "final" | "edit";
export type GatewayBusyBehavior = "reject" | "follow-up" | "steer";
export type GatewaySessionScope = "chat" | "user" | "thread";

export interface GatewaySource {
	platform: GatewayPlatform;
	chatId: string;
	chatType: GatewayChatType;
	messageId?: string;
	threadId?: string;
	userId?: string;
	userName?: string;
	isBot?: boolean;
	metadata?: Record<string, unknown>;
}

export interface GatewayAttachment {
	id: string;
	kind: "image" | "audio" | "video" | "document" | "unknown";
	name?: string;
	mimeType?: string;
	url?: string;
	metadata?: Record<string, unknown>;
}

export interface GatewayMessage {
	id: string;
	source: GatewaySource;
	text: string;
	timestamp: number;
	attachments?: GatewayAttachment[];
	raw?: unknown;
}

export interface GatewaySendOptions {
	replyToMessageId?: string;
	threadId?: string;
	parseMode?: "plain" | "markdown";
}

export interface GatewayEditTarget {
	chatId: string;
	messageId: string;
	threadId?: string;
}

export interface GatewaySendResult {
	platform: GatewayPlatform;
	chatId: string;
	messageId?: string;
	threadId?: string;
	raw?: unknown;
}

export interface GatewayAdapterContext {
	signal: AbortSignal;
	onMessage(message: GatewayMessage): void | Promise<void>;
	onError?(error: unknown): void;
}

export interface GatewayAdapter {
	readonly platform: GatewayPlatform;
	start(context: GatewayAdapterContext): Promise<void>;
	stop(): Promise<void>;
	send(source: GatewaySource, text: string, options?: GatewaySendOptions): Promise<GatewaySendResult>;
	edit?(target: GatewayEditTarget, text: string): Promise<GatewaySendResult>;
	typing?(source: GatewaySource): Promise<void>;
}

export interface GatewaySessionLike {
	readonly isStreaming?: boolean;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	abort?(): void;
	dispose?(): Promise<void>;
}

export interface GatewaySessionHandle {
	key: string;
	session: GatewaySessionLike;
	createdAt: number;
	lastUsedAt: number;
}

export type GatewaySessionFactory = (input: {
	key: string;
	source: GatewaySource;
	sessionDir: string;
	forceNew: boolean;
}) => Promise<GatewaySessionLike>;

export interface GatewayPlatformRuntimeConfig {
	enabled: boolean;
	token?: string;
	allowedUsers: string[];
	allowedChats: string[];
	homeChatId?: string;
	streamingMode: GatewayStreamingMode;
	sessionScope: GatewaySessionScope;
	ignoreBots: boolean;
}

export interface GatewayRuntimeConfig {
	agentDir: string;
	cwd: string;
	sessionDir: string;
	allowAllUsers: boolean;
	busyBehavior: GatewayBusyBehavior;
	platforms: Record<GatewayPlatform, GatewayPlatformRuntimeConfig>;
}

export interface GatewayPromptResult {
	message: GatewayMessage;
	text: string;
	sent?: GatewaySendResult;
}

export function extractGatewayText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as { type?: unknown; text?: unknown; content?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (typeof block.content === "string") {
			parts.push(block.content);
		}
	}
	return parts.join("");
}

export function isAssistantMessage(message: AgentMessage): boolean {
	return (message as { role?: unknown }).role === "assistant";
}
