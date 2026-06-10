import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "@amaze/coding-agent/internal-urls/local-protocol";
import type { Mission } from "@amaze/coding-agent/mission/core/mission";
import type { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import type { MissionProposal } from "@amaze/coding-agent/mission/core/mission-proposal";
import { MissionPolicyGate } from "@amaze/coding-agent/tools/gateway/index";
import type { ToolDescriptor } from "@amaze/coding-agent/tools/registry/index";

const tempDirs: string[] = [];

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
	};
}

function mission(): Mission {
	return {
		id: "m1",
		title: "Mission",
		objective: "Objective",
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
		proposalId: "p1",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
	};
}

function proposal(overrides: Partial<MissionProposal> = {}): MissionProposal {
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

function gate(active: Mission, activeProposal?: MissionProposal): MissionPolicyGate {
	return new MissionPolicyGate({
		missionControl: {
			getActiveMission: () => active,
			getActiveProposal: () => activeProposal,
		} as unknown as MissionControlRuntime,
	});
}

function installLocalArtifact(content: string): { uri: string; filePath: string; hash: string } {
	const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "amaze-policy-gate-hash-"));
	tempDirs.push(artifactsDir);
	LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "hash-test" });
	const uri = "local://PLAN.md";
	const filePath = resolveLocalUrlToPath(uri, {
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "hash-test",
	});
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return { uri, filePath, hash: createHash("sha256").update(content).digest("hex") };
}

afterEach(() => {
	LocalProtocolHandler.resetOverrideForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MissionPolicyGate proposal artifact hash verification", () => {
	it("allows mutation when proposal artifact hash matches", () => {
		const artifact = installLocalArtifact("approved proposal");
		const decision = gate(mission(), proposal({ artifactUri: artifact.uri, contentHash: artifact.hash })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);

		expect(decision.allowed).toBe(true);
	});

	it("denies with proposal-artifact-drift when the artifact mutates after attach", () => {
		const artifact = installLocalArtifact("approved proposal");
		fs.writeFileSync(artifact.filePath, "mutated proposal");

		const decision = gate(mission(), proposal({ artifactUri: artifact.uri, contentHash: artifact.hash })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);

		expect(decision).toMatchObject({
			allowed: false,
			reason: "proposal-artifact-drift",
			details: { proposalId: "p1", expected: artifact.hash },
		});
	});

	it("allows mutation when proposal has no artifactUri for legacy approval", () => {
		const decision = gate(mission(), proposal({ artifactUri: "", contentHash: "" })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);

		expect(decision.allowed).toBe(true);
	});
});
