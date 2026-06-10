import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { filterProcessEnv, parseEnvFile, procmgr } from "../src";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid AMAZE_ variables to AMAZE_ variables", () => {
		const filePath = writeTempEnv("AMAZE_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			AMAZE_FEATURE: "enabled",
		});
	});
});

describe("scrubProcessEnv", () => {
	it("returns a clean env copy without mutating process.env", () => {
		const originalMallocStackLogging = process.env.MallocStackLogging;
		const originalMallocStackLoggingNoCompact = process.env.MallocStackLoggingNoCompact;

		try {
			process.env.MallocStackLogging = "0";
			process.env.MallocStackLoggingNoCompact = "off";

			const result = procmgr.scrubProcessEnv();

			expect(result.MallocStackLogging).toBeUndefined();
			expect(result.MallocStackLoggingNoCompact).toBeUndefined();
			expect(process.env.MallocStackLogging).toBe("0");
			expect(process.env.MallocStackLoggingNoCompact).toBe("off");
		} finally {
			if (originalMallocStackLogging === undefined) delete process.env.MallocStackLogging;
			else process.env.MallocStackLogging = originalMallocStackLogging;

			if (originalMallocStackLoggingNoCompact === undefined) delete process.env.MallocStackLoggingNoCompact;
			else process.env.MallocStackLoggingNoCompact = originalMallocStackLoggingNoCompact;
		}
	});

	it("removes enabled macOS malloc stack logging variables from env copies", () => {
		expect(
			procmgr.scrubProcessEnv({
				MallocStackLogging: "1",
				MallocStackLoggingNoCompact: "yes",
				GOOD: "value",
			}),
		).toEqual({ GOOD: "value" });
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops disabled macOS malloc stack logging variables", () => {
		expect(
			filterProcessEnv({
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "false",
				GOOD: "value",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("drops enabled macOS malloc stack logging variables because Bun warns on any inherited value", () => {
		expect(
			filterProcessEnv({
				MallocStackLogging: "1",
				MallocStackLoggingNoCompact: "YES",
				GOOD: "value",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});
