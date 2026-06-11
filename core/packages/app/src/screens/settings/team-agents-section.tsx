import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Bot, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react-native";
import type { TeamAgent } from "@getrocky/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

interface TeamAgentDraft {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  thinkingOptionId: string;
  approvalPolicy: string;
  systemPrompt: string;
  enabled: boolean;
}

function emptyDraft(defaultProvider: string): TeamAgentDraft {
  return {
    id: "",
    name: "",
    role: "",
    provider: defaultProvider,
    model: "",
    thinkingOptionId: "",
    approvalPolicy: "",
    systemPrompt: "",
    enabled: true,
  };
}

function draftFromAgent(agent: TeamAgent): TeamAgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? "",
    provider: agent.provider,
    model: agent.model ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    approvalPolicy: typeof agent.approvalPolicy === "string" ? agent.approvalPolicy : "",
    systemPrompt: agent.systemPrompt ?? "",
    enabled: agent.enabled !== false,
  };
}

export function draftToAgent(draft: TeamAgentDraft): TeamAgent {
  return {
    id: draft.id || `tagent_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: draft.name.trim(),
    role: draft.role.trim(),
    provider: draft.provider,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.thinkingOptionId.trim() ? { thinkingOptionId: draft.thinkingOptionId.trim() } : {}),
    ...(draft.approvalPolicy.trim() ? { approvalPolicy: draft.approvalPolicy.trim() } : {}),
    ...(draft.systemPrompt.trim() ? { systemPrompt: draft.systemPrompt.trim() } : {}),
    enabled: draft.enabled,
  };
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function SelectField({
  label,
  triggerLabel,
  options,
  value,
  onSelect,
  searchable = true,
  testID,
}: {
  label: string;
  triggerLabel: string;
  options: ComboboxOption[];
  value: string;
  onSelect: (id: string) => void;
  searchable?: boolean;
  testID: string;
}) {
  const { theme } = useUnistyles();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setIsOpen(false);
    },
    [onSelect],
  );
  const triggerStyle = useMemo(
    () => [styles.selectTrigger, { borderColor: theme.colors.border }],
    [theme.colors.border],
  );
  return (
    <FormField label={label}>
      <Pressable
        ref={triggerRef}
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={testID}
      >
        <Text style={styles.selectTriggerLabel} numberOfLines={1}>
          {triggerLabel}
        </Text>
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>
      <Combobox
        title={label}
        options={options}
        value={value}
        onSelect={handleSelect}
        searchable={searchable}
        desktopMinWidth={280}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={triggerRef}
      />
    </FormField>
  );
}

function TeamAgentEditorSheet({
  initialDraft,
  serverId,
  isSaving,
  onSave,
  onClose,
}: {
  initialDraft: TeamAgentDraft;
  serverId: string;
  isSaving: boolean;
  onSave: (draft: TeamAgentDraft) => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState(initialDraft);
  const { entries } = useProvidersSnapshot(serverId);
  const header = useMemo<SheetHeader>(
    () => ({ title: initialDraft.id ? "Edit agent" : "Register agent" }),
    [initialDraft.id],
  );

  const providerOptions = useMemo<ComboboxOption[]>(() => {
    const ready = (entries ?? []).filter(
      (entry) => entry.enabled && entry.status !== "unavailable",
    );
    return ready.map((entry) => ({
      id: entry.provider,
      label: entry.label ?? entry.provider,
      description:
        entry.models && entry.models.length > 0 ? `${entry.models.length} models` : undefined,
    }));
  }, [entries]);

  const selectedEntry = useMemo(
    () => (entries ?? []).find((entry) => entry.provider === draft.provider),
    [draft.provider, entries],
  );

  const modelOptions = useMemo<ComboboxOption[]>(() => {
    const models = selectedEntry?.models ?? [];
    return [
      { id: "", label: "Provider default" },
      ...models.map((model) => ({ id: model.id, label: model.label, description: model.id })),
    ];
  }, [selectedEntry]);

  const selectedModel = useMemo(
    () => (selectedEntry?.models ?? []).find((model) => model.id === draft.model),
    [draft.model, selectedEntry],
  );

  const thinkingOptions = useMemo<ComboboxOption[]>(() => {
    const options = selectedModel?.thinkingOptions ?? [];
    return [
      { id: "", label: "Model default" },
      ...options.map((option) => ({ id: option.id, label: option.label ?? option.id })),
    ];
  }, [selectedModel]);

  const modeOptions = useMemo<ComboboxOption[]>(() => {
    const modes = selectedEntry?.modes ?? [];
    return [
      { id: "", label: "Provider default" },
      ...modes.map((mode) => ({ id: mode.id, label: mode.label, description: mode.description })),
    ];
  }, [selectedEntry]);

  const providerLabel =
    providerOptions.find((option) => option.id === draft.provider)?.label ||
    draft.provider ||
    "Select provider";
  const modelLabel = modelOptions.find((option) => option.id === draft.model)?.label ?? draft.model;
  const thinkingLabel =
    thinkingOptions.find((option) => option.id === draft.thinkingOptionId)?.label ??
    draft.thinkingOptionId;
  const approvalPolicyLabel =
    modeOptions.find((option) => option.id === draft.approvalPolicy)?.label ?? draft.approvalPolicy;

  const handleSelectProvider = useCallback((id: string) => {
    setDraft((prev) => ({
      ...prev,
      provider: id,
      model: "",
      thinkingOptionId: "",
      approvalPolicy: "",
    }));
  }, []);
  const handleSelectModel = useCallback((id: string) => {
    setDraft((prev) => ({ ...prev, model: id, thinkingOptionId: "" }));
  }, []);
  const handleSelectThinking = useCallback((id: string) => {
    setDraft((prev) => ({ ...prev, thinkingOptionId: id }));
  }, []);
  const handleSelectApprovalPolicy = useCallback((id: string) => {
    setDraft((prev) => ({ ...prev, approvalPolicy: id }));
  }, []);
  const handleSetName = useCallback((name: string) => setDraft((prev) => ({ ...prev, name })), []);
  const handleSetRole = useCallback((role: string) => setDraft((prev) => ({ ...prev, role })), []);
  const handleSetPrompt = useCallback(
    (systemPrompt: string) => setDraft((prev) => ({ ...prev, systemPrompt })),
    [],
  );
  const handleSave = useCallback(() => onSave(draft), [draft, onSave]);

  const canSave = draft.name.trim().length > 0 && draft.provider.trim().length > 0;
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground, borderColor: theme.colors.border }],
    [theme.colors.border, theme.colors.foreground],
  );
  const textAreaStyle = useMemo(() => [...inputStyle, styles.textArea], [inputStyle]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="team-agent-editor-sheet"
      desktopMaxWidth={560}
    >
      <View style={styles.form}>
        <FormField label="Name">
          <TextInput
            style={inputStyle}
            value={draft.name}
            onChangeText={handleSetName}
            placeholder="Backend reviewer"
            placeholderTextColor={theme.colors.foregroundMuted}
            testID="team-agent-name-input"
          />
        </FormField>
        <FormField label="Role">
          <TextInput
            style={inputStyle}
            value={draft.role}
            onChangeText={handleSetRole}
            placeholder="Reviews server code and writes tests"
            placeholderTextColor={theme.colors.foregroundMuted}
            testID="team-agent-role-input"
          />
        </FormField>
        <SelectField
          label="Provider"
          triggerLabel={providerLabel}
          options={providerOptions}
          value={draft.provider}
          onSelect={handleSelectProvider}
          testID="team-agent-provider-trigger"
        />
        <SelectField
          label="Model"
          triggerLabel={modelLabel || "Provider default"}
          options={modelOptions}
          value={draft.model}
          onSelect={handleSelectModel}
          testID="team-agent-model-trigger"
        />
        <SelectField
          label="Thinking"
          triggerLabel={thinkingLabel || "Model default"}
          options={thinkingOptions}
          value={draft.thinkingOptionId}
          onSelect={handleSelectThinking}
          searchable={false}
          testID="team-agent-thinking-trigger"
        />
        <SelectField
          label="Execution mode"
          triggerLabel={approvalPolicyLabel || "Provider default"}
          options={modeOptions}
          value={draft.approvalPolicy}
          onSelect={handleSelectApprovalPolicy}
          searchable={false}
          testID="team-agent-approval-policy-trigger"
        />
        <FormField label="System prompt">
          <TextInput
            style={textAreaStyle}
            value={draft.systemPrompt}
            onChangeText={handleSetPrompt}
            placeholder="Persona, constraints, and working rules for this agent."
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            testID="team-agent-prompt-input"
          />
        </FormField>
        <View style={styles.formActions}>
          <Button variant="ghost" size="sm" onPress={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onPress={handleSave}
            disabled={!canSave || isSaving}
            testID="team-agent-save"
          >
            {isSaving ? "Saving..." : "Save agent"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

interface TeamAgentRowProps {
  agent: TeamAgent;
  onToggleEnabled: (agent: TeamAgent, enabled: boolean) => void;
  onEdit: (agent: TeamAgent) => void;
  onRemove: (agent: TeamAgent) => void;
}

function TeamAgentRow({ agent, onToggleEnabled, onEdit, onRemove }: TeamAgentRowProps) {
  const { theme } = useUnistyles();
  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      onToggleEnabled(agent, enabled);
    },
    [agent, onToggleEnabled],
  );
  const handleEdit = useCallback(() => {
    onEdit(agent);
  }, [agent, onEdit]);
  const handleRemove = useCallback(() => {
    onRemove(agent);
  }, [agent, onRemove]);

  return (
    <View key={agent.id} style={styles.agentRow} testID={`team-agent-row-${agent.id}`}>
      <Bot size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <View style={styles.agentInfo}>
        <Text style={styles.agentName} numberOfLines={1}>
          {agent.name}
        </Text>
        <Text style={styles.agentMeta} numberOfLines={1}>
          {[agent.role, agent.provider, agent.model, agent.approvalPolicy]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Switch
        value={agent.enabled !== false}
        onValueChange={handleToggleEnabled}
        accessibilityLabel={`Enable ${agent.name}`}
      />
      <Button variant="ghost" size="xs" onPress={handleEdit} testID={`team-agent-edit-${agent.id}`}>
        <Pencil size={14} color={theme.colors.foregroundMuted} />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleRemove}
        testID={`team-agent-remove-${agent.id}`}
      >
        <Trash2 size={14} color={theme.colors.foregroundMuted} />
      </Button>
    </View>
  );
}

export function TeamAgentsSection({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editorDraft, setEditorDraft] = useState<TeamAgentDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const agents = useMemo(() => config?.teamAgents ?? [], [config?.teamAgents]);

  const persistAgents = useCallback(
    async (next: TeamAgent[]) => {
      setIsSaving(true);
      try {
        await patchConfig({ teamAgents: next });
      } catch (error) {
        console.error("[TeamAgents] Failed to save team agents", error);
        Alert.alert(
          "Unable to save agents",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig],
  );

  const handleAdd = useCallback(() => setEditorDraft(emptyDraft("amaze")), []);
  const handleCloseEditor = useCallback(() => setEditorDraft(null), []);

  const handleSaveDraft = useCallback(
    async (draft: TeamAgentDraft) => {
      const agent = draftToAgent(draft);
      const next = draft.id
        ? agents.map((existing) => (existing.id === draft.id ? agent : existing))
        : [...agents, agent];
      await persistAgents(next);
      setEditorDraft(null);
    },
    [agents, persistAgents],
  );

  const handleEdit = useCallback((agent: TeamAgent) => {
    setEditorDraft(draftFromAgent(agent));
  }, []);

  const handleToggleEnabled = useCallback(
    (agent: TeamAgent, enabled: boolean) => {
      void persistAgents(
        agents.map((existing) => (existing.id === agent.id ? { ...existing, enabled } : existing)),
      );
    },
    [agents, persistAgents],
  );

  const handleRemove = useCallback(
    (agent: TeamAgent) => {
      void persistAgents(agents.filter((existing) => existing.id !== agent.id));
    },
    [agents, persistAgents],
  );

  if (!isConnected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="team-agents-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Team agents</Text>
            <Text style={settingsStyles.rowHint}>
              Named agent presets — role, provider, model, and system prompt — used by Team missions
              and quick launches
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Plus}
            onPress={handleAdd}
            testID="team-agents-add"
          >
            Register
          </Button>
        </View>
        {agents.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>
              No registered agents yet. Register an agent to reuse it in Team missions.
            </Text>
          </View>
        ) : (
          agents.map((agent) => (
            <TeamAgentRow
              key={agent.id}
              agent={agent}
              onToggleEnabled={handleToggleEnabled}
              onEdit={handleEdit}
              onRemove={handleRemove}
            />
          ))
        )}
      </View>

      {editorDraft ? (
        <TeamAgentEditorSheet
          initialDraft={editorDraft}
          serverId={serverId}
          isSaving={isSaving}
          onSave={handleSaveDraft}
          onClose={handleCloseEditor}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyRow: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  agentInfo: {
    flex: 1,
    gap: 2,
  },
  agentName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  agentMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  form: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
  },
  textArea: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  selectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  selectTriggerLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
