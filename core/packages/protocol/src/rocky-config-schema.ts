import { z } from "zod";

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

export const RockyLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const RockyScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const RockyWorktreeConfigRawSchema = z
  .object({
    setup: RockyLifecycleCommandRawSchema.optional(),
    teardown: RockyLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
  })
  .passthrough();

export const RockyMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const RockyMetadataGenerationSchema = z
  .object({
    agentTitle: RockyMetadataGenerationEntrySchema.optional(),
    branchName: RockyMetadataGenerationEntrySchema.optional(),
    commitMessage: RockyMetadataGenerationEntrySchema.optional(),
    pullRequest: RockyMetadataGenerationEntrySchema.optional(),
  })
  .passthrough()
  .catch({});

export const RockyConfigRawSchema = z
  .object({
    worktree: RockyWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), RockyScriptEntryRawSchema).optional(),
    metadataGeneration: RockyMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = RockyWorktreeConfigRawSchema.extend({
  setup: z.unknown().transform(normalizeLifecycleCommands),
  teardown: z.unknown().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = RockyScriptEntryRawSchema.catch({});

export const RockyConfigSchema = RockyConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: RockyMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const RockyConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: RockyConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type RockyScriptEntryRaw = z.infer<typeof RockyScriptEntryRawSchema>;
export type RockyMetadataGenerationEntry = z.infer<typeof RockyMetadataGenerationEntrySchema>;
export type RockyMetadataGeneration = z.infer<typeof RockyMetadataGenerationSchema>;
export type RockyConfigRaw = z.infer<typeof RockyConfigRawSchema>;
export type RockyConfig = z.infer<typeof RockyConfigSchema>;
export type RockyConfigRevision = z.infer<typeof RockyConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
