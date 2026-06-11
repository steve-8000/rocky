import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: mocks.connectToDaemon,
}));

import { isDaemonAuthProbeError, probeDaemonOverWebsocket } from "./status.js";

type ProbeState = Parameters<typeof probeDaemonOverWebsocket>[0]["state"];

function runningState(): ProbeState {
  return { running: true } as ProbeState;
}

describe("daemon status websocket probe", () => {
  beforeEach(() => {
    mocks.connectToDaemon.mockReset();
  });

  test("recognizes daemon auth failures", () => {
    expect(isDaemonAuthProbeError(new Error("Password required"))).toBe(true);
    expect(isDaemonAuthProbeError(new Error("Incorrect password"))).toBe(true);
    expect(isDaemonAuthProbeError(new Error("connect ECONNREFUSED 127.0.0.1:7767"))).toBe(false);
  });

  test("reports a password-protected running daemon as reachable", async () => {
    mocks.connectToDaemon.mockRejectedValueOnce(new Error("Password required"));

    await expect(
      probeDaemonOverWebsocket({ host: "127.0.0.1:7767", state: runningState() }),
    ).resolves.toEqual({
      connectedDaemon: "reachable",
      note: "Local daemon PID is running; websocket at 127.0.0.1:7767 requires daemon password for detailed status",
    });
  });

  test("still reports a running daemon unresponsive when the websocket is unreachable", async () => {
    mocks.connectToDaemon.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:7767"));

    await expect(
      probeDaemonOverWebsocket({ host: "127.0.0.1:7767", state: runningState() }),
    ).resolves.toEqual({
      connectedDaemon: "unreachable",
      localDaemonOverride: "unresponsive",
      note: "Local daemon PID is running but websocket at 127.0.0.1:7767 is not reachable",
    });
  });
});
