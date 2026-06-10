import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrowser } from "@amaze/coding-agent/tools/browser/registry";

describe("browser registry Chrome extension mode", () => {
	it("rejects extension paths that are not directories before launching Chrome", async () => {
		const dir = mkdtempSync(join(tmpdir(), "amaze-browser-registry-"));
		const extensionFile = join(dir, "extension.js");
		writeFileSync(extensionFile, "export {};\n");

		await expect(
			acquireBrowser(
				{
					kind: "chrome-extension",
					path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					userDataDir: join(dir, "profile"),
					extensionPath: extensionFile,
				},
				{ cwd: dir },
			),
		).rejects.toThrow("Chrome extension path must be a directory");
	});
});
