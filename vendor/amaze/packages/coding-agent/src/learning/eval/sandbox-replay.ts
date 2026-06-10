import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { procmgr } from "@amaze/utils";
import { restoreSnapshot, snapshotFile, writeFileAtomically } from "../apply/snapshots";
import type { LearningProposal, SandboxReplayReport } from "../types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export async function runSandboxReplay(
	proposal: LearningProposal,
	opts: { workspaceRoot: string; tmpRoot?: string },
): Promise<SandboxReplayReport> {
	const commands = proposal.regressionCommands ?? [];
	const sourceRoot = path.resolve(opts.workspaceRoot);
	const sandboxRoot = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), `${proposal.id}-sandbox-`));
	const workspaceRoot = path.join(sandboxRoot, "workspace");
	await copyWorkspace(sourceRoot, workspaceRoot);
	const snapshotPath = path.join(workspaceRoot, ".amaze", "settings.json");
	const snapshot = await snapshotFile("settings", snapshotPath);
	let revertedCleanly = false;

	const perCommand: SandboxReplayReport["perCommand"] = [];
	try {
		await applyProposalPatch(proposal, snapshotPath);

		for (const command of commands) {
			perCommand.push(await runCommand(command, workspaceRoot));
		}
	} finally {
		try {
			await restoreSnapshot(snapshot);
			await fs.rm(sandboxRoot, { recursive: true, force: true });
			revertedCleanly = true;
		} catch {
			revertedCleanly = false;
		}
	}

	return {
		ok: perCommand.every((result, index) => result.exit === (commands[index]?.expected ?? 0) && !result.timedOut),
		perCommand,
		revertedCleanly,
	};
}

async function copyWorkspace(sourceRoot: string, workspaceRoot: string): Promise<void> {
	await fs.cp(sourceRoot, workspaceRoot, {
		recursive: true,
		filter: source => {
			const relative = path.relative(sourceRoot, source);
			const parts = relative.split(path.sep);
			return !parts.includes(".git") && !parts.includes("node_modules");
		},
	});
}

async function applyProposalPatch(proposal: LearningProposal, settingsPath: string): Promise<void> {
	if (proposal.type !== "settings") return;
	await writeFileAtomically(settingsPath, `${JSON.stringify(proposal.patch, null, "\t")}\n`);
}

async function runCommand(
	command: NonNullable<LearningProposal["regressionCommands"]>[number],
	workspaceRoot: string,
): Promise<SandboxReplayReport["perCommand"][number]> {
	const startedAt = performance.now();
	const timeoutMs = Math.min(Math.max(0, command.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
	let timedOut = false;
	const signal = AbortSignal.timeout(timeoutMs);
	signal.addEventListener("abort", () => {
		timedOut = true;
	});

	const proc = Bun.spawn(command.argv, {
		cwd: command.cwd ? path.resolve(workspaceRoot, command.cwd) : workspaceRoot,
		env: procmgr.scrubProcessEnv(Bun.env),
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [stdout, stderr, exit] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited.catch(() => null),
	]);

	return {
		argv: command.argv,
		exit: timedOut ? null : exit,
		stdout,
		stderr,
		durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
		timedOut,
	};
}
