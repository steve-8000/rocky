import type {
  AgentSnapshotPayload,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProjectPlacementPayload,
  RefreshProvidersSnapshotResponseMessage,
  SendAgentMessageRequest,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from "@getrocky/protocol/messages";
import { DaemonClient } from "./daemon-client.js";
import type {
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  FetchAgentTimelineProjection,
} from "./daemon-client.js";

export { DaemonClient };
export type {
  DaemonClientConfig,
  DaemonEvent,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client.js";

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface RockyLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface RockyClientConfig {
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: RockyLogger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type RockyWorkspace = WorkspaceDescriptorPayload;
export type RockyAgent = AgentSnapshotPayload;
export type RockyWorkspaceListOptions = Omit<
  FetchWorkspacesRequestMessage,
  "type" | "requestId"
> & {
  requestId?: string;
};

export interface RockyWorkspaceListResult {
  requestId: string;
  subscriptionId?: string | null;
  entries: RockyWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface RockyWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export interface RockyWorkspaceOpenResult {
  requestId: string;
  workspace: RockyWorkspaceHandle | null;
  error: string | null;
}

export interface RockyWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type RockyWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type RockyWorkspaceUpdateHandler = (update: RockyWorkspaceUpdate) => void;

/**
 * A handle is a stable typed reference to a daemon resource. Its identity is the
 * daemon id, and `latest()` only returns the most recent snapshot this handle has
 * seen through construction, `refetch()`, or this handle's local subscription.
 */
export interface RockyWorkspaceHandle {
  readonly id: string;
  latest(): RockyWorkspace | null;
  /**
   * Fetches a fresh workspace snapshot through the existing workspace list RPC,
   * exact-matches this handle id from the result, and updates `latest()`.
   */
  refetch(options?: { requestId?: string }): Promise<RockyWorkspace | null>;
  archive(requestId?: string): Promise<RockyWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: RockyWorkspaceUpdate) => void): () => void;
}

export interface RockyWorkspaceActions {
  list(options?: RockyWorkspaceListOptions): Promise<RockyWorkspaceListResult>;
  ref(workspace: string | RockyWorkspace): RockyWorkspaceHandle;
  open(
    input: string | RockyWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<RockyWorkspaceOpenResult>;
  create(
    input: string | RockyWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<RockyWorkspaceOpenResult>;
  archive(
    workspace: string | RockyWorkspaceHandle,
    requestId?: string,
  ): Promise<RockyWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: RockyWorkspaceUpdateHandler): () => void;
}

type RockyAgentSessionConfig = CreateAgentRequestMessage["config"];
type RockyAgentProvider = RockyAgentSessionConfig["provider"];
type RockyAgentConfigOverrides = Partial<Omit<RockyAgentSessionConfig, "provider" | "cwd">>;

export interface RockyAgentCreateOptions extends RockyAgentConfigOverrides {
  config?: RockyAgentSessionConfig;
  provider?: CreateAgentRequestMessage["config"]["provider"];
  cwd?: string;
  workspaceId?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  worktreeName?: string;
  requestId?: string;
  labels?: Record<string, string>;
}

export interface RockyAgentRefetchResult {
  agent: RockyAgent;
  project: ProjectPlacementPayload | null;
}

export interface RockyAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  requestId?: string;
}

export interface RockyAgentSendOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: SendAgentMessageRequest["attachments"];
}

export type RockyAgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

export type RockyAgentStream = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export type RockyAgentUpdateHandler = (update: RockyAgentUpdate) => void;

export interface RockyAgentTimelineHandle {
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle's `latest()`
   * is updated to that snapshot.
   */
  refetch(options?: RockyAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Local listener for agent_stream events matching this handle id. It does not
   * retain timeline entries or own application cache state.
   */
  subscribe(handler: (event: RockyAgentStream) => void): () => void;
}

/**
 * Agent handles follow the same identity/snapshot rule as workspace handles:
 * `id` is stable, while `latest()` is only the newest snapshot observed by this
 * handle through construction, `refetch()`, timeline refetch, archive, or local
 * agent_update subscription.
 */
export interface RockyAgentHandle {
  readonly id: string;
  readonly timeline: RockyAgentTimelineHandle;
  latest(): RockyAgent | null;
  refetch(requestId?: string): Promise<RockyAgentRefetchResult | null>;
  send(text: string, options?: RockyAgentSendOptions): Promise<void>;
  archive(): Promise<{ archivedAt: string }>;
  subscribe(handler: (update: RockyAgentUpdate) => void): () => void;
}

export interface RockyAgentActions {
  ref(agent: string | RockyAgent): RockyAgentHandle;
  create(options: RockyAgentCreateOptions): Promise<RockyAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: RockyAgentUpdateHandler): () => void;
}

export interface RockyProviderConfig extends RockyProviderConfigInput {
  provider: RockyAgentProvider;
}
export type RockyProviderFeatureValues = Record<string, unknown>;

export interface RockyProviderConfigInput {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: RockyProviderFeatureValues;
}

export type RockyProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type RockyProviderModesResult = ListProviderModesResponseMessage["payload"];
export type RockyProviderFeaturesInput = ListProviderFeaturesRequestMessage["draftConfig"];
export type RockyProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type RockyProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type RockyProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type RockyProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type RockyProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type RockyProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];

export interface RockyProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface RockyProviderRefreshOptions {
  cwd?: string;
  providers?: RockyAgentProvider[];
  requestId?: string;
}

export interface RockyProviderActions {
  codex(input?: RockyProviderConfigInput): RockyProviderConfig;
  claude(input?: RockyProviderConfigInput): RockyProviderConfig;
  opencode(input?: RockyProviderConfigInput): RockyProviderConfig;
  copilot(input?: RockyProviderConfigInput): RockyProviderConfig;
  config(provider: RockyAgentProvider, input?: RockyProviderConfigInput): RockyProviderConfig;
  listModels(
    provider: RockyAgentProvider,
    options?: RockyProviderListOptions,
  ): Promise<RockyProviderModelsResult>;
  listModes(
    provider: RockyAgentProvider,
    options?: RockyProviderListOptions,
  ): Promise<RockyProviderModesResult>;
  listFeatures(
    draftConfig: RockyProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<RockyProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<RockyProviderAvailabilityResult>;
  snapshot(options?: RockyProviderListOptions): Promise<RockyProviderSnapshotResult>;
  refresh(options?: RockyProviderRefreshOptions): Promise<RockyProviderRefreshResult>;
  diagnostic(
    provider: RockyAgentProvider,
    options?: { requestId?: string },
  ): Promise<RockyProviderDiagnosticResult>;
  subscribe(handler: (update: RockyProviderSnapshotUpdate) => void): () => void;
}

export interface RockyConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

export interface RockyClient {
  readonly workspaces: RockyWorkspaceActions;
  readonly agents: RockyAgentActions;
  readonly providers: RockyProviderActions;
  readonly config: RockyConfigActions;
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

export function createRockyClient(config: RockyClientConfig): RockyClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });
  const createWorkspaceHandle = createWorkspaceHandleFactory(daemonClient);
  const createAgentHandle = createAgentHandleFactory(daemonClient);

  return {
    workspaces: {
      list: (options) => daemonClient.fetchWorkspaces(options),
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          handler(message.payload);
        }),
    },
    agents: {
      ref: (agent) => createAgentHandle(agent),
      create: async (options) => {
        const agent = await daemonClient.createAgent(options);
        return createAgentHandle(agent);
      },
      subscribe: (handler) =>
        daemonClient.on("agent_update", (message) => {
          handler(message.payload);
        }),
    },
    providers: {
      codex: (input) => providerConfig("codex", input),
      claude: (input) => providerConfig("claude", input),
      opencode: (input) => providerConfig("opencode", input),
      copilot: (input) => providerConfig("copilot", input),
      config: (provider, input) => providerConfig(provider, input),
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: (draftConfig, options) =>
        daemonClient.listProviderFeatures(draftConfig, options),
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      subscribe: (handler) =>
        daemonClient.on("providers_snapshot_update", (message) => {
          handler(message.payload);
        }),
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
    connect: () => daemonClient.connect(),
    close: () => daemonClient.close(),
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

type WorkspaceHandleFactory = (workspace: string | RockyWorkspace) => RockyWorkspaceHandle;
type AgentHandleFactory = (agent: string | RockyAgent) => RockyAgentHandle;

function createWorkspaceHandleFactory(daemonClient: DaemonClient): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let latest = typeof workspace === "string" ? null : workspace;

    return {
      id,
      latest: () => latest,
      refetch: async (options) => {
        const result = await daemonClient.fetchWorkspaces({
          requestId: options?.requestId,
          filter: { idPrefix: id },
          page: { limit: 25 },
        });
        latest = result.entries.find((entry) => entry.id === id) ?? null;
        return latest;
      },
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (latest) {
          latest = { ...latest, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.workspace.id === id) {
            latest = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            latest = null;
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(daemonClient: DaemonClient): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let latest = typeof agent === "string" ? null : agent;

    const handle: RockyAgentHandle = {
      id,
      timeline: {
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            latest = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          daemonClient.on("agent_stream", (message) => {
            if (message.payload.agentId === id) {
              handler(message.payload);
            }
          }),
      },
      latest: () => latest,
      refetch: async (requestId) => {
        const result = await daemonClient.fetchAgent(id, requestId);
        latest = result?.agent ?? null;
        return result;
      },
      send: (text, options) => daemonClient.sendAgentMessage(id, text, options),
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (latest) {
          latest = { ...latest, archivedAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        daemonClient.on("agent_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.agent.id === id) {
            latest = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            latest = null;
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | RockyWorkspaceOpenOptions,
  requestId?: string,
): Promise<RockyWorkspaceOpenResult> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  return {
    ...result,
    workspace: result.workspace ? createWorkspaceHandle(result.workspace) : null,
  };
}

function resolveWorkspaceId(workspace: string | RockyWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function providerConfig(
  provider: RockyAgentProvider,
  input: RockyProviderConfigInput = {},
): RockyProviderConfig {
  return {
    provider,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
    ...(input.thinkingOptionId !== undefined ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues !== undefined ? { featureValues: input.featureValues } : {}),
  };
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `rocky-sdk-${randomId}`;
}
