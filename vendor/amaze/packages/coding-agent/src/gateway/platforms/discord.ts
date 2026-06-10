import type {
	GatewayAdapter,
	GatewayAdapterContext,
	GatewayEditTarget,
	GatewayMessage,
	GatewaySendOptions,
	GatewaySendResult,
	GatewaySource,
} from "../types";

export interface DiscordAdapterOptions {
	token: string;
	fetchImpl?: typeof fetch;
	webSocketFactory?: (url: string) => WebSocket;
	intents?: number;
}

type DiscordGatewayPayload = { op: number; d?: any; s?: number; t?: string };
type DiscordMessage = {
	id: string;
	channel_id: string;
	guild_id?: string;
	timestamp?: string;
	content?: string;
	author?: { id: string; username?: string; bot?: boolean };
	type?: number;
	message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
	attachments?: Array<{ id: string; filename?: string; content_type?: string; url?: string }>;
};

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

export class DiscordAdapter implements GatewayAdapter {
	readonly platform = "discord" as const;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #webSocketFactory: (url: string) => WebSocket;
	readonly #intents: number;
	#socket: WebSocket | undefined;
	#heartbeat: Timer | undefined;
	#running = false;
	#lastSequence: number | null = null;
	#context: GatewayAdapterContext | undefined;

	constructor(options: DiscordAdapterOptions) {
		this.#token = options.token;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
		this.#intents = options.intents ?? DEFAULT_INTENTS;
	}

	async start(context: GatewayAdapterContext): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#context = context;
		this.#connect(DEFAULT_GATEWAY_URL);
	}

	async stop(): Promise<void> {
		this.#running = false;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.#socket?.close();
		this.#socket = undefined;
	}

	async send(source: GatewaySource, text: string, options: GatewaySendOptions = {}): Promise<GatewaySendResult> {
		const result = await this.#api<DiscordMessage>(`/channels/${source.threadId ?? source.chatId}/messages`, "POST", {
			content: text,
			message_reference: options.replyToMessageId
				? { message_id: options.replyToMessageId, channel_id: source.chatId, fail_if_not_exists: false }
				: undefined,
		});
		return {
			platform: "discord",
			chatId: result.channel_id,
			messageId: result.id,
			threadId: source.threadId,
			raw: result,
		};
	}

	async edit(target: GatewayEditTarget, text: string): Promise<GatewaySendResult> {
		const result = await this.#api<DiscordMessage>(
			`/channels/${target.threadId ?? target.chatId}/messages/${target.messageId}`,
			"PATCH",
			{
				content: text,
			},
		);
		return {
			platform: "discord",
			chatId: result.channel_id,
			messageId: result.id,
			threadId: target.threadId,
			raw: result,
		};
	}

	async typing(source: GatewaySource): Promise<void> {
		await this.#api(`/channels/${source.threadId ?? source.chatId}/typing`, "POST", undefined);
	}

	#connect(url: string): void {
		const socket = this.#webSocketFactory(url);
		this.#socket = socket;
		socket.addEventListener("message", event => {
			try {
				this.#handlePayload(JSON.parse(String(event.data)) as DiscordGatewayPayload);
			} catch (error) {
				this.#context?.onError?.(error);
			}
		});
		socket.addEventListener("close", () => {
			if (this.#heartbeat) clearInterval(this.#heartbeat);
			this.#heartbeat = undefined;
			if (this.#running && !this.#context?.signal.aborted) {
				setTimeout(() => this.#connect(url), 1500);
			}
		});
		socket.addEventListener("error", event => this.#context?.onError?.(event));
	}

	#handlePayload(payload: DiscordGatewayPayload): void {
		if (typeof payload.s === "number") this.#lastSequence = payload.s;
		if (payload.op === 10) {
			const interval = Number(payload.d?.heartbeat_interval ?? 45_000);
			this.#heartbeat = setInterval(() => this.#sendGateway({ op: 1, d: this.#lastSequence }), interval);
			this.#sendGateway({
				op: 2,
				d: {
					token: this.#token,
					intents: this.#intents,
					properties: { os: process.platform, browser: "amaze", device: "amaze" },
				},
			});
			return;
		}
		if (payload.op === 11) return;
		if (payload.t === "MESSAGE_CREATE") {
			const normalized = normalizeDiscordMessage(payload.d as DiscordMessage);
			if (normalized) void this.#context?.onMessage(normalized);
		}
	}

	#sendGateway(payload: DiscordGatewayPayload): void {
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#socket.send(JSON.stringify(payload));
		}
	}

	async #api<T = unknown>(route: string, method: string, body: Record<string, unknown> | undefined): Promise<T> {
		const response = await this.#fetch(`${DISCORD_API}${route}`, {
			method,
			headers: {
				authorization: `Bot ${this.#token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(removeUndefined(body)),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Discord ${method} ${route} failed: ${response.status} ${text}`);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}
}

export function normalizeDiscordMessage(message: DiscordMessage): GatewayMessage | undefined {
	if (!message.id || !message.channel_id) return undefined;
	const source: GatewaySource = {
		platform: "discord",
		chatId: message.channel_id,
		chatType: message.guild_id ? "group" : "private",
		messageId: message.id,
		userId: message.author?.id,
		userName: message.author?.username,
		isBot: message.author?.bot === true,
		metadata: { guildId: message.guild_id, messageType: message.type },
	};
	return {
		id: `discord:${message.id}`,
		source,
		text: message.content ?? "",
		timestamp: message.timestamp ? Date.parse(message.timestamp) : Date.now(),
		attachments: message.attachments?.map(attachment => ({
			id: attachment.id,
			kind: attachment.content_type?.startsWith("image/") ? "image" : "document",
			name: attachment.filename,
			mimeType: attachment.content_type,
			url: attachment.url,
		})),
		raw: message,
	};
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
