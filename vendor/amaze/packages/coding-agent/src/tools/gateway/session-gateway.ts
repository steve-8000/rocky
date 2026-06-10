/**
 * Lane H — the agent-session dispatch seam's entrypoint to the {@link ToolGateway}.
 *
 * The agent loop dispatches every tool call through the active `AgentTool.execute`.
 * For MUTATION-class tools (write/edit/ast_edit/bash/github) we route the call's
 * allow/deny + timeout + telemetry decision through a single per-session gateway
 * BEFORE the tool's real execution runs. The gateway is a TRANSPARENT pass-through
 * by default: the production policy/permission gates allow-all, so observable
 * behavior for allowed calls is unchanged. The existing inline subagent/mission scope
 * enforcement inside the write/edit tools remains the authoritative deny path and
 * is left untouched; the gateway's {@link SubagentMutationScopeGuard} mirrors it for
 * callers that opt to enforce at the seam (see tests).
 */

import type { MissionControlRuntime } from "../../mission/core/mission-control-runtime";
import { enforceMutationScope } from "../../subagent/mutation-scope";
import type { ToolDescriptor, ToolExecutionContext } from "../registry/tool-descriptor";
import { ToolRegistry } from "../registry/tool-registry";
import { MissionPolicyGate } from "./mission-policy-gate";
import { SubagentMutationScopeGuard } from "./mutation-guard";
import { AllowAllPermissionGate } from "./permission-gate";
import { type GuardDecision, ToolGateway } from "./tool-gateway";

/** Tool names whose calls are routed through the gateway at the dispatch seam. */
export const GATEWAY_MUTATION_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "ast_edit", "bash", "github"]);

/** Minimal descriptor metadata for the mutation tools the seam classifies. */
const SEAM_DESCRIPTOR_META: Record<
	string,
	Pick<ToolDescriptor, "domain" | "riskLevel" | "mutatesWorkspace" | "requiresApproval" | "supportsRollback">
> = {
	write: {
		domain: "filesystem",
		riskLevel: "HIGH",
		mutatesWorkspace: true,
		requiresApproval: false,
		supportsRollback: true,
	},
	edit: {
		domain: "filesystem",
		riskLevel: "HIGH",
		mutatesWorkspace: true,
		requiresApproval: false,
		supportsRollback: true,
	},
	ast_edit: {
		domain: "filesystem",
		riskLevel: "HIGH",
		mutatesWorkspace: true,
		requiresApproval: false,
		supportsRollback: true,
	},
	bash: {
		domain: "shell",
		riskLevel: "CRITICAL",
		mutatesWorkspace: true,
		requiresApproval: false,
		supportsRollback: false,
	},
	github: {
		domain: "vcs",
		riskLevel: "MEDIUM",
		mutatesWorkspace: false,
		requiresApproval: false,
		supportsRollback: false,
	},
};

/**
 * Build a thin descriptor for a seam-routed tool. `execute` is never invoked by the
 * seam (the agent loop owns real execution); it exists only to satisfy the descriptor
 * shape for classification.
 */
function seamDescriptor(name: string): ToolDescriptor {
	const meta = SEAM_DESCRIPTOR_META[name] ?? {
		domain: "unknown" as const,
		riskLevel: "LOW" as const,
		mutatesWorkspace: false,
		requiresApproval: false,
		supportsRollback: false,
	};
	return {
		name,
		toolClass: "legacy",
		...meta,
		execute: async () => ({ ok: true, output: undefined }),
	};
}

/**
 * Per-session gateway facade for the dispatch seam. Holds a registry of the seam
 * descriptors and a single transparent {@link ToolGateway}. Construct one per
 * AgentSession and call {@link decide}/{@link settle} around each mutation tool call.
 */
export class SessionToolGateway {
	#gateway: ToolGateway;
	#registry = new ToolRegistry();
	#missionControl?: MissionControlRuntime;
	#mutationTools: ReadonlySet<string>;

	constructor(options?: {
		enforceMutationScopeAtSeam?: boolean;
		missionControl?: MissionControlRuntime;
		mutationToolNames?: ReadonlySet<string>;
	}) {
		this.#missionControl = options?.missionControl;
		this.#mutationTools = options?.mutationToolNames ?? GATEWAY_MUTATION_TOOLS;
		for (const name of this.#mutationTools) {
			this.#registry.register(seamDescriptor(name));
		}
		this.#gateway = new ToolGateway(this.#registry, {
			policyGate: options?.missionControl
				? new MissionPolicyGate({ missionControl: options.missionControl, mutationToolNames: this.#mutationTools })
				: undefined,
			// Production seam is a transparent pass-through unless mission control is supplied:
			// allow-all permission keeps behavior for allowed calls identical to today.
			permissionGate: new AllowAllPermissionGate(),
			// The inline tool enforcement remains authoritative by default; opt in to
			// seam-level scope enforcement (tests / strict modes) explicitly.
			...(options?.enforceMutationScopeAtSeam
				? { asyncMutationGuard: new SubagentMutationScopeGuard(enforceMutationScope) }
				: {}),
		});
	}

	/** Whether a tool name is routed through the seam gateway. */
	handles(name: string): boolean {
		return this.#mutationTools.has(name);
	}

	/**
	 * Run the policy pipeline for a tool call and emit `mission.tool.requested` on allow.
	 * Returns the gateway decision; the caller executes the tool only when `allowed`.
	 */
	async decide(name: string, ctx: ToolExecutionContext): Promise<GuardDecision> {
		const descriptor = this.#registry.get(name) ?? seamDescriptor(name);
		const decision = await this.#gateway.guard(descriptor, ctx);
		if (
			decision.allowed ||
			decision.code !== "PROMOTE_REQUIRED" ||
			!this.handles(descriptor.name) ||
			!this.#missionControl
		) {
			return decision;
		}

		// One-shot retry: ambient mutations are promoted once, then the gateway is
		// re-run exactly once so repeated denials cannot loop indefinitely.
		await this.#missionControl.promoteFromAmbient({ triggeringTool: descriptor.name });
		return this.#gateway.guard(descriptor, ctx);
	}

	/** Emit `mission.tool.completed` for a call that passed {@link decide}. */
	settle(name: string, ctx: ToolExecutionContext, status: "ok" | "error"): void {
		const descriptor = this.#registry.get(name) ?? seamDescriptor(name);
		this.#gateway.settle(descriptor, ctx, status);
	}
}
