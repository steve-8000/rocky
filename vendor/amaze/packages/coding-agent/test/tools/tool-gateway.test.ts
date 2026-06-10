import { describe, expect, it } from "bun:test";
import {
	AllowAllPermissionGate,
	DefaultTimeoutPolicy,
	RISK_DEFAULT_TIMEOUT_MS,
	ToolGateway,
} from "@amaze/coding-agent/tools/gateway/index";
import { type ToolDescriptor, ToolRegistry } from "@amaze/coding-agent/tools/registry/index";

function descriptor(overrides: Partial<ToolDescriptor> & Pick<ToolDescriptor, "name">): ToolDescriptor {
	return {
		toolClass: "native",
		domain: "filesystem",
		riskLevel: "LOW",
		mutatesWorkspace: false,
		requiresApproval: false,
		supportsRollback: false,
		execute: async () => ({ ok: true, output: undefined }),
		...overrides,
	};
}

describe("ToolRegistry", () => {
	it("registers and looks up descriptors", () => {
		const reg = new ToolRegistry();
		reg.register(descriptor({ name: "alpha" }));
		expect(reg.has("alpha")).toBe(true);
		expect(reg.get("alpha")?.name).toBe("alpha");
		expect(reg.get("missing")).toBeUndefined();
		expect(reg.size).toBe(1);
	});

	it("dedupes by name (last writer wins)", () => {
		const reg = new ToolRegistry();
		reg.register(descriptor({ name: "dup", label: "first" }));
		reg.register(descriptor({ name: "dup", label: "second" }));
		expect(reg.size).toBe(1);
		expect(reg.get("dup")?.label).toBe("second");
	});

	it("throws on duplicate when strict", () => {
		const reg = new ToolRegistry();
		reg.register(descriptor({ name: "dup" }));
		expect(() => reg.register(descriptor({ name: "dup" }), { strict: true })).toThrow(/duplicate/);
	});
});

describe("ToolGateway", () => {
	it("denies a mutating tool without approval", async () => {
		const reg = new ToolRegistry();
		let ran = false;
		reg.register(
			descriptor({
				name: "writer",
				domain: "filesystem",
				riskLevel: "HIGH",
				mutatesWorkspace: true,
				requiresApproval: true,
				execute: async () => {
					ran = true;
					return { ok: true, output: "wrote" };
				},
			}),
		);
		const gateway = new ToolGateway(reg);
		const result = await gateway.run("writer", {});
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/approval/);
		expect(ran).toBe(false);
	});

	it("runs a mutating tool when approval is granted", async () => {
		const reg = new ToolRegistry();
		reg.register(
			descriptor({
				name: "writer",
				mutatesWorkspace: true,
				riskLevel: "HIGH",
				requiresApproval: true,
				execute: async () => ({ ok: true, output: "wrote" }),
			}),
		);
		const gateway = new ToolGateway(reg);
		const result = await gateway.run("writer", {}, { approvalGranted: true });
		expect(result.ok).toBe(true);
		expect(result.output).toBe("wrote");
		expect(result.riskLevel).toBe("HIGH");
	});

	it("denies a mutation when scope is empty", async () => {
		const reg = new ToolRegistry();
		reg.register(descriptor({ name: "writer", mutatesWorkspace: true, riskLevel: "LOW" }));
		const gateway = new ToolGateway(reg, { permissionGate: new AllowAllPermissionGate() });
		const result = await gateway.run("writer", {}, { mutationScope: [] });
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/scope/);
	});

	it("resolves timeout metadata (descriptor wins, else per-risk default)", async () => {
		const policy = new DefaultTimeoutPolicy();
		// descriptor-provided timeout wins
		expect(policy.resolve(descriptor({ name: "t", timeoutMs: 1234 }), "LOW")).toBe(1234);
		// otherwise per-risk default
		expect(policy.resolve(descriptor({ name: "t" }), "CRITICAL")).toBe(RISK_DEFAULT_TIMEOUT_MS.CRITICAL);

		const reg = new ToolRegistry();
		reg.register(descriptor({ name: "reader", riskLevel: "LOW" }));
		const gateway = new ToolGateway(reg);
		const result = await gateway.run("reader", {});
		expect(result.ok).toBe(true);
		expect(result.timeoutMs).toBe(RISK_DEFAULT_TIMEOUT_MS.LOW);
	});

	it("returns a failed result for an unknown tool", async () => {
		const gateway = new ToolGateway(new ToolRegistry());
		const result = await gateway.run("nope", {});
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/no tool registered/);
	});
});
