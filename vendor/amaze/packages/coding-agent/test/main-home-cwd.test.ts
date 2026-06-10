import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { getProjectDir, setProjectDir } from "@amaze/utils";
import type { Args } from "../src/cli/args";
import { runRootCommand } from "../src/main";

const originalProjectDir = getProjectDir();
const homeDir = os.homedir();

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});

describe("runRootCommand startup cwd", () => {
	it("keeps the home directory instead of auto-switching to a scratch tmp dir", async () => {
		setProjectDir(homeDir);

		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);

		const args: Args = {
			version: true,
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
		};

		await expect(
			runRootCommand(args, [], {
				discoverAuthStorage: async () =>
					({
						setFallbackResolver: () => {},
						setConfigApiKey: () => {},
						hasAuth: () => false,
						hasOAuth: () => false,
						peekApiKey: () => undefined,
						getApiKey: async () => undefined,
					}) as never,
			}),
		).rejects.toThrow("process.exit:0");

		expect(stdoutSpy).toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(0);
		expect(getProjectDir()).toBe(homeDir);
	});
});
