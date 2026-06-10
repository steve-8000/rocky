#!/usr/bin/env bun
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const amazePackageDir = path.join(repoRoot, "packages", "amaze");

interface PackEntry {
	filename: string;
}

async function run(command: string[], cwd: string, options: { capture?: boolean } = {}): Promise<string> {
	console.log(`$ ${command.join(" ")}`);
	const proc = Bun.spawn(command, {
		cwd,
		stdout: options.capture ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		options.capture ? new Response(proc.stdout).text() : Promise.resolve(""),
	]);
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
	return stdout;
}

async function npmPackJson(packageDir: string): Promise<string> {
	const output = await run(["npm", "pack", "--json", "--ignore-scripts"], packageDir, { capture: true });
	const jsonStart = output.indexOf("[");
	if (jsonStart === -1) throw new Error(`npm pack did not return JSON: ${output}`);
	const entries = JSON.parse(output.slice(jsonStart)) as PackEntry[];
	const filename = entries[0]?.filename;
	if (!filename) throw new Error(`npm pack did not return a tarball filename: ${output}`);
	return path.join(packageDir, filename);
}

await run(["bun", "run", "build"], codingAgentDir);
await run(["bun", "run", "build"], amazePackageDir);
const tarballPath = await npmPackJson(amazePackageDir);
await run(["npm", "install", "-g", tarballPath], repoRoot);
await run(["amaze", "--version"], repoRoot);
console.log(`Installed local Amaze package from ${tarballPath}`);
