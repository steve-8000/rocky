import { describe, expect, it } from "bun:test";
import { getExclusionReason, parseDiff } from "../src/extensibility/custom-commands/bundled/review";

describe("/review command diff filtering", () => {
	it("excludes Markdown files with an explicit reason", () => {
		expect(getExclusionReason("README.md")).toBe("Markdown documentation");
		expect(getExclusionReason("docs/CHANGELOG.MD")).toBe("Markdown documentation");
	});

	it("treats Markdown-only diffs as having no reviewable files", () => {
		const stats = parseDiff(`diff --git a/README.md b/README.md
index 0000000..1111111 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Title
+Documentation update
`);

		expect(stats.files).toEqual([]);
		expect(stats.excluded).toEqual([
			{ path: "README.md", reason: "Markdown documentation", linesAdded: 1, linesRemoved: 0 },
		]);
	});
});
