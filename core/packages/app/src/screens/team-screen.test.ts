import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getrocky/protocol/agent-labels";
import { buildLeaderBriefing, groupAgentsIntoTeams } from "./team-model";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makeAgent(input: {
  id: string;
  parentAgentId?: string;
  lastActivityAt?: Date;
}): AggregatedAgent {
  return {
    id: input.id,
    serverId: "srv-1",
    serverLabel: "Local",
    title: input.id,
    status: "idle",
    lastActivityAt: input.lastActivityAt ?? new Date("2026-06-10T00:00:00Z"),
    cwd: "/tmp/project",
    provider: "amaze",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: new Date("2026-06-10T00:00:00Z"),
    labels: input.parentAgentId ? { [PARENT_AGENT_ID_LABEL]: input.parentAgentId } : {},
    pendingPermissionCount: 0,
  };
}

describe("groupAgentsIntoTeams", () => {
  it("groups teammates under their leader via the parent label", () => {
    const leader = makeAgent({ id: "leader" });
    const teammateA = makeAgent({ id: "a", parentAgentId: "leader" });
    const teammateB = makeAgent({ id: "b", parentAgentId: "leader" });
    const solo = makeAgent({ id: "solo" });

    const teams = groupAgentsIntoTeams([leader, teammateA, teammateB, solo]);

    expect(teams).toHaveLength(1);
    expect(teams[0]?.leader.id).toBe("leader");
    expect(teams[0]?.teammates.map((agent) => agent.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores parent labels pointing at unknown agents", () => {
    const orphan = makeAgent({ id: "orphan", parentAgentId: "gone" });
    expect(groupAgentsIntoTeams([orphan])).toHaveLength(0);
  });

  it("sorts teammates by recency and teams by leader recency", () => {
    const oldLeader = makeAgent({ id: "old", lastActivityAt: new Date("2026-06-01T00:00:00Z") });
    const newLeader = makeAgent({ id: "new", lastActivityAt: new Date("2026-06-09T00:00:00Z") });
    const stale = makeAgent({
      id: "stale",
      parentAgentId: "new",
      lastActivityAt: new Date("2026-06-02T00:00:00Z"),
    });
    const fresh = makeAgent({
      id: "fresh",
      parentAgentId: "new",
      lastActivityAt: new Date("2026-06-08T00:00:00Z"),
    });
    const child = makeAgent({ id: "child", parentAgentId: "old" });

    const teams = groupAgentsIntoTeams([oldLeader, newLeader, stale, fresh, child]);

    expect(teams.map((team) => team.leader.id)).toEqual(["new", "old"]);
    expect(teams[0]?.teammates.map((agent) => agent.id)).toEqual(["fresh", "stale"]);
  });
});

describe("buildLeaderBriefing", () => {
  it("embeds the trimmed goal and the orchestrate protocol", () => {
    const briefing = buildLeaderBriefing("  Ship the feature  ");
    expect(briefing).toContain("Goal: Ship the feature");
    expect(briefing).toContain("rocky-orchestrate");
    expect(briefing).toContain("create_agent");
  });
});

describe("buildLeaderBriefing roster", () => {
  it("lists enabled registered agents with their specs", () => {
    const briefing = buildLeaderBriefing("Ship it", [
      {
        id: "a1",
        name: "Backend reviewer",
        role: "Reviews server code",
        provider: "amaze",
        model: "anthropic/claude-fable-5",
        thinkingOptionId: "high",
        systemPrompt: "Be strict.",
        enabled: true,
      },
      {
        id: "a2",
        name: "Disabled one",
        role: "",
        provider: "amaze",
        enabled: false,
      },
    ]);
    expect(briefing).toContain("Backend reviewer — Reviews server code");
    expect(briefing).toContain("provider=amaze, model=anthropic/claude-fable-5, thinking=high");
    expect(briefing).toContain("system prompt: Be strict.");
    expect(briefing).not.toContain("Disabled one");
  });

  it("omits the roster section when no agents are registered", () => {
    const briefing = buildLeaderBriefing("Ship it", []);
    expect(briefing).not.toContain("Registered team agents");
  });
});
