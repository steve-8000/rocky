import { z } from "zod";
import {
  MissionRecordSchema,
  MissionStatusSchema,
  MissionTaskIsolationSchema,
  MissionTaskSchema,
  MissionTaskStatusSchema,
  MissionVerificationSchema,
} from "./types.js";

export const MissionCreateRequestSchema = z.object({
  type: z.literal("mission.create.request"),
  requestId: z.string(),
  goal: z.string(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  leaderAgentId: z.string().optional(),
  chatRoomId: z.string().optional(),
  boardPath: z.string().optional(),
  status: MissionStatusSchema.optional(),
});

export const MissionListRequestSchema = z.object({
  type: z.literal("mission.list.request"),
  requestId: z.string(),
  includeArchived: z.boolean().optional(),
});

export const MissionInspectRequestSchema = z.object({
  type: z.literal("mission.inspect.request"),
  requestId: z.string(),
  missionId: z.string(),
});

export const MissionUpdateRequestSchema = z.object({
  type: z.literal("mission.update.request"),
  requestId: z.string(),
  missionId: z.string(),
  goal: z.string().optional(),
  status: MissionStatusSchema.optional(),
  leaderAgentId: z.string().nullable().optional(),
  chatRoomId: z.string().nullable().optional(),
  boardPath: z.string().nullable().optional(),
});

export const MissionTaskCreateRequestSchema = z.object({
  type: z.literal("mission.task.create.request"),
  requestId: z.string(),
  missionId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  ownerAgentId: z.string().optional(),
  rosterAgentId: z.string().optional(),
  worktreePath: z.string().optional(),
  isolation: MissionTaskIsolationSchema.optional(),
  status: MissionTaskStatusSchema.optional(),
});

export const MissionTaskUpdateRequestSchema = z.object({
  type: z.literal("mission.task.update.request"),
  requestId: z.string(),
  missionId: z.string(),
  taskId: z.string(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  status: MissionTaskStatusSchema.optional(),
  ownerAgentId: z.string().nullable().optional(),
  rosterAgentId: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  isolation: MissionTaskIsolationSchema.optional(),
  result: z.string().nullable().optional(),
  verification: z.array(MissionVerificationSchema).optional(),
});

export const MissionCreateResponseSchema = z.object({
  type: z.literal("mission.create.response"),
  payload: z.object({
    requestId: z.string(),
    mission: MissionRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const MissionListResponseSchema = z.object({
  type: z.literal("mission.list.response"),
  payload: z.object({
    requestId: z.string(),
    missions: z.array(MissionRecordSchema),
    error: z.string().nullable(),
  }),
});

export const MissionInspectResponseSchema = z.object({
  type: z.literal("mission.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    mission: MissionRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const MissionUpdateResponseSchema = z.object({
  type: z.literal("mission.update.response"),
  payload: z.object({
    requestId: z.string(),
    mission: MissionRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const MissionTaskCreateResponseSchema = z.object({
  type: z.literal("mission.task.create.response"),
  payload: z.object({
    requestId: z.string(),
    mission: MissionRecordSchema.nullable(),
    task: MissionTaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const MissionTaskUpdateResponseSchema = z.object({
  type: z.literal("mission.task.update.response"),
  payload: z.object({
    requestId: z.string(),
    mission: MissionRecordSchema.nullable(),
    task: MissionTaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});
