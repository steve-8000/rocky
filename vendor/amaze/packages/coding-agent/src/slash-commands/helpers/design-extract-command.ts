import * as path from "node:path";

const DEFAULT_DESIGN_ROOT = "/Users/steve/roy/design";
const DEFAULT_STACK = "html_tailwind";
const DEFAULT_MODE = "site";
const DEFAULT_CRAWL_DEPTH = 3;
const DEFAULT_MAX_PAGES = 100;
const LOCAL_MODEL = "unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit";
const LOCAL_OPENAI_BASE_URL = "http://127.0.0.1:8000/v1";
const SCREENSHOT_TO_CODE_WS = "ws://127.0.0.1:7001/generate-code";
const USAGE =
	"Usage: /design-extract <url> [--out <dir>] [--mode site|component] [--stack html_tailwind] [--open] [--depth <positive integer>] [--max-pages <positive integer>] [--pages <comma-separated paths-or-URLs>]";

export type DesignExtractSlashRuntime = {
	cwd: string;
	session: {
		setForcedToolChoice: (toolName: string) => void;
	};
	output: (text: string) => Promise<void> | void;
};

export type DesignExtractSlashResult = undefined | { consumed: true } | { prompt: string };

type DesignExtractOptions = {
	target: string;
	out: string;
	mode: string;
	stack: string;
	open: boolean;
	depth?: number;
	maxPages?: number;
	pages: string[];
};

function safeSlug(value: string): string {
	const withoutProtocol = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const slug = withoutProtocol
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "site";
}

function parsePositiveInteger(value: string | undefined, optionName: string): number | string {
	if (!value) return `Missing value for ${optionName}.`;
	if (!/^[1-9]\d*$/.test(value)) return `${optionName} must be a positive integer.`;
	return Number(value);
}

function parsePages(value: string | undefined): string[] | string {
	if (!value) return "Missing value for --pages.";
	const pages = value
		.split(",")
		.map(page => page.trim())
		.filter(Boolean);
	if (pages.length === 0) return "--pages must include at least one path or URL.";
	return pages;
}

function parseArgs(rawArgs: string, cwd: string): DesignExtractOptions | string {
	const args =
		rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part => {
			if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
				return part.slice(1, -1);
			}
			return part;
		}) ?? [];
	let target = "";
	let out = "";
	let mode = DEFAULT_MODE;
	let stack = DEFAULT_STACK;
	let open = false;
	let depth: number | undefined;
	let maxPages: number | undefined;
	let pages: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--out") {
			const value = args[++i];
			if (!value) return "Missing value for --out.";
			out = value;
			continue;
		}
		if (arg === "--mode") {
			const value = args[++i];
			if (!value) return "Missing value for --mode.";
			mode = value;
			continue;
		}
		if (arg === "--stack") {
			const value = args[++i];
			if (!value) return "Missing value for --stack.";
			stack = value;
			continue;
		}
		if (arg === "--open") {
			open = true;
			continue;
		}
		if (arg === "--crawl") {
			continue;
		}
		if (arg === "--depth") {
			const parsedDepth = parsePositiveInteger(args[++i], "--depth");
			if (typeof parsedDepth === "string") return parsedDepth;
			depth = parsedDepth;
			continue;
		}
		if (arg === "--max-pages") {
			const parsedMaxPages = parsePositiveInteger(args[++i], "--max-pages");
			if (typeof parsedMaxPages === "string") return parsedMaxPages;
			maxPages = parsedMaxPages;
			continue;
		}
		if (arg === "--pages") {
			const parsedPages = parsePages(args[++i]);
			if (typeof parsedPages === "string") return parsedPages;
			pages = parsedPages;
			continue;
		}
		if (arg.startsWith("-")) return `Unknown option: ${arg}`;
		if (target) return `Unexpected extra argument: ${arg}`;
		target = arg;
	}

	if (!target) {
		return USAGE;
	}
	const resolvedOut = path.resolve(
		cwd,
		out || path.join(DEFAULT_DESIGN_ROOT, ".amaze-design-extract", safeSlug(target)),
	);
	return {
		target,
		out: resolvedOut,
		mode,
		stack,
		open,
		depth: depth ?? DEFAULT_CRAWL_DEPTH,
		maxPages: maxPages ?? DEFAULT_MAX_PAGES,
		pages,
	};
}

function buildPageSelectionInstruction(options: DesignExtractOptions): string {
	if (options.pages.length > 0) {
		return `Page selection:
- Explicit page-list mode (--pages).
- Resolve each --pages entry against the target URL origin when it is a relative path.
- Process exactly the resolved --pages entries, plus the target URL only if it is not already included after URL normalization.
- Raw --pages entries: ${options.pages.join(", ")}
- Deduplicate normalized URLs before execution.
- Do not crawl beyond this explicit set.`;
	}

	return `Page selection:
- Whole-site mode (default; --crawl is accepted but not required).
- Crawl same-origin internal links starting from the target URL.
- Respect crawl depth ${options.depth} and max pages ${options.maxPages}.
- Deduplicate normalized URLs before execution.
- Skip external links, fragments, mailto:, tel:, and javascript: URLs.`;
}

function buildExecutionInstructions(
	options: DesignExtractOptions,
	designRoot: string,
	designExtractOut: string,
	screenshotOut: string,
	layoutOut: string,
): string {
	return `Required execution:
- Create the output directories under ${options.out}.
- Select the pages first according to the Page selection contract above.
- For each selected page, create deterministic per-page artifact subdirectories under ${designExtractOut} and ${screenshotOut} using a normalized page slug.
- For each selected page, run design-extract from ${path.join(designRoot, "design-extract")} using: bun run bin/design-extract.js <selected-page-url> -o <per-page-design-extract-output> --screenshots --json-pretty
- If that command is not valid in the checked-out version, inspect package.json/bin/design-extract.js and use the equivalent designlang invocation.
- For each selected page, send screenshot-to-code a create request using codeGenerationModel=${LOCAL_MODEL}, openAiBaseURL=${LOCAL_OPENAI_BASE_URL}, openAiApiKey=EMPTY, generatedCodeConfig=${options.stack}, and a prompt that includes that page's design-extract outputs plus captured screenshots; write results under the matching per-page screenshot-to-code artifact directory.
- Merge common tokens/components into shared layout-app artifacts, create per-page route artifacts, and write manifest JSON entries into ${layoutOut}.`;
}

function buildPrompt(options: DesignExtractOptions): string {
	const designRoot = path.dirname(path.dirname(options.out));
	const designExtractOut = path.join(options.out, "design-extract");
	const screenshotOut = path.join(options.out, "screenshot-to-code");
	const layoutOut = path.join(options.out, "layout-app");
	const openInstruction = options.open
		? "Open the final local preview when the layout app artifact is ready."
		: "Do not open a browser unless verification requires it.";

	return `Run the site design extraction pipeline for ${options.target}.

Architecture contract:
1. Use design-extract first to capture DOM/CSS/design tokens/screenshots.
2. Use screenshot-to-code with the local MLX VLM endpoint for image-to-code generation.
3. Persist the generated implementation and references in a layout-app-ready artifact folder.
4. For multi-page extraction, merge common tokens/components into shared layout-app artifacts and create per-page route artifacts plus manifest entries.

Concrete settings:
- Target URL or path: ${options.target}
- Output root: ${options.out}
- design-extract output: ${designExtractOut}
- screenshot-to-code artifacts: ${screenshotOut}
- layout-app artifact output: ${layoutOut}
- Mode: ${options.mode}
- Stack: ${options.stack}
- Crawl enabled: yes
- Crawl depth: ${options.depth}
- Maximum crawl pages: ${options.maxPages}
- Explicit pages (--pages): ${options.pages.length > 0 ? options.pages.join(", ") : "none"}
- Local model: ${LOCAL_MODEL}
- OpenAI-compatible base URL: ${LOCAL_OPENAI_BASE_URL}
- screenshot-to-code WebSocket: ${SCREENSHOT_TO_CODE_WS}

${buildPageSelectionInstruction(options)}

${buildExecutionInstructions(options, designRoot, designExtractOut, screenshotOut, layoutOut)}
- Verify the MLX VLM server health before generation and verify at least one generated artifact exists afterward.
- ${openInstruction}

Do not use any cloud LLM keys. Keep all artifacts local. Report exact artifact paths and verification results.

Usage reference: /design-extract <url> [--out <dir>] [--mode site|component] [--stack html_tailwind] [--open] [--depth <positive integer>] [--max-pages <positive integer>] [--pages <comma-separated paths-or-URLs>]`;
}

function commandConsumed(): { consumed: true } {
	return { consumed: true };
}

async function usage(text: string, runtime: DesignExtractSlashRuntime): Promise<DesignExtractSlashResult> {
	await runtime.output(text);
	return commandConsumed();
}

export async function handleDesignExtractCommand(
	commandArgs: string,
	runtime: DesignExtractSlashRuntime,
): Promise<DesignExtractSlashResult> {
	const parsed = parseArgs(commandArgs, runtime.cwd);
	if (typeof parsed === "string") return usage(parsed, runtime);
	try {
		runtime.session.setForcedToolChoice("bash");
	} catch {
		// The returned prompt still carries the complete execution contract if bash is unavailable.
	}
	await runtime.output(`Design extraction pipeline queued for ${parsed.target}.`);
	return { prompt: buildPrompt(parsed) };
}
