import { Command } from "commander";
import type { MissionRecord, MissionTask } from "@getrocky/protocol/mission/types";
import type { ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

interface MissionCommandOptions {
  host?: string;
}

interface MissionRow {
  id: string;
  goal: string;
  status: string;
  tasks: number;
  leader: string;
  chat: string;
  updatedAt: string;
}

interface MissionTaskRow {
  id: string;
  title: string;
  status: string;
  owner: string;
  isolation: string;
  result: string;
}

interface MissionCreateOptions extends MissionCommandOptions {
  project?: string;
  workspace?: string;
  leader?: string;
  chat?: string;
  board?: string;
  status?: MissionRecord["status"];
}

interface MissionListOptions extends MissionCommandOptions {
  all?: boolean;
}

interface MissionUpdateOptions extends MissionCommandOptions {
  goal?: string;
  status?: MissionRecord["status"];
  leader?: string;
  chat?: string;
  board?: string;
}

interface MissionTaskCreateOptions extends MissionCommandOptions {
  description?: string;
  acceptance?: string[];
  owner?: string;
  roster?: string;
  worktree?: string;
  isolation?: MissionTask["isolation"];
  status?: MissionTask["status"];
}

interface MissionTaskUpdateOptions extends MissionCommandOptions {
  title?: string;
  description?: string;
  acceptance?: string[];
  status?: MissionTask["status"];
  owner?: string;
  roster?: string;
  worktree?: string;
  isolation?: MissionTask["isolation"];
  result?: string;
}

const missionSchema: OutputSchema<MissionRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 40 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "TASKS", field: "tasks", width: 6 },
    { header: "LEADER", field: "leader", width: 18 },
    { header: "CHAT", field: "chat", width: 18 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
    { header: "GOAL", field: "goal", width: 48 },
  ],
};

const missionDetailSchema: OutputSchema<MissionRecord> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 40 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "TASKS", field: (mission) => mission.tasks.length, width: 6 },
    { header: "LEADER", field: (mission) => mission.leaderAgentId ?? "-", width: 18 },
    { header: "CHAT", field: (mission) => mission.chatRoomId ?? "-", width: 18 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
    { header: "GOAL", field: "goal", width: 48 },
  ],
  serialize: (mission) => mission,
};

const missionTaskSchema: OutputSchema<MissionTaskRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 40 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "OWNER", field: "owner", width: 18 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "TITLE", field: "title", width: 48 },
    { header: "RESULT", field: "result", width: 48 },
  ],
};

function toMissionRow(mission: MissionRecord): MissionRow {
  return {
    id: mission.id,
    goal: mission.goal,
    status: mission.status,
    tasks: mission.tasks.length,
    leader: mission.leaderAgentId ?? "-",
    chat: mission.chatRoomId ?? "-",
    updatedAt: mission.updatedAt,
  };
}

function toMissionTaskRow(task: MissionTask): MissionTaskRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.ownerAgentId ?? "-",
    isolation: task.isolation,
    result: task.result ?? "-",
  };
}

function connectMissionClient(host?: string) {
  getDaemonHost({ host });
  return connectToDaemon({ host });
}

function requirePayloadMission(payload: {
  mission: MissionRecord | null;
  error: string | null;
}): MissionRecord {
  if (!payload.mission) {
    throw new Error(payload.error ?? "Mission response did not include a mission");
  }
  return payload.mission;
}

function requirePayloadTask(payload: {
  task: MissionTask | null;
  error: string | null;
}): MissionTask {
  if (!payload.task) {
    throw new Error(payload.error ?? "Mission response did not include a task");
  }
  return payload.task;
}

async function runCreateCommand(
  goal: string,
  options: MissionCreateOptions,
  _command: Command,
): Promise<SingleResult<MissionRow>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.createMission({
      goal,
      projectId: options.project,
      workspaceId: options.workspace,
      leaderAgentId: options.leader,
      chatRoomId: options.chat,
      boardPath: options.board,
      status: options.status,
    });
    return {
      type: "single",
      data: toMissionRow(requirePayloadMission(payload)),
      schema: missionSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runListCommand(
  options: MissionListOptions,
  _command: Command,
): Promise<ListResult<MissionRow>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.listMissions({ includeArchived: options.all });
    return {
      type: "list",
      data: payload.missions.map(toMissionRow),
      schema: missionSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runInspectCommand(
  missionId: string,
  options: MissionCommandOptions,
  _command: Command,
): Promise<SingleResult<MissionRecord>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.inspectMission({ missionId });
    return {
      type: "single",
      data: requirePayloadMission(payload),
      schema: missionDetailSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runUpdateCommand(
  missionId: string,
  options: MissionUpdateOptions,
  _command: Command,
): Promise<SingleResult<MissionRow>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.updateMission({
      missionId,
      goal: options.goal,
      status: options.status,
      leaderAgentId: options.leader,
      chatRoomId: options.chat,
      boardPath: options.board,
    });
    return {
      type: "single",
      data: toMissionRow(requirePayloadMission(payload)),
      schema: missionSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runTaskCreateCommand(
  missionId: string,
  title: string,
  options: MissionTaskCreateOptions,
  _command: Command,
): Promise<SingleResult<MissionTaskRow>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.createMissionTask({
      missionId,
      title,
      description: options.description,
      acceptanceCriteria: options.acceptance,
      ownerAgentId: options.owner,
      rosterAgentId: options.roster,
      worktreePath: options.worktree,
      isolation: options.isolation,
      status: options.status,
    });
    return {
      type: "single",
      data: toMissionTaskRow(requirePayloadTask(payload)),
      schema: missionTaskSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runTaskUpdateCommand(
  missionId: string,
  taskId: string,
  options: MissionTaskUpdateOptions,
  _command: Command,
): Promise<SingleResult<MissionTaskRow>> {
  const client = await connectMissionClient(options.host);
  try {
    const payload = await client.updateMissionTask({
      missionId,
      taskId,
      title: options.title,
      description: options.description,
      acceptanceCriteria: options.acceptance,
      status: options.status,
      ownerAgentId: options.owner,
      rosterAgentId: options.roster,
      worktreePath: options.worktree,
      isolation: options.isolation,
      result: options.result,
    });
    return {
      type: "single",
      data: toMissionTaskRow(requirePayloadTask(payload)),
      schema: missionTaskSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export function createMissionCommand(): Command {
  const mission = new Command("mission").description("Manage Mission Control missions");

  addJsonAndDaemonHostOptions(
    mission
      .command("create")
      .description("Create a Mission Control mission")
      .argument("<goal>", "Mission goal")
      .option("--project <id>", "Project ID")
      .option("--workspace <id>", "Workspace ID")
      .option("--leader <agent-id>", "Leader agent ID")
      .option("--chat <room-id>", "Chat room ID")
      .option("--board <path>", "TEAM_BOARD.md path")
      .option("--status <status>", "Initial mission status"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    mission
      .command("ls")
      .description("List Mission Control missions")
      .option("--all", "Include archived missions"),
  ).action(withOutput(runListCommand));

  addJsonAndDaemonHostOptions(
    mission
      .command("inspect")
      .description("Inspect a Mission Control mission")
      .argument("<mission-id>", "Mission ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    mission
      .command("update")
      .description("Update a Mission Control mission")
      .argument("<mission-id>", "Mission ID")
      .option("--goal <goal>", "Mission goal")
      .option("--status <status>", "Mission status")
      .option("--leader <agent-id>", "Leader agent ID")
      .option("--chat <room-id>", "Chat room ID")
      .option("--board <path>", "TEAM_BOARD.md path"),
  ).action(withOutput(runUpdateCommand));

  const task = mission.command("task").description("Manage Mission Control tasks");
  addJsonAndDaemonHostOptions(
    task
      .command("create")
      .description("Create a Mission Control task")
      .argument("<mission-id>", "Mission ID")
      .argument("<title>", "Task title")
      .option("--description <text>", "Task description")
      .option("--acceptance <criterion>", "Acceptance criterion", collectRepeated, [])
      .option("--owner <agent-id>", "Owner agent ID")
      .option("--roster <roster-id>", "Team roster agent ID")
      .option("--worktree <path>", "Worktree path")
      .option("--isolation <mode>", "shared, worktree, or read-only")
      .option("--status <status>", "Task status"),
  ).action(withOutput(runTaskCreateCommand));

  addJsonAndDaemonHostOptions(
    task
      .command("update")
      .description("Update a Mission Control task")
      .argument("<mission-id>", "Mission ID")
      .argument("<task-id>", "Task ID")
      .option("--title <title>", "Task title")
      .option("--description <text>", "Task description")
      .option("--acceptance <criterion>", "Acceptance criterion", collectRepeated, [])
      .option("--status <status>", "Task status")
      .option("--owner <agent-id>", "Owner agent ID")
      .option("--roster <roster-id>", "Team roster agent ID")
      .option("--worktree <path>", "Worktree path")
      .option("--isolation <mode>", "shared, worktree, or read-only")
      .option("--result <text>", "Task result summary"),
  ).action(withOutput(runTaskUpdateCommand));

  return mission;
}

function collectRepeated(value: string, previous: string[]): string[] {
  return previous.concat(value);
}
