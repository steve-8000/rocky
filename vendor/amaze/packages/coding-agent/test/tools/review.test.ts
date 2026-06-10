import { describe, expect, it } from "bun:test";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import {
	isBlockingReviewFinding,
	isBlockingSourceReviewFinding,
	isMarkdownPath,
	isSourceReviewFinding,
	parseReportFindingDetails,
} from "../../src/tools/review";

describe("review finding filters", () => {
	it("treats Markdown paths as review-only metadata regardless of extension case", () => {
		expect(isMarkdownPath("README.md")).toBe(true);
		expect(isMarkdownPath("docs/CHANGELOG.MD")).toBe(true);
		expect(isMarkdownPath("notes/review.Md")).toBe(true);
		expect(isMarkdownPath("src/review.ts")).toBe(false);
		expect(isMarkdownPath("docs/README.md.bak")).toBe(false);
	});

	it("counts only non-Markdown file findings as source review findings", () => {
		expect(isSourceReviewFinding({ file_path: "src/tools/review.ts" })).toBe(true);
		expect(isSourceReviewFinding({ file_path: "packages/coding-agent/README.md" })).toBe(false);
		expect(isSourceReviewFinding({ file_path: "docs/REVIEW.MD" })).toBe(false);
	});

	it("blocks only P0 and P1 review findings", () => {
		expect(isBlockingReviewFinding({ priority: "P0" })).toBe(true);
		expect(isBlockingReviewFinding({ priority: "P1" })).toBe(true);
		expect(isBlockingReviewFinding({ priority: "P2" })).toBe(false);
		expect(isBlockingReviewFinding({ priority: "P3" })).toBe(false);
	});

	it("blocks only P0 and P1 findings on non-Markdown files", () => {
		expect(isBlockingSourceReviewFinding({ file_path: "src/tools/review.ts", priority: "P0" })).toBe(true);
		expect(isBlockingSourceReviewFinding({ file_path: "src/tools/review.ts", priority: "P1" })).toBe(true);
		expect(isBlockingSourceReviewFinding({ file_path: "src/tools/review.ts", priority: "P2" })).toBe(false);
		expect(isBlockingSourceReviewFinding({ file_path: "README.md", priority: "P0" })).toBe(false);
		expect(isBlockingSourceReviewFinding({ file_path: "docs/REVIEW.MD", priority: "P1" })).toBe(false);
	});
});

describe("report_finding subprocess extraction", () => {
	it("returns undefined for malformed finding details", () => {
		expect(parseReportFindingDetails({})).toBeUndefined();
		expect(
			parseReportFindingDetails({
				title: "[P1] Missing file path",
				body: "Body",
				priority: "P1",
				confidence: 0.8,
				line_start: 12,
				line_end: 12,
			}),
		).toBeUndefined();
	});

	it("ignores error events and extracts valid details", () => {
		const handler = subprocessToolRegistry.getHandler("report_finding");
		if (!handler?.extractData) {
			throw new Error("report_finding handler is not registered");
		}

		const validDetails = {
			title: "[P1] Example finding",
			body: "Details",
			priority: "P1" as const,
			confidence: 0.95,
			file_path: "/tmp/example.ts",
			line_start: 10,
			line_end: 12,
		};

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-1",
				result: {
					content: [{ type: "text", text: "Finding recorded" }],
					details: validDetails,
				},
				isError: false,
			}),
		).toEqual(validDetails);

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-2",
				result: {
					content: [{ type: "text", text: "Validation failed" }],
					details: {},
				},
				isError: true,
			}),
		).toBeUndefined();
	});
});
