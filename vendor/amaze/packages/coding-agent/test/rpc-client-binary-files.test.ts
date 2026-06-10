import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@amaze/coding-agent/modes";
import type { RpcHostFileReadRequest, RpcHostFileResult } from "@amaze/coding-agent/modes/rpc/rpc-types";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempPaths.splice(0).map(async filePath => {
			try {
				await fs.rm(filePath, { force: true });
			} catch {}
		}),
	);
});

async function createHostFileScript(): Promise<string> {
	const scriptPath = path.join(os.tmpdir(), `amaze-rpc-host-file-${Date.now()}-${Math.random()}.js`);
	tempPaths.push(scriptPath);
	await Bun.write(
		scriptPath,
		`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "host_file_read", id: "file-read-1", path: "/client/image.png", maxBytes: 1024 });
		return;
	}
	if (frame.type === "host_file_result") {
		write({ type: "agent_start" });
		write({
			type: "tool_execution_end",
			toolCallId: "toolu_file_1",
			toolName: "readBinaryFile",
			result: { content: [{ type: "text", text: frame.isError ? frame.error : frame.dataBase64 }], details: frame },
			isError: frame.isError === true,
		});
		write({ type: "agent_end", messages: [] });
	}
}
`,
	);
	return scriptPath;
}

describe("RpcClient host binary file reads", () => {
	it("serves host_file_read requests with callback results", async () => {
		const scriptPath = await createHostFileScript();
		let received: { path: string; maxBytes: number; aborted: boolean } | undefined;
		const client = new RpcClient({
			cliPath: scriptPath,
			readBinaryFile: async params => {
				received = { path: params.path, maxBytes: params.maxBytes, aborted: params.signal.aborted };
				return { dataBase64: "aGVsbG8=", mimeType: "image/png" };
			},
		});

		try {
			await client.start();
			const events = await client.promptAndWait("read host file");
			const resultEvent = events.find(
				(event): event is Extract<(typeof events)[number], { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);

			expect(received).toEqual({ path: "/client/image.png", maxBytes: 1024, aborted: false });
			expect(resultEvent?.isError).toBe(false);
			expect(resultEvent?.result).toEqual({
				content: [{ type: "text", text: "aGVsbG8=" }],
				details: {
					type: "host_file_result",
					id: "file-read-1",
					dataBase64: "aGVsbG8=",
					mimeType: "image/png",
				},
			});
		} finally {
			client.stop();
		}
	});

	it("returns an error result when no binary read callback is configured", async () => {
		const scriptPath = await createHostFileScript();
		const client = new RpcClient({ cliPath: scriptPath });

		try {
			await client.start();
			const events = await client.promptAndWait("read host file");
			const resultEvent = events.find(
				(event): event is Extract<(typeof events)[number], { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);

			expect(resultEvent?.isError).toBe(true);
			expect(resultEvent?.result.content[0]).toEqual({
				type: "text",
				text: "Host binary file reads are not configured",
			});
		} finally {
			client.stop();
		}
	});

	it("returns an error result when the binary read callback throws", async () => {
		const scriptPath = await createHostFileScript();
		const client = new RpcClient({
			cliPath: scriptPath,
			readBinaryFile: async () => {
				throw new Error("host file missing");
			},
		});

		try {
			await client.start();
			const events = await client.promptAndWait("read host file");
			const resultEvent = events.find(
				(event): event is Extract<(typeof events)[number], { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);

			expect(resultEvent?.isError).toBe(true);
			expect(resultEvent?.result.content[0]).toEqual({ type: "text", text: "host file missing" });
		} finally {
			client.stop();
		}
	});
});

describe("RPC host binary file frame types", () => {
	it("describe request and result payloads", () => {
		const request = {
			type: "host_file_read",
			id: "read-1",
			path: "/client/image.png",
			maxBytes: 4096,
		} satisfies RpcHostFileReadRequest;
		const result = {
			type: "host_file_result",
			id: request.id,
			dataBase64: "aGVsbG8=",
			mimeType: "image/png",
		} satisfies RpcHostFileResult;

		expect(result.dataBase64).toBe("aGVsbG8=");
	});
});
