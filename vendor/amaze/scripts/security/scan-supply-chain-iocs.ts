// Static supply-chain IOC scanner for security:ioc; CLI scans dependency/config manifests and exports pure scanners for tests.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface IOCFinding {
	file: string;
	line?: number;
	rule: string;
	severity: "low" | "medium" | "high" | "critical";
	message: string;
	evidence: string;
}

export interface IOCReport {
	status: "ok" | "fail";
	findings: IOCFinding[];
	summary: { byClass: Record<string, number> };
}

const SECRET_PREFIX_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|token|password|secret)["']?\s*[:=]\s*['"]([^'"]{16,})['"]/gi;
const NON_HTTPS_RE = /^(?:git\+ssh|http):\/\//i;

function truncateEvidence(value: string): string {
	return value.length > 100 ? `${value.slice(0, 97)}...` : value;
}

function lineForIndex(input: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (input[cursor] === "\n") line += 1;
	}
	return line;
}

function isStructuredConfig(fileName: string): boolean {
	return /\.(json|ya?ml|toml)$/i.test(fileName);
}

function isAllowedSecretValue(value: string): boolean {
	return value.startsWith("!") || value.startsWith("${") || /^<[^>]+>$/.test(value);
}

function addSecretFindings(input: string, fileName: string, findings: IOCFinding[]): void {
	for (const match of input.matchAll(SECRET_PREFIX_RE)) {
		findings.push({
			file: fileName,
			line: lineForIndex(input, match.index ?? 0),
			rule: "IOC-SECRET-001",
			severity: "critical",
			message: "Hardcoded API key prefix detected; move this secret to a secure store.",
			evidence: truncateEvidence(match[0]),
		});
	}

	if (!isStructuredConfig(fileName)) return;
	for (const match of input.matchAll(SECRET_ASSIGNMENT_RE)) {
		const value = match[2] ?? "";
		if (isAllowedSecretValue(value)) continue;
		findings.push({
			file: fileName,
			line: lineForIndex(input, match.index ?? 0),
			rule: "IOC-SECRET-002",
			severity: "high",
			message: "Hardcoded credential assignment detected; reference a secret source instead.",
			evidence: truncateEvidence(match[0]),
		});
	}
}

function parseJson(input: string): unknown | undefined {
	try {
		return JSON.parse(input);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function addMcpFindings(input: string, fileName: string, findings: IOCFinding[]): void {
	if (path.basename(fileName) !== ".mcp.json") return;
	const parsed = asRecord(parseJson(input));
	const servers = asRecord(parsed?.mcpServers ?? parsed?.servers);
	if (servers === undefined) return;
	for (const [name, value] of Object.entries(servers)) {
		const server = asRecord(value);
		if (server === undefined) continue;
		const command = typeof server.command === "string" ? server.command : "";
		const commandBase = path.basename(command).toLowerCase();
		const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
		const evidence = `${name}: ${[command, ...args].join(" ")}`.trim();
		if (["sh", "bash", "zsh", "curl", "wget"].includes(commandBase) || args.includes("-c")) {
			findings.push({
				file: fileName,
				rule: "IOC-MCP-001",
				severity: "high",
				message: "MCP server launches a shell or downloader; replace it with a pinned executable.",
				evidence: truncateEvidence(evidence),
			});
		}
		if ((commandBase === "npx" || commandBase === "bunx") && args.includes("-y")) {
			findings.push({
				file: fileName,
				rule: "IOC-MCP-002",
				severity: "medium",
				message: "MCP server auto-installs from a remote registry; pin and vendor the executable.",
				evidence: truncateEvidence(evidence),
			});
		}
	}
}

function addPackageUrlFindings(input: string, fileName: string, findings: IOCFinding[]): void {
	if (path.basename(fileName) !== "package.json") return;
	const parsed = asRecord(parseJson(input));
	if (parsed === undefined) return;
	for (const sectionName of ["dependencies", "devDependencies"] as const) {
		const section = asRecord(parsed[sectionName]);
		if (section === undefined) continue;
		for (const [name, value] of Object.entries(section)) {
			if (typeof value !== "string" || !NON_HTTPS_RE.test(value)) continue;
			findings.push({
				file: fileName,
				rule: "IOC-DEP-002",
				severity: "low",
				message: "Dependency uses a non-HTTPS source URL; switch to HTTPS or a registry-pinned version.",
				evidence: truncateEvidence(`${sectionName}.${name}=${value}`),
			});
		}
	}
}

function addBunLockDuplicateFindings(input: string, fileName: string, findings: IOCFinding[]): void {
	if (path.basename(fileName) !== "bun.lock") return;
	const versionsByName = new Map<string, Set<string>>();
	const patterns = [
		/^[ \t]*["']?(@?[^\s"'@/][^"'@\s]*|@[^\s"']+\/[^\s"']+)@([^\s"']+)["']?\s*:/gm,
		/["'](@?[^@\s"']+)@([^@\s"']+)["']/g,
	];
	for (const pattern of patterns) {
		for (const match of input.matchAll(pattern)) {
			const name = match[1];
			const version = match[2];
			if (!name || !version || version.startsWith("workspace:")) continue;
			const versions = versionsByName.get(name) ?? new Set<string>();
			versions.add(version.replace(/[,;]$/, ""));
			versionsByName.set(name, versions);
		}
	}
	for (const [name, versions] of [...versionsByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (versions.size < 2) continue;
		findings.push({
			file: fileName,
			rule: "IOC-DEP-001",
			severity: "low",
			message:
				"Duplicate dependency versions in bun.lock; common in transitive npm trees, audit when direct deps drift. Demoted to advisory severity.",
			evidence: truncateEvidence(`${name}: ${[...versions].sort().join(", ")}`),
		});
	}
}

export function scanForFindings(input: string, fileName: string): IOCFinding[] {
	const findings: IOCFinding[] = [];
	addSecretFindings(input, fileName, findings);
	addMcpFindings(input, fileName, findings);
	addPackageUrlFindings(input, fileName, findings);
	addBunLockDuplicateFindings(input, fileName, findings);
	return findings;
}

export function buildReport(findings: IOCFinding[]): IOCReport {
	const byClass: Record<string, number> = {};
	for (const finding of findings) {
		byClass[finding.rule] = (byClass[finding.rule] ?? 0) + 1;
	}
	const failing = findings.some(finding => finding.severity !== "low");
	return { status: failing ? "fail" : "ok", findings, summary: { byClass } };
}

function renderHuman(report: IOCReport): string {
	const lines: string[] = [];
	const byFile = new Map<string, IOCFinding[]>();
	for (const finding of report.findings) {
		const entries = byFile.get(finding.file) ?? [];
		entries.push(finding);
		byFile.set(finding.file, entries);
	}
	for (const [file, findings] of byFile) {
		lines.push(file);
		for (const finding of findings) {
			const location = finding.line === undefined ? "" : `${finding.line} `;
			lines.push(`  ${location}${finding.rule} ${finding.severity}: ${finding.message} (${finding.evidence})`);
		}
	}
	lines.push(`Total findings: ${report.findings.length}`);
	const rules = Object.entries(report.summary.byClass).sort(([a], [b]) => a.localeCompare(b));
	lines.push(`Summary by class: ${rules.length === 0 ? "none" : rules.map(([rule, count]) => `${rule}=${count}`).join(", ")}`);
	return `${lines.join("\n")}\n`;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(filePath);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export async function collectTargetFiles(root: string): Promise<string[]> {
	const files = new Set<string>();
	const directTargets = [
		"package.json",
		"bun.lock",
		"Cargo.lock",
		"python/rocky/pyproject.toml",
		".mcp.json",
		".amaze/settings.json",
		"scripts/install.sh",
		"scripts/release.ts",
		"scripts/ci-release-build-binaries.ts",
		"scripts/ci-release-publish.ts",
	];
	for (const target of directTargets) {
		if (await fileExists(path.join(root, target))) files.add(target);
	}

	for (const pattern of ["packages/*/package.json", ".github/workflows/*.yaml", ".github/workflows/*.yml"]) {
		const glob = new Bun.Glob(pattern);
		for await (const match of glob.scan({ cwd: root, onlyFiles: true })) {
			if (await fileExists(path.join(root, match))) files.add(match);
		}
	}
	for (const pattern of ["*.yaml", "*.yml"]) {
		const glob = new Bun.Glob(pattern);
		for await (const match of glob.scan({ cwd: path.join(root, ".github", "workflows"), onlyFiles: true })) {
			const target = path.join(".github", "workflows", match);
			if (await fileExists(path.join(root, target))) files.add(target);
		}
	}
	return [...files].sort();
}

export function parseArgs(args: string[]): { json: boolean; root: string } {
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
	const findings: IOCFinding[] = [];
	for (const file of await collectTargetFiles(root)) {
		const input = await fs.readFile(path.join(root, file), "utf8");
		findings.push(...scanForFindings(input, file));
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
