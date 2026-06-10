import { describe, expect, it } from "bun:test";
import { Settings } from "@amaze/coding-agent/config/settings";
import { resolveBrowserKind } from "@amaze/coding-agent/tools/browser";
import type { ToolSession } from "../../src/sdk";

function session(cwd = "/workspace/project"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({}),
	} as unknown as ToolSession;
}

describe("browser Chrome profile mode", () => {
	it("resolves Chrome mode to a persistent profile browser kind", () => {
		const kind = resolveBrowserKind(
			{
				action: "open",
				app: {
					kind: "chrome",
					path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					user_data_dir: ".amaze/chrome-profile",
					extension_path: "extensions/test-extension",
				},
			},
			session(),
		);

		expect(kind).toEqual({
			kind: "chrome-extension",
			path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			userDataDir: "/workspace/project/.amaze/chrome-profile",
			extensionPath: "/workspace/project/extensions/test-extension",
		});
	});

	it("keeps app.path as spawned app mode unless Chrome mode is explicit", () => {
		const kind = resolveBrowserKind(
			{ action: "open", app: { path: "/Applications/Cursor.app/Contents/MacOS/Cursor" } },
			session(),
		);

		expect(kind).toEqual({ kind: "spawned", path: "/Applications/Cursor.app/Contents/MacOS/Cursor" });
	});

	it("rejects ambiguous Chrome profile plus existing CDP endpoint configuration", () => {
		expect(() => {
			resolveBrowserKind({ action: "open", app: { kind: "chrome", cdp_url: "http://127.0.0.1:9222" } }, session());
		}).toThrow("app.kind='chrome' cannot be combined with app.cdp_url");
	});

	it("uses the configured default headless browser when no app is requested", () => {
		const kind = resolveBrowserKind({ action: "open" }, session());

		expect(kind).toEqual({ kind: "headless", headless: true });
	});
});
