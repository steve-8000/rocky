import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getrocky/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";
import { resolveWorkspaceScriptLink } from "./workspace-script-links";

const runningService: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web--feature--rocky.localhost",
  port: 3000,
  localProxyUrl: "http://web--feature--rocky.localhost:7767",
  publicProxyUrl: null,
  proxyUrl: "http://web--feature--rocky.localhost:7767",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

function resolveLink(activeConnection: ActiveConnection | null) {
  return resolveWorkspaceScriptLink({
    script: runningService,
    activeConnection,
  });
}

describe("resolveWorkspaceScriptLink", () => {
  it("uses the local proxy URL for loopback TCP connections", () => {
    expect(
      resolveLink({ type: "directTcp", endpoint: "localhost:7767", display: "localhost:7767" }),
    ).toEqual({
      openUrl: "http://web--feature--rocky.localhost:7767",
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("uses the local proxy URL for socket and pipe connections", () => {
    expect(
      resolveLink({ type: "directSocket", endpoint: "/tmp/rocky.sock", display: "socket" }),
    ).toEqual({
      openUrl: "http://web--feature--rocky.localhost:7767",
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("degrades to daemon-host plus service port for direct network connections", () => {
    expect(
      resolveLink({
        type: "directTcp",
        endpoint: "mac-mini.tail123.ts.net:7767",
        display: "mac-mini.tail123.ts.net:7767",
      }),
    ).toEqual({
      openUrl: "http://mac-mini.tail123.ts.net:3000",
      labelUrl: "http://mac-mini.tail123.ts.net:3000",
    });
  });

  it("shows the local proxy URL but disables opening over relay", () => {
    expect(
      resolveLink({ type: "relay", endpoint: "relay.invalid:443", display: "relay" }),
    ).toEqual({
      openUrl: null,
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("opens the public URL over relay when one is provided", () => {
    expect(
      resolveWorkspaceScriptLink({
        script: {
          ...runningService,
          publicProxyUrl: "https://web--feature--rocky.services.example.com",
          proxyUrl: "https://web--feature--rocky.services.example.com",
        },
        activeConnection: { type: "relay", endpoint: "relay.invalid:443", display: "relay" },
      }),
    ).toEqual({
      openUrl: "https://web--feature--rocky.services.example.com",
      labelUrl: "https://web--feature--rocky.services.example.com",
    });
  });

  it("uses local URL for direct loopback even when public URL exists", () => {
    expect(
      resolveWorkspaceScriptLink({
        script: {
          ...runningService,
          publicProxyUrl: "https://web--feature--rocky.services.example.com",
          proxyUrl: "https://web--feature--rocky.services.example.com",
        },
        activeConnection: { type: "directTcp", endpoint: "127.0.0.1:7767", display: "localhost" },
      }),
    ).toEqual({
      openUrl: "http://web--feature--rocky.localhost:7767",
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("uses local URL for direct socket and pipe even when public URL exists", () => {
    expect(
      resolveWorkspaceScriptLink({
        script: {
          ...runningService,
          publicProxyUrl: "https://web--feature--rocky.services.example.com",
          proxyUrl: "https://web--feature--rocky.services.example.com",
        },
        activeConnection: { type: "directPipe", endpoint: "rocky", display: "pipe" },
      }),
    ).toEqual({
      openUrl: "http://web--feature--rocky.localhost:7767",
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("uses public URL for direct remote TCP when split URLs exist", () => {
    expect(
      resolveWorkspaceScriptLink({
        script: {
          ...runningService,
          publicProxyUrl: "https://web--feature--rocky.services.example.com",
          proxyUrl: "https://web--feature--rocky.services.example.com",
        },
        activeConnection: {
          type: "directTcp",
          endpoint: "mac-mini.tail123.ts.net:7767",
          display: "remote",
        },
      }),
    ).toEqual({
      openUrl: "https://web--feature--rocky.services.example.com",
      labelUrl: "https://web--feature--rocky.services.example.com",
    });
  });

  it("keeps old daemon local-only proxyUrl payloads working", () => {
    const {
      localProxyUrl: _localProxyUrl,
      publicProxyUrl: _publicProxyUrl,
      ...oldPayload
    } = runningService;

    expect(
      resolveWorkspaceScriptLink({
        script: oldPayload,
        activeConnection: { type: "directTcp", endpoint: "localhost:7767", display: "localhost" },
      }),
    ).toEqual({
      openUrl: "http://web--feature--rocky.localhost:7767",
      labelUrl: "http://web--feature--rocky.localhost:7767",
    });
  });

  it("keeps old daemon public proxyUrl payloads working over relay", () => {
    const {
      localProxyUrl: _localProxyUrl,
      publicProxyUrl: _publicProxyUrl,
      ...oldPayload
    } = {
      ...runningService,
      proxyUrl: "https://web--feature--rocky.services.example.com",
    };

    expect(
      resolveWorkspaceScriptLink({
        script: oldPayload,
        activeConnection: { type: "relay", endpoint: "relay.invalid:443", display: "relay" },
      }),
    ).toEqual({
      openUrl: "https://web--feature--rocky.services.example.com",
      labelUrl: "https://web--feature--rocky.services.example.com",
    });
  });
});
