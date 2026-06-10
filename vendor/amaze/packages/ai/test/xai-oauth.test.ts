import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@amaze/utils";
import { AuthStorage } from "../src/auth-storage";
import { getOAuthProviders } from "../src/utils/oauth";
import { getXaiExpiresAt, refreshXaiOAuthToken } from "../src/utils/oauth/xai";

function makeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.`;
}

describe("xAI OAuth", () => {
	it("registers xAI Grok OAuth as a built-in provider", () => {
		const provider = getOAuthProviders().find(candidate => candidate.id === "xai-oauth");

		expect(provider).toEqual({ id: "xai-oauth", name: "xAI Grok OAuth", available: true });
	});

	it("refreshes through the discovered token endpoint and preserves omitted refresh tokens", async () => {
		const tokenEndpoint = "https://auth.x.ai/oauth/token";
		const accessToken = makeJwt({ exp: 2_000_000_000 });
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://auth.x.ai/.well-known/openid-configuration") {
				return Response.json({
					authorization_endpoint: "https://auth.x.ai/oauth/authorize",
					token_endpoint: tokenEndpoint,
				});
			}
			if (url === tokenEndpoint) {
				return Response.json({ access_token: accessToken, expires_in: 3600 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const result = await refreshXaiOAuthToken({ access: "old-access", refresh: "old-refresh", expires: 0 });
		const tokenRequest = requests[1];

		expect(requests.map(request => request.url)).toEqual([
			"https://auth.x.ai/.well-known/openid-configuration",
			tokenEndpoint,
		]);
		expect(tokenRequest?.init?.method).toBe("POST");
		expect(new Headers(tokenRequest?.init?.headers).get("Accept")).toBe("application/json");
		expect(new Headers(tokenRequest?.init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(String(tokenRequest?.init?.body)).toBe(
			"grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=old-refresh",
		);
		expect(result).toEqual({
			access: accessToken,
			refresh: "old-refresh",
			expires: 2_000_000_000 * 1000 - 120_000,
		});
	});

	it("uses stored xai-oauth credentials for xai provider API keys", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xai-oauth-alias-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			await authStorage.set("xai-oauth", [
				{
					type: "oauth",
					access: "xai-access-token",
					refresh: "xai-refresh-token",
					expires: Date.now() + 60_000,
				},
			]);

			expect(authStorage.hasAuth("xai")).toBe(true);
			expect(await authStorage.peekApiKey("xai")).toBe("xai-access-token");
			expect(await authStorage.getApiKey("xai", "session-xai")).toBe("xai-access-token");
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("invalidates stored xai-oauth credentials through the xai provider alias", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xai-oauth-invalidate-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			await authStorage.set("xai-oauth", [
				{
					type: "oauth",
					access: "xai-access-token",
					refresh: "xai-refresh-token",
					expires: Date.now() + 60_000,
				},
			]);

			expect(await authStorage.invalidateCredentialMatching("xai", "xai-access-token")).toBe(true);
			expect(await authStorage.peekApiKey("xai")).toBeUndefined();
			expect(authStorage.hasAuth("xai")).toBe(false);
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers JWT expiry over expires_in", () => {
		const accessToken = makeJwt({ exp: 3_000 });

		expect(getXaiExpiresAt(accessToken, 10, 1_000)).toBe(3_000 * 1000 - 120_000);
	});
});
