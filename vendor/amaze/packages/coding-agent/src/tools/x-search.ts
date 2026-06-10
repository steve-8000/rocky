import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@amaze/agent-core";
import type { Component } from "@amaze/tui";
import { Text } from "@amaze/tui";
import { prompt, untilAborted } from "@amaze/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import xSearchDescription from "../prompts/tools/x-search.md" with { type: "text" };
import { renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatErrorMessage, TRUNCATE_LENGTHS } from "./render-utils";

const DEFAULT_X_SEARCH_MODEL = "grok-4.3";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 2;
const MAX_HANDLES = 10;
const DEFAULT_DEEP_CHUNK_SIZE = 900;
const DEFAULT_DEEP_MAX_CHUNKS = 12;
const DEFAULT_DEEP_OVERLAP_CHARS = 0;
const MIN_DEEP_CHUNK_SIZE = 200;
const MAX_DEEP_CHUNK_SIZE = 2_000;
const MAX_DEEP_MAX_CHUNKS = 50;
const MAX_DEEP_OVERLAP_CHARS = 200;
const DEFAULT_DEEP_OUTPUT_MODE: XSearchDeepOutputMode = "file";

type CredentialSource = "xai-oauth" | "xai";
type XSearchToolName = "x_search" | "x_search_deep";
type XSearchDeepOutputMode = "inline" | "file";

const xSearchSchema = z.object({
	query: z.string().describe("The X/Twitter search query to run through xAI's built-in x_search tool."),
	allowed_x_handles: z
		.array(z.string().describe("X handle to allow, with or without @."))
		.optional()
		.describe("Optional allow-list of X handles. Cannot be combined with excluded_x_handles."),
	excluded_x_handles: z
		.array(z.string().describe("X handle to exclude, with or without @."))
		.optional()
		.describe("Optional block-list of X handles. Cannot be combined with allowed_x_handles."),
	from_date: z.string().optional().describe("Optional start date filter accepted by xAI x_search."),
	to_date: z.string().optional().describe("Optional end date filter accepted by xAI x_search."),
	enable_image_understanding: z
		.boolean()
		.optional()
		.describe("Ask xAI x_search to use image understanding when available."),
	enable_video_understanding: z
		.boolean()
		.optional()
		.describe("Ask xAI x_search to use video understanding when available."),
	return_full_text: z
		.boolean()
		.optional()
		.describe("Return the complete original post text verbatim instead of a summary."),
});

const xSearchDeepSchema = xSearchSchema.extend({
	chunk_size: z
		.number()
		.int()
		.min(MIN_DEEP_CHUNK_SIZE)
		.max(MAX_DEEP_CHUNK_SIZE)
		.optional()
		.describe(`Characters to request per chunk. Defaults to ${DEFAULT_DEEP_CHUNK_SIZE}.`),
	max_chunks: z
		.number()
		.int()
		.min(1)
		.max(MAX_DEEP_MAX_CHUNKS)
		.optional()
		.describe(`Maximum chunks to request. Defaults to ${DEFAULT_DEEP_MAX_CHUNKS}.`),
	overlap_chars: z
		.number()
		.int()
		.min(0)
		.max(MAX_DEEP_OVERLAP_CHARS)
		.optional()
		.describe(`Characters of overlap between adjacent chunks. Defaults to ${DEFAULT_DEEP_OVERLAP_CHARS}.`),
	output_mode: z
		.enum(["inline", "file"])
		.optional()
		.describe(`Where to place reconstructed text. Defaults to ${DEFAULT_DEEP_OUTPUT_MODE}.`),
	output_path: z
		.string()
		.optional()
		.describe(
			"Optional Markdown file path for output_mode=file. Relative paths resolve from the current working directory.",
		),
});

export type XSearchParams = z.infer<typeof xSearchSchema>;
export type XSearchDeepParams = z.infer<typeof xSearchDeepSchema>;

type XSearchToolDefinition = {
	type: "x_search";
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	enable_image_understanding?: true;
	enable_video_understanding?: true;
	return_full_text?: true;
};

type XSearchRequestPayload = {
	model: string;
	input: Array<{ role: "user"; content: string }>;
	tools: [XSearchToolDefinition];
	tool_choice: "required";
	store: false;
};

type InlineCitation = {
	title?: string;
	url?: string;
	start_index?: number;
	end_index?: number;
};

type XSearchSuccess = {
	success: true;
	provider: "xai";
	credential_source: CredentialSource;
	tool: "x_search";
	model: string;
	query: string;
	response_id?: string;
	answer: string;
	citations: unknown[];
	inline_citations: InlineCitation[];
};

type XSearchFailure = {
	success: false;
	provider: "xai";
	credential_source?: CredentialSource;
	tool: XSearchToolName;
	model?: string;
	query?: string;
	error: string;
	error_type: string;
	status?: number;
};

type XSearchDeepChunk = {
	index: number;
	start: number;
	end: number;
	text: string;
	response_id?: string;
	truncated: boolean;
};

type XSearchDeepSuccess = {
	success: true;
	provider: "xai";
	credential_source: CredentialSource;
	tool: "x_search_deep";
	model: string;
	query: string;
	char_count?: number;
	chunk_size: number;
	max_chunks: number;
	overlap_chars: number;
	chunks_requested: number;
	complete: boolean;
	output_mode: XSearchDeepOutputMode;
	output_path?: string;
	bytes_written?: number;
	full_text?: string;
	answer: string;
	chunks: XSearchDeepChunk[];
	chunks_written?: number;
	warnings: string[];
	citations: unknown[];
	inline_citations: InlineCitation[];
};

export type XSearchDetails = XSearchSuccess | XSearchDeepSuccess | XSearchFailure;

type ResolvedCredential = {
	source: CredentialSource;
	apiKey: string;
};

type FetchResponseLike = {
	ok: boolean;
	status: number;
	text(): Promise<string>;
};

type FetchLike = (
	url: string,
	init: {
		method: "POST";
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<FetchResponseLike>;

function getEnv(name: string): string | undefined {
	return process.env[name];
}

function nonEmptyEnv(name: string): string | undefined {
	const value = getEnv(name)?.trim();
	return value ? value : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	const parsed = Math.trunc(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "") || DEFAULT_XAI_BASE_URL;
}

function sanitizeFilePart(value: string): string {
	return (
		value
			.trim()
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "x-post"
	);
}

function extractStatusId(query: string): string | undefined {
	return query.match(/status\/(\d+)/)?.[1];
}

function normalizeHandles(handles: readonly string[] | undefined, fieldName: string): string[] {
	const cleaned: string[] = [];
	for (const handle of handles ?? []) {
		const normalized = handle.trim().replace(/^@+/, "");
		if (normalized && !cleaned.includes(normalized)) {
			cleaned.push(normalized);
		}
	}
	if (cleaned.length > MAX_HANDLES) {
		throw new Error(`${fieldName} supports at most ${MAX_HANDLES} handles`);
	}
	return cleaned;
}

function buildXSearchToolDefinition(params: XSearchParams): XSearchToolDefinition {
	const allowedHandles = normalizeHandles(params.allowed_x_handles, "allowed_x_handles");
	const excludedHandles = normalizeHandles(params.excluded_x_handles, "excluded_x_handles");
	if (allowedHandles.length > 0 && excludedHandles.length > 0) {
		throw new Error("allowed_x_handles and excluded_x_handles cannot be used together");
	}

	const tool: XSearchToolDefinition = { type: "x_search" };
	if (allowedHandles.length > 0) tool.allowed_x_handles = allowedHandles;
	if (excludedHandles.length > 0) tool.excluded_x_handles = excludedHandles;

	const fromDate = params.from_date?.trim();
	if (fromDate) tool.from_date = fromDate;
	const toDate = params.to_date?.trim();
	if (toDate) tool.to_date = toDate;

	if (params.enable_image_understanding === true) tool.enable_image_understanding = true;
	if (params.enable_video_understanding === true) tool.enable_video_understanding = true;
	if (params.return_full_text === true) tool.return_full_text = true;
	return tool;
}

function buildXSearchPayload(params: XSearchParams, model: string): XSearchRequestPayload {
	let query = params.query.trim();
	if (!query) {
		throw new Error("query is required");
	}
	if (params.return_full_text === true) {
		query = `Return the complete original post text verbatim. Do not summarize, truncate, or rewrite. Output only the full raw text of the matching X post(s).\n\n${query}`;
	}
	return {
		model,
		input: [{ role: "user", content: query }],
		tools: [buildXSearchToolDefinition(params)],
		tool_choice: "required",
		store: false,
	};
}

function containsTruncationMarker(text: string): boolean {
	return /<truncated:\d+ bytes original>/i.test(text);
}

function parseDeepCharCount(text: string): number | undefined {
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			const charCount = parsed.char_count;
			if (typeof charCount === "number" && Number.isFinite(charCount) && charCount > 0) {
				return Math.trunc(charCount);
			}
			if (typeof charCount === "string") {
				const numeric = Number.parseInt(charCount.replace(/[^\d]/g, ""), 10);
				return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
			}
		} catch {
			// Fall through to regex parsing for model outputs with non-strict JSON.
		}
	}

	const labeledMatch = text.match(/char[_\s-]*count["'\s:=]+([\d,]+)/i);
	if (!labeledMatch?.[1]) return undefined;
	const numeric = Number.parseInt(labeledMatch[1].replace(/,/g, ""), 10);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function resolveDeepOptions(params: XSearchDeepParams): { chunkSize: number; maxChunks: number; overlapChars: number } {
	const chunkSize = parseBoundedInt(
		params.chunk_size,
		DEFAULT_DEEP_CHUNK_SIZE,
		MIN_DEEP_CHUNK_SIZE,
		MAX_DEEP_CHUNK_SIZE,
	);
	const maxChunks = parseBoundedInt(params.max_chunks, DEFAULT_DEEP_MAX_CHUNKS, 1, MAX_DEEP_MAX_CHUNKS);
	const overlapChars = parseBoundedInt(
		params.overlap_chars,
		DEFAULT_DEEP_OVERLAP_CHARS,
		0,
		Math.min(MAX_DEEP_OVERLAP_CHARS, chunkSize - 1),
	);
	return { chunkSize, maxChunks, overlapChars };
}

function buildXSearchDeepCountQuery(query: string): string {
	return [
		"Find the exact X/Twitter post matching the query below.",
		"Return ONLY compact JSON, with no markdown and no post body.",
		'Schema: {"char_count": number}',
		"char_count must be the number of Unicode characters in the original post text, excluding quoted/reposted surrounding UI text.",
		"",
		query.trim(),
	].join("\n");
}

function buildXSearchDeepChunkQuery(query: string, start: number, end: number): string {
	return [
		"Find the exact X/Twitter post matching the query below.",
		`Return ONLY Unicode characters ${start} through ${end}, inclusive, from the original post text.`,
		"Do not summarize, rewrite, add ellipses, add markdown, add labels, or include any surrounding UI text.",
		"If this range starts after the end of the post, return an empty string.",
		"",
		query.trim(),
	].join("\n");
}

async function resolveXaiCredential(session: ToolSession): Promise<ResolvedCredential | undefined> {
	const sessionId = session.getSessionId?.() ?? undefined;
	const oauthKey = (await session.modelRegistry?.getApiKeyForProvider("xai-oauth", sessionId))?.trim();
	if (oauthKey) return { source: "xai-oauth", apiKey: oauthKey };

	const apiKey = (await session.modelRegistry?.getApiKeyForProvider("xai", sessionId))?.trim();
	if (apiKey) return { source: "xai", apiKey };

	return undefined;
}

function resolveModel(): string {
	return nonEmptyEnv("AMAZE_X_SEARCH_MODEL") ?? DEFAULT_X_SEARCH_MODEL;
}

function resolveBaseUrl(): string {
	return normalizeBaseUrl(
		nonEmptyEnv("AMAZE_X_SEARCH_BASE_URL") ?? nonEmptyEnv("XAI_BASE_URL") ?? DEFAULT_XAI_BASE_URL,
	);
}

function extractResponseText(payload: unknown): string {
	const root = asRecord(payload);
	const outputText = asString(root?.output_text)?.trim();
	if (outputText) return outputText;

	const parts: string[] = [];
	for (const itemValue of asArray(root?.output)) {
		const item = asRecord(itemValue);
		if (item?.type !== "message") continue;
		for (const contentValue of asArray(item.content)) {
			const content = asRecord(contentValue);
			if (!content) continue;
			const type = content.type;
			if (type !== "output_text" && type !== "text") continue;
			const text = asString(content.text)?.trim();
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

function extractInlineCitations(payload: unknown): InlineCitation[] {
	const root = asRecord(payload);
	const citations: InlineCitation[] = [];
	for (const itemValue of asArray(root?.output)) {
		const item = asRecord(itemValue);
		if (item?.type !== "message") continue;
		for (const contentValue of asArray(item.content)) {
			const content = asRecord(contentValue);
			for (const annotationValue of asArray(content?.annotations)) {
				const annotation = asRecord(annotationValue);
				if (!annotation) continue;
				const url = asString(annotation.url);
				const title = asString(annotation.title);
				if (!url && !title) continue;
				const citation: InlineCitation = {};
				if (title) citation.title = title;
				if (url) citation.url = url;
				const startIndex = asNumber(annotation.start_index);
				if (startIndex !== undefined) citation.start_index = startIndex;
				const endIndex = asNumber(annotation.end_index);
				if (endIndex !== undefined) citation.end_index = endIndex;
				citations.push(citation);
			}
		}
	}
	return citations;
}

function buildSuccessDetails(
	data: unknown,
	params: XSearchParams,
	credentialSource: CredentialSource,
	model: string,
): XSearchSuccess {
	const root = asRecord(data);
	const responseId = asString(root?.id);
	const details: XSearchSuccess = {
		success: true,
		provider: "xai",
		credential_source: credentialSource,
		tool: "x_search",
		model,
		query: params.query.trim(),
		answer: extractResponseText(data),
		citations: asArray(root?.citations),
		inline_citations: extractInlineCitations(data),
	};
	if (responseId) details.response_id = responseId;
	return details;
}

function createMergedAbortSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`x_search timed out after ${timeoutMs}ms`)), timeoutMs);

	if (signal?.aborted) {
		controller.abort(signal.reason);
	}

	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		},
	};
}

async function postResponses(
	fetchImpl: FetchLike,
	url: string,
	apiKey: string,
	payload: XSearchRequestPayload,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<FetchResponseLike> {
	const merged = createMergedAbortSignal(signal, timeoutMs);
	try {
		return await fetchImpl(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "amaze/x-search",
			},
			body: JSON.stringify(payload),
			signal: merged.signal,
		});
	} finally {
		merged.cleanup();
	}
}

async function callXaiResponses(
	fetchImpl: FetchLike,
	baseUrl: string,
	apiKey: string,
	payload: XSearchRequestPayload,
	options: { signal: AbortSignal | undefined; timeoutMs: number; retries: number },
): Promise<{ status: number; data: unknown }> {
	const endpoint = `${normalizeBaseUrl(baseUrl)}/responses`;
	let lastError: unknown;

	for (let attempt = 0; attempt <= options.retries; attempt += 1) {
		try {
			const response = await postResponses(fetchImpl, endpoint, apiKey, payload, options.signal, options.timeoutMs);
			const rawText = await response.text();
			let data: unknown;
			try {
				data = rawText ? JSON.parse(rawText) : {};
			} catch {
				data = { raw: rawText };
			}

			if (response.ok) return { status: response.status, data };

			if (response.status >= 500 && attempt < options.retries) {
				lastError = { status: response.status, data };
				continue;
			}

			throw { status: response.status, data };
		} catch (error) {
			lastError = error;
			const status = asNumber(asRecord(error)?.status);
			if ((status !== undefined && status < 500) || options.signal?.aborted) throw error;
			if (attempt >= options.retries) throw error;
		}
	}

	throw lastError;
}

function errorMessageFromData(data: unknown): string {
	const root = asRecord(data);
	const errorRecord = asRecord(root?.error);
	return (
		asString(errorRecord?.message) ??
		asString(root?.message) ??
		asString(root?.error) ??
		asString(root?.raw) ??
		JSON.stringify(data)
	);
}

function redactSensitiveValues(message: string, sensitiveValues: readonly string[]): string {
	let redacted = message;
	for (const value of sensitiveValues) {
		if (value) redacted = redacted.split(value).join("[redacted]");
	}
	return redacted;
}

function failureFromUnknown(
	error: unknown,
	params: Pick<XSearchParams, "query">,
	model: string,
	credentialSource?: CredentialSource,
	tool: XSearchToolName = "x_search",
	sensitiveValues: readonly string[] = [],
): XSearchFailure {
	const errorRecord = asRecord(error);
	const status = asNumber(errorRecord?.status);
	const data = errorRecord?.data;
	const details: XSearchFailure = {
		success: false,
		provider: "xai",
		tool,
		model,
		query: params.query,
		error: redactSensitiveValues(
			data !== undefined ? errorMessageFromData(data) : error instanceof Error ? error.message : String(error),
			sensitiveValues,
		),
		error_type: status
			? "api_error"
			: error instanceof Error && error.name === "AbortError"
				? "timeout"
				: "runtime_error",
	};
	if (credentialSource) details.credential_source = credentialSource;
	if (status !== undefined) details.status = status;
	return details;
}

function jsonToolResult(details: XSearchDetails): AgentToolResult<XSearchDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
		details,
		...(details.success ? {} : { isError: true }),
	};
}

function authRequiredResult(tool: XSearchToolName, model: string, query: string): AgentToolResult<XSearchDetails> {
	return jsonToolResult({
		success: false,
		provider: "xai",
		tool,
		model,
		query,
		error: "No xAI credentials found. Run /login and choose xAI Grok OAuth, or configure XAI_API_KEY for provider xai.",
		error_type: "auth_required",
	});
}

function resolveDeepOutputPath(params: XSearchDeepParams, cwd: string): string {
	const outputPath = params.output_path?.trim();
	if (outputPath) return path.isAbsolute(outputPath) ? outputPath : path.join(cwd, outputPath);

	const outputDir = nonEmptyEnv("AMAZE_X_SEARCH_DEEP_OUTPUT_DIR") ?? path.join(cwd, "x-search-deep-results");
	const id = extractStatusId(params.query) ?? sanitizeFilePart(params.query);
	return path.join(outputDir, `${id}.md`);
}

async function writeMarkdownHeader(
	filePath: string,
	params: XSearchDeepParams,
	meta: {
		charCount: number | undefined;
		chunkSize: number;
		maxChunks: number;
		overlapChars: number;
		chunksRequested: number;
	},
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const lines = [
		"# X Search Deep Result",
		"",
		`Query: ${params.query.trim()}`,
		`Generated at: ${new Date().toISOString()}`,
		`Reported char_count: ${meta.charCount ?? "unknown"}`,
		`Chunk size: ${meta.chunkSize}`,
		`Max chunks: ${meta.maxChunks}`,
		`Overlap chars: ${meta.overlapChars}`,
		`Chunks requested: ${meta.chunksRequested}`,
		"",
		"## Reconstructed Text",
		"",
	];
	await Bun.write(filePath, lines.join("\n"));
}

async function appendMarkdownChunk(filePath: string, chunk: XSearchDeepChunk): Promise<number> {
	const content = [
		`\n<!-- chunk ${chunk.index + 1}: chars ${chunk.start}-${chunk.end}; truncated=${chunk.truncated} -->\n`,
		chunk.text,
		"\n",
	].join("");
	await fs.appendFile(filePath, content, "utf8");
	return Buffer.byteLength(content, "utf8");
}

async function appendMarkdownWarnings(
	filePath: string,
	warnings: readonly string[],
	complete: boolean,
): Promise<number> {
	const lines = ["", "## Retrieval Status", "", `Complete: ${complete}`, "", "## Warnings", ""];
	if (warnings.length === 0) {
		lines.push("- None");
	} else {
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	lines.push("");
	const content = lines.join("\n");
	await fs.appendFile(filePath, content, "utf8");
	return Buffer.byteLength(content, "utf8");
}

async function executeXSearchInternal(
	params: XSearchParams,
	session: ToolSession,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<XSearchDetails>> {
	const model = resolveModel();
	let credentialSource: CredentialSource | undefined;
	let credentialApiKey: string | undefined;
	try {
		const query = params.query.trim();
		if (!query) {
			return jsonToolResult({
				success: false,
				provider: "xai",
				tool: "x_search",
				model,
				error: "query is required",
				error_type: "validation_error",
			});
		}

		const credential = await resolveXaiCredential(session);
		if (!credential) return authRequiredResult("x_search", model, query);
		credentialSource = credential.source;
		credentialApiKey = credential.apiKey;

		const fetchImpl = globalThis.fetch as FetchLike | undefined;
		if (!fetchImpl) {
			return jsonToolResult({
				success: false,
				provider: "xai",
				credential_source: credential.source,
				tool: "x_search",
				model,
				query,
				error: "global fetch is not available in this runtime",
				error_type: "runtime_error",
			});
		}

		const payload = buildXSearchPayload({ ...params, query }, model);
		const response = await callXaiResponses(fetchImpl, resolveBaseUrl(), credential.apiKey, payload, {
			signal,
			timeoutMs: parsePositiveInt(nonEmptyEnv("AMAZE_X_SEARCH_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
			retries: parsePositiveInt(nonEmptyEnv("AMAZE_X_SEARCH_RETRIES"), DEFAULT_RETRIES),
		});

		return jsonToolResult(buildSuccessDetails(response.data, { ...params, query }, credential.source, model));
	} catch (error) {
		return jsonToolResult(
			failureFromUnknown(
				error,
				params,
				model,
				credentialSource,
				"x_search",
				credentialApiKey ? [credentialApiKey] : [],
			),
		);
	}
}

async function executeXSearchDeepInternal(
	params: XSearchDeepParams,
	session: ToolSession,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<XSearchDetails>> {
	const model = resolveModel();
	let credentialSource: CredentialSource | undefined;
	let credentialApiKey: string | undefined;
	try {
		const query = params.query.trim();
		if (!query) {
			return jsonToolResult({
				success: false,
				provider: "xai",
				tool: "x_search_deep",
				model,
				error: "query is required",
				error_type: "validation_error",
			});
		}

		const credential = await resolveXaiCredential(session);
		if (!credential) return authRequiredResult("x_search_deep", model, query);
		credentialSource = credential.source;
		credentialApiKey = credential.apiKey;

		const fetchImpl = globalThis.fetch as FetchLike | undefined;
		if (!fetchImpl) {
			return jsonToolResult({
				success: false,
				provider: "xai",
				credential_source: credential.source,
				tool: "x_search_deep",
				model,
				query,
				error: "global fetch is not available in this runtime",
				error_type: "runtime_error",
			});
		}

		const timeoutMs = parsePositiveInt(nonEmptyEnv("AMAZE_X_SEARCH_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
		const retries = parsePositiveInt(nonEmptyEnv("AMAZE_X_SEARCH_RETRIES"), DEFAULT_RETRIES);
		const baseUrl = resolveBaseUrl();
		const { chunkSize, maxChunks, overlapChars } = resolveDeepOptions(params);
		const outputMode = params.output_mode ?? DEFAULT_DEEP_OUTPUT_MODE;
		const outputPath = outputMode === "file" ? resolveDeepOutputPath(params, session.cwd) : undefined;
		const baseParams: XSearchParams = { ...params, query, return_full_text: true };

		const callPrompt = async (input: string): Promise<XSearchSuccess> => {
			const payload = buildXSearchPayload({ ...baseParams, query: input, return_full_text: true }, model);
			const response = await callXaiResponses(fetchImpl, baseUrl, credential.apiKey, payload, {
				signal,
				timeoutMs,
				retries,
			});
			return buildSuccessDetails(response.data, { ...baseParams, query: input }, credential.source, model);
		};

		const warnings: string[] = [];
		const metadata = await callPrompt(buildXSearchDeepCountQuery(query));
		const charCount = parseDeepCharCount(metadata.answer);
		if (charCount === undefined) {
			warnings.push("Could not parse char_count from the metadata response; max_chunks will cap retrieval.");
		}
		if (containsTruncationMarker(metadata.answer)) {
			warnings.push("The metadata response contained a truncation marker; char_count may be unreliable.");
		}

		const requiredChunks =
			charCount === undefined ? maxChunks : Math.ceil(charCount / Math.max(1, chunkSize - overlapChars));
		const chunksRequested = Math.min(maxChunks, Math.max(1, requiredChunks));
		if (charCount !== undefined && requiredChunks > maxChunks) {
			warnings.push(
				`Post requires ${requiredChunks} chunks at chunk_size=${chunkSize}, but max_chunks=${maxChunks} capped retrieval.`,
			);
		}
		if (outputPath) {
			await writeMarkdownHeader(outputPath, params, {
				charCount,
				chunkSize,
				maxChunks,
				overlapChars,
				chunksRequested,
			});
		}

		const chunks: XSearchDeepChunk[] = [];
		let bytesWritten = 0;
		for (let index = 0; index < chunksRequested; index += 1) {
			const start = index * (chunkSize - overlapChars) + 1;
			const end = start + chunkSize - 1;
			const chunk = await callPrompt(buildXSearchDeepChunkQuery(query, start, end));
			const truncated = containsTruncationMarker(chunk.answer);
			if (truncated) warnings.push(`Chunk ${index + 1} contained a truncation marker.`);
			const chunkRecord: XSearchDeepChunk = {
				index,
				start,
				end,
				text: outputMode === "file" ? "" : chunk.answer,
				...(chunk.response_id ? { response_id: chunk.response_id } : {}),
				truncated,
			};
			chunks.push(chunkRecord);
			if (outputPath) bytesWritten += await appendMarkdownChunk(outputPath, { ...chunkRecord, text: chunk.answer });
			if (charCount === undefined && !chunk.answer) break;
		}

		const fullText = chunks
			.map((chunk, index) => (index > 0 && overlapChars > 0 ? chunk.text.slice(overlapChars) : chunk.text))
			.join("");
		if (charCount !== undefined && outputMode === "inline" && fullText.length < Math.floor(charCount * 0.85)) {
			warnings.push(
				`Merged text length (${fullText.length}) is much shorter than reported char_count (${charCount}).`,
			);
		}
		const complete = warnings.length === 0 && (charCount === undefined || chunksRequested >= requiredChunks);
		if (outputPath) bytesWritten += await appendMarkdownWarnings(outputPath, warnings, complete);
		const answer = outputPath
			? `x_search_deep wrote ${chunks.length} chunks to ${outputPath}. complete=${complete}. warnings=${warnings.length}.`
			: fullText;

		const details: XSearchDeepSuccess = {
			success: true,
			provider: "xai",
			credential_source: credential.source,
			tool: "x_search_deep",
			model,
			query,
			...(charCount !== undefined ? { char_count: charCount } : {}),
			chunk_size: chunkSize,
			max_chunks: maxChunks,
			overlap_chars: overlapChars,
			chunks_requested: chunksRequested,
			complete,
			output_mode: outputMode,
			...(outputPath
				? { output_path: outputPath, bytes_written: bytesWritten, chunks_written: chunks.length }
				: { full_text: fullText }),
			answer,
			chunks,
			warnings,
			citations: metadata.citations,
			inline_citations: metadata.inline_citations,
		};

		return jsonToolResult(details);
	} catch (error) {
		return jsonToolResult(
			failureFromUnknown(
				error,
				params,
				model,
				credentialSource,
				"x_search_deep",
				credentialApiKey ? [credentialApiKey] : [],
			),
		);
	}
}

export class XSearchTool implements AgentTool<typeof xSearchSchema, XSearchDetails> {
	readonly name = "x_search";
	readonly label = "X Search";
	readonly summary = "Search current X/Twitter content through xAI x_search";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = xSearchSchema;
	readonly strict = true;

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(xSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: XSearchParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<XSearchDetails>> {
		return untilAborted(signal, () => executeXSearchInternal(params, this.#session, signal));
	}
}

export class XSearchDeepTool implements AgentTool<typeof xSearchDeepSchema, XSearchDetails> {
	readonly name = "x_search_deep";
	readonly label = "X Search Deep";
	readonly summary = "Reconstruct long X/Twitter post text through chunked xAI x_search calls";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = xSearchDeepSchema;
	readonly strict = true;

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(xSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: XSearchDeepParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<XSearchDetails>> {
		return untilAborted(signal, () => executeXSearchDeepInternal(params, this.#session, signal));
	}
}

type XSearchRenderArgs = Partial<XSearchParams & XSearchDeepParams>;

function renderXSearchCall(title: string, args: XSearchRenderArgs, uiTheme: Theme): Component {
	const description = args.query ? truncateToWidth(args.query, TRUNCATE_LENGTHS.TITLE) : undefined;
	return new Text(renderStatusLine({ icon: "pending", title, description }, uiTheme), 0, 0);
}

function renderXSearchResult(
	title: string,
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	uiTheme: Theme,
): Component {
	const details = result.details as Partial<XSearchDetails> | undefined;
	const icon = result.isError || details?.success === false ? "error" : "success";
	const description =
		typeof details?.query === "string" ? truncateToWidth(details.query, TRUNCATE_LENGTHS.TITLE) : undefined;
	const header = renderStatusLine({ icon, title, description }, uiTheme);
	if (icon === "error") {
		const textContent = result.content.find(content => content.type === "text")?.text ?? "";
		const renderedLines = [header, formatErrorMessage(textContent, uiTheme)];
		return { render: () => renderedLines, invalidate() {} };
	}
	return new Text(header, 0, 0);
}

export const xSearchToolRenderer = {
	renderCall(args: XSearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		return renderXSearchCall("X Search", args, uiTheme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		return renderXSearchResult("X Search", result, uiTheme);
	},
	mergeCallAndResult: true,
};

export const xSearchDeepToolRenderer = {
	renderCall(args: XSearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		return renderXSearchCall("X Search Deep", args, uiTheme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		return renderXSearchResult("X Search Deep", result, uiTheme);
	},
	mergeCallAndResult: true,
};
