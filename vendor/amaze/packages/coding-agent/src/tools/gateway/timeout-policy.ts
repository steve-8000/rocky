/**
 * Lane C1 — ToolGateway Skeleton.
 *
 * Resolves the effective timeout (ms) for a tool call. The default policy
 * honors the descriptor's `timeoutMs`, falling back to a per-risk default and
 * finally a global default. This is a stub — it does not yet enforce
 * cancellation (that stays with the existing tool runtime).
 */
import type { ToolDescriptor, ToolRiskLevel } from "../registry/tool-descriptor";

/** Global fallback when neither descriptor nor risk default applies. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-risk default timeouts (ms). Higher risk ⇒ more generous default. */
export const RISK_DEFAULT_TIMEOUT_MS: Record<ToolRiskLevel, number> = {
	LOW: 20_000,
	MEDIUM: 30_000,
	HIGH: 60_000,
	CRITICAL: 300_000,
};

export interface TimeoutPolicy {
	resolve(descriptor: ToolDescriptor<any, any>, riskLevel: ToolRiskLevel): number;
}

export class DefaultTimeoutPolicy implements TimeoutPolicy {
	resolve(descriptor: ToolDescriptor<any, any>, riskLevel: ToolRiskLevel): number {
		if (typeof descriptor.timeoutMs === "number" && descriptor.timeoutMs > 0) {
			return descriptor.timeoutMs;
		}
		return RISK_DEFAULT_TIMEOUT_MS[riskLevel] ?? DEFAULT_TIMEOUT_MS;
	}
}
