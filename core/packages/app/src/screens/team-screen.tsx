import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Bot, ChevronRight, Crown, Rocket, Settings2, Users } from "lucide-react-native";
import type { TeamAgent } from "@getrocky/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { getProviderIcon } from "@/components/provider-icons";
import { useAllAgentsList } from "@/hooks/use-all-agents-list";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHostProjects, type HostProjectListItem } from "@/projects/host-projects";
import { useDraftStore } from "@/stores/draft-store";
import {
  buildHostAgentDetailRoute,
  buildHostNewWorkspaceRoute,
  buildSettingsHostSectionRoute,
} from "@/utils/host-routes";
import { formatTimeAgo } from "@/utils/time";
import { buildLeaderBriefing, groupAgentsIntoTeams } from "@/screens/team-model";

function statusTone(status: AggregatedAgent["status"]): "running" | "attention" | "muted" {
  if (status === "running" || status === "initializing") return "running";
  if (status === "error") return "attention";
  return "muted";
}

function statusLabel(agent: AggregatedAgent): string {
  if ((agent.pendingPermissionCount ?? 0) > 0) {
    return `${agent.pendingPermissionCount} pending`;
  }
  switch (agent.status) {
    case "initializing":
      return "Starting";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    default:
      return agent.status;
  }
}

function AgentRow({
  agent,
  role,
  onPress,
}: {
  agent: AggregatedAgent;
  role: "leader" | "teammate";
  onPress: (agent: AggregatedAgent) => void;
}) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(agent.provider);
  const tone = statusTone(agent.status);
  const handlePress = useCallback(() => onPress(agent), [agent, onPress]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: { pressed: boolean; hovered?: boolean }) => [
      styles.agentRow,
      role === "teammate" && styles.teammateRow,
      (pressed || hovered) && styles.agentRowHovered,
    ],
    [role],
  );
  const dotStyle = useMemo(
    () => [
      styles.statusDot,
      tone === "running" && styles.statusDotRunning,
      tone === "attention" && styles.statusDotAttention,
    ],
    [tone],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      testID={`team-agent-${agent.serverId}-${agent.id}`}
    >
      {role === "leader" ? (
        <Crown size={theme.iconSize.sm} color={theme.colors.accentBright} />
      ) : (
        <Bot size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      )}
      <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <Text style={styles.agentTitle} numberOfLines={1}>
        {agent.title || "New agent"}
      </Text>
      <View style={dotStyle} />
      <Text style={styles.agentMeta}>{statusLabel(agent)}</Text>
      <Text style={styles.agentMeta}>{formatTimeAgo(agent.lastActivityAt)}</Text>
      <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function ProjectChip({
  project,
  selected,
  onSelect,
}: {
  project: HostProjectListItem;
  selected: boolean;
  onSelect: (project: HostProjectListItem) => void;
}) {
  const handlePress = useCallback(() => onSelect(project), [onSelect, project]);
  const chipStyle = useMemo(
    () => [styles.projectChip, selected && styles.projectChipSelected],
    [selected],
  );
  const chipTextStyle = useMemo(
    () => [styles.projectChipText, selected && styles.projectChipTextSelected],
    [selected],
  );
  return (
    <Pressable style={chipStyle} onPress={handlePress} testID={`team-project-${project.projectKey}`}>
      <Text style={chipTextStyle} numberOfLines={1}>
        {project.projectName}
      </Text>
    </Pressable>
  );
}

function RosterRow({ preset }: { preset: TeamAgent }) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(preset.provider);
  const disabled = preset.enabled === false;
  return (
    <View style={styles.rosterRow} testID={`team-roster-${preset.id}`}>
      <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <View style={styles.rosterInfo}>
        <Text style={disabled ? styles.rosterNameDisabled : styles.rosterName} numberOfLines={1}>
          {preset.name}
        </Text>
        <Text style={styles.agentMeta} numberOfLines={1}>
          {[
            preset.role,
            preset.provider,
            preset.model,
            preset.approvalPolicy,
            disabled ? "disabled" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
    </View>
  );
}

export function TeamScreen({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const projects = useHostProjects(serverId || null);
  const { agents } = useAllAgentsList({ serverId });
  const { config } = useDaemonConfig(serverId);
  const roster = useMemo(() => config?.teamAgents ?? [], [config?.teamAgents]);
  const [goal, setGoal] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);

  const selectedProject = useMemo(() => {
    if (projects.length === 0) return null;
    return projects.find((project) => project.projectKey === selectedProjectKey) ?? projects[0];
  }, [projects, selectedProjectKey]);

  const teams = useMemo(() => groupAgentsIntoTeams(agents), [agents]);

  const handleSelectProject = useCallback((project: HostProjectListItem) => {
    setSelectedProjectKey(project.projectKey);
  }, []);

  const handleOpenAgent = useCallback(
    (agent: AggregatedAgent) => {
      router.push(buildHostAgentDetailRoute(agent.serverId, agent.id));
    },
    [],
  );

  const canLaunch = Boolean(selectedProject) && goal.trim().length > 0;

  const handleLaunch = useCallback(() => {
    if (!selectedProject || goal.trim().length === 0) return;
    const sourceDirectory = selectedProject.iconWorkingDir;
    const draftKey = `new-workspace:${serverId}:${sourceDirectory}`;
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: buildLeaderBriefing(goal, roster), attachments: [] },
    });
    setGoal("");
    router.push(
      buildHostNewWorkspaceRoute(serverId, sourceDirectory, {
        displayName: selectedProject.projectName,
        projectId: selectedProject.projectKey,
      }),
    );
  }, [goal, roster, selectedProject, serverId]);

  const handleOpenAgentSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [serverId]);

  const handleOpenProviderSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "providers"));
  }, [serverId]);

  return (
    <View style={styles.container}>
      <MenuHeader title="Team" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Rocket size={theme.iconSize.md} color={theme.colors.accentBright} />
            <Text style={styles.cardTitle}>Start a mission</Text>
          </View>
          <Text style={styles.cardSubtitle}>
            Launch a Leader agent that decomposes the goal and spawns parallel Teammates with
            their own worktrees, a shared task board, and a mission mailbox.
          </Text>
          {projects.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.projectChips}>
                {projects.map((project) => (
                  <ProjectChip
                    key={project.projectKey}
                    project={project}
                    selected={project.projectKey === selectedProject?.projectKey}
                    onSelect={handleSelectProject}
                  />
                ))}
              </View>
            </ScrollView>
          ) : (
            <Text style={styles.emptyText}>Add a project first to launch a team.</Text>
          )}
          <TextInput
            style={styles.goalInput}
            value={goal}
            onChangeText={setGoal}
            placeholder="Describe the mission goal..."
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            testID="team-goal-input"
          />
          <View style={styles.launchRow}>
            <Button onPress={handleLaunch} disabled={!canLaunch} testID="team-launch">
              Launch Leader
            </Button>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Bot size={theme.iconSize.md} color={theme.colors.foreground} />
            <Text style={styles.cardTitle}>Registered agents</Text>
          </View>
          {roster.length === 0 ? (
            <Text style={styles.emptyText}>
              No registered agents. Register reusable agent presets in Agent settings; the
              Leader will staff missions with them.
            </Text>
          ) : (
            roster.map((preset) => <RosterRow key={preset.id} preset={preset} />)
          )}
          <View style={styles.settingsLinks}>
            <Button variant="secondary" size="sm" onPress={handleOpenAgentSettings}>
              Manage agents
            </Button>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Users size={theme.iconSize.md} color={theme.colors.foreground} />
            <Text style={styles.cardTitle}>Active teams</Text>
          </View>
          {teams.length === 0 ? (
            <Text style={styles.emptyText}>
              No teams yet. Teams appear here when a Leader spawns Teammate agents.
            </Text>
          ) : (
            teams.map((team) => (
              <View key={team.leader.id} style={styles.teamGroup}>
                <AgentRow agent={team.leader} role="leader" onPress={handleOpenAgent} />
                {team.teammates.map((teammate) => (
                  <AgentRow
                    key={teammate.id}
                    agent={teammate}
                    role="teammate"
                    onPress={handleOpenAgent}
                  />
                ))}
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Settings2 size={theme.iconSize.md} color={theme.colors.foreground} />
            <Text style={styles.cardTitle}>Agent configuration</Text>
          </View>
          <Text style={styles.cardSubtitle}>
            Tool injection, system prompt, and provider setup for agents on this host.
          </Text>
          <View style={styles.settingsLinks}>
            <Button variant="secondary" size="sm" onPress={handleOpenAgentSettings}>
              Agent settings
            </Button>
            <Button variant="secondary" size="sm" onPress={handleOpenProviderSettings}>
              Providers
            </Button>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  cardSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  projectChips: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  projectChip: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  projectChipSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  projectChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  projectChipTextSelected: {
    color: theme.colors.foreground,
  },
  goalInput: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
    textAlignVertical: "top",
  },
  launchRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  teamGroup: {
    gap: theme.spacing[1],
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  teammateRow: {
    marginLeft: theme.spacing[6],
  },
  agentRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  agentTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  agentMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  statusDotRunning: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusDotAttention: {
    backgroundColor: theme.colors.statusDanger,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  settingsLinks: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  rosterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rosterInfo: {
    flex: 1,
    gap: 2,
  },
  rosterName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rosterNameDisabled: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
