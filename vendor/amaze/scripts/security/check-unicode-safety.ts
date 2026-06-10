// Static Unicode safety scanner for security:unicode; CLI scans prompt/config/docs surfaces and exports a pure scanner for tests.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface UnicodeFinding {
	file: string;
	line: number;
	column: number;
	codePoint: string;
	class: string;
	contextSnippet: string;
}

export interface UnicodeReport {
	status: "ok" | "fail";
	findings: UnicodeFinding[];
	summary: { byClass: Record<string, number> };
}

const DEFAULT_TARGETS = [
	".amaze/settings.json",
	".amaze/skills/**",
	".amaze/rules/**",
	".amaze/commands/**",
	"docs/**/*.md",
	"README.md",
	"AGENTS.md",
	"python/rocky/AGENTS.md",
] as const;

function unicodeClassFor(codePoint: number): string | undefined {
	switch (true) {
		case codePoint === 0x200b ||
			codePoint === 0x200c ||
			codePoint === 0x200d ||
			codePoint === 0x200e ||
			codePoint === 0x200f ||
			codePoint === 0xfeff:
			return "zero-width";
		case (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069):
			return "bidi-control";
		case (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef):
			return "variation-selector";
		case codePoint >= 0xe0000 && codePoint <= 0xe007f:
			return "unicode-tag";
		case codePoint === 0x3164 || codePoint === 0xffa0:
			return "hangul-filler";
		case codePoint >= 0x2061 && codePoint <= 0x2064:
			return "invisible-math-operator";
		default:
			return undefined;
	}
}

function formatCodePoint(codePoint: number): string {
	return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function makeContextSnippet(line: string, index: number, ch: string, codePoint: string): string {
	const before = Array.from(line.slice(0, index)).slice(-10).join("");
	const after = Array.from(line.slice(index + ch.length)).slice(0, 10).join("");
	return `${before}<<${codePoint}>>${after}`;
}

export function scanForFindings(input: string, fileName: string): UnicodeFinding[] {
	const findings: UnicodeFinding[] = [];
	let line = 1;
	let column = 1;
	let lineStart = 0;

	for (let index = 0; index < input.length;) {
		const ch = input[index] === "\r" && input[index + 1] === "\n" ? "\r\n" : Array.from(input.slice(index))[0] ?? "";
		if (ch === "\n" || ch === "\r\n") {
			line += 1;
			column = 1;
			index += ch.length;
			lineStart = index;
			continue;
		}

		const codePoint = ch.codePointAt(0);
		const className = codePoint === undefined ? undefined : unicodeClassFor(codePoint);
		if (codePoint !== undefined && className !== undefined) {
			let lineEnd = input.indexOf("\n", index);
			if (lineEnd === -1) lineEnd = input.length;
			const rawLine = input.slice(lineStart, lineEnd).replace(/\r$/, "");
			const formatted = formatCodePoint(codePoint);
			findings.push({
				file: fileName,
				line,
				column,
				codePoint: formatted,
				class: className,
				contextSnippet: makeContextSnippet(rawLine, index - lineStart, ch, formatted),
			});
		}

		column += 1;
		index += ch.length;
	}

	return findings;
}

export function buildReport(findings: UnicodeFinding[]): UnicodeReport {
	const byClass: Record<string, number> = {};
	for (const finding of findings) {
		byClass[finding.class] = (byClass[finding.class] ?? 0) + 1;
	}
	return { status: findings.length === 0 ? "ok" : "fail", findings, summary: { byClass } };
}

function renderHuman(report: UnicodeReport): string {
	const lines: string[] = [];
	const byFile = new Map<string, UnicodeFinding[]>();
	for (const finding of report.findings) {
		const entries = byFile.get(finding.file) ?? [];
		entries.push(finding);
		byFile.set(finding.file, entries);
	}
	for (const [file, findings] of byFile) {
		lines.push(file);
		for (const finding of findings) {
			lines.push(
				`  ${finding.line}:${finding.column} ${finding.codePoint} ${finding.class} ${finding.contextSnippet}`,
			);
		}
	}
	lines.push(`Total findings: ${report.findings.length}`);
	const classes = Object.entries(report.summary.byClass).sort(([a], [b]) => a.localeCompare(b));
	lines.push(
		`Summary by class: ${classes.length === 0 ? "none" : classes.map(([name, count]) => `${name}=${count}`).join(", ")}`,
	);
	return `${lines.join("\n")}\n`;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isRegularNonSymlink(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(filePath);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

async function collectTargetFiles(root: string): Promise<string[]> {
	const files = new Set<string>();
	for (const target of DEFAULT_TARGETS) {
		if (target.includes("*")) {
			const glob = new Bun.Glob(target);
			for await (const match of glob.scan({ cwd: root, onlyFiles: true })) {
				const absolute = path.join(root, match);
				if (await isRegularNonSymlink(absolute)) files.add(match);
			}
		} else if (await pathExists(path.join(root, target)) && (await isRegularNonSymlink(path.join(root, target)))) {
			files.add(target);
		}
	}
	return [...files].sort();
}

async function readScannableText(filePath: string): Promise<string | undefined> {
	const buffer = await fs.readFile(filePath);
	if (Buffer.byteLength(buffer) > 1024 * 1024) return undefined;
	if (buffer.subarray(0, 1024).includes(0)) return undefined;
	return buffer.toString("utf8");
}

function parseArgs(args: string[]): { json: boolean; root: string } {
	let json = false;
	let root = ".";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--json") {
			json = true;
		} else if (arg === "--root") {
			root = args[index + 1] ?? ".";
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { json, root: path.resolve(root) };
}

async function main(): Promise<void> {
	const { json, root } = parseArgs(Bun.argv.slice(2));
	const findings: UnicodeFinding[] = [];
	for (const file of await collectTargetFiles(root)) {
		const text = await readScannableText(path.join(root, file));
		if (text !== undefined) findings.push(...scanForFindings(text, file));
	}
	const report = buildReport(findings);
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(renderHuman(report));
	}
	process.exitCode = report.status === "ok" ? 0 : 1;
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
