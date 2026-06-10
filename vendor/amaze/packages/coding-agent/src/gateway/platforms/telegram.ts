import type {
	GatewayAdapter,
	GatewayAdapterContext,
	GatewayEditTarget,
	GatewayMessage,
	GatewaySendOptions,
	GatewaySendResult,
	GatewaySource,
} from "../types";

export interface TelegramAdapterOptions {
	token: string;
	fetchImpl?: typeof fetch;
	pollTimeoutSeconds?: number;
}

type TelegramUser = { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
type TelegramChat = { id: number; type?: string; title?: string; username?: string };
type TelegramMessage = {
	message_id: number;
	date?: number;
	message_thread_id?: number;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
	caption?: string;
	document?: { file_id: string; file_name?: string; mime_type?: string };
	photo?: Array<{ file_id: string }>;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage };

export class TelegramAdapter implements GatewayAdapter {
	readonly platform = "telegram" as const;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #pollTimeoutSeconds: number;
	#running = false;
	#offset = 0;
	#loop: Promise<void> | undefined;

	constructor(options: TelegramAdapterOptions) {
		this.#token = options.token;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
	}

	async start(context: GatewayAdapterContext): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#loop = this.#poll(context).finally(() => {
			this.#running = false;
		});
	}

	async stop(): Promise<void> {
		this.#running = false;
		await this.#loop?.catch(() => undefined);
	}

	async send(source: GatewaySource, text: string, options: GatewaySendOptions = {}): Promise<GatewaySendResult> {
		const result = await this.#api<TelegramMessage>("sendMessage", {
			chat_id: source.chatId,
			text,
			reply_to_message_id: options.replyToMessageId,
			message_thread_id: options.threadId ?? source.threadId,
			disable_web_page_preview: true,
		});
		return {
			platform: "telegram",
			chatId: String(result.chat.id),
			messageId: String(result.message_id),
			threadId: result.message_thread_id === undefined ? undefined : String(result.message_thread_id),
			raw: result,
		};
	}

	async edit(target: GatewayEditTarget, text: string): Promise<GatewaySendResult> {
		const result = await this.#api<TelegramMessage>("editMessageText", {
			chat_id: target.chatId,
			message_id: target.messageId,
			text,
			disable_web_page_preview: true,
		});
		return {
			platform: "telegram",
			chatId: String(result.chat.id),
			messageId: String(result.message_id),
			threadId: result.message_thread_id === undefined ? undefined : String(result.message_thread_id),
			raw: result,
		};
	}

	async typing(source: GatewaySource): Promise<void> {
		await this.#api("sendChatAction", { chat_id: source.chatId, action: "typing" });
	}

	async #poll(context: GatewayAdapterContext): Promise<void> {
		while (this.#running && !context.signal.aborted) {
			try {
				const updates = await this.#api<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: this.#offset || undefined,
						timeout: this.#pollTimeoutSeconds,
						allowed_updates: ["message", "edited_message"],
					},
					context.signal,
				);
				for (const update of updates) {
					this.#offset = Math.max(this.#offset, update.update_id + 1);
					const normalized = normalizeTelegramUpdate(update);
					if (normalized) await context.onMessage(normalized);
				}
			} catch (error) {
				if (context.signal.aborted || !this.#running) return;
				context.onError?.(error);
				await sleep(1000, context.signal);
			}
		}
	}

	async #api<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(removeUndefined(body)),
			signal,
		});
		const json = (await response.json()) as { ok?: boolean; result?: T; description?: string };
		if (!response.ok || !json.ok) {
			throw new Error(`Telegram ${method} failed: ${json.description ?? response.statusText}`);
		}
		return json.result as T;
	}
}

export function normalizeTelegramUpdate(update: TelegramUpdate): GatewayMessage | undefined {
	const message = update.message ?? update.edited_message;
	if (!message) return undefined;
	const text = message.text ?? message.caption ?? "";
	const from = message.from;
	const source: GatewaySource = {
		platform: "telegram",
		chatId: String(message.chat.id),
		chatType: normalizeTelegramChatType(message.chat.type),
		messageId: String(message.message_id),
		threadId: message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
		userId: from ? String(from.id) : undefined,
		userName: formatTelegramUser(from),
		isBot: from?.is_bot === true,
		metadata: { updateId: update.update_id },
	};
	return {
		id: `telegram:${update.update_id}`,
		source,
		text,
		timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
		attachments: normalizeTelegramAttachments(message),
		raw: update,
	};
}

function normalizeTelegramChatType(type: string | undefined): GatewaySource["chatType"] {
	if (type === "private") return "private";
	if (type === "group" || type === "supergroup") return "group";
	if (type === "channel") return "channel";
	return "unknown";
}

function normalizeTelegramAttachments(message: TelegramMessage): GatewayMessage["attachments"] {
	const attachments: NonNullable<GatewayMessage["attachments"]> = [];
	if (message.document) {
		attachments.push({
			id: message.document.file_id,
			kind: "document",
			name: message.document.file_name,
			mimeType: message.document.mime_type,
		});
	}
	if (message.photo?.length) {
		const last = message.photo[message.photo.length - 1];
		if (last) attachments.push({ id: last.file_id, kind: "image" });
	}
	return attachments.length ? attachments : undefined;
}

function formatTelegramUser(user: TelegramUser | undefined): string | undefined {
	if (!user) return undefined;
	if (user.username) return user.username;
	return [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>(resolve => {
		const timeout = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}
