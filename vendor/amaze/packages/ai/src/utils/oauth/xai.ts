import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOSTNAME = "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://${CALLBACK_HOSTNAME}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 120_000;

type XaiDiscovery = {
	authorization_endpoint: string;
	token_endpoint: string;
};

type XaiTokenPayload = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
};

type PKCE = {
	verifier: string;
	challenge: string;
};

function validateXaiEndpoint(url: string, field: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`xAI OAuth discovery ${field} is not a valid URL`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`xAI OAuth discovery ${field} must use https`);
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== "x.ai" && !host.endsWith(".x.ai")) {
		throw new Error(`xAI OAuth discovery ${field} must be hosted on x.ai or a subdomain`);
	}
}

export function getXaiJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000;
	} catch {
		return undefined;
	}
}

export function getXaiExpiresAt(accessToken: string, expiresIn: unknown, now: number = Date.now()): number {
	const jwtExpiry = getXaiJwtExpiryMs(accessToken);
	if (jwtExpiry) return jwtExpiry - REFRESH_SKEW_MS;
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
		return now + expiresIn * 1000 - REFRESH_SKEW_MS;
	}
	return now + 55 * 60_000;
}

async function discoverXaiOAuth(): Promise<XaiDiscovery> {
	const response = await fetch(DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`xAI OAuth discovery failed with status ${response.status}`);
	}
	const payload = (await response.json()) as Partial<XaiDiscovery>;
	const authorizationEndpoint = String(payload.authorization_endpoint || "").trim();
	const tokenEndpoint = String(payload.token_endpoint || "").trim();
	if (!authorizationEndpoint || !tokenEndpoint) {
		throw new Error("xAI OAuth discovery response is missing endpoints");
	}
	validateXaiEndpoint(authorizationEndpoint, "authorization_endpoint");
	validateXaiEndpoint(tokenEndpoint, "token_endpoint");
	return { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
}

async function exchangeXaiToken(tokenEndpoint: string, body: URLSearchParams): Promise<XaiTokenPayload> {
	validateXaiEndpoint(tokenEndpoint, "token_endpoint");
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`xAI OAuth token request failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	return (await response.json()) as XaiTokenPayload;
}

function credentialsFromXaiTokenPayload(payload: XaiTokenPayload, previousRefresh?: string): OAuthCredentials {
	const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
	const responseRefresh = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
	const refresh = responseRefresh || previousRefresh || "";
	if (!access) throw new Error("xAI OAuth token response is missing access_token");
	if (!refresh) throw new Error("xAI OAuth token response is missing refresh_token");
	return {
		access,
		refresh,
		expires: getXaiExpiresAt(access, payload.expires_in),
	};
}

class XaiOAuthFlow extends OAuthCallbackFlow {
	#discovery?: XaiDiscovery;
	#pkce: PKCE;
	constructor(ctrl: OAuthController, pkce: PKCE) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			callbackHostname: CALLBACK_HOSTNAME,
			redirectUri: REDIRECT_URI,
		});
		this.#pkce = pkce;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		this.ctrl.onProgress?.("Discovering xAI OAuth endpoints...");
		const discovery = await discoverXaiOAuth();
		this.#discovery = discovery;
		const nonce = crypto.randomUUID?.().replaceAll("-", "") ?? state;
		const params = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			scope: SCOPE,
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			state,
			nonce,
			plan: "generic",
			referrer: "amaze",
		});
		return {
			url: `${discovery.authorization_endpoint}?${params.toString()}`,
			instructions:
				"Authorize xAI Grok OAuth in your browser with a SuperGrok subscription. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const discovery = this.#discovery ?? (await discoverXaiOAuth());
		const payload = await exchangeXaiToken(
			discovery.token_endpoint,
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				code_verifier: this.#pkce.verifier,
				redirect_uri: redirectUri,
			}),
		);
		return credentialsFromXaiTokenPayload(payload);
	}
}

export async function loginXaiOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const flow = new XaiOAuthFlow(ctrl, pkce);
	return flow.login();
}

export async function refreshXaiOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const discovery = await discoverXaiOAuth();
	const payload = await exchangeXaiToken(
		discovery.token_endpoint,
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
	);
	return credentialsFromXaiTokenPayload(payload, credentials.refresh);
}
