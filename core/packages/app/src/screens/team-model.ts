import { getParentAgentIdFromLabels } from "@getrocky/protocol/agent-labels";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export interface TeamGroup {
  leader: AggregatedAgent;
  teammates: AggregatedAgent[];
}

/**
 * Groups live daemon agents into Leader -> Teammate teams using the
 * `rocky.parent-agent-id` label the daemon stamps on agents spawned through
 * the agent-to-agent MCP tools (create_agent). An agent is a Leader when at
 * least one other agent points at it.
 */
export function groupAgentsIntoTeams(agents: readonly AggregatedAgent[]): TeamGroup[] {
  const byId = new Map<string, AggregatedAgent>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  const teammatesByParent = new Map<string, AggregatedAgent[]>();
  for (const agent of agents) {
    const parentId = getParentAgentIdFromLabels(agent.labels);
    if (!parentId || !byId.has(parentId)) continue;
    const bucket = teammatesByParent.get(parentId);
    if (bucket) {
      bucket.push(agent);
    } else {
      teammatesByParent.set(parentId, [agent]);
    }
  }
  const groups: TeamGroup[] = [];
  for (const [parentId, teammates] of teammatesByParent) {
    const leader = byId.get(parentId);
    if (!leader) continue;
    teammates.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    groups.push({ leader, teammates });
  }
  groups.sort((a, b) => b.leader.lastActivityAt.getTime() - a.leader.lastActivityAt.getTime());
  return groups;
}

export function buildLeaderBriefing(goal: string): string {
  const trimmedGoal = goal.trim();
  return [
    "You are the Leader of a Rocky agent team. Use the rocky-orchestrate skill protocol:",
    "decompose the goal into independent subtasks, spawn parallel Teammate agents with the",
    "create_agent MCP tool (use worktrees for code changes), track a TEAM_BOARD.md at the",
    "workspace root, monitor with wait_for_agent, integrate results, and report with",
    "verification evidence.",
    "",
    `Goal: ${trimmedGoal}`,
  ].join("\n");
}
