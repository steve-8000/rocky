import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bumpSkillUse, getSkillUsagePath, readSkillUsageSnapshot } from "../src/extensibility/skill-usage";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-usage-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("skill usage telemetry", () => {
	it("creates the sidecar on first bump", async () => {
		await withDir(async dir => {
			await bumpSkillUse(dir, "debug");
			const snap = await readSkillUsageSnapshot(dir);
			expect(snap.debug?.use_count).toBe(1);
			expect(snap.debug?.last_used_at).not.toBeNull();
			const filePath = getSkillUsagePath(dir);
			const exists = await fs.stat(filePath).then(
				() => true,
				() => false,
			);
			expect(exists).toBe(true);
		});
	});

	it("accumulates counts across multiple bumps to the same skill", async () => {
		await withDir(async dir => {
			await bumpSkillUse(dir, "review");
			await bumpSkillUse(dir, "review");
			await bumpSkillUse(dir, "review");
			const snap = await readSkillUsageSnapshot(dir);
			expect(snap.review.use_count).toBe(3);
		});
	});

	it("tracks separate skills independently", async () => {
		await withDir(async dir => {
			await bumpSkillUse(dir, "debug");
			await bumpSkillUse(dir, "review");
			await bumpSkillUse(dir, "review");
			const snap = await readSkillUsageSnapshot(dir);
			expect(snap.debug.use_count).toBe(1);
			expect(snap.review.use_count).toBe(2);
		});
	});

	it("survives 20 concurrent bumps without losing updates", async () => {
		await withDir(async dir => {
			await Promise.all(Array.from({ length: 20 }, () => bumpSkillUse(dir, "perf")));
			const snap = await readSkillUsageSnapshot(dir);
			expect(snap.perf.use_count).toBe(20);
		});
	});
});
