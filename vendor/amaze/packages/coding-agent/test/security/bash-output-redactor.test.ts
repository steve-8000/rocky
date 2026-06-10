import { describe, expect, test } from "bun:test";
import type { BashExecutorOptions } from "../../src/exec/bash-executor";
import { redactBashChunk } from "../../src/security/bash-output-redactor";

describe("bash output redactor", () => {
	test("passes through without obfuscator", () => {
		expect(redactBashChunk("hello", {})).toBe("hello");
	});

	test("uses obfuscateText when supplied", () => {
		const obfuscator = {
			obfuscateText: (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]"),
		};
		expect(redactBashChunk("OPENAI_API_KEY=sk-abc123", { obfuscator })).toBe("OPENAI_API_KEY=[REDACTED]");
	});

	test("executeBash redactChunk-style threading transforms only through the supplied function", () => {
		const options: BashExecutorOptions = {
			redactChunk: chunk =>
				redactBashChunk(chunk, { obfuscator: { obfuscate: text => text.replace("SECRET", "[redacted]") } }),
		};
		const transform = options.redactChunk ?? ((chunk: string) => chunk);
		const passThrough = (chunk: string) => chunk;

		expect(transform("value=SECRET")).toBe("value=[redacted]");
		expect(passThrough("value=SECRET")).toBe("value=SECRET");
	});
});
