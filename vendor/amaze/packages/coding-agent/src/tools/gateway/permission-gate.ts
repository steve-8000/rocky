/**
 * Lane C1 — ToolGateway Skeleton.
 *
 * Minimal permission policy stub. The gateway consults a {@link PermissionGate}
 * before running a tool; the default policy grants LOW/MEDIUM and requires
 * `approvalGranted` (or `requiresApproval=false`) for HIGH/CRITICAL or any tool
 * flagged `requiresApproval`. This is a stub interface — Wave 3 (Lane H) wires
 * it to the real approval surface.
 */
import type { ToolDescriptor, ToolExecutionContext, ToolRiskLevel } from "../registry/tool-descriptor";

export interface PermissionDecision {
	allowed: boolean;
	/** Human-readable reason, populated when denied. */
	reason?: string;
}

export interface PermissionGate {
	check(descriptor: ToolDescriptor<any, any>, ctx: ToolExecutionContext, riskLevel: ToolRiskLevel): PermissionDecision;
}

/** Risk levels that require explicit approval under the default policy. */
const APPROVAL_REQUIRED_RISK: ReadonlySet<ToolRiskLevel> = new Set<ToolRiskLevel>(["HIGH", "CRITICAL"]);

export class DefaultPermissionGate implements PermissionGate {
	check(
		descriptor: ToolDescriptor<any, any>,
		ctx: ToolExecutionContext,
		riskLevel: ToolRiskLevel,
	): PermissionDecision {
		const needsApproval = descriptor.requiresApproval || APPROVAL_REQUIRED_RISK.has(riskLevel);
		if (needsApproval && !ctx.approvalGranted) {
			return {
				allowed: false,
				reason: `tool "${descriptor.name}" (${riskLevel}) requires approval; none granted`,
			};
		}
		return { allowed: true };
	}
}

/** A gate that allows everything — useful for tests and read-only flows. */
export class AllowAllPermissionGate implements PermissionGate {
	check(): PermissionDecision {
		return { allowed: true };
	}
}
