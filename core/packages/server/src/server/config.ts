import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRockyNodeEnv } from "./rocky-env.js";
import { z } from "zod";
import { expandTilde } from "../utils/path.js";

import type { RockyDaemonConfig } from "./bootstrap.js";
import {
  loadPersistedConfig,
  LogFormatSchema,
  LogLevelSchema,
  type PersistedConfig,
} from "./persisted-config.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { AgentProviderSchema } from "@getrocky/protocol/provider-manifest";
import type { TeamAgent } from "@getrocky/protocol/messages";
import { hashDaemonPassword } from "./auth.js";
import { resolveSpeechConfig } from "./speech/speech-config-resolver.js";
import { mergeHostnames, parseHostnamesEnv, type HostnamesConfig } from "./hostnames.js";

const DEFAULT_PORT = 7767;
const DEFAULT_RELAY_ENDPOINT = "relay.invalid:443";
const DEFAULT_APP_BASE_URL = "https://rocky.clab.one";
const WEB_UI_ENV_KEYS = ["ROCKY_WEB_UI_DIR", "WEB_UI_DIST"] as const;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizeLogEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.trim().toLowerCase();
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  relayUseTls: boolean;
  mcpEnabled: boolean;
  mcpInjectIntoAgents: boolean;
  hostnames: HostnamesConfig;
}>;

function resolveLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): PersistedConfig["log"] {
  const envLogLevel = LogLevelSchema.safeParse(normalizeLogEnv(env.ROCKY_LOG_LEVEL));
  const envLogFormat = LogFormatSchema.safeParse(normalizeLogEnv(env.ROCKY_LOG_FORMAT));

  if (!envLogLevel.success && !envLogFormat.success) {
    return persisted.log;
  }

  return {
    ...persisted.log,
    ...(envLogLevel.success ? { level: envLogLevel.data } : {}),
    ...(envLogFormat.success ? { format: envLogFormat.data } : {}),
  };
}

const OptionalVoiceLlmProviderSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  )
  .pipe(z.union([AgentProviderSchema, z.null()]));

function parseOptionalVoiceLlmProvider(value: unknown): AgentProvider | null {
  const parsed = OptionalVoiceLlmProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractProviderOverrides(
  providers: Record<string, unknown> | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!providers) {
    return undefined;
  }

  const providerOverrides = Object.entries(providers).flatMap(([providerId, provider]) => {
    const parsed = ProviderOverrideSchema.safeParse(provider);
    return parsed.success ? [[providerId, parsed.data] as const] : [];
  });

  return providerOverrides.length > 0 ? Object.fromEntries(providerOverrides) : undefined;
}

function extractAgentProviderSettings(
  providerOverrides: Record<string, ProviderOverride> | undefined,
): AgentProviderRuntimeSettingsMap | undefined {
  if (!providerOverrides) {
    return undefined;
  }

  const runtimeSettings = Object.entries(providerOverrides).flatMap(([providerId, provider]) => {
    const parsedProviderId = AgentProviderSchema.safeParse(providerId);
    if (!parsedProviderId.success || (!provider.command && !provider.env)) {
      return [];
    }

    return [
      [
        parsedProviderId.data,
        {
          command: provider.command
            ? {
                mode: "replace" as const,
                argv: provider.command,
              }
            : undefined,
          env: provider.env,
        },
      ] as const,
    ];
  });

  return runtimeSettings.length > 0
    ? (Object.fromEntries(runtimeSettings) as AgentProviderRuntimeSettingsMap)
    : undefined;
}

interface ResolveRelayInput {
  env: NodeJS.ProcessEnv;
  persisted: ReturnType<typeof loadPersistedConfig>;
  cliRelayEnabled: boolean | undefined;
  cliRelayUseTls: boolean | undefined;
}

interface ResolvedRelay {
  enabled: boolean;
  endpoint: string;
  publicEndpoint: string;
  useTls: boolean;
  publicUseTls: boolean;
}

interface ResolvedServiceProxy {
  publicBaseUrl: string | null;
  standaloneListen: string | null;
}

function resolveTlsFromEnv(
  envValue: string | undefined,
  persistedValue: boolean | undefined,
  fallback: boolean,
): boolean {
  if (envValue !== undefined) {
    return parseBooleanEnv(envValue) ?? false;
  }
  return persistedValue ?? fallback;
}

function resolveRelayConfig(input: ResolveRelayInput): ResolvedRelay {
  // Rocky is self-contained: no hosted relay exists, so relay is opt-in.
  const enabled =
    input.cliRelayEnabled ??
    parseBooleanEnv(input.env.ROCKY_RELAY_ENABLED) ??
    input.persisted.daemon?.relay?.enabled ??
    false;
  const endpoint =
    input.env.ROCKY_RELAY_ENDPOINT ??
    input.persisted.daemon?.relay?.endpoint ??
    DEFAULT_RELAY_ENDPOINT;
  const publicEndpoint =
    input.env.ROCKY_RELAY_PUBLIC_ENDPOINT ??
    input.persisted.daemon?.relay?.publicEndpoint ??
    endpoint;
  const useTls =
    input.cliRelayUseTls ??
    resolveTlsFromEnv(
      input.env.ROCKY_RELAY_USE_TLS,
      input.persisted.daemon?.relay?.useTls,
      endpoint === DEFAULT_RELAY_ENDPOINT,
    );
  const publicUseTls = resolveTlsFromEnv(
    input.env.ROCKY_RELAY_PUBLIC_USE_TLS,
    input.persisted.daemon?.relay?.publicUseTls,
    useTls,
  );
  return { enabled, endpoint, publicEndpoint, useTls, publicUseTls };
}

interface ResolvedVoiceLlm {
  provider: AgentProvider | null;
  providerExplicit: boolean;
  model: string | null;
}

function resolveServiceProxyPublicBaseUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid ROCKY_SERVICE_PROXY_PUBLIC_BASE_URL: ${value}`);
  }
}

function resolveServiceProxyConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedServiceProxy {
  const enabledShim =
    parseBooleanEnv(env.ROCKY_SERVICE_PROXY_ENABLED) ?? persisted.daemon?.serviceProxy?.enabled;
  // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
  // `enabled=false` used to disable the separate service proxy listener. Localhost
  // service proxying is now always enabled; this only suppresses optional layers.
  const optionalLayersEnabled = enabledShim !== false;
  const publicBaseUrl = optionalLayersEnabled
    ? resolveServiceProxyPublicBaseUrl(
        env.ROCKY_SERVICE_PROXY_PUBLIC_BASE_URL ??
          persisted.daemon?.serviceProxy?.publicBaseUrl ??
          null,
      )
    : null;
  const standaloneListen = optionalLayersEnabled
    ? (env.ROCKY_SERVICE_PROXY_LISTEN ?? persisted.daemon?.serviceProxy?.listen ?? null)
    : null;

  return { publicBaseUrl, standaloneListen };
}

function resolveVoiceLlmConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedVoiceLlm {
  const envVoiceLlmProvider = parseOptionalVoiceLlmProvider(env.ROCKY_VOICE_LLM_PROVIDER);
  const persistedVoiceLlmProvider = parseOptionalVoiceLlmProvider(
    persisted.features?.voiceMode?.llm?.provider,
  );
  return {
    provider: envVoiceLlmProvider ?? persistedVoiceLlmProvider ?? null,
    providerExplicit: envVoiceLlmProvider !== null || persistedVoiceLlmProvider !== null,
    model: persisted.features?.voiceMode?.llm?.model ?? null,
  };
}

function resolveCorsAllowedOrigins(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string[] {
  const envCorsOrigins = env.ROCKY_CORS_ORIGINS
    ? env.ROCKY_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];
  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];
  return Array.from(
    new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0)),
  );
}

// ROCKY_LISTEN can be:
// - host:port (TCP)
// - /path/to/socket (Unix socket)
// - unix:///path/to/socket (Unix socket)
// Default is TCP at 127.0.0.1:7767
function resolveListenAddress(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string {
  return (
    cli?.listen ??
    env.ROCKY_LISTEN ??
    persisted.daemon?.listen ??
    `127.0.0.1:${env.PORT ?? DEFAULT_PORT}`
  );
}

function resolveAuthConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): RockyDaemonConfig["auth"] {
  const envPassword = env.ROCKY_PASSWORD?.trim();
  if (envPassword) {
    return { password: hashDaemonPassword(envPassword) };
  }
  return persisted.daemon?.auth?.password
    ? { password: persisted.daemon.auth.password }
    : undefined;
}

function resolveWorktreesRoot(
  rockyHome: string,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string | undefined {
  const configuredRoot = persisted.worktrees?.root?.trim();
  if (!configuredRoot) {
    return undefined;
  }

  const expandedRoot = expandTilde(configuredRoot);
  return path.isAbsolute(expandedRoot)
    ? path.resolve(expandedRoot)
    : path.resolve(rockyHome, expandedRoot);
}

function resolveAppendSystemPrompt(persisted: ReturnType<typeof loadPersistedConfig>): string {
  return persisted.daemon?.appendSystemPrompt ?? "";
}

function resolveTeamAgents(persisted: ReturnType<typeof loadPersistedConfig>): TeamAgent[] {
  const agents: TeamAgent[] = [];

  for (const agent of persisted.daemon?.teamAgents ?? []) {
    agents.push({
      ...agent,
      role: agent.role ?? "",
      approvalPolicy: agent.approvalPolicy?.trim() || undefined,
      enabled: agent.enabled ?? true,
    });
  }

  return agents;
}

function resolveStaticDir(rockyHome: string, env: NodeJS.ProcessEnv): string {
  const configuredStaticDir = env.ROCKY_STATIC_DIR?.trim();
  if (!configuredStaticDir) {
    return path.join(rockyHome, "public");
  }
  const expanded = expandTilde(configuredStaticDir);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(rockyHome, expanded);
}

function normalizeDirectoryPath(value: string): string {
  const expanded = expandTilde(value.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(expanded);
}

function resolveExplicitWebUiDir(env: NodeJS.ProcessEnv): string | null {
  for (const key of WEB_UI_ENV_KEYS) {
    const configured = env[key]?.trim();
    if (!configured) {
      continue;
    }
    const webUiDir = normalizeDirectoryPath(configured);
    const indexPath = path.join(webUiDir, "index.html");
    if (!existsSync(indexPath)) {
      throw new Error(`Rocky WebUI bundle missing at ${webUiDir}. Run: npm run build:webui`);
    }
    return webUiDir;
  }
  return null;
}

function resolveBundledWebUiDir(): string | undefined {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../../../app/dist"),
    path.resolve(currentDir, "../../../../app/dist"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
}

function resolveWebUiDir(env: NodeJS.ProcessEnv): string | undefined {
  return resolveExplicitWebUiDir(env) ?? resolveBundledWebUiDir();
}

function resolveStaticLoadConfigSettings(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
) {
  return {
    mcpEnabled: cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true,
    mcpInjectIntoAgents:
      cli?.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? false,
    autoArchiveAfterMerge: persisted.daemon?.autoArchiveAfterMerge ?? false,
    appendSystemPrompt: resolveAppendSystemPrompt(persisted),
    teamAgents: resolveTeamAgents(persisted),
    hostnames: mergeHostnames([
      persisted.daemon?.hostnames,
      parseHostnamesEnv(env.ROCKY_HOSTNAMES ?? env.ROCKY_ALLOWED_HOSTS),
      cli?.hostnames,
    ]),
    appBaseUrl: env.ROCKY_APP_BASE_URL ?? persisted.app?.baseUrl ?? DEFAULT_APP_BASE_URL,
  };
}

export function loadConfig(
  rockyHome: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
  },
): RockyDaemonConfig {
  const env = options?.env ?? process.env;
  const persisted = loadPersistedConfig(rockyHome);

  const listen = resolveListenAddress(env, options?.cli, persisted);
  const {
    mcpEnabled,
    mcpInjectIntoAgents,
    autoArchiveAfterMerge,
    appendSystemPrompt,
    teamAgents,
    hostnames,
    appBaseUrl,
  } = resolveStaticLoadConfigSettings(env, options?.cli, persisted);

  const relay = resolveRelayConfig({
    env,
    persisted,
    cliRelayEnabled: options?.cli?.relayEnabled,
    cliRelayUseTls: options?.cli?.relayUseTls,
  });
  const serviceProxy = resolveServiceProxyConfig(env, persisted);

  const { openai, speech } = resolveSpeechConfig({
    rockyHome,
    env,
    persisted,
  });

  const voiceLlm = resolveVoiceLlmConfig(env, persisted);
  const providerOverrides = extractProviderOverrides(
    persisted.agents?.providers as Record<string, unknown> | undefined,
  );

  return {
    listen,
    rockyHome,
    worktreesRoot: resolveWorktreesRoot(rockyHome, persisted),
    corsAllowedOrigins: resolveCorsAllowedOrigins(env, persisted),
    hostnames,
    mcpEnabled,
    mcpInjectIntoAgents,
    autoArchiveAfterMerge,
    appendSystemPrompt,
    teamAgents,
    mcpDebug: env.MCP_DEBUG === "1",
    isDev: resolveRockyNodeEnv(env) === "development",
    agentStoragePath: path.join(rockyHome, "agents"),
    staticDir: resolveStaticDir(rockyHome, env),
    webUiDir: resolveWebUiDir(env),
    agentClients: {},
    relayEnabled: relay.enabled,
    relayEndpoint: relay.endpoint,
    relayPublicEndpoint: relay.publicEndpoint,
    relayUseTls: relay.useTls,
    relayPublicUseTls: relay.publicUseTls,
    serviceProxy,
    appBaseUrl,
    auth: resolveAuthConfig(env, persisted),
    openai,
    speech,
    voiceLlmProvider: voiceLlm.provider,
    voiceLlmProviderExplicit: voiceLlm.providerExplicit,
    voiceLlmModel: voiceLlm.model,
    agentProviderSettings: extractAgentProviderSettings(providerOverrides),
    metadataGeneration: persisted.agents?.metadataGeneration,
    providerOverrides,
    log: resolveLogConfigFromEnv(env, persisted),
  };
}
