import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { MissionRecordSchema, MissionTaskSchema } from "@getrocky/protocol/mission/types";
import { DaemonClient } from "./test-utils/index.js";
import { createTestRockyDaemon } from "./test-utils/rocky-daemon.js";

const roots: string[] = [];

async function createBoardPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rocky-mission-e2e-"));
  roots.push(root);
  return path.join(root, "TEAM_BOARD.md");
}

describe("Mission Control daemon RPC", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("creates a mission, mutates a task, and syncs TEAM_BOARD.md over WebSocket", async () => {
    const daemon = await createTestRockyDaemon();
    const boardPath = await createBoardPath();
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      const created = await client.createMission({
        goal: "Ship Mission Control",
        boardPath,
      });
      const mission = MissionRecordSchema.parse(created.mission);
      expect(mission.goal).toBe("Ship Mission Control");

      const missionId = mission.id;
      const taskCreated = await client.createMissionTask({
        missionId,
        title: "Implement durable board",
        ownerAgentId: "agent_builder",
        isolation: "worktree",
      });
      const createdTask = MissionTaskSchema.parse(taskCreated.task);
      expect(createdTask.status).toBe("todo");

      const taskUpdated = await client.updateMissionTask({
        missionId,
        taskId: createdTask.id,
        status: "done",
        result: "board synced",
      });
      const updatedTask = MissionTaskSchema.parse(taskUpdated.task);
      expect(updatedTask.status).toBe("done");

      const listed = await client.listMissions();
      expect(listed.missions.map((listedMission) => listedMission.id)).toEqual([missionId]);

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain(
        "| 1 | Implement durable board | agent_builder | worktree | done | board synced |",
      );
    } finally {
      await client.close();
      await daemon.close();
    }
  });
});
