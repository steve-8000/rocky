/**
 * Lane C1 — ToolGateway Skeleton.
 *
 * Minimal mutation-scope policy stub. For workspace-mutating tools the gateway
 * asks the guard whether the call is within the caller's declared mutation
 * scope. The default guard is permissive when no scope is declared and is the
 * hook Lane H/I will tighten (e.g. subagent scope enforcement).
 */
import type { ToolDescriptor, ToolExecutionContext } from "../registry/tool-descriptor";

export interface MutationDecision {
	allowed: boolean;
	reason?: string;
}

export interface MutationScopeGuard {
	check(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext): MutationDecision;
}

export class DefaultMutationScopeGuard implements MutationScopeGuard {
	check(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext): MutationDecision {
		// Non-mutating tools are never scope-restricted.
		if (!descriptor.mutatesWorkspace) {
			return { allowed: true };
		}
		// No declared scope ⇒ no restriction to enforce (skeleton behavior).
		if (!ctx.mutationScope) {
			return { allowed: true };
		}
		// An explicitly empty scope means "no mutation allowed".
		if (ctx.mutationScope.length === 0) {
			return {
				allowed: false,
				reason: `tool "${descriptor.name}" mutates the workspace but the mutation scope is empty`,
			};
		}
		return { allowed: true };
	}
}

/** A guard that allows everything. */
export class AllowAllMutationScopeGuard implements MutationScopeGuard {
	check(): MutationDecision {
		return { allowed: true };
	}
}

/**
 * Async mutation-scope guard surface. The subagent/mission scope check is async
 * (it realpaths the filesystem), so the gateway seam consults this variant
 * directly rather than the synchronous {@link MutationScopeGuard}.
 */
export interface AsyncMutationScopeGuard {
	checkAsync(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext): Promise<MutationDecision>;
}

/**
 * The session contract surface the subagent guard needs. Structurally a subset
 * of `ToolSession` so the gateway layer stays decoupled from the app session.
 */
export interface MutationScopeSession {
	cwd: string;
	getSubagentContract?: () => unknown;
	conflictHistory?: { get(id: number): { absolutePath: string } | undefined };
}

/** Pulls the mutation target path(s) for a known mutation tool from its input. */
function extractMutationPaths(toolName: string, input: unknown): { path: string; isRename?: boolean }[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const out: { path: string; isRename?: boolean }[] = [];
	const pushIf = (value: unknown, isRename?: boolean) => {
		if (typeof value === "string" && value.length > 0) out.push({ path: value, isRename });
	};
	switch (toolName) {
		case "write":
		case "edit":
		case "ast_edit":
			pushIf(obj.path);
			pushIf(obj.file_path);
			// rename/move destinations on write-family tools
			pushIf(obj.new_path, true);
			pushIf(obj.destination, true);
			break;
		default:
			break;
	}
	return out;
}

/**
 * Lane H — routes the EXISTING subagent/mission mutation-scope enforcement through
 * the gateway. It delegates to the same `enforceMutationScope` used inline by the
 * write/edit tools, so a subagent (or mission-scoped session) writing outside its
 * declared scope is denied EXACTLY as today — only surfaced as a `MutationDecision`
 * deny instead of a thrown error at this layer. Non-mutating tools and calls with
 * no resolvable path or no session are allowed (transparent pass-through).
 */
export class SubagentMutationScopeGuard implements AsyncMutationScopeGuard {
	#enforce: typeof import("../../subagent/mutation-scope").enforceMutationScope;

	constructor(enforce: typeof import("../../subagent/mutation-scope").enforceMutationScope) {
		this.#enforce = enforce;
	}

	async checkAsync(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext): Promise<MutationDecision> {
		if (!descriptor.mutatesWorkspace) return { allowed: true };
		const session = ctx.session as MutationScopeSession | undefined;
		if (!session) return { allowed: true };
		const targets = extractMutationPaths(descriptor.name, ctx.input);
		if (targets.length === 0) return { allowed: true };

		for (const target of targets) {
			let denied: string | undefined;
			try {
				await this.#enforce(
					session as never,
					target.path,
					{ op: target.isRename ? "rename-destination" : "update", source: descriptor.name },
					(msg: string) => {
						denied = msg;
						throw new Error(msg);
					},
				);
			} catch (err) {
				const reason = denied ?? (err instanceof Error ? err.message : String(err));
				return { allowed: false, reason };
			}
		}
		return { allowed: true };
	}
}
