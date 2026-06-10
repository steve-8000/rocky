import { authorizeGatewaySource } from "./auth";
import { deliverGatewayText } from "./delivery";
import { GatewaySessionStore } from "./session-store";
import {
	extractGatewayText,
	type GatewayAdapter,
	type GatewayEditTarget,
	type GatewayMessage,
	type GatewayPromptResult,
	type GatewayRuntimeConfig,
	type GatewaySendResult,
	isAssistantMessage,
} from "./types";

export interface GatewayRunnerOptions {
	config: GatewayRuntimeConfig;
	adapters: GatewayAdapter[];
	sessionStore?: GatewaySessionStore;
}

export class GatewayRunner {
	readonly #config: GatewayRuntimeConfig;
	readonly #adapters = new Map<string, GatewayAdapter>();
	readonly #sessionStore: GatewaySessionStore;
	readonly #busy = new Map<string, Promise<GatewayPromptResult | undefined>>();
	#abortController: AbortController | undefined;

	constructor(options: GatewayRunnerOptions) {
		this.#config = options.config;
		for (const adapter of options.adapters) {
			this.#adapters.set(adapter.platform, adapter);
		}
		this.#sessionStore = options.sessionStore ?? new GatewaySessionStore({ config: options.config });
	}

	get sessionStore(): GatewaySessionStore {
		return this.#sessionStore;
	}

	async start(): Promise<void> {
		if (this.#abortController) return;
		const controller = new AbortController();
		this.#abortController = controller;
		await Promise.all(
			[...this.#adapters.values()].map(adapter =>
				adapter.start({
					signal: controller.signal,
					onMessage: async message => {
						await this.handleMessage(message);
					},
					onError: error => {
						process.stderr.write(
							`gateway ${adapter.platform} error: ${error instanceof Error ? error.message : String(error)}\n`,
						);
					},
				}),
			),
		);
	}

	async stop(): Promise<void> {
		this.#abortController?.abort();
		this.#abortController = undefined;
		await Promise.all([...this.#adapters.values()].map(adapter => adapter.stop()));
		await this.#sessionStore.dispose();
	}

	async handleMessage(message: GatewayMessage): Promise<GatewayPromptResult | undefined> {
		const adapter = this.#adapters.get(message.source.platform);
		if (!adapter) throw new Error(`No adapter registered for ${message.source.platform}`);
		const authorization = authorizeGatewaySource(this.#config, message.source);
		if (!authorization.allowed) {
			return undefined;
		}
		const command = parseGatewayCommand(message.text);
		if (command) {
			return this.#handleCommand(adapter, message, command);
		}
		const text = message.text.trim();
		if (!text && !message.attachments?.length) return undefined;
		return this.#runPrompt(adapter, message, text);
	}

	async #handleCommand(
		adapter: GatewayAdapter,
		message: GatewayMessage,
		command: GatewayCommand,
	): Promise<GatewayPromptResult | undefined> {
		switch (command.name) {
			case "help":
				return this.#sendStatic(
					adapter,
					message,
					"Commands: /help, /new, /reset, /stop, /sessions. Send any other text to Amaze.",
				);
			case "new":
			case "reset":
				await this.#sessionStore.reset(message.source);
				return this.#sendStatic(adapter, message, "Started a fresh Amaze gateway session.");
			case "stop": {
				const handle = await this.#sessionStore.get(message.source);
				handle.session.abort?.();
				return this.#sendStatic(adapter, message, "Stop requested for the active Amaze turn.");
			}
			case "sessions": {
				const keys = this.#sessionStore.activeKeys;
				return this.#sendStatic(adapter, message, keys.length ? keys.join("\n") : "No active gateway sessions.");
			}
		}
	}

	async #sendStatic(adapter: GatewayAdapter, message: GatewayMessage, text: string): Promise<GatewayPromptResult> {
		const sent = await deliverGatewayText(adapter, message.source, text, {
			replyToMessageId: message.source.messageId,
		});
		return { message, text, sent };
	}

	async #runPrompt(
		adapter: GatewayAdapter,
		message: GatewayMessage,
		prompt: string,
	): Promise<GatewayPromptResult | undefined> {
		const handle = await this.#sessionStore.get(message.source);
		const existing = this.#busy.get(handle.key);
		if (existing) {
			if (this.#config.busyBehavior === "reject") {
				const sent = await deliverGatewayText(
					adapter,
					message.source,
					"Amaze is still working on the previous message.",
					{
						replyToMessageId: message.source.messageId,
					},
				);
				return { message, text: "", sent };
			}
			const streamingBehavior = this.#config.busyBehavior === "steer" ? "steer" : "followUp";
			await handle.session.prompt(prompt, { streamingBehavior, expandPromptTemplates: false });
			return existing;
		}

		const run = this.#executePrompt(adapter, message, prompt);
		this.#busy.set(handle.key, run);
		try {
			return await run;
		} finally {
			this.#busy.delete(handle.key);
		}
	}

	async #executePrompt(
		adapter: GatewayAdapter,
		message: GatewayMessage,
		prompt: string,
	): Promise<GatewayPromptResult | undefined> {
		const handle = await this.#sessionStore.get(message.source);
		let latestAssistantText = "";
		let sent: GatewaySendResult | undefined;
		let editTarget: GatewayEditTarget | undefined;
		const platformConfig = this.#config.platforms[message.source.platform];
		const streamByEdit = platformConfig.streamingMode === "edit" && !!adapter.edit;
		let lastEditAt = 0;
		const unsubscribe = handle.session.subscribe(event => {
			if (event.type === "message_update" && isAssistantMessage(event.message)) {
				latestAssistantText = extractGatewayText(event.message);
				if (streamByEdit && editTarget && latestAssistantText && Date.now() - lastEditAt > 1200) {
					lastEditAt = Date.now();
					void adapter.edit?.(editTarget, latestAssistantText).catch(() => undefined);
				}
			} else if (event.type === "message_end" && isAssistantMessage(event.message)) {
				latestAssistantText = extractGatewayText(event.message);
			}
		});
		try {
			await adapter.typing?.(message.source);
			if (streamByEdit) {
				sent = await adapter.send(message.source, "Working…", {
					replyToMessageId: message.source.messageId,
					threadId: message.source.threadId,
				});
				if (sent.messageId) {
					editTarget = { chatId: sent.chatId, messageId: sent.messageId, threadId: sent.threadId };
				}
			}
			await handle.session.prompt(prompt, { expandPromptTemplates: false });
			const finalText = latestAssistantText.trim() || "Amaze finished without a text response.";
			sent = await deliverGatewayText(adapter, message.source, finalText, {
				editTarget,
				replyToMessageId: streamByEdit ? undefined : message.source.messageId,
			});
			return { message, text: finalText, sent };
		} finally {
			unsubscribe();
		}
	}
}

type GatewayCommand = { name: "help" | "new" | "reset" | "stop" | "sessions" };

function parseGatewayCommand(text: string): GatewayCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const first = trimmed.slice(1).split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase();
	if (first === "help" || first === "new" || first === "reset" || first === "stop" || first === "sessions") {
		return { name: first };
	}
	return undefined;
}
