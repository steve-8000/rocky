import { describe, expect, it, vi } from "bun:test";
import { handleDesignExtractCommand } from "../../src/slash-commands/helpers/design-extract-command";

function createRuntimeHarness() {
	const setForcedToolChoice = vi.fn((_toolName: string) => {});
	const output = vi.fn(async (_text: string) => {});

	return {
		runtime: {
			cwd: "/Users/steve/roy/design",
			session: { setForcedToolChoice },
			output,
		},
		setForcedToolChoice,
		output,
	};
}

describe("/design-extract slash command", () => {
	it("returns an orchestration prompt and forces bash", async () => {
		const harness = createRuntimeHarness();

		const result = await handleDesignExtractCommand("https://example.com --out ./out --open", harness.runtime);

		expect(result).toEqual({ prompt: expect.any(String) });
		const prompt = result && "prompt" in result ? result.prompt : "";
		expect(prompt).toContain("Run the site design extraction pipeline for https://example.com.");
		expect(prompt).toContain("Output root: /Users/steve/roy/design/out");
		expect(prompt).toContain("Local model: unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit");
		expect(prompt).toContain("Open the final local preview");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("bash");
		expect(prompt).toContain("Crawl enabled: yes");
		expect(prompt).toContain("Crawl depth: 3");
		expect(prompt).toContain("Maximum crawl pages: 100");
		expect(prompt).toContain("Whole-site mode (default; --crawl is accepted but not required).");
		expect(harness.output).toHaveBeenCalledWith("Design extraction pipeline queued for https://example.com.");
	});

	it("shows usage when target is missing", async () => {
		const harness = createRuntimeHarness();

		const result = await handleDesignExtractCommand("", harness.runtime);

		expect(result).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith(
			"Usage: /design-extract <url> [--out <dir>] [--mode site|component] [--stack html_tailwind] [--open] [--depth <positive integer>] [--max-pages <positive integer>] [--pages <comma-separated paths-or-URLs>]",
		);
		expect(harness.setForcedToolChoice).not.toHaveBeenCalled();
	});

	it("includes crawl depth and max-pages instructions", async () => {
		const harness = createRuntimeHarness();

		const result = await handleDesignExtractCommand("https://example.com --depth 4 --max-pages 7", harness.runtime);

		expect(result).toEqual({ prompt: expect.any(String) });
		const prompt = result && "prompt" in result ? result.prompt : "";
		expect(prompt).toContain("Crawl enabled: yes");
		expect(prompt).toContain("Crawl depth: 4");
		expect(prompt).toContain("Maximum crawl pages: 7");
		expect(prompt).toContain("Crawl same-origin internal links starting from the target URL.");
		expect(prompt).toContain("Deduplicate normalized URLs before execution.");
		expect(prompt).toContain("Skip external links, fragments, mailto:, tel:, and javascript: URLs.");
		expect(prompt).toContain("For each selected page, run design-extract");
		expect(prompt).toContain("For each selected page, send screenshot-to-code");
	});

	it("uses whole-site crawl defaults without requiring --crawl", async () => {
		const harness = createRuntimeHarness();

		const result = await handleDesignExtractCommand("https://example.com", harness.runtime);

		expect(result).toEqual({ prompt: expect.any(String) });
		const prompt = result && "prompt" in result ? result.prompt : "";
		expect(prompt).toContain("Crawl enabled: yes");
		expect(prompt).toContain("Crawl depth: 3");
		expect(prompt).toContain("Maximum crawl pages: 100");
		expect(prompt).toContain("Whole-site mode (default; --crawl is accepted but not required).");
		expect(prompt).toContain("For each selected page, run design-extract");
	});
	it("includes exact page-list instructions for --pages", async () => {
		const harness = createRuntimeHarness();

		const result = await handleDesignExtractCommand(
			"https://example.com --pages /pricing,https://example.com/docs",
			harness.runtime,
		);

		expect(result).toEqual({ prompt: expect.any(String) });
		const prompt = result && "prompt" in result ? result.prompt : "";
		expect(prompt).toContain("Explicit page-list mode (--pages).");
		expect(prompt).toContain(
			"Process exactly the resolved --pages entries, plus the target URL only if it is not already included after URL normalization.",
		);
		expect(prompt).toContain("Resolve each --pages entry against the target URL origin when it is a relative path.");
		expect(prompt).toContain("Do not crawl beyond this explicit set.");
		expect(prompt).toContain("Merge common tokens/components into shared layout-app artifacts");
		expect(prompt).toContain("create per-page route artifacts");
		expect(prompt).toContain("manifest JSON entries");
	});
});
