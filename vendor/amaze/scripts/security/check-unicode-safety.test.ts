import { describe, expect, test } from "bun:test";
import { scanForFindings } from "./check-unicode-safety";

describe("check-unicode-safety", () => {
	test("ASCII-only content yields zero findings", () => {
		expect(scanForFindings("plain ascii\nsecond line", "README.md")).toEqual([]);
	});

	test("detects one positive case per configured Unicode class", () => {
		const input = [
			"zero\u200Bwidth",
			"bidi\u202Econtrol",
			"variation\uFE0Fselector",
			"tag\u{E0001}block",
			"hangul\u3164filler",
			"math\u2062operator",
		].join("\n");

		const findings = scanForFindings(input, "AGENTS.md");

		expect(findings.map((finding) => finding.class)).toEqual([
			"zero-width",
			"bidi-control",
			"variation-selector",
			"unicode-tag",
			"hangul-filler",
			"invisible-math-operator",
		]);
		expect(findings.map((finding) => finding.codePoint)).toEqual([
			"U+200B",
			"U+202E",
			"U+FE0F",
			"U+E0001",
			"U+3164",
			"U+2062",
		]);
		expect(findings[0]?.contextSnippet).toBe("zero<<U+200B>>width");
	});

	test("reports per-line 1-based columns using code point iteration", () => {
		const findings = scanForFindings("😀abc\n12345\u200Btail", "README.md");

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ line: 2, column: 6, codePoint: "U+200B" });
	});
});
