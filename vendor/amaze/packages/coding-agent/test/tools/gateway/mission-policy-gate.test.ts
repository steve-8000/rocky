import { describe, expect, it } from "bun:test";
import type { Mission } from "@amaze/coding-agent/mission/core/mission";
import type { MissionControlRuntime } from "@amaze/coding-agent/mission/core/mission-control-runtime";
import { MissionPolicyGate } from "@amaze/coding-agent/tools/gateway/index";
import type { ToolDescriptor } from "@amaze/coding-agent/tools/registry/index";

function descriptor(name: string): ToolDescriptor {
	return {
		name,
		toolClass: "legacy",
		domain: name === "read" ? "search" : "filesystem",
		riskLevel: name === "read" ? "LOW" : "HIGH",
		mutatesWorkspace: name !== "read",
		requiresApproval: false,
		supportsRollback: name !== "read",
		execute: async () => ({ ok: true, output: undefined }),
	};
}

function mission(overrides: Partial<Mission>): Mission {
	return {
		id: "m1",
		title: "Mission",
		objective: "Objective",
		mode: "auto",
		lifecycle: "executing",
		riskLevel: "medium",
		intent: "code_change",
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

function gate(
	active: Mission | undefined,
	proposal?: ReturnType<MissionControlRuntime["getActiveProposal"]>,
): MissionPolicyGate {
	return new MissionPolicyGate({
		missionControl: {
			getActiveMission: () => active,
			getActiveProposal: () => proposal,
		} as unknown as MissionControlRuntime,
	});
}

describe("MissionPolicyGate", () => {
	it("allows non-mutation tools without an active mission", () => {
		const decision = gate(undefined).check(descriptor("read"), {}, "LOW");
		expect(decision.allowed).toBe(true);
	});

	it("denies subagent mutation tools without an active mission", () => {
		const decision = gate(undefined).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision).toMatchObject({ allowed: false, code: "PROMOTE_REQUIRED" });
		expect(decision.reason).toContain("mission-required");
	});

	it("allows code_change mutations in executing lifecycle", () => {
		const decision = gate(mission({ intent: "code_change", lifecycle: "executing" })).check(
			descriptor("write"),
			{},
			"HIGH",
		);
		expect(decision.allowed).toBe(true);
	});

	it("denies subagent architecture_change mutations before execution without a proposal", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "classified" })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);
		expect(decision).toMatchObject({ allowed: false, code: "PROPOSAL_REQUIRED" });
		expect(decision.reason).toContain("proposal-required");
	});

	it("allows architecture_change mutations before execution with a proposal", () => {
		const decision = gate(
			mission({ intent: "architecture_change", lifecycle: "classified", proposalId: "proposal-1" }),
		).check(descriptor("write"), {}, "HIGH");
		expect(decision.allowed).toBe(true);
	});

	it("denies subagent architecture_change mutations in executing lifecycle without a proposal", () => {
		// The proposal requirement is a lifecycle-independent invariant: advancing a mission to
		// `executing` must not let mutations slip through without an approved proposal.
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "executing" })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);
		expect(decision).toMatchObject({ allowed: false, code: "PROPOSAL_REQUIRED" });
		expect(decision.reason).toContain("proposal-required");
	});

	it("allows architecture_change mutations in executing lifecycle once a proposal is attached", () => {
		const decision = gate(
			mission({ intent: "architecture_change", lifecycle: "executing", proposalId: "proposal-1" }),
		).check(descriptor("write"), {}, "HIGH");
		expect(decision.allowed).toBe(true);
	});
});

describe("MissionPolicyGate role + bash classifier", () => {
	function bashDescriptor(): ToolDescriptor {
		return {
			name: "bash",
			toolClass: "legacy",
			domain: "shell",
			riskLevel: "HIGH",
			mutatesWorkspace: true,
			requiresApproval: false,
			supportsRollback: false,
			execute: async () => ({ ok: true, output: undefined }),
		};
	}

	it("bypasses the gate entirely for orchestrator role even without a mission", () => {
		const decision = gate(undefined).check(descriptor("write"), { agentRole: "orchestrator" }, "HIGH");
		expect(decision.allowed).toBe(true);
	});

	it("bypasses the gate for orchestrator even when mission requires a proposal", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "planning" })).check(
			descriptor("write"),
			{ agentRole: "orchestrator" },
			"HIGH",
		);
		expect(decision.allowed).toBe(true);
	});

	it("denies subagent mutations with an IRC-routed proposal hint", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "planning" })).check(
			descriptor("write"),
			{ agentRole: "subagent" },
			"HIGH",
		);
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROPOSAL_REQUIRED");
		expect(decision.reason).toContain("irc");
		expect(decision.reason).toContain("0-Main");
	});

	it("denies subagent mutations without a mission with an IRC-routed promote hint", () => {
		const decision = gate(undefined).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROMOTE_REQUIRED");
		expect(decision.reason).toContain("irc");
	});

	it("lets a subagent run a read-only bash command (kubectl get) without a proposal", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "planning" })).check(
			bashDescriptor(),
			{ agentRole: "subagent", input: { command: "kubectl get pods -A" } },
			"HIGH",
		);
		expect(decision.allowed).toBe(true);
	});

	it("gates a subagent's mutating bash command (kubectl apply) until a proposal lands", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "planning" })).check(
			bashDescriptor(),
			{ agentRole: "subagent", input: { command: "kubectl apply -f deploy.yaml" } },
			"HIGH",
		);
		expect(decision.allowed).toBe(false);
		expect(decision.code).toBe("PROPOSAL_REQUIRED");
	});

	it("treats missing agentRole as orchestrator for backward compat", () => {
		const decision = gate(mission({ intent: "architecture_change", lifecycle: "planning" })).check(
			descriptor("write"),
			{},
			"HIGH",
		);
		expect(decision.allowed).toBe(true);
	});
});

describe("MissionPolicyGate proposal-artifact verification (P4)", () => {
	const m = mission({ intent: "architecture_change", lifecycle: "executing", proposalId: "p1" });

	it("allows mutation when the proposal record is approved", () => {
		const decision = gate(m, {
			id: "p1",
			missionId: m.id,
			artifactUri: "",
			contentHash: "",
			status: "approved",
			approvedBy: "user",
			approvedAt: 1,
			summary: null,
			createdAt: 1,
			updatedAt: 1,
		}).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision.allowed).toBe(true);
	});

	it("denies mutation when the proposal record is in draft", () => {
		const decision = gate(m, {
			id: "p1",
			missionId: m.id,
			artifactUri: "local://PLAN.md",
			contentHash: "h",
			status: "draft",
			approvedBy: null,
			approvedAt: null,
			summary: null,
			createdAt: 1,
			updatedAt: 1,
		}).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision).toMatchObject({ allowed: false, code: "PROPOSAL_NOT_APPROVED" });
		expect(decision.reason).toContain("draft");
	});

	it("denies mutation when the proposal record was rolled back", () => {
		const decision = gate(m, {
			id: "p1",
			missionId: m.id,
			artifactUri: "local://PLAN.md",
			contentHash: "h",
			status: "rolled_back",
			approvedBy: "user",
			approvedAt: 1,
			summary: null,
			createdAt: 1,
			updatedAt: 2,
		}).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision).toMatchObject({ allowed: false, code: "PROPOSAL_NOT_APPROVED" });
		expect(decision.reason).toContain("rolled_back");
	});

	it("tolerates legacy missions where no proposal row exists", () => {
		// proposalId set, but the store has no row — legacy path; gate allows.
		const decision = gate(m, undefined).check(descriptor("write"), { agentRole: "subagent" }, "HIGH");
		expect(decision.allowed).toBe(true);
	});
});
