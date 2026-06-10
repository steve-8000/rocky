import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@amaze/coding-agent/capability/mcp";
import { loadCapability } from "@amaze/coding-agent/discovery";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
	const originalEnv = {
		AMAZE_OAUTH_TOKEN_URL: process.env.AMAZE_OAUTH_TOKEN_URL,
		AMAZE_OAUTH_CLIENT_ID: process.env.AMAZE_OAUTH_CLIENT_ID,
		AMAZE_OAUTH_CLIENT_SECRET: process.env.AMAZE_OAUTH_CLIENT_SECRET,
		AMAZE_OAUTH_REDIRECT_URI: process.env.AMAZE_OAUTH_REDIRECT_URI,
		AMAZE_OAUTH_CALLBACK_PATH: process.env.AMAZE_OAUTH_CALLBACK_PATH,
		AMAZE_MCP_HEADER: process.env.AMAZE_MCP_HEADER,
		AMAZE_MCP_URL: process.env.AMAZE_MCP_URL,
		AMAZE_MCP_ENV: process.env.AMAZE_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-mcp-json-"));
		process.env.AMAZE_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.AMAZE_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.AMAZE_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.AMAZE_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.AMAZE_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.AMAZE_MCP_HEADER = "Bearer test-token";
		process.env.AMAZE_MCP_URL = "https://mcp.example.com";
		process.env.AMAZE_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("AMAZE_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("AMAZE_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("AMAZE_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("AMAZE_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("AMAZE_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("AMAZE_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("AMAZE_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("AMAZE_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("AMAZE_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("AMAZE_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("AMAZE_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("AMAZE_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});
