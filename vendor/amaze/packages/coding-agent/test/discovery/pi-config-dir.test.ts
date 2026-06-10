import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@amaze/coding-agent/capability/types";
import { getConfigDirs } from "@amaze/coding-agent/config";
import { getUserPath } from "@amaze/coding-agent/discovery/helpers";

describe("AMAZE_CONFIG_DIR", () => {
	const original = process.env.AMAZE_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.AMAZE_CONFIG_DIR;
		} else {
			process.env.AMAZE_CONFIG_DIR = original;
		}
	});

	test("getUserPath uses AMAZE_CONFIG_DIR for native userAgent", () => {
		process.env.AMAZE_CONFIG_DIR = ".config/amaze";
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		const result = getUserPath(ctx, "native", "commands");
		expect(result).toBe(path.join(ctx.home, ".config/amaze/agent", "commands"));
	});

	test("getConfigDirs respects AMAZE_CONFIG_DIR for user base", () => {
		process.env.AMAZE_CONFIG_DIR = ".config/amaze";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/amaze", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".amaze", level: "user" });
	});
});
