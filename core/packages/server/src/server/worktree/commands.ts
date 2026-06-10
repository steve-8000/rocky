import { join } from "node:path";

import { getRockyWorktreesRoot, isRockyOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveRockyWorktree,
  type ArchiveRockyWorktreeDependencies,
} from "../rocky-worktree-archive-service.js";
import type {
  CreateRockyWorktreeInput,
  CreateRockyWorktreeResult,
} from "../rocky-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";

export interface ListRockyWorktreesCommandDependencies {
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

export interface ListRockyWorktreesCommandInput {
  cwd: string;
  reason?: string;
}

export async function listRockyWorktreesCommand(
  dependencies: ListRockyWorktreesCommandDependencies,
  input: ListRockyWorktreesCommandInput,
): Promise<WorkspaceGitWorktreeInfo[]> {
  if (input.reason) {
    return dependencies.workspaceGitService.listWorktrees(input.cwd, { reason: input.reason });
  }
  return dependencies.workspaceGitService.listWorktrees(input.cwd);
}

type CreateRockyWorktreeWorkflow<Result extends CreateRockyWorktreeResult> = (
  input: CreateRockyWorktreeInput,
) => Promise<Result>;

export interface CreateRockyWorktreeCommandDependencies<
  Result extends CreateRockyWorktreeResult = CreateRockyWorktreeResult,
> {
  rockyHome?: string;
  worktreesRoot?: string;
  createRockyWorktreeWorkflow?: CreateRockyWorktreeWorkflow<Result>;
}

export type CreateRockyWorktreeCommandInput = Omit<
  CreateRockyWorktreeInput,
  "rockyHome" | "runSetup"
> & {
  rockyHome?: string;
  worktreesRoot?: string;
};

export type CreateRockyWorktreeCommandResult<Result extends CreateRockyWorktreeResult> =
  | {
      ok: true;
      createdWorktree: Result;
    }
  | {
      ok: false;
      error: WorktreeWireError;
      cause: unknown;
    };

export async function createRockyWorktreeCommand<Result extends CreateRockyWorktreeResult>(
  dependencies: CreateRockyWorktreeCommandDependencies<Result>,
  input: CreateRockyWorktreeCommandInput,
): Promise<CreateRockyWorktreeCommandResult<Result>> {
  try {
    if (!dependencies.createRockyWorktreeWorkflow) {
      throw new Error("Rocky worktree service is not configured");
    }

    const createdWorktree = await dependencies.createRockyWorktreeWorkflow({
      ...input,
      runSetup: false,
      rockyHome: input.rockyHome ?? dependencies.rockyHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    });
    return { ok: true, createdWorktree };
  } catch (error) {
    return {
      ok: false,
      error: toWorktreeWireError(error),
      cause: error,
    };
  }
}

export interface ArchiveRockyWorktreeCommandDependencies extends Omit<
  ArchiveRockyWorktreeDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
}

export interface ArchiveRockyWorktreeCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
}

export type ArchiveRockyWorktreeCommandResult =
  | {
      ok: true;
      removedAgents: string[];
    }
  | {
      ok: false;
      code: "NOT_ALLOWED";
      message: string;
      removedAgents: [];
    };

export async function archiveRockyWorktreeCommand(
  dependencies: ArchiveRockyWorktreeCommandDependencies,
  input: ArchiveRockyWorktreeCommandInput,
): Promise<ArchiveRockyWorktreeCommandResult> {
  const resolvedTarget = await resolveArchiveTarget(dependencies, input);
  const ownership = await isRockyOwnedWorktreeCwd(resolvedTarget.targetPath, {
    rockyHome: dependencies.rockyHome,
    worktreesRoot: dependencies.worktreesRoot,
  });

  if (!ownership.allowed) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: "Worktree is not a Rocky-owned worktree",
      removedAgents: [],
    };
  }

  const repoRoot = ownership.repoRoot ?? resolvedTarget.repoRoot ?? null;
  const removedAgents = await archiveRockyWorktree(dependencies, {
    targetPath: resolvedTarget.targetPath,
    repoRoot,
    worktreesRoot: ownership.worktreeRoot,
    worktreesBaseRoot: dependencies.worktreesRoot,
    requestId: input.requestId,
  });

  return {
    ok: true,
    removedAgents,
  };
}

interface ResolvedArchiveTarget {
  targetPath: string;
  repoRoot: string | null;
}

async function resolveArchiveTarget(
  dependencies: ArchiveRockyWorktreeCommandDependencies,
  input: ArchiveRockyWorktreeCommandInput,
): Promise<ResolvedArchiveTarget> {
  const repoRoot = input.repoRoot ?? null;
  if (input.worktreePath) {
    return { targetPath: input.worktreePath, repoRoot };
  }

  if (input.worktreeSlug) {
    if (!repoRoot) {
      throw new Error("repoRoot is required when worktreeSlug is supplied");
    }
    return {
      targetPath: await resolveWorktreeSlugPath(dependencies, repoRoot, input.worktreeSlug),
      repoRoot,
    };
  }

  if (repoRoot && input.branchName) {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
    const match = worktrees.find((entry) => entry.branchName === input.branchName);
    if (!match) {
      throw new Error(`Rocky worktree not found for branch ${input.branchName}`);
    }
    return { targetPath: match.path, repoRoot };
  }

  throw new Error("worktreePath, worktreeSlug, or repoRoot+branchName is required");
}

async function resolveWorktreeSlugPath(
  dependencies: ArchiveRockyWorktreeCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  const worktreesRoot = await getRockyWorktreesRoot(
    repoRoot,
    dependencies.rockyHome,
    dependencies.worktreesRoot,
  );
  return join(worktreesRoot, worktreeSlug);
}
