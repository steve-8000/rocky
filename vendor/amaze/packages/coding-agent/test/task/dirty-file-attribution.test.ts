import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { diffDirtySnapshots, snapshotDirtyFilesWithHash } from "../../src/subagent/task-revision-loop";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "amaze-dirty-attribution-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "a.txt"), "clean\n");
	await runGit(repo, ["add", "a.txt"]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("dirty file attribution snapshots", () => {
	it("attributes a pre-existing dirty file when its content changes again", async () => {
		const repo = await createRepo();
		await fs.writeFile(path.join(repo, "a.txt"), "dirty once\n");

		const before = await snapshotDirtyFilesWithHash(repo);
		await fs.writeFile(path.join(repo, "a.txt"), "dirty twice\n");
		const after = await snapshotDirtyFilesWithHash(repo);

		expect(diffDirtySnapshots(before, after)).toEqual(["a.txt"]);
	});

	it("does not attribute dirty files whose content hash is unchanged", async () => {
		const repo = await createRepo();
		await fs.writeFile(path.join(repo, "a.txt"), "dirty once\n");

		const before = await snapshotDirtyFilesWithHash(repo);
		const after = await snapshotDirtyFilesWithHash(repo);

		expect(diffDirtySnapshots(before, after)).toEqual([]);
	});
});
