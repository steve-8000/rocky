import { z } from "zod";

export const MissionStatusSchema = z.enum([
  "draft",
  "running",
  "blocked",
  "verifying",
  "completed",
  "failed",
  "canceled",
  "archived",
]);

export const MissionTaskStatusSchema = z.enum([
  "todo",
  "running",
  "blocked",
  "failed",
  "done",
  "canceled",
]);

export const MissionTaskIsolationSchema = z.enum(["shared", "worktree", "read-only"]);

export const MissionVerificationSchema = z.object({
  kind: z.enum(["command", "manual", "agent", "test"]),
  summary: z.string(),
  evidence: z.string(),
  passed: z.boolean(),
  timestamp: z.string(),
});

export const MissionTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  acceptanceCriteria: z.array(z.string()),
  status: MissionTaskStatusSchema,
  ownerAgentId: z.string().nullable(),
  rosterAgentId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  isolation: MissionTaskIsolationSchema,
  result: z.string().nullable(),
  verification: z.array(MissionVerificationSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const MissionEventSchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  type: z.string(),
  payload: z.record(z.unknown()),
});

export const MissionRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  goal: z.string(),
  status: MissionStatusSchema,
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  leaderAgentId: z.string().nullable(),
  chatRoomId: z.string().nullable(),
  boardPath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  tasks: z.array(MissionTaskSchema),
  events: z.array(MissionEventSchema),
});

export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type MissionTaskStatus = z.infer<typeof MissionTaskStatusSchema>;
export type MissionTaskIsolation = z.infer<typeof MissionTaskIsolationSchema>;
export type MissionVerification = z.infer<typeof MissionVerificationSchema>;
export type MissionTask = z.infer<typeof MissionTaskSchema>;
export type MissionEvent = z.infer<typeof MissionEventSchema>;
export type MissionRecord = z.infer<typeof MissionRecordSchema>;
