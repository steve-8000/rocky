import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceMutationScope } from "@amaze/coding-agent/subagent/mutation-scope";
import {
	AllowAllPermissionGate,
	RISK_DEFAULT_TIMEOUT_MS,
	SessionToolGateway,
	SubagentMutationScopeGuard,
	ToolGateway,
} from "@amaze/coding-agent/tools/gateway/index";
import type { ToolCallRecord } from "@amaze/coding-agent/tools/registry/index";
import { ToolRegistry } from "@amaze/coding-agent/tools/registry/index";

/** A minimal ToolSession-shaped object the scope guard reads from. */
function fakeSession(cwd: string, contract?: { include: string[]; exclude: string[] }) {
	return {
		cwd,
		getSubagentContract: () =>
			contract
				? {
						role: "test-subagent",
						scope: contract,
						successCriteria: [],
						escalation: { onUncertainty: "block", budgetCap: 0 },
					}
				: undefined,
	};
}

describe("ToolGateway enforcement at the dispatch seam (Lane H)", () => {
	let cwd: string;
	beforeAll(() => {
		cwd = mkdtempSync(join(tmpdir(), "gateway-enforce-"));
	});
	afterAll(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	describe("allowed calls pass through unchanged", () => {
		it("allows a write with no scope restriction and resolves HIGH timeout", async () => {
			const seam = new SessionToolGateway();
			expect(seam.handles("write")).toBe(true);
			const decision = await seam.decide("write", { toolCallId: "t1", cwd, input: { path: "a.txt" } });
			expect(decision.allowed).toBe(true);
			expect(decision.riskLevel).toBe("HIGH");
			expect(decision.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.HIGH);
		});

		it("allows a bash call and resolves CRITICAL timeout", async () => {
			const seam = new SessionToolGateway();
			const decision = await seam.decide("bash", { toolCallId: "t2", input: { command: "echo hi" } });
			expect(decision.allowed).toBe(true);
			expect(decision.riskLevel).toBe("CRITICAL");
			expect(decision.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.CRITICAL);
		});

		it("does not handle non-mutation tools (transparent — returns them untouched)", () => {
			const seam = new SessionToolGateway();
			expect(seam.handles("read")).toBe(false);
			expect(seam.handles("repo_search")).toBe(false);
		});
	});

	describe("subagent scope violation is denied exactly as today", () => {
		it("denies a write outside the subagent contract scope.include", async () => {
			const guard = new SubagentMutationScopeGuard(enforceMutationScope);
			const session = fakeSession(cwd, { include: ["src/**"], exclude: [] });
			const descriptor = {
				name: "write",
				toolClass: "legacy" as const,
				domain: "filesystem" as const,
				riskLevel: "HIGH" as const,
				mutatesWorkspace: true,
				requiresApproval: false,
				supportsRollback: true,
				execute: async () => ({ ok: true, output: undefined }),
			};
			const decision = await guard.checkAsync(descriptor, { session, input: { path: "secrets.txt" } });
			expect(decision.allowed).toBe(false);
			expect(decision.reason).toMatch(/scope/i);
		});

		it("allows a write inside the subagent contract scope.include", async () => {
			const guard = new SubagentMutationScopeGuard(enforceMutationScope);
			const session = fakeSession(cwd, { include: ["src/**"], exclude: [] });
			const descriptor = {
				name: "write",
				toolClass: "legacy" as const,
				domain: "filesystem" as const,
				riskLevel: "HIGH" as const,
				mutatesWorkspace: true,
				requiresApproval: false,
				supportsRollback: true,
				execute: async () => ({ ok: true, output: undefined }),
			};
			const decision = await guard.checkAsync(descriptor, { session, input: { path: "src/app.ts" } });
			expect(decision.allowed).toBe(true);
		});

		it("denies through the gateway pipeline when the async guard is wired", async () => {
			const reg = new ToolRegistry();
			const descriptor = {
				name: "write",
				toolClass: "legacy" as const,
				domain: "filesystem" as const,
				riskLevel: "HIGH" as const,
				mutatesWorkspace: true,
				requiresApproval: false,
				supportsRollback: true,
				execute: async () => ({ ok: true, output: undefined }),
			};
			reg.register(descriptor);
			const gateway = new ToolGateway(reg, {
				permissionGate: new AllowAllPermissionGate(),
				asyncMutationGuard: new SubagentMutationScopeGuard(enforceMutationScope),
			});
			const session = fakeSession(cwd, { include: [], exclude: ["**/*.env"] });
			const decision = await gateway.guard(descriptor, {
				toolCallId: "t3",
				session,
				input: { path: "config/prod.env" },
			});
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) expect(decision.stage).toBe("mutation");
		});
	});

	describe("mission tool-call telemetry", () => {
		it("emits requested + completed records when a mission context is present", async () => {
			const records: ToolCallRecord[] = [];
			const seam = new SessionToolGateway();
			const ctx = {
				toolCallId: "call-9",
				input: { path: "a.txt" },
				mission: {
					missionId: "m1",
					taskId: "task-1",
					emit: (r: ToolCallRecord) => records.push(r),
				},
			};
			const decision = await seam.decide("write", ctx);
			expect(decision.allowed).toBe(true);
			seam.settle("write", ctx, "ok");

			expect(records).toHaveLength(2);
			expect(records[0]).toMatchObject({
				type: "mission.tool.requested",
				missionId: "m1",
				taskId: "task-1",
				toolCallId: "call-9",
				tool: "write",
			});
			expect(records[1]).toMatchObject({
				type: "mission.tool.completed",
				missionId: "m1",
				taskId: "task-1",
				toolCallId: "call-9",
				tool: "write",
				status: "ok",
			});
		});

		it("emits a denied completed record when a mission context is present and the call is blocked", async () => {
			const records: ToolCallRecord[] = [];
			const reg = new ToolRegistry();
			const descriptor = {
				name: "write",
				toolClass: "legacy" as const,
				domain: "filesystem" as const,
				riskLevel: "HIGH" as const,
				mutatesWorkspace: true,
				requiresApproval: false,
				supportsRollback: true,
				execute: async () => ({ ok: true, output: undefined }),
			};
			reg.register(descriptor);
			const gateway = new ToolGateway(reg, {
				permissionGate: new AllowAllPermissionGate(),
				asyncMutationGuard: new SubagentMutationScopeGuard(enforceMutationScope),
			});
			const session = fakeSession(cwd, { include: ["src/**"], exclude: [] });
			const decision = await gateway.guard(descriptor, {
				toolCallId: "call-deny",
				session,
				input: { path: "outside.txt" },
				mission: { missionId: "m2", taskId: null, emit: (r: ToolCallRecord) => records.push(r) },
			});
			expect(decision.allowed).toBe(false);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				type: "mission.tool.completed",
				missionId: "m2",
				status: "denied",
				tool: "write",
			});
		});

		it("no-ops telemetry when no mission context is present", async () => {
			const seam = new SessionToolGateway();
			// Should not throw; simply produces no records (nothing to assert beyond allow).
			const decision = await seam.decide("write", { toolCallId: "x", input: { path: "a.txt" } });
			expect(decision.allowed).toBe(true);
			seam.settle("write", { toolCallId: "x", input: { path: "a.txt" } }, "ok");
		});
	});

	describe("timeout metadata respected", () => {
		it("uses the per-risk default timeout for each mutation tool", async () => {
			const seam = new SessionToolGateway();
			const w = await seam.decide("write", { toolCallId: "a", input: { path: "a.txt" } });
			const e = await seam.decide("edit", { toolCallId: "b", input: { path: "a.txt" } });
			const b = await seam.decide("bash", { toolCallId: "c", input: { command: "ls" } });
			const g = await seam.decide("github", { toolCallId: "d", input: {} });
			expect(w.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.HIGH);
			expect(e.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.HIGH);
			expect(b.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.CRITICAL);
			expect(g.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.MEDIUM);
		});
	});

	describe("mission auto-promotion", () => {
		it("promotes ambient mutation calls and retries once", async () => {
			const promoted: string[] = [];
			let active = false;
			const seam = new SessionToolGateway({
				missionControl: {
					getActiveMission: () =>
						active
							? {
									id: "m-promoted",
									intent: "code_change",
									lifecycle: "executing",
								}
							: undefined,
					promoteFromAmbient: async (input: { triggeringTool: string }) => {
						promoted.push(input.triggeringTool);
						active = true;
						return {
							id: "m-promoted",
							intent: "code_change",
							lifecycle: "executing",
						};
					},
				} as never,
			});

			const decision = await seam.decide("write", { toolCallId: "ambient-write", input: { path: "a.txt" } });

			expect(decision.allowed).toBe(true);
			expect(promoted).toEqual(["write"]);
		});
	});
});
