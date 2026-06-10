/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@amaze/agent-core";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
} from "@amaze/agent-core/compaction/messages";
import type { AssistantMessage, ImageContent, Message, MessageAttribution, TextContent } from "@amaze/ai";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
} from "@amaze/agent-core/compaction/messages";

import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const MEMORY_ACTIVITY_MESSAGE_TYPE = "memory-activity";
const CONTEXT_FREE_CUSTOM_MESSAGE_TYPES = new Set<string>([MEMORY_ACTIVITY_MESSAGE_TYPE]);

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
	/** Internal: tag used by AgentSession to remove the pending-display chip
	 *  from `#steeringMessages` / `#followUpMessages` when the agent consumes
	 *  this message. Not surfaced to renderers; the `__` prefix signals
	 *  "private". Optional — non-streaming skill prompts never set it. Stripped
	 *  from persisted `details` by `SessionManager.appendCustomMessageEntry`
	 *  via the `INTERNAL_DETAILS_FIELDS` allowlist below. */
	__pendingDisplayTag?: string;
}

/** Sentinel value for `AssistantMessage.errorMessage` indicating that the abort
 *  was an *expected internal transition* (plan-mode → execution compaction)
 *  and must NOT surface as a red "Operation aborted" line. Distinct from
 *  `undefined` (default) so user-cancel aborts with no errorMessage still
 *  render normally. Persists through SessionManager so history replay
 *  branches identically.
 *
 *  Consumers: `AgentSession.#handleAgentEvent` (stamper) writes this value;
 *  `EventController.#handleMessageEnd`, `AssistantMessageComponent`,
 *  `ui-helpers.addMessageToChat` (renderers), `SessionObserverOverlay
 *  #buildTranscriptLines`, `runPrintMode`, and `AcpAgent#replayAssistantMessage`
 *  (fallback error emission) read it via `isSilentAbort`. */
export const SILENT_ABORT_MARKER = "__omp.silent_abort__";

/** Type-guard for `SILENT_ABORT_MARKER`. Renderers MUST branch on this rather
 *  than string-comparing inline so refactors to the marker constant (e.g.,
 *  namespacing changes) propagate through every consumer in lockstep. */
export function isSilentAbort(errorMessage: string | undefined): boolean {
	return errorMessage === SILENT_ABORT_MARKER;
}

/** Extract the optional `__pendingDisplayTag` field from a CustomMessage's
 *  `details` blob. Safe over `unknown`; returns undefined when the field is
 *  absent or non-string. */
export function readPendingDisplayTag(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __pendingDisplayTag?: unknown }).__pendingDisplayTag;
	return typeof candidate === "string" ? candidate : undefined;
}

export function isContextFreeCustomMessageType(customType: string): boolean {
	return CONTEXT_FREE_CUSTOM_MESSAGE_TYPES.has(customType);
}

/** Explicit allowlist of `details` field names that are AgentSession-internal
 *  transient bookkeeping and MUST be removed before SessionManager persists
 *  the CustomMessageEntry to disk. Scoped intentionally narrow: only fields
 *  declared here are stripped. Adding a new entry is a deliberate, reviewed
 *  change — unrelated future payload fields are never silently dropped. */
export const INTERNAL_DETAILS_FIELDS = ["__pendingDisplayTag"] as const;

/** Return a `details` copy with every key in `INTERNAL_DETAILS_FIELDS`
 *  removed. Returns the input unchanged when there is nothing to strip
 *  (null/non-object, or no listed fields present) so callers don't pay a
 *  clone cost on the common path. */
export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output?: string;
	exitCode?: number | null;
	cancelled?: boolean;
	truncated?: boolean;
	excludeFromContext?: boolean;
	meta?: OutputMeta;
	timestamp: number;
}

export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output?: string;
	exitCode?: number | null;
	cancelled?: boolean;
	truncated?: boolean;
	excludeFromContext?: boolean;
	meta?: OutputMeta;
	timestamp: number;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@amaze/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}

		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely.
	// After rehydration it belongs to a previous live provider connection and
	// replaying it on a warmed session causes 401 rejections from GitHub Copilot.
	// User/developer payloads are preserved separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Convert CustomMessages to user messages for the LLM context.
 *
 * Design choice: custom/hook messages are injected as `user` role because they
 * represent external context or control messages, not assistant completions.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "pythonExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: pythonExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "custom":
				case "hookMessage": {
					if (isContextFreeCustomMessageType(m.customType)) return undefined;
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					const role = "user";
					const attribution = m.attribution;
					return {
						role,
						content,
						attribution,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [
							{
								type: "text",
								text: renderBranchSummaryContext(m.summary),
							},
						],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{
								type: "text",
								text: renderCompactionSummaryContext(m.summary),
							},
						],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "fileMention":
					return {
						role: "user",
						content: [
							{
								type: "text",
								text: m.files.map(file => `File: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n"),
							},
						],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "assistant":
					return sanitizeRehydratedOpenAIResponsesAssistantMessage(m);
				default:
					return m as Message;
			}
		})
		.filter(Boolean) as Message[];
}
