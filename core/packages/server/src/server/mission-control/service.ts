import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import {
  MissionRecordSchema,
  MissionTaskSchema,
  type MissionEvent,
  type MissionRecord,
  type MissionStatus,
  type MissionTask,
  type MissionTaskIsolation,
  type MissionTaskStatus,
  type MissionVerification,
} from "@getrocky/protocol/mission/types";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";

export class MissionControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MissionControlError";
    this.code = code;
  }
}

export interface CreateMissionInput {
  goal: string;
  status?: MissionStatus;
  projectId?: string | null;
  workspaceId?: string | null;
  leaderAgentId?: string | null;
  chatRoomId?: string | null;
  boardPath?: string | null;
}

export interface UpdateMissionInput {
  missionId: string;
  goal?: string;
  status?: MissionStatus;
  leaderAgentId?: string | null;
  chatRoomId?: string | null;
  boardPath?: string | null;
}

export interface CreateMissionTaskInput {
  missionId: string;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string[];
  status?: MissionTaskStatus;
  ownerAgentId?: string | null;
  rosterAgentId?: string | null;
  worktreePath?: string | null;
  isolation?: MissionTaskIsolation;
}

export interface UpdateMissionTaskInput {
  missionId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  acceptanceCriteria?: string[];
  status?: MissionTaskStatus;
  ownerAgentId?: string | null;
  rosterAgentId?: string | null;
  worktreePath?: string | null;
  isolation?: MissionTaskIsolation;
  result?: string | null;
  verification?: MissionVerification[];
}

interface MissionTaskResult {
  mission: MissionRecord;
  task: MissionTask;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MissionControlError("invalid_mission_input", `${field} is required`);
  }
  return trimmed;
}

function normalizeBoardPath(value: string | null | undefined): string | null {
  const trimmed = trimToNull(value);
  return trimmed ? path.resolve(trimmed) : null;
}

function compareMissions(left: MissionRecord, right: MissionRecord): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt)
  );
}

function nextEventSeq(mission: MissionRecord): number {
  const lastEvent = mission.events[mission.events.length - 1];
  return lastEvent ? lastEvent.seq + 1 : 1;
}

function eventFor(
  mission: MissionRecord,
  type: string,
  payload: Record<string, unknown>,
  timestamp: string,
): MissionEvent {
  return {
    seq: nextEventSeq(mission),
    timestamp,
    type,
    payload,
  };
}

function withStatusTimestamps(
  mission: MissionRecord,
  status: MissionStatus,
  now: string,
): MissionRecord {
  return MissionRecordSchema.parse({
    ...mission,
    status,
    completedAt: status === "completed" ? (mission.completedAt ?? now) : mission.completedAt,
    archivedAt: status === "archived" ? (mission.archivedAt ?? now) : mission.archivedAt,
  });
}

function escapeBoardCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderMissionBoard(mission: MissionRecord): string {
  const rows = mission.tasks.map((task, index) => {
    const owner = task.ownerAgentId ?? "unassigned";
    const result = task.result ?? "";
    return `| ${index + 1} | ${escapeBoardCell(task.title)} | ${escapeBoardCell(owner)} | ${task.isolation} | ${task.status} | ${escapeBoardCell(result)} |`;
  });
  return [
    `# Team Board — ${mission.goal}`,
    "",
    "| # | Task | Owner (agent id) | Isolation | Status | Result |",
    "|---|------|------------------|-----------|--------|--------|",
    ...rows,
    "",
  ].join("\n");
}

export class FileBackedMissionControlService {
  private readonly dirPath: string;
  private readonly logger: pino.Logger;

  constructor(options: { rockyHome: string; logger: pino.Logger }) {
    this.dirPath = path.join(options.rockyHome, "missions");
    this.logger = options.logger.child({ component: "mission-control" });
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
  }

  async createMission(input: CreateMissionInput): Promise<MissionRecord> {
    const now = new Date().toISOString();
    const mission = MissionRecordSchema.parse({
      version: 1,
      id: `mis_${randomUUID()}`,
      goal: requireText(input.goal, "goal"),
      status: input.status ?? "running",
      projectId: trimToNull(input.projectId),
      workspaceId: trimToNull(input.workspaceId),
      leaderAgentId: trimToNull(input.leaderAgentId),
      chatRoomId: trimToNull(input.chatRoomId),
      boardPath: normalizeBoardPath(input.boardPath),
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === "completed" ? now : null,
      archivedAt: input.status === "archived" ? now : null,
      tasks: [],
      events: [],
    });
    const event = eventFor(mission, "mission_created", { status: mission.status }, now);
    const withEvent = MissionRecordSchema.parse({ ...mission, events: [event] });
    await this.writeMission(withEvent);
    return withEvent;
  }

  async listMissions(options: { includeArchived?: boolean } = {}): Promise<MissionRecord[]> {
    await this.initialize();
    const entries = await fs.readdir(this.dirPath, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const missions: MissionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      missions.push(await this.readMissionFile(path.join(this.dirPath, entry.name)));
    }
    return missions
      .filter((mission) => options.includeArchived || mission.status !== "archived")
      .sort(compareMissions);
  }

  async inspectMission(missionId: string): Promise<MissionRecord> {
    return this.readMission(missionId);
  }

  async updateMission(input: UpdateMissionInput): Promise<MissionRecord> {
    const mission = await this.readMission(input.missionId);
    const now = new Date().toISOString();
    const goal = input.goal === undefined ? mission.goal : requireText(input.goal, "goal");
    const status = input.status ?? mission.status;
    const updated = withStatusTimestamps(
      MissionRecordSchema.parse({
        ...mission,
        goal,
        status,
        leaderAgentId:
          input.leaderAgentId === undefined
            ? mission.leaderAgentId
            : trimToNull(input.leaderAgentId),
        chatRoomId:
          input.chatRoomId === undefined ? mission.chatRoomId : trimToNull(input.chatRoomId),
        boardPath:
          input.boardPath === undefined ? mission.boardPath : normalizeBoardPath(input.boardPath),
        updatedAt: now,
      }),
      status,
      now,
    );
    const withEvent = MissionRecordSchema.parse({
      ...updated,
      events: [...updated.events, eventFor(updated, "mission_updated", { status }, now)],
    });
    await this.writeMission(withEvent);
    return withEvent;
  }

  async createTask(input: CreateMissionTaskInput): Promise<MissionTaskResult> {
    const mission = await this.readMission(input.missionId);
    const now = new Date().toISOString();
    const task = MissionTaskSchema.parse({
      id: `task_${randomUUID()}`,
      title: requireText(input.title, "title"),
      description: trimToNull(input.description),
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      status: input.status ?? "todo",
      ownerAgentId: trimToNull(input.ownerAgentId),
      rosterAgentId: trimToNull(input.rosterAgentId),
      worktreePath: trimToNull(input.worktreePath),
      isolation: input.isolation ?? "worktree",
      result: null,
      verification: [],
      createdAt: now,
      updatedAt: now,
    });
    const updated = MissionRecordSchema.parse({
      ...mission,
      updatedAt: now,
      tasks: [...mission.tasks, task],
      events: [...mission.events, eventFor(mission, "task_created", { taskId: task.id }, now)],
    });
    await this.writeMission(updated);
    return { mission: updated, task };
  }

  async updateTask(input: UpdateMissionTaskInput): Promise<MissionTaskResult> {
    const mission = await this.readMission(input.missionId);
    const taskIndex = mission.tasks.findIndex((task) => task.id === input.taskId);
    if (taskIndex === -1) {
      throw new MissionControlError(
        "mission_task_not_found",
        `Mission task not found: ${input.taskId}`,
      );
    }
    const now = new Date().toISOString();
    const current = mission.tasks[taskIndex];
    const updatedTask = MissionTaskSchema.parse({
      ...current,
      title: input.title === undefined ? current.title : requireText(input.title, "title"),
      description:
        input.description === undefined ? current.description : trimToNull(input.description),
      acceptanceCriteria: input.acceptanceCriteria ?? current.acceptanceCriteria,
      status: input.status ?? current.status,
      ownerAgentId:
        input.ownerAgentId === undefined ? current.ownerAgentId : trimToNull(input.ownerAgentId),
      rosterAgentId:
        input.rosterAgentId === undefined ? current.rosterAgentId : trimToNull(input.rosterAgentId),
      worktreePath:
        input.worktreePath === undefined ? current.worktreePath : trimToNull(input.worktreePath),
      isolation: input.isolation ?? current.isolation,
      result: input.result === undefined ? current.result : trimToNull(input.result),
      verification: input.verification ?? current.verification,
      updatedAt: now,
    });
    const tasks = mission.tasks.map((task, index) => (index === taskIndex ? updatedTask : task));
    const updated = MissionRecordSchema.parse({
      ...mission,
      updatedAt: now,
      tasks,
      events: [
        ...mission.events,
        eventFor(
          mission,
          "task_updated",
          { taskId: updatedTask.id, status: updatedTask.status },
          now,
        ),
      ],
    });
    await this.writeMission(updated);
    return { mission: updated, task: updatedTask };
  }

  private async readMission(missionId: string): Promise<MissionRecord> {
    const id = requireText(missionId, "missionId");
    return this.readMissionFile(this.filePathFor(id));
  }

  private async readMissionFile(filePath: string): Promise<MissionRecord> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return MissionRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MissionControlError(
          "mission_not_found",
          `Mission not found: ${path.basename(filePath, ".json")}`,
        );
      }
      throw error;
    }
  }

  private filePathFor(missionId: string): string {
    if (missionId.includes("/") || missionId.includes("\\")) {
      throw new MissionControlError("invalid_mission_id", `Invalid mission id: ${missionId}`);
    }
    return path.join(this.dirPath, `${missionId}.json`);
  }

  private async writeMission(mission: MissionRecord): Promise<void> {
    await this.initialize();
    await writeJsonFileAtomic(this.filePathFor(mission.id), mission);
    await this.writeBoardProjection(mission);
  }

  private async writeBoardProjection(mission: MissionRecord): Promise<void> {
    if (!mission.boardPath) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(mission.boardPath), { recursive: true });
      await writeFileAtomic(mission.boardPath, renderMissionBoard(mission));
    } catch (error) {
      this.logger.error(
        { err: error, missionId: mission.id, boardPath: mission.boardPath },
        "Failed to write mission board",
      );
      throw error;
    }
  }
}
