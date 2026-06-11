//! Workspace/project registry + worktree + git operations for rockyd.
//!
//! This crate adds the WRITE/mutation, worktree, and git side on top of the
//! read-only `rocky-store` projections. It mirrors the TypeScript server:
//! - `core/packages/server/src/server/workspace-registry.ts` (registries)
//! - `core/packages/server/src/utils/worktree.ts` (worktree lifecycle)
//! - `core/packages/protocol/src/branch-slug.ts` (branch slug validation)
//! - `core/packages/server/src/server/workspace-git-service.ts` +
//!   `core/packages/server/src/utils/run-git-command.ts` (git wrapper)

pub mod git;
pub mod registry;
pub mod worktree;

pub use git::{
    current_branch, diff, git_status_porcelain, is_inside_work_tree, run_git, run_git_checked,
    DiffOptions, GitError, GitOutput,
};
pub use registry::{ProjectRegistry, RegistryError, WorkspaceRegistry};
pub use worktree::{
    archive_worktree, create_worktree, derive_worktree_repo_root, list_worktrees,
    normalize_workspace_id, resolve_worktree_root, upsert_workspace_for_worktree,
    validate_branch_slug, BranchSlugValidation, CreatedWorktree, WorktreeError, WorktreeInfo,
};

// Re-export the record types so consumers construct registry inputs without a
// direct `rocky-store` dependency.
pub use rocky_store::{
    PersistedProjectRecord, PersistedWorkspaceRecord, ProjectKind,
};
