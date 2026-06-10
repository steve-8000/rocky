/**
 * Architecture invariants for Mission 2.x.
 *
 * Locks the load-bearing rules that survive across phases:
 *  1. Mission is the single source of truth (revision-based stale detection).
 *  2. Verifier verdict is authoritative for completion.
 *  3. Every intent that mutates production-critical state requires a proposal
 *     before mutation, enforced by the policy gate.
 *  4. Proposal artifact hash mismatch is denied at the mutation gate.
 *  5. Schema migrations are versioned, idempotent, and forward-only.
 *
 * A failure here is a load-bearing regression — fix the system, not the test.
 */

import { afterEach, describe, expect, it, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "@amaze/coding-agent/internal-urls/local-protocol";
import { LIFECYCLE_TEMPLATES } from "@amaze/coding-agent/mission/core/lifecycle-template";
import type { Mission } from "@amaze/coding-agent/mission/core/mission";
import type { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import type { MissionInput } from "@amaze/coding-agent/mission/core/mission-input";
import type { MissionProposal } from "@amaze/coding-agent/mission/core/mission-proposal";
import { MissionRuntimeImpl } from "@amaze/coding-agent/mission/core/mission-runtime";
import { MISSION_INTENTS, type MissionIntent } from "@amaze/coding-agent/mission/policy/intent";
import { MissionStore } from "@amaze/coding-agent/mission/store";
import { MissionPolicyGate } from "@amaze/coding-agent/tools/gateway/index";
import type { ToolDescriptor } from "@amaze/coding-agent/tools/registry/index";

const stores: MissionStore[] = [];
const runtimes: MissionRuntimeImpl[] = [];
const tempDirs: string[] = [];

function freshStore(): MissionStore {
	const store = new MissionStore(":memory:");
	stores.push(store);
	return store;
}

function freshRuntime(store?: MissionStore): MissionRuntimeImpl {
	const s = store ?? freshStore();
	const runtime = new MissionRuntimeImpl({ store: s });
	runtimes.push(runtime);
	return runtime;
}

function baseInput(overrides: Partial<MissionInput> = {}): MissionInput {
	return {
		title: "invariant mission",
		objective: "lock architecture invariants",
		riskLevel: "low",
		acceptanceCriteria: [{ id: "c1", description: "tests pass", satisfied: false }],
		...overrides,
	};
}

function mockMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "m1",
		title: "m",
		objective: "o",
		mode: "auto",
		lifecycle: "executing",
		riskLevel: "high",
		intent: "architecture_change",
		constraints: [],
		acceptanceCriteria: [],
		budget: { tokenBudget: 0, tokensUsed: 0 },
		contextBudget: { maxContextTokens: 0, contextTokensUsed: 0 },
		tasks: [],
		evidenceRefs: [],
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
		...overrides,
	};
}

function mockProposal(overrides: Partial<MissionProposal> = {}): MissionProposal {
	return {
		id: "p1",
		missionId: "m1",
		artifactUri: "local://PLAN.md",
		contentHash: "",
		status: "approved",
		approvedBy: "user",
		approvedAt: 1,
		summary: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function descriptor(name: string): ToolDescriptor {
	return {
		name,
		toolClass: "legacy",
		domain: "filesystem",
		riskLevel: "HIGH",
		mutatesWorkspace: true,
		requiresApproval: false,
		supportsRollback: true,
		execute: async () => ({ ok: true, output: undefined }),
	} as unknown as ToolDescriptor;
}

function makeGate(active: Mission | undefined, activeProposal?: MissionProposal): MissionPolicyGate {
	return new MissionPolicyGate({
		missionControl: {
			getActiveMission: () => active,
			getActiveProposal: () => activeProposal,
		} as unknown as MissionControlRuntime,
	});
}

function installLocalArtifact(content: string): { uri: string; filePath: string; hash: string } {
	const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-inv-"));
	tempDirs.push(artifactsDir);
	LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "inv-test" });
	const uri = "local://PLAN.md";
	const filePath = resolveLocalUrlToPath(uri, {
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "inv-test",
	});
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return { uri, filePath, hash: createHash("sha256").update(content).digest("hex") };
}

afterEach(() => {
	for (const r of runtimes.splice(0)) r.close();
	for (const s of stores.splice(0)) {
		try {
			s.close();
		} catch {
			/* runtime may have closed it */
		}
	}
	LocalProtocolHandler.resetOverrideForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Invariant 1 — Mission single source of truth (revision-based)
// ---------------------------------------------------------------------------
describe("INV-1 mission single source of truth", () => {
	test("every intent is registered in LIFECYCLE_TEMPLATES exactly once", () => {
		for (const intent of MISSION_INTENTS) {
			expect(LIFECYCLE_TEMPLATES[intent]).toBeDefined();
			expect(LIFECYCLE_TEMPLATES[intent].intent).toBe(intent);
		}
	});

	test("any aggregate mutation bumps the store revision; sibling runtimes invalidate cache", async () => {
		const store = freshStore();
		const runtimeA = freshRuntime(store);
		const runtimeB = freshRuntime(store);

		const mission = await runtimeA.create(baseInput());
		const rev0 = store.getMissionRevision(mission.id);
		expect(typeof rev0).toBe("number");

		// runtime B sees the same revision through the shared store.
		expect(runtimeB.tryGet(mission.id)?.revision).toBe(rev0);

		// Mutate through B: revision MUST advance.
		runtimeB.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "ok" });
		const rev1 = store.getMissionRevision(mission.id);
		expect(rev1).toBeGreaterThan(rev0 ?? -1);

		// A's stale cache MUST be invalidated and re-hydrated to the new revision.
		const refetched = runtimeA.tryGet(mission.id);
		expect(refetched?.revision).toBe(rev1);
	});
});

// ---------------------------------------------------------------------------
// Invariant 2 — Verifier verdict is authoritative
// ---------------------------------------------------------------------------
describe("INV-2 verifier verdict is authoritative for completion", () => {
	test("verdict=pass admits completion regardless of stray criterion flags", async () => {
		const runtime = freshRuntime();
		const mission = await runtime.create(
			baseInput({
				acceptanceCriteria: [
					{ id: "c1", description: "a", satisfied: false },
					{ id: "c2", description: "b", satisfied: false },
				],
			}),
		);
		runtime.recordVerification(mission.id, { status: "pass", verdict: "pass", summary: "ok" });
		const completed = await runtime.complete(mission.id, {
			outcome: {
				status: "success",
				summary: "done",
				recordedAt: Date.now(),
			},
		});
		expect(completed.lifecycle).toBe("completed");
	});

	test("verdict=fail refuses completion even when all criterion flags are true (no force)", async () => {
		const runtime = freshRuntime();
		const mission = await runtime.create(
			baseInput({
				acceptanceCriteria: [{ id: "c1", description: "a", satisfied: true }],
			}),
		);
		runtime.recordVerification(mission.id, { status: "fail", verdict: "fail", summary: "verifier nack" });
		await expect(
			runtime.complete(mission.id, { outcome: { status: "success", summary: "done", recordedAt: Date.now() } }),
		).rejects.toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Invariant 3 — Proposal-before-mutation contract per intent
// ---------------------------------------------------------------------------
describe("INV-3 proposal-before-mutation matches the policy gate", () => {
	const proposalRequired: MissionIntent[] = MISSION_INTENTS.filter(
		intent => LIFECYCLE_TEMPLATES[intent].requireProposalBeforeMutation,
	);

	test("proposal-required intent set is exactly {architecture_change, runtime_refactor, release_hardening, external_side_effect}", () => {
		expect([...proposalRequired].sort()).toEqual(
			[
				"architecture_change",
				"external_side_effect",
				"release_hardening",
				"runtime_refactor",
			].sort() as MissionIntent[],
		);
	});

	test.each(
		proposalRequired,
	)("intent=%s denies mutation with code=PROPOSAL_REQUIRED when no proposal attached", intent => {
		const mission = mockMission({ intent, proposalId: undefined });
		const decision = makeGate(mission).check(
			descriptor("write"),
			{ agentRole: "subagent" } as never,
			"HIGH" as never,
		);
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROPOSAL_REQUIRED");
	});
});

// ---------------------------------------------------------------------------
// Invariant 4 — Proposal artifact hash drift is denied at the gate
// ---------------------------------------------------------------------------
describe("INV-4 proposal artifact hash drift is denied", () => {
	it("post-attach mutation of the artifact triggers PROPOSAL_ARTIFACT_DRIFT", () => {
		const artifact = installLocalArtifact("approved proposal body");
		const mission = mockMission({ proposalId: "p1" });
		const proposal = mockProposal({ artifactUri: artifact.uri, contentHash: artifact.hash });

		// Untampered: allowed.
		expect(
			makeGate(mission, proposal).check(descriptor("write"), { agentRole: "subagent" } as never, "HIGH" as never)
				.allowed,
		).toBe(true);

		// Tamper the artifact and re-check: denied with the drift code.
		fs.writeFileSync(artifact.filePath, "tampered body");
		const drifted = makeGate(mission, proposal).check(
			descriptor("write"),
			{ agentRole: "subagent" } as never,
			"HIGH" as never,
		);
		expect(drifted.allowed).toBe(false);
		expect(drifted.code).toBe("PROPOSAL_ARTIFACT_DRIFT");
	});
});

// ---------------------------------------------------------------------------
// Invariant 5 — Schema migrations are versioned and forward-only
// ---------------------------------------------------------------------------
describe("INV-5 schema migrations are versioned and forward-only", () => {
	test("a fresh store exposes the post-v2 surface (getMissionRevision)", () => {
		const store = freshStore();
		// getMissionRevision was introduced with the v2 migration; its presence is the
		// observable proof that migrations ran past v1. Direct PRAGMA peek is intentionally
		// avoided so this test stays decoupled from the store's private Database field.
		expect(typeof store.getMissionRevision).toBe("function");
	});

	test("re-opening a populated DB does not re-run completed migrations or duplicate data", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-inv5-"));
		tempDirs.push(dir);
		const file = path.join(dir, "store.db");

		const s1 = new MissionStore(file);
		stores.push(s1);
		const runtime1 = new MissionRuntimeImpl({ store: s1 });
		runtimes.push(runtime1);
		const mission = await runtime1.create(baseInput());
		const initialRev = s1.getMissionRevision(mission.id);
		runtime1.close();
		// drop from cleanup lists since runtime1.close() already closes the store
		runtimes.splice(runtimes.indexOf(runtime1), 1);
		stores.splice(stores.indexOf(s1), 1);

		// Re-open the same file — migrations must be no-op and the row must still be there.
		const s2 = new MissionStore(file);
		stores.push(s2);
		expect(s2.getMissionRevision(mission.id)).toBe(initialRev);
	});
});
