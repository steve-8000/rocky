import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from ".";

export function resolveAgentCwd(session: ToolSession): string {
	if ((session.taskDepth ?? 0) <= 0) return session.cwd;
	const agentId = session.getAgentId?.();
	if (!agentId) return session.cwd;
	const registry = session.agentRegistry;
	if (!registry) return session.cwd;
	const parentCwd = resolveParentAgentCwd(registry, agentId);
	return parentCwd ?? session.cwd;
}

function resolveParentAgentCwd(registry: AgentRegistry, agentId: string): string | undefined {
	const current = registry.get(agentId);
	const parentId = current?.parentId;
	if (!parentId) return undefined;
	const parent = registry.get(parentId);
	const cwd = parent?.session?.sessionManager.getCwd();
	return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}
