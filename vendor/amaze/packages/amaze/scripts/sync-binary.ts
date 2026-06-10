#!/usr/bin/env bun
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
const sourceBinary = path.join(repoRoot, "packages", "coding-agent", "dist", "amaze");
const outputBinary = path.join(packageDir, "bin", "amaze");

if (!(await Bun.file(sourceBinary).exists())) {
	throw new Error(
		`Missing compiled Amaze binary: ${sourceBinary}. Run bun --cwd=packages/coding-agent run build first.`,
	);
}

await Bun.write(outputBinary, Bun.file(sourceBinary));
await Bun.spawn(["chmod", "+x", outputBinary]).exited;
console.log(`Copied ${sourceBinary} -> ${outputBinary}`);
