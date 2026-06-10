import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RockyConfigRawSchema,
  type RockyConfigRaw,
  type RockyConfigRevision,
  type ProjectConfigRpcError,
} from "@getrocky/protocol/rocky-config-schema";
export {
  RockyConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type RockyConfigRevision,
  type ProjectConfigRpcError,
} from "@getrocky/protocol/rocky-config-schema";

export const ROCKY_CONFIG_FILE_NAME = "rocky.json";

export type ReadRockyConfigForEditResult =
  | { ok: true; config: RockyConfigRaw | null; revision: RockyConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };

export type WriteRockyConfigForEditResult =
  | { ok: true; config: RockyConfigRaw; revision: RockyConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

export interface WriteRockyConfigForEditInput {
  repoRoot: string;
  config: RockyConfigRaw;
  expectedRevision: RockyConfigRevision | null;
}

export function resolveRockyConfigPath(repoRoot: string): string {
  return join(repoRoot, ROCKY_CONFIG_FILE_NAME);
}

export function statRockyConfigPath(repoRoot: string): RockyConfigRevision | null {
  const configPath = resolveRockyConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  const stats = statSync(configPath);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

export function readRockyConfigJson(repoRoot: string): unknown {
  const configPath = resolveRockyConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function readRockyConfigForEdit(repoRoot: string): ReadRockyConfigForEditResult {
  try {
    const json = readRockyConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null, revision: null };
    }
    return {
      ok: true,
      config: RockyConfigRawSchema.parse(json),
      revision: statRockyConfigPath(repoRoot),
    };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_project_config" },
    };
  }
}

export function writeRockyConfigForEdit(
  input: WriteRockyConfigForEditInput,
): WriteRockyConfigForEditResult {
  const parsed = RockyConfigRawSchema.safeParse(input.config);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_project_config" } };
  }

  const configPath = resolveRockyConfigPath(input.repoRoot);
  const tempPath = join(
    input.repoRoot,
    `.${ROCKY_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
    const currentRevision = statRockyConfigPath(input.repoRoot);
    if (!rockyConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
      removeTempRockyConfig(tempPath);
      return {
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      };
    }

    renameSync(tempPath, configPath);
    const revision = statRockyConfigPath(input.repoRoot);
    if (!revision) {
      return { ok: false, error: { code: "write_failed" } };
    }
    return { ok: true, config: parsed.data, revision };
  } catch {
    removeTempRockyConfig(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

function rockyConfigRevisionsEqual(
  left: RockyConfigRevision | null,
  right: RockyConfigRevision | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function removeTempRockyConfig(tempPath: string): void {
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup only; callers need the original write outcome.
  }
}
