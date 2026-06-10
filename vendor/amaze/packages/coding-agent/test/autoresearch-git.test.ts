import { describe, expect, it } from "bun:test";
import { parseDirtyPaths, parseDirtyPathsWithStatus } from "../src/autoresearch/git";

describe("autoresearch git dirty path parsing", () => {
	it("preserves rename targets containing the literal arrow substring in line mode", () => {
		const status = "R  old.txt -> docs/a -> b.txt\n";

		expect(parseDirtyPaths(status)).toEqual(["old.txt", "docs/a -> b.txt"]);
		expect(parseDirtyPathsWithStatus(status)).toEqual([
			{ path: "old.txt", untracked: false },
			{ path: "docs/a -> b.txt", untracked: false },
		]);
	});
});
