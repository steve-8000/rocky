import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@amaze/agent-core";
import { prompt, untilAborted } from "@amaze/utils";
import * as z from "zod/v4";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { acquireBrowser, type BrowserHandle, type BrowserKind, type BrowserKindTag } from "./browser/registry";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import {
	acquireTab,
	dropHeadlessTabs,
	getTab,
	releaseAllTabs,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
} from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";
export { releaseTabsForOwner };

const DEFAULT_TAB_NAME = "main";

const appSchema = z.object({
	path: z.string().describe("binary path to spawn").optional(),
	cdp_url: z.string().describe("existing cdp endpoint").optional(),
	args: z.array(z.string()).describe("extra cli args").optional(),
	target: z.string().describe("substring to pick a window").optional(),
	kind: z
		.enum(["chrome"] as const)
		.describe("launch a persistent Chrome/Chromium profile")
		.optional(),
	user_data_dir: z.string().describe("persistent Chrome profile directory for chrome mode").optional(),
	extension_path: z.string().describe("unpacked Chrome extension directory for chrome mode").optional(),
});

const browserSchema = z.object({
	action: z.enum(["open", "close", "run"] as const).describe("operation"),
	name: z.string().describe("tab id (default 'main')").optional(),
	url: z.string().describe("url to open").optional(),
	app: appSchema.optional(),
	viewport: z
		.object({
			width: z.number(),
			height: z.number(),
			scale: z.number().optional(),
		})
		.optional(),
	wait_until: z
		.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"] as const)
		.describe("navigation wait condition")
		.optional(),
	dialogs: z
		.enum(["accept", "dismiss"] as const)
		.describe("auto-handle dialogs")
		.optional(),
	code: z.string().describe("js body to run in tab").optional(),
	timeout: z.number().default(30).describe("timeout in seconds (default 30, max 300)").optional(),
	all: z.boolean().describe("close every tab").optional(),
	kill: z.boolean().describe("also kill spawned-app browsers").optional(),
});

/** Input schema for the browser tool. */
export type BrowserParams = z.infer<typeof browserSchema>;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
}

export function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		if (app.kind === "chrome") {
			throw new ToolError("app.kind='chrome' cannot be combined with app.cdp_url. Use app.path or omit app.path.");
		}
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		if (app.kind === "chrome") {
			return {
				kind: "chrome-extension",
				path: exe,
				userDataDir: app.user_data_dir ? resolveToCwd(app.user_data_dir, session.cwd) : undefined,
				extensionPath: app.extension_path ? resolveToCwd(app.extension_path, session.cwd) : undefined,
			};
		}
		return { kind: "spawned", path: exe };
	}
	if (app?.kind === "chrome" || app?.user_data_dir || app?.extension_path) {
		return {
			kind: "chrome-extension",
			userDataDir: app?.user_data_dir ? resolveToCwd(app.user_data_dir, session.cwd) : undefined,
			extensionPath: app?.extension_path ? resolveToCwd(app.extension_path, session.cwd) : undefined,
		};
	}
	const headless = session.settings.get("browser.headless") ?? true;
	return { kind: "headless", headless };
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | chrome-extension | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control Chromium tabs, including persistent Chrome-profile automation";
	readonly parameters = browserSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = await untilAborted(signal, () =>
			acquireBrowser(kind, {
				cwd: this.session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				appArgs: params.app?.args,
				signal,
			}),
		);

		const result = await untilAborted(signal, () =>
			acquireTab(name, browser, {
				url: params.url,
				waitUntil: params.wait_until,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				target: params.app?.target,
				timeoutMs,
				dialogs: params.dialogs,
				ownerId: resolveBrowserOwnerId(this.session),
				signal,
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(lines.join("\n")).done();
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill }));
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill }));
		details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		details.result = textOnly;
		return toolResult(details).content(content).done();
	}
}

function resolveBrowserOwnerId(session: ToolSession): string | undefined {
	return session.getAgentId?.() ?? session.getSessionId?.() ?? undefined;
}

function describeBrowser(handle: BrowserHandle): string {
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "chrome-extension":
			return `Chrome extension browser${handle.pid ? ` (pid ${handle.pid})` : ""}`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "chrome-extension":
			return `chrome${kind.path ? `:${kind.path}` : ""}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "chrome-extension" && b.kind === "chrome-extension") {
		return a.path === b.path && a.userDataDir === b.userDataDir && a.extensionPath === b.extensionPath;
	}
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
