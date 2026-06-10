import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "@amaze/coding-agent/tools";
import { XSearchDeepTool, XSearchTool } from "@amaze/coding-agent/tools/x-search";

const ORIGINAL_ENV = {
	AMAZE_X_SEARCH_MODEL: process.env.AMAZE_X_SEARCH_MODEL,
	AMAZE_X_SEARCH_BASE_URL: process.env.AMAZE_X_SEARCH_BASE_URL,
	XAI_BASE_URL: process.env.XAI_BASE_URL,
	AMAZE_X_SEARCH_TIMEOUT_MS: process.env.AMAZE_X_SEARCH_TIMEOUT_MS,
	AMAZE_X_SEARCH_RETRIES: process.env.AMAZE_X_SEARCH_RETRIES,
	AMAZE_X_SEARCH_DEEP_OUTPUT_DIR: process.env.AMAZE_X_SEARCH_DEEP_OUTPUT_DIR,
};

type FetchCall = {
	url: string;
	init: RequestInit & { body: string; headers: Record<string, string> };
};

function restoreEnv() {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function clearXSearchEnvOverrides() {
	delete process.env.AMAZE_X_SEARCH_MODEL;
	delete process.env.AMAZE_X_SEARCH_BASE_URL;
	delete process.env.XAI_BASE_URL;
	delete process.env.AMAZE_X_SEARCH_DEEP_OUTPUT_DIR;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status });
}

function installFetchMock(
	impl: (url: string | Request | URL, init: BunFetchRequestInit | RequestInit | undefined) => Promise<Response>,
) {
	vi.spyOn(globalThis, "fetch").mockImplementation(impl as typeof fetch);
}

function createSession(keys: Partial<Record<"xai-oauth" | "xai", string>>): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "session-1",
		modelRegistry: {
			async getApiKeyForProvider(provider: string, sessionId?: string) {
				expect(sessionId).toBe("session-1");
				return keys[provider as "xai-oauth" | "xai"];
			},
		},
		settings: {},
	} as ToolSession;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("x_search tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv();
	});

	it("prefers xai-oauth credentials over xai and does not leak credentials in output", async () => {
		process.env.AMAZE_X_SEARCH_RETRIES = "0";
		const calls: FetchCall[] = [];
		installFetchMock(async (url, init) => {
			calls.push({ url: String(url), init: init as FetchCall["init"] });
			return jsonResponse({ id: "resp-1", output_text: "result text" });
		});

		const tool = new XSearchTool(createSession({ "xai-oauth": "oauth-secret", xai: "api-secret" }));
		const result = await tool.execute("call-1", { query: "from:xai" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init.headers.Authorization).toBe("Bearer oauth-secret");
		expect(result.details?.success).toBe(true);
		if (result.details?.success) {
			expect(result.details.credential_source).toBe("xai-oauth");
		}
		const output = textContent(result);
		expect(output).not.toContain("oauth-secret");
		expect(output).not.toContain("api-secret");
	});

	it("builds Responses API payload with store false, x_search tool, default model, filters, and normalized handles", async () => {
		process.env.AMAZE_X_SEARCH_RETRIES = "0";
		clearXSearchEnvOverrides();
		const calls: FetchCall[] = [];
		installFetchMock(async (url, init) => {
			calls.push({ url: String(url), init: init as FetchCall["init"] });
			return jsonResponse({ output_text: "ok" });
		});

		const tool = new XSearchTool(createSession({ xai: "api-key" }));
		await tool.execute("call-1", {
			query: " x search query ",
			allowed_x_handles: [" @xai ", "@grok", "xai", ""],
			from_date: " 2026-01-01 ",
			to_date: " 2026-01-31 ",
			enable_image_understanding: true,
			enable_video_understanding: false,
			return_full_text: true,
		});

		expect(calls[0]?.url).toBe("https://api.x.ai/v1/responses");
		const payload = JSON.parse(calls[0]?.init.body ?? "{}");
		expect(payload.model).toBe("grok-4.3");
		expect(payload.store).toBe(false);
		expect(payload.tool_choice).toBe("required");
		expect(payload.tools).toEqual([
			{
				type: "x_search",
				allowed_x_handles: ["xai", "grok"],
				from_date: "2026-01-01",
				to_date: "2026-01-31",
				enable_image_understanding: true,
				return_full_text: true,
			},
		]);
		expect(payload.input[0].content).toContain("Return the complete original post text verbatim");
		expect(payload.input[0].content).toContain("x search query");
	});

	it("honors model override", async () => {
		process.env.AMAZE_X_SEARCH_MODEL = "grok-test";
		process.env.AMAZE_X_SEARCH_RETRIES = "0";
		const calls: FetchCall[] = [];
		installFetchMock(async (url, init) => {
			calls.push({ url: String(url), init: init as FetchCall["init"] });
			return jsonResponse({ output_text: "ok" });
		});

		const tool = new XSearchTool(createSession({ xai: "api-key" }));
		await tool.execute("call-1", { query: "latest" });

		const payload = JSON.parse(calls[0]?.init.body ?? "{}");
		expect(payload.model).toBe("grok-test");
	});

	it("returns auth_required when no xAI credentials exist", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const tool = new XSearchTool(createSession({}));

		const result = await tool.execute("call-1", { query: "latest" });

		expect(result.isError).toBe(true);
		expect(result.details?.success).toBe(false);
		if (result.details?.success === false) {
			expect(result.details.error_type).toBe("auth_required");
			expect(result.details.error).toContain("/login");
			expect(result.details.error).toContain("XAI_API_KEY");
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("x_search_deep tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv();
	});

	it("performs count and chunk requests and returns merged inline text", async () => {
		process.env.AMAZE_X_SEARCH_RETRIES = "0";
		const firstChunk = "a".repeat(200);
		const secondChunk = "b".repeat(150);
		const calls: FetchCall[] = [];
		installFetchMock(async (url, init) => {
			calls.push({ url: String(url), init: init as FetchCall["init"] });
			if (calls.length === 1) return jsonResponse({ output_text: '{"char_count":350}' });
			if (calls.length === 2) return jsonResponse({ id: "chunk-1", output_text: firstChunk });
			return jsonResponse({ id: "chunk-2", output_text: secondChunk });
		});

		const tool = new XSearchDeepTool(createSession({ "xai-oauth": "oauth-secret" }));
		const result = await tool.execute("call-1", {
			query: "https://x.com/xai/status/123",
			chunk_size: 200,
			max_chunks: 3,
			overlap_chars: 0,
			output_mode: "inline",
		});

		expect(calls).toHaveLength(3);
		const countPayload = JSON.parse(calls[0]?.init.body ?? "{}");
		const firstChunkPayload = JSON.parse(calls[1]?.init.body ?? "{}");
		const secondChunkPayload = JSON.parse(calls[2]?.init.body ?? "{}");
		expect(countPayload.input[0].content).toContain("char_count");
		expect(firstChunkPayload.input[0].content).toContain("Unicode characters 1 through 200");
		expect(secondChunkPayload.input[0].content).toContain("Unicode characters 201 through 400");
		expect(result.details?.success).toBe(true);
		if (result.details?.success && result.details.tool === "x_search_deep") {
			expect(result.details.output_mode).toBe("inline");
			expect(result.details.chunks_requested).toBe(2);
			expect(result.details.full_text).toBe(`${firstChunk}${secondChunk}`);
			expect(result.details.answer).toBe(`${firstChunk}${secondChunk}`);
		}
	});
});
