/**
 * Lane C1 — ToolGateway Skeleton (workplan §9.4).
 *
 * Maps a {@link ToolDescriptor} to a {@link ToolRiskLevel}. The descriptor may
 * carry an explicit `riskLevel`; this classifier derives a level from the
 * tool's observable properties and returns the MORE severe of the two so a
 * descriptor can escalate but never silently downgrade.
 *
 * Rules (§9.4):
 *   - executes shell / arbitrary commands ........... CRITICAL
 *   - mutates remote/shared state (vcs writes) ...... CRITICAL
 *   - mutates the local workspace ................... HIGH
 *   - reaches the network (read-only) ............... MEDIUM
 *   - pure local read / inspection .................. LOW
 */
import type { ToolDescriptor, ToolDomain, ToolRiskLevel } from "../registry/tool-descriptor";

const RISK_ORDER: Record<ToolRiskLevel, number> = {
	LOW: 0,
	MEDIUM: 1,
	HIGH: 2,
	CRITICAL: 3,
};

/** Return the more severe of two risk levels. */
export function maxRisk(a: ToolRiskLevel, b: ToolRiskLevel): ToolRiskLevel {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Network-reaching domains that imply at least MEDIUM risk when read-only. */
const NETWORK_DOMAINS: ReadonlySet<ToolDomain> = new Set<ToolDomain>(["network", "vcs"]);

/** Domains whose mutations escalate to CRITICAL (remote/shared state). */
const REMOTE_MUTATION_DOMAINS: ReadonlySet<ToolDomain> = new Set<ToolDomain>(["vcs", "network"]);

/** Derive a risk level purely from descriptor properties. */
export function deriveRiskLevel(descriptor: ToolDescriptor<any, any>): ToolRiskLevel {
	// Arbitrary command execution is always CRITICAL.
	if (descriptor.domain === "shell") {
		return "CRITICAL";
	}
	if (descriptor.mutatesWorkspace) {
		// Mutating remote/shared state is worse than mutating the local tree.
		return REMOTE_MUTATION_DOMAINS.has(descriptor.domain) ? "CRITICAL" : "HIGH";
	}
	// Read-only but network-reaching.
	if (NETWORK_DOMAINS.has(descriptor.domain)) {
		return "MEDIUM";
	}
	return "LOW";
}

/**
 * Classify a descriptor. Returns the more severe of the descriptor's declared
 * level and the derived level, so descriptors can escalate but not downgrade.
 */
export function classifyRisk(descriptor: ToolDescriptor<any, any>): ToolRiskLevel {
	const derived = deriveRiskLevel(descriptor);
	return descriptor.riskLevel ? maxRisk(descriptor.riskLevel, derived) : derived;
}
