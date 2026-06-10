/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@amaze/ai";
import { calculateCost } from "@amaze/ai/models";
import { parseStreamingJson } from "@amaze/ai/utils/json-parse";
import { readSseJson } from "@amaze/utils";

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
	/**
	 * Optional token refresh callback. When the proxy rejects the request with
	 * 401/403, the stream invokes this (with `force: true`) to obtain a fresh
	 * token and retries the request once. Without it, an expired token fails the
	 * request hard with no recovery path. The callback should return a valid
	 * bearer token; `force` signals the cached token was rejected and must be
	 * re-minted rather than reused.
	 */
	getAuthToken?: (opts: { force: boolean }) => string | Promise<string>;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
export function streamProxy(model: Model, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		let response: Response | null = null;
		const abortHandler = () => {
			const body = response?.body;
			if (body) {
				body.cancel("Request aborted by user").catch(() => {});
			}
		};
		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		const requestBody = JSON.stringify({
			model,
			context,
			options: {
				temperature: options.temperature,
				topP: options.topP,
				topK: options.topK,
				minP: options.minP,
				presencePenalty: options.presencePenalty,
				repetitionPenalty: options.repetitionPenalty,
				maxTokens: options.maxTokens,
				reasoning: options.reasoning,
			},
		});
		const sendRequest = async (token: string): Promise<Response> =>
			fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: requestBody,
				signal: options.signal,
			});

		try {
			let token = options.getAuthToken ? await options.getAuthToken({ force: false }) : options.authToken;
			response = await sendRequest(token);

			// Auth rejection: re-mint the token once via the refresh callback and
			// retry. Without a refresh callback there is no recovery — fail hard.
			if ((response.status === 401 || response.status === 403) && options.getAuthToken) {
				try {
					await response.body?.cancel();
				} catch {
					// best-effort drain of the rejected response
				}
				token = await options.getAuthToken({ force: true });
				response = await sendRequest(token);
			}

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			let sawTerminalEvent = false;
			for await (const event of readSseJson<ProxyAssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				options.signal,
			)) {
				const parsedEvent = processProxyEvent(model, event, partial);
				if (parsedEvent) {
					if (parsedEvent.type === "done" || parsedEvent.type === "error") {
						sawTerminalEvent = true;
					}
					stream.push(parsedEvent);
				}
			}

			// The stream ended without a `done`/`error` event. Distinguish three cases so we
			// neither mistake a dropped stream for success NOR fail a fully-delivered turn:
			//   - aborted by the caller  → propagate the abort reason.
			//   - no content at all      → genuine truncation/empty response; error out.
			//   - content was delivered  → tolerate the missing terminal frame (some backends
			//     close the connection right after the final event, or a `[DONE]` sentinel was
			//     consumed upstream before a typed `done` reached us). Complete with the partial.
			if (!sawTerminalEvent) {
				if (options.signal?.aborted) {
					const reason = options.signal.reason;
					throw reason instanceof Error ? reason : new Error(String(reason ?? "Request aborted"));
				}
				if (partial.content.length === 0) {
					throw new Error(
						"Proxy stream ended without any content or terminal event (connection closed prematurely)",
					);
				}
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	model: Model,
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex] as (ToolCall & { partialJson?: string }) | undefined;
			if (content?.type === "toolCall") {
				const partialJson = (content.partialJson ?? "") + proxyEvent.delta;
				content.partialJson = partialJson;
				content.arguments = parseStreamingJson(partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex] as (ToolCall & { partialJson?: string }) | undefined;
			if (content?.type === "toolCall") {
				delete content.partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			calculateCost(model, partial.usage);
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			calculateCost(model, partial.usage);
			return { type: "error", reason: proxyEvent.reason, error: partial };
	}
}
