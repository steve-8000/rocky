import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  beforeEach(() => {
    mockState.superConstructorOptions.length = 0;
  });

  test("passes the custom command only as defaultCommand", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions[0]).toMatchObject({
      provider: "acp",
      logger: expect.any(Object),
      runtimeSettings: {
        env: {
          HERMES_LOG: "info",
        },
      },
      defaultCommand: ["hermes", "acp"],
      providerModeWriter: expect.any(Function),
      modesTransformer: expect.any(Function),
      isAutonomousPermissionMode: expect.any(Function),
    });
  });

  test("maps Rocky bypass aliases to autonomous permission mode", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["amaze", "acp"],
    });
    void _client;

    const options = mockState.superConstructorOptions[0] as {
      isAutonomousPermissionMode: (modeId: string | null | undefined) => boolean;
    };

    expect(options.isAutonomousPermissionMode("never")).toBe(true);
    expect(options.isAutonomousPermissionMode("bypass")).toBe(true);
    expect(options.isAutonomousPermissionMode("bypassPermissions")).toBe(true);
    expect(options.isAutonomousPermissionMode("full-access")).toBe(true);
    expect(options.isAutonomousPermissionMode("allow-all")).toBe(true);
    expect(options.isAutonomousPermissionMode("default")).toBe(false);
    expect(options.isAutonomousPermissionMode(null)).toBe(false);
  });

  test("handles Rocky autonomous mode without forwarding unsupported ACP mode", async () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["amaze", "acp"],
    });
    void _client;

    const options = mockState.superConstructorOptions[0] as {
      providerModeWriter: (context: {
        requestedModeId: string;
        currentModeId: string | null;
      }) => Promise<{ handled: boolean; currentModeId?: string | null }>;
    };

    await expect(
      options.providerModeWriter({ requestedModeId: "bypass", currentModeId: "default" }),
    ).resolves.toEqual({ handled: true });
    await expect(
      options.providerModeWriter({ requestedModeId: "default", currentModeId: "default" }),
    ).resolves.toEqual({ handled: false });
  });

  test("advertises a Rocky bypass mode when the agent does not expose one", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["amaze", "acp"],
    });
    void _client;

    const options = mockState.superConstructorOptions[0] as {
      modesTransformer: (
        modes: { id: string; label: string; isUnattended?: boolean }[],
      ) => { id: string; label: string; isUnattended?: boolean }[];
    };

    const agentModes = [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
    ];
    const transformed = options.modesTransformer(agentModes);
    expect(transformed.map((mode) => mode.id)).toEqual(["default", "plan", "bypass"]);
    expect(transformed.at(-1)).toMatchObject({ id: "bypass", isUnattended: true });
  });

  test("does not duplicate bypass when the agent already exposes an autonomous mode", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["amaze", "acp"],
    });
    void _client;

    const options = mockState.superConstructorOptions[0] as {
      modesTransformer: (modes: { id: string; label: string }[]) => { id: string }[];
    };

    const agentModes = [
      { id: "default", label: "Default" },
      { id: "full-access", label: "Full Access" },
    ];
    expect(options.modesTransformer(agentModes)).toBe(agentModes);
  });

  test("normalizes Rocky approval aliases to the advertised bypass mode at create time", () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["amaze", "acp"],
    });

    const availableModes = [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
      { id: "bypass", label: "Bypass", isUnattended: true },
    ];

    // Alias not in the advertised list -> normalized to "bypass".
    expect(
      client.resolveCreateConfig({
        provider: "acp",
        requestedMode: "never",
        featureValues: undefined,
        parent: null,
        unattended: true,
        availableModes,
      }).modeId,
    ).toBe("bypass");

    // Advertised mode ids pass through untouched.
    expect(
      client.resolveCreateConfig({
        provider: "acp",
        requestedMode: "plan",
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes,
      }).modeId,
    ).toBe("plan");

    // Unattended create without explicit mode picks the unattended mode.
    expect(
      client.resolveCreateConfig({
        provider: "acp",
        requestedMode: undefined,
        featureValues: undefined,
        parent: null,
        unattended: true,
        availableModes,
      }).modeId,
    ).toBe("bypass");
  });
});
