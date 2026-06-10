import { describe, expect, it } from "bun:test";
import {
	checkScope,
	deriveContractScopeFromParent,
	enforceContractScope,
	renderSubagentContract,
	type SubagentContract,
} from "@amaze/coding-agent/subagent/contract";

function throwOnViolation(msg: string): never {
	throw new Error(msg);
}

function baseContract(overrides: Partial<SubagentContract> = {}): SubagentContract {
	return {
		role: "refactor-applier",
		scope: { include: [], exclude: [] },
		successCriteria: [],
		escalation: { onUncertainty: "ask-parent", budgetCap: 50000 },
		...overrides,
	};
}

describe("SubagentContract — Phase 2.0 primitive", () => {
	it("renderSubagentContract produces a deterministic XML block (byte-stable for identical input)", () => {
		const contract: SubagentContract = baseContract({
			role: "refactor-applier",
			scope: { include: ["packages/coding-agent/**"], exclude: ["**/CHANGELOG.md"] },
			successCriteria: [
				{
					id: "tests-pass",
					description: "all tests green",
					check: { type: "command-exit", command: "bun test", expected: 0 },
				},
			],
			escalation: { onUncertainty: "ask-parent", budgetCap: 50000 },
		});

		const a = renderSubagentContract(contract);
		const b = renderSubagentContract(contract);
		expect(a).toBe(b);
		expect(a).toContain(`role="refactor-applier"`);
		expect(a).toContain(`<include>packages/coding-agent/**</include>`);
		expect(a).toContain(`<exclude>**/CHANGELOG.md</exclude>`);
		expect(a).toContain(`<criterion id="tests-pass"`);
		expect(a).toContain(`<escalation on-uncertainty="ask-parent" budget-cap="50000"/>`);
	});

	it("renderSubagentContract escapes XML metacharacters in user-provided fields", () => {
		const contract: SubagentContract = baseContract({
			role: "watch & wait",
			scope: { include: ["src/<gen>/*.ts"], exclude: [] },
			successCriteria: [
				{
					id: "a&b",
					description: "fix <bad> & restore",
					check: { type: "manual", description: "human check" },
				},
			],
		});
		const rendered = renderSubagentContract(contract);
		expect(rendered).toContain(`role="watch &amp; wait"`);
		expect(rendered).toContain(`<include>src/&lt;gen&gt;/*.ts</include>`);
		expect(rendered).toContain(`<criterion id="a&amp;b" kind="manual">fix &lt;bad&gt; &amp; restore</criterion>`);
	});

	it("renderSubagentContract omits sections that are empty (clean output)", () => {
		const minimal = baseContract();
		const rendered = renderSubagentContract(minimal);
		expect(rendered).not.toContain("<success-criteria>");
		expect(rendered).not.toContain("<input-artifact>");
		expect(rendered).not.toContain("<output-contract>");
		// Scope block emitted even if both lists empty, so the contract surface is consistent
		// (callers can always count on `<scope>` presence when reading).
		expect(rendered).toContain("<scope>");
		expect(rendered).toContain("</scope>");
	});

	it("checkScope: allowed when no contract is set (no-op for ungoverned subagents)", () => {
		const result = checkScope(undefined, "anything/at/all.ts");
		expect(result.allowed).toBe(true);
	});

	it("checkScope: blocks paths matching scope.exclude (hard fail)", () => {
		const contract = baseContract({
			scope: { include: [], exclude: ["**/CHANGELOG.md"] },
		});
		const result = checkScope(contract, "packages/coding-agent/CHANGELOG.md");
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("scope.exclude");
			expect(result.reason).toContain("CHANGELOG.md");
		}
	});

	it("checkScope: allows paths inside scope.include when include is non-empty", () => {
		const contract = baseContract({
			scope: { include: ["packages/coding-agent/**"], exclude: [] },
		});
		const inside = checkScope(contract, "packages/coding-agent/src/x.ts");
		const outside = checkScope(contract, "packages/ai/src/y.ts");
		expect(inside.allowed).toBe(true);
		expect(outside.allowed).toBe(false);
		if (!outside.allowed) {
			expect(outside.reason).toContain("outside contract scope.include");
		}
	});

	it("checkScope: empty include means no positive restriction (only exclude matters)", () => {
		const contract = baseContract({
			scope: { include: [], exclude: ["secrets/**"] },
		});
		expect(checkScope(contract, "anywhere/else.ts").allowed).toBe(true);
		expect(checkScope(contract, "secrets/key.env").allowed).toBe(false);
	});

	it("checkScope: exclude takes precedence over include (defense in depth)", () => {
		const contract = baseContract({
			scope: { include: ["packages/**"], exclude: ["**/CHANGELOG.md"] },
		});
		// CHANGELOG.md is inside packages/** but also matches exclude — exclude wins.
		const result = checkScope(contract, "packages/coding-agent/CHANGELOG.md");
		expect(result.allowed).toBe(false);
	});

	it("checkScope: normalizes backslashes to forward slashes (Windows interop)", () => {
		const contract = baseContract({
			scope: { include: ["packages/**"], exclude: [] },
		});
		const result = checkScope(contract, "packages\\coding-agent\\src\\x.ts");
		expect(result.allowed).toBe(true);
	});
});

describe("deriveContractScopeFromParent — PR4 contract scope derivation", () => {
	it("returns the contract unchanged when there is no parent scope", () => {
		const c = baseContract({ scope: { include: ["src/**"], exclude: [] } });
		expect(deriveContractScopeFromParent(c, undefined)).toBe(c);
	});

	it("propagates parent denials: a child cannot mutate a path the parent excludes", () => {
		const child = baseContract({ scope: { include: ["src/**"], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, { include: [], exclude: [".github/**"] });
		expect(derived.scope.exclude).toContain(".github/**");
		// The parent denial now binds the child via the contract scope guard.
		expect(checkScope(derived, ".github/workflows/ci.yml").allowed).toBe(false);
		// In-scope child paths still pass.
		expect(checkScope(derived, "src/app.ts").allowed).toBe(true);
	});

	it("unions excludes without duplicating shared globs", () => {
		const child = baseContract({ scope: { include: [], exclude: ["dist/**"] } });
		const derived = deriveContractScopeFromParent(child, { include: [], exclude: ["dist/**", "vendor/**"] });
		expect(derived.scope.exclude.sort()).toEqual(["dist/**", "vendor/**"]);
	});

	it("inherits the parent allowlist when the child declares none", () => {
		const child = baseContract({ scope: { include: [], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, { include: ["packages/app/**"], exclude: [] });
		expect(derived.scope.include).toEqual(["packages/app/**"]);
		// Child is now bounded to the parent's domain.
		expect(checkScope(derived, "packages/app/x.ts").allowed).toBe(true);
		expect(checkScope(derived, "packages/other/y.ts").allowed).toBe(false);
	});

	it("keeps the child's own allowlist when it declares one (still bound by parent excludes)", () => {
		const child = baseContract({ scope: { include: ["packages/app/src/**"], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, {
			include: ["packages/app/**"],
			exclude: ["packages/app/src/secret/**"],
		});
		expect(derived.scope.include).toEqual(["packages/app/src/**"]);
		expect(checkScope(derived, "packages/app/src/ok.ts").allowed).toBe(true);
		expect(checkScope(derived, "packages/app/src/secret/key.ts").allowed).toBe(false);
	});

	it("carries parentMissionScope when the parent declares an include allowlist", () => {
		const child = baseContract({ scope: { include: ["src/featureB/**"], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, { include: ["src/featureA/**"], exclude: [] });
		expect(derived.parentMissionScope).toEqual({ include: ["src/featureA/**"], exclude: [] });
	});

	it("does NOT carry parentMissionScope when the parent has no include allowlist (excludes already folded)", () => {
		const child = baseContract({ scope: { include: ["src/**"], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, { include: [], exclude: ["vendor/**"] });
		expect(derived.parentMissionScope).toBeUndefined();
	});
});

describe("enforceContractScope — child cannot escape parent mission allowlist", () => {
	it("blocks a child edit outside the parent include-allowlist even when the contract scope allows it", () => {
		// Child contract allows src/featureB/**, but the parent mission only permits
		// src/featureA/**. The derived contract carries parentMissionScope; enforcement must reject
		// the sibling-subtree escape that checkScope(contract) alone would allow.
		const child = baseContract({ scope: { include: ["src/featureB/**"], exclude: [] } });
		const derived = deriveContractScopeFromParent(child, { include: ["src/featureA/**"], exclude: [] });

		// Contract scope alone would allow it (this is the escape the bug enabled):
		expect(checkScope(derived, "src/featureB/x.ts").allowed).toBe(true);
		// But enforcement (which also checks parentMissionScope) blocks it:
		expect(() => enforceContractScope(derived, "src/featureB/x.ts", throwOnViolation)).toThrow(
			/Parent mission scope violation/,
		);
		// A path inside BOTH the contract and the parent allowlist is fine.
		const inBoth = baseContract({ scope: { include: ["src/featureA/sub/**"], exclude: [] } });
		const derivedInBoth = deriveContractScopeFromParent(inBoth, { include: ["src/featureA/**"], exclude: [] });
		expect(() => enforceContractScope(derivedInBoth, "src/featureA/sub/y.ts", throwOnViolation)).not.toThrow();
	});
});
