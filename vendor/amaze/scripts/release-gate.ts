#!/usr/bin/env bun
/**
 * `bun run release:gate` — local release-readiness orchestrator.
 *
 * Runs the release-delta gates that are NOT already covered by per-PR CI
 * jobs `check`, `check_py`, `test`, `install_methods`. Specifically:
 *   - Unicode smuggling scan
 *   - Supply-chain IOC scan
 *   - Doctor security (bash safety posture, MCP scan, secret file scan)
 *   - Spoofed-version drift (advisory; flaky upstream)
 */
import { spawn } from "bun";

interface Gate {
	name: string;
	cmd: string[];
	/** When true, surface as a warning rather than blocking. Used for gates
	 * that are still being wired up by the staged rollout. */
	advisory?: boolean;
}

export const GATES: Gate[] = [
	{ name: "Unicode smuggling scan", cmd: ["bun", "run", "security:unicode"] },
	{ name: "Supply-chain IOC scan", cmd: ["bun", "run", "security:ioc"] },
	{ name: "Doctor security", cmd: ["bun", "run", "security:doctor"] },
	{ name: "Spoofed-version drift", cmd: ["bun", "run", "check-spoofed-versions"], advisory: true },
];

interface GateResult {
	gate: Gate;
	exitCode: number;
}

async function runGate(gate: Gate): Promise<GateResult> {
	process.stdout.write(`\n→ ${gate.name}\n`);
	const proc = spawn({
		cmd: gate.cmd,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "" },
	});
	const exitCode = await proc.exited;
	return { gate, exitCode };
}

async function main(): Promise<void> {
	const results: GateResult[] = [];
	for (const gate of GATES) {
		results.push(await runGate(gate));
	}

	const failures = results.filter(r => r.exitCode !== 0 && !r.gate.advisory);
	const warnings = results.filter(r => r.exitCode !== 0 && r.gate.advisory);

	process.stdout.write("\n----- release:gate summary -----\n");
	for (const r of results) {
		const status = r.exitCode === 0 ? "PASS" : r.gate.advisory ? "WARN" : "FAIL";
		process.stdout.write(`  [${status}] ${r.gate.name}\n`);
	}

	if (failures.length > 0) {
		process.stdout.write(`\nrelease:gate failed: ${failures.length} blocking gate(s) failed.\n`);
		process.stdout.write("Fix the gates above before tagging a release.\n");
		process.exit(1);
	}

	if (warnings.length > 0) {
		process.stdout.write(`\nrelease:gate passed with ${warnings.length} advisory warning(s).\n`);
		process.stdout.write("note: spoofed-version check unavailable; release proceeds without freshness verification.\n");
	} else {
		process.stdout.write("\nrelease:gate passed.\n");
	}
}

if (import.meta.main) {
	await main();
}
