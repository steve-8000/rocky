import { afterEach, beforeEach, describe, expect, it } from "bun:test";

type ServerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

let proc: ServerProcess | undefined;

beforeEach(() => {
	proc = undefined;
});

afterEach(() => {
	proc?.kill();
});

describe("amaze browser bridge MCP server", () => {
	it("lists tools over newline-delimited JSON-RPC", async () => {
		proc = startServer();
		await waitForStderr(proc, "Amaze browser bridge listening");

		const initialize = await rpc(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(initialize.result.serverInfo.name).toBe("amaze-browser-bridge");

		const listed = await rpc(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"browser_tabs",
			"browser_eval",
			"browser_control",
		]);
	});

	it("reports a deterministic error when no Chrome tabs are connected", async () => {
		proc = startServer();
		await waitForStderr(proc, "Amaze browser bridge listening");

		const result = await rpc(proc, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "browser_eval", arguments: { script: "return document.title" } },
		});

		expect(result.result.isError).toBe(true);
		expect(result.result.content[0].text).toContain("No Chrome tabs are connected");
	});

	it("reports a deterministic error when browser control has no extension bridge", async () => {
		proc = startServer();
		await waitForStderr(proc, "Amaze browser bridge listening");

		const result = await rpc(proc, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "browser_control", arguments: { type: "tabs_query" } },
		});

		expect(result.result.isError).toBe(true);
		expect(result.result.content[0].text).toContain("No Chrome extension bridge is connected");
	});
});

function startServer(): ServerProcess {
	return Bun.spawn(["bun", "src/mcp-server.ts"], {
		cwd: import.meta.dir.replace(/\/src$/, ""),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...Bun.env,
			AMAZE_BROWSER_BRIDGE_PORT: "0",
		},
	});
}

async function rpc(proc: ServerProcess, request: Record<string, unknown>): Promise<any> {
	proc.stdin.write(`${JSON.stringify(request)}\n`);
	proc.stdin.flush();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("MCP server stdout closed before response.");
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(text.slice(0, text.indexOf("\n")));
}

async function waitForStderr(proc: ServerProcess, needle: string): Promise<void> {
	const reader = proc.stderr.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`Process exited before stderr contained ${needle}`);
			text += decoder.decode(value, { stream: true });
			if (text.includes(needle)) return;
		}
	} finally {
		reader.releaseLock();
	}
}
