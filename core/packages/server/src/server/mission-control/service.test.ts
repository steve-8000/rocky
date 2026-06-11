import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { FileBackedMissionControlService } from "./service.js";

const roots: string[] = [];

async function createService(): Promise<{
  root: string;
  rockyHome: string;
  service: FileBackedMissionControlService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rocky-mission-control-"));
  roots.push(root);
  const rockyHome = path.join(root, ".rocky");
  await mkdir(rockyHome, { recursive: true });
  const logger = pino({ level: "silent" });
  return {
    root,
    rockyHome,
    service: new FileBackedMissionControlService({ rockyHome, logger }),
  };
}

describe("FileBackedMissionControlService", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("creates durable mission records and lists active missions newest first", async () => {
    const { rockyHome, service } = await createService();

    const first = await service.createMission({ goal: "First mission" });
    const second = await service.createMission({ goal: "Second mission" });

    const storedFirst = JSON.parse(
      await readFile(path.join(rockyHome, "missions", `${first.id}.json`), "utf8"),
    );
    expect(storedFirst.goal).toBe("First mission");
    expect(storedFirst.events).toEqual([
      expect.objectContaining({ seq: 1, type: "mission_created" }),
    ]);
    expect((await service.listMissions()).map((mission) => mission.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  test("syncs TEAM_BOARD.md projection when tasks change", async () => {
    const { root, service } = await createService();
    const boardPath = path.join(root, "TEAM_BOARD.md");
    const mission = await service.createMission({
      goal: "Ship Mission Control",
      boardPath,
    });

    const created = await service.createTask({
      missionId: mission.id,
      title: "Implement storage",
      ownerAgentId: "agent_builder",
      isolation: "worktree",
    });
    await service.updateTask({
      missionId: mission.id,
      taskId: created.task.id,
      status: "done",
      result: "storage landed",
    });

    const board = await readFile(boardPath, "utf8");
    expect(board).toContain("# Team Board — Ship Mission Control");
    expect(board).toContain(
      "| 1 | Implement storage | agent_builder | worktree | done | storage landed |",
    );
  });

  test("archives missions without deleting historical tasks", async () => {
    const { service } = await createService();
    const mission = await service.createMission({ goal: "Archive me" });
    const created = await service.createTask({ missionId: mission.id, title: "Keep task" });

    const archived = await service.updateMission({ missionId: mission.id, status: "archived" });

    expect(archived.archivedAt).not.toBeNull();
    expect(archived.tasks.map((task) => task.id)).toEqual([created.task.id]);
    expect(await service.listMissions()).toEqual([]);
    expect((await service.listMissions({ includeArchived: true })).map((item) => item.id)).toEqual([
      mission.id,
    ]);
  });
});
