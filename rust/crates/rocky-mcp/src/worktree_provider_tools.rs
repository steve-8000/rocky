//! Worktree + provider MCP tools.
//!
//! Mirrors `core/packages/server/src/server/agent/mcp-server.ts`:
//! - Provider tools (lines 2131-2241):
//!   - `list_providers` — configured providers, availability, and modes.
//!   - `list_models` — models for a provider.
//!   - `inspect_provider` — compact provider capabilities for orchestration.
//! - Worktree tools (lines 2243-2402):
//!   - `list_worktrees` — Rocky-managed git worktrees for a repo.
//!   - `create_worktree` — branch-off / checkout-branch / checkout-pr.
//!   - `archive_worktree` — delete a Rocky-managed worktree.
//!
//! Daemon deviations from the TS server (intentional, honest):
//! - The Rust daemon hosts exactly ONE provider (`ctx.provider()`), and has no
//!   static provider/model catalog. The TS `providerSnapshotManager` is replaced
//!   by LIVE ACP discovery via [`rocky_agents::AgentProvider`] (`list_models`,
//!   `list_modes`, `list_features`). Provider tools never fabricate a catalog;
//!   when no provider is wired they return a structured `not_wired` error.
//! - `create_worktree` mode `checkout-pr` is not supported by the Rust daemon
//!   yet; it returns `not_wired` rather than faking a success. `branch-off` and
//!   `checkout-branch` are fully functional.
//! - `WorktreeInfo` (the Rust porcelain parse) carries `path`, `branch`, and
//!   `head` but NO `createdAt`. The TS `WorktreeSummarySchema` requires
//!   `createdAt`, so `list_worktrees` emits an empty string `""` for it rather
//!   than synthesizing a timestamp. See the `list_worktrees` handler.

use std::path::Path;

use serde_json::{json, Value};

use crate::protocol::{tool_result, ToolDescriptor, ToolError, ToolRegistry};
use crate::tools::{as_object, boxed, object_schema, opt_str, req_str};

/// Register the worktree + provider tools on `registry`.
pub fn register(registry: &mut ToolRegistry) {
    register_list_worktrees(registry);
    register_create_worktree(registry);
    register_archive_worktree(registry);
    register_list_providers(registry);
    register_list_models(registry);
    register_inspect_provider(registry);
}

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

/// Resolve the cwd a tool should operate in, mirroring the TS
/// `resolveScopedCwd(cwd, { required: true })`:
/// - An explicit, non-empty `requested` value wins (trimmed; NOT tilde-expanded
///   — callers pass already-expanded paths, matching the TS upstream step).
/// - Otherwise fall back to the authenticated caller agent's `cwd`.
/// - Otherwise this is an error (`cwd is required`).
async fn resolve_scoped_cwd(
    ctx: &crate::context::CallCtx,
    requested: Option<String>,
) -> Result<String, ToolError> {
    if let Some(cwd) = requested {
        let trimmed = cwd.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(id) = ctx.caller_agent_id() {
        if let Some(agent) = ctx.agent_manager().get(id).await {
            if !agent.cwd.trim().is_empty() {
                return Ok(agent.cwd);
            }
        }
    }
    Err(ToolError::invalid_params("cwd is required"))
}

/// Best-effort cwd for provider discovery, mirroring the TS `resolveSnapshotCwd`
/// fallback chain: explicit cwd -> caller agent cwd -> `$ROCKY_HOME` -> ".".
/// Never errors (discovery always has a working directory to probe).
async fn resolve_discovery_cwd(ctx: &crate::context::CallCtx, requested: Option<String>) -> String {
    if let Some(cwd) = requested {
        let trimmed = cwd.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(id) = ctx.caller_agent_id() {
        if let Some(agent) = ctx.agent_manager().get(id).await {
            if !agent.cwd.trim().is_empty() {
                return agent.cwd;
            }
        }
    }
    if let Some(home) = ctx.services().rocky_home.as_ref() {
        return home.to_string_lossy().to_string();
    }
    ".".to_string()
}

// ---------------------------------------------------------------------------
// Worktree tools
// ---------------------------------------------------------------------------

/// `list_worktrees` (mcp-server.ts:2243-2273). Lists Rocky-managed git worktrees
/// for the resolved repository cwd.
///
/// Output matches the TS `WorktreeSummarySchema { path, createdAt, branchName?,
/// head? }`. DEVIATION: the Rust `WorktreeInfo` (porcelain parse) has no
/// `createdAt`, so we emit `""` for it rather than synthesizing a timestamp from
/// the filesystem — keeping this a faithful, side-effect-free projection of what
/// git reports.
fn register_list_worktrees(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "list_worktrees".into(),
            title: "List worktrees".into(),
            description: "List Rocky-managed git worktrees for a repository.".into(),
            input_schema: object_schema(&[], &[("cwd", "string")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let requested = opt_str(map, "cwd")?;

            if ctx.services().workspace_registry.is_none() || ctx.services().rocky_home.is_none() {
                return Err(ToolError::not_wired(
                    "WorkspaceGitService is required to list worktrees",
                ));
            }

            let cwd = resolve_scoped_cwd(&ctx, requested).await?;
            let entries = rocky_workspaces::list_worktrees(Path::new(&cwd))
                .await
                .map_err(|e| ToolError::execution("worktree_error", e.to_string()))?;

            let worktrees: Vec<Value> = entries
                .into_iter()
                .map(|e| {
                    json!({
                        "path": e.path.to_string_lossy(),
                        "createdAt": "",
                        "branchName": e.branch,
                        "head": e.head,
                    })
                })
                .collect();

            Ok(tool_result(json!({ "worktrees": worktrees })))
        }),
    );
}

/// `create_worktree` (mcp-server.ts:2275-2349). Creates a Rocky-managed git
/// worktree from a discriminated `target`:
/// - `{ mode: "branch-off", newBranch, base? }` — new branch off `base`.
/// - `{ mode: "checkout-branch", branch }` — attach an existing branch.
/// - `{ mode: "checkout-pr", prNumber }` — DEVIATION: not supported by the Rust
///   daemon yet; returns `not_wired` rather than faking a success.
///
/// `project_id` derivation reuses `create_worktree_inner` (workspace.rs:595-619):
/// `normalize_workspace_id(repoRoot)`, and the path layout is
/// `resolve_worktree_root(rocky_home, worktrees_root).join(project_id).join(slug)`.
fn register_create_worktree(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "create_worktree".into(),
            title: "Create worktree".into(),
            description:
                "Create a Rocky-managed git worktree. Branch off a new branch, check out an existing branch, or check out a GitHub PR."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "cwd": { "type": "string" },
                    "target": {
                        "type": "object",
                        "properties": {
                            "mode": { "type": "string" },
                            "newBranch": { "type": "string" },
                            "base": { "type": "string" },
                            "branch": { "type": "string" },
                            "prNumber": { "type": "number" },
                        },
                        "required": ["mode"],
                        "additionalProperties": true,
                    },
                },
                "required": ["target"],
                "additionalProperties": false,
            }),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let requested = opt_str(map, "cwd")?;

            let (registry_arc, rocky_home) =
                match (&ctx.services().workspace_registry, &ctx.services().rocky_home) {
                    (Some(reg), Some(home)) => (reg.clone(), home.clone()),
                    _ => {
                        return Err(ToolError::not_wired(
                            "WorkspaceGitService is required to create worktrees",
                        ))
                    }
                };

            let target = map
                .get("target")
                .and_then(Value::as_object)
                .ok_or_else(|| ToolError::invalid_params("target is required"))?;
            let mode = target
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::invalid_params("target.mode is required"))?;

            // The branch slug we create/attach depends on the mode.
            let branch: String;
            let base_ref: Option<String>;
            match mode {
                "branch-off" => {
                    branch = target
                        .get("newBranch")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            ToolError::invalid_params("target.newBranch is required")
                        })?;
                    base_ref = target
                        .get("base")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
                "checkout-branch" => {
                    branch = target
                        .get("branch")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| ToolError::invalid_params("target.branch is required"))?;
                    base_ref = None;
                }
                "checkout-pr" => {
                    return Err(ToolError::not_wired(
                        "checkout-pr worktree creation is not supported by the Rust daemon yet",
                    ));
                }
                other => {
                    return Err(ToolError::invalid_params(format!(
                        "unknown target.mode `{other}`"
                    )));
                }
            }

            let validation = rocky_workspaces::validate_branch_slug(&branch);
            if !validation.valid {
                return Err(ToolError::invalid_params(
                    validation
                        .error
                        .unwrap_or_else(|| "invalid branch slug".to_string()),
                ));
            }

            let repo_root = resolve_scoped_cwd(&ctx, requested).await?;
            let project_id = rocky_workspaces::normalize_workspace_id(Path::new(&repo_root));
            let base_root = rocky_workspaces::resolve_worktree_root(
                &rocky_home,
                ctx.services().worktrees_root.as_deref(),
            );
            let worktree_path = base_root.join(&project_id).join(&branch);

            let created = rocky_workspaces::create_worktree(
                Path::new(&repo_root),
                &worktree_path,
                &branch,
                base_ref.as_deref(),
            )
            .await
            .map_err(|e| ToolError::execution("worktree_error", e.to_string()))?;

            // Best-effort: register a worktree-kind workspace record so the
            // worktree shows up in the sidebar (mirrors workspace.rs). A lock
            // failure here is non-fatal — the worktree exists on disk.
            if let Ok(mut workspaces) = registry_arc.lock() {
                let _ = rocky_workspaces::upsert_workspace_for_worktree(
                    &mut workspaces,
                    &project_id,
                    &created.path,
                );
            }

            Ok(tool_result(json!({
                "branchName": created.branch,
                "worktreePath": created.path.to_string_lossy(),
            })))
        }),
    );
}

/// `archive_worktree` (mcp-server.ts:2351-2402). Deletes a Rocky-managed git
/// worktree by explicit `worktreePath` or by `worktreeSlug` (resolved under the
/// worktree root). The repo root is derived from the worktree path via git
/// (`derive_worktree_repo_root`) and falls back to the scoped cwd.
fn register_archive_worktree(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "archive_worktree".into(),
            title: "Archive worktree".into(),
            description: "Delete a Rocky-managed git worktree.".into(),
            input_schema: object_schema(
                &[],
                &[
                    ("cwd", "string"),
                    ("worktreePath", "string"),
                    ("worktreeSlug", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let requested = opt_str(map, "cwd")?;
            let worktree_path = opt_str(map, "worktreePath")?;
            let worktree_slug = opt_str(map, "worktreeSlug")?;

            if worktree_path.is_none() && worktree_slug.is_none() {
                return Err(ToolError::invalid_params(
                    "worktreePath or worktreeSlug is required",
                ));
            }

            let rocky_home = match (
                ctx.services().workspace_registry.is_some(),
                &ctx.services().rocky_home,
            ) {
                (true, Some(home)) => home.clone(),
                _ => {
                    return Err(ToolError::not_wired(
                        "WorkspaceGitService is required to archive worktrees",
                    ))
                }
            };

            let scoped_cwd = resolve_scoped_cwd(&ctx, requested).await?;

            // Determine the target worktree path: explicit path wins; else
            // compute it from the worktree root + project id + slug.
            let target_path = match worktree_path {
                Some(path) => path,
                None => {
                    let slug = worktree_slug.expect("slug present when path absent");
                    let project_id =
                        rocky_workspaces::normalize_workspace_id(Path::new(&scoped_cwd));
                    let base_root = rocky_workspaces::resolve_worktree_root(
                        &rocky_home,
                        ctx.services().worktrees_root.as_deref(),
                    );
                    base_root
                        .join(project_id)
                        .join(slug)
                        .to_string_lossy()
                        .to_string()
                }
            };

            // Resolve the repo root the git commands run in: derive from the
            // worktree via git, falling back to the scoped cwd.
            let repo_root =
                match rocky_workspaces::derive_worktree_repo_root(Path::new(&target_path)).await {
                    Some(root) => Some(root),
                    None => Some(std::path::PathBuf::from(&scoped_cwd)),
                };

            rocky_workspaces::archive_worktree(repo_root.as_deref(), Path::new(&target_path))
                .await
                .map_err(|e| ToolError::execution("worktree_error", e.to_string()))?;

            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

// ---------------------------------------------------------------------------
// Provider tools (live ACP discovery; no static catalog)
// ---------------------------------------------------------------------------

/// `list_providers` (mcp-server.ts:2131-2151). The Rust daemon hosts exactly one
/// provider (`ctx.provider()`), so this returns a single-element list. Mode
/// availability is probed live via `list_modes`; a probe failure downgrades the
/// entry to `available: false` / `status: "error"` with a non-null `error`,
/// mirroring the availability shape in `daemon_read::provider_snapshot_entry`
/// (no fabricated catalog).
fn register_list_providers(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "list_providers".into(),
            title: "List providers".into(),
            description: "List configured agent providers, availability, and their modes.".into(),
            input_schema: object_schema(&[], &[("cwd", "string")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let requested = opt_str(map, "cwd")?;

            let Some(provider) = ctx.provider() else {
                return Err(ToolError::not_wired("provider is not configured"));
            };
            let provider_id = provider.id().to_string();
            let cwd = resolve_discovery_cwd(&ctx, requested).await;

            let entry = match provider.list_modes(&cwd).await {
                Ok(modes) => {
                    let modes = serde_json::to_value(modes)
                        .map_err(|e| ToolError::execution("serialize_error", e.to_string()))?;
                    json!({
                        "provider": provider_id,
                        "available": true,
                        "label": provider_id,
                        "modes": modes,
                        "status": "ready",
                    })
                }
                Err(e) => json!({
                    "provider": provider_id,
                    "available": false,
                    "label": provider_id,
                    "modes": [],
                    "status": "error",
                    "error": e.to_string(),
                }),
            };

            Ok(tool_result(json!({ "providers": [entry] })))
        }),
    );
}

/// `list_models` (mcp-server.ts:2153-2188). Probes the single live provider's
/// `list_models` for the resolved cwd. The `provider` argument is accepted (the
/// Rust daemon has only one provider) and echoed back in the output.
fn register_list_models(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "list_models".into(),
            title: "List models".into(),
            description: "List models for an agent provider.".into(),
            input_schema: object_schema(&[("provider", "string")], &[("cwd", "string")]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let provider_arg = req_str(map, "provider")?;
            let requested = opt_str(map, "cwd")?;

            let Some(provider) = ctx.provider() else {
                return Err(ToolError::not_wired("provider is not configured"));
            };
            let cwd = resolve_discovery_cwd(&ctx, requested).await;

            let models = provider
                .list_models(&cwd)
                .await
                .map_err(|e| ToolError::execution("provider_error", e.to_string()))?;
            let models = serde_json::to_value(models)
                .map_err(|e| ToolError::execution("serialize_error", e.to_string()))?;

            Ok(tool_result(json!({
                "provider": provider_arg,
                "models": models,
            })))
        }),
    );
}

/// `inspect_provider` (mcp-server.ts:2190-2241). Compact provider capabilities
/// for orchestration: modes + draft feature settings (and the selected model
/// echoed from `settings.model`). Use `list_models` for the full model list.
/// A discovery probe failure surfaces as an execution error rather than an
/// empty/fabricated capability set.
fn register_inspect_provider(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "inspect_provider".into(),
            title: "Inspect provider".into(),
            description:
                "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string" },
                    "cwd": { "type": "string" },
                    "settings": { "type": "object" },
                },
                "required": ["provider"],
                "additionalProperties": false,
            }),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let provider_arg = req_str(map, "provider")?;
            let requested = opt_str(map, "cwd")?;
            let settings = map.get("settings").and_then(Value::as_object);
            let selected_model = settings
                .and_then(|s| s.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string);

            let Some(provider) = ctx.provider() else {
                return Err(ToolError::not_wired("provider is not configured"));
            };
            let cwd = resolve_discovery_cwd(&ctx, requested).await;

            let modes = provider
                .list_modes(&cwd)
                .await
                .map_err(|e| ToolError::execution("provider_error", e.to_string()))?;
            let modes = serde_json::to_value(modes)
                .map_err(|e| ToolError::execution("serialize_error", e.to_string()))?;

            let features = provider
                .list_features(&cwd)
                .await
                .map_err(|e| ToolError::execution("provider_error", e.to_string()))?;

            Ok(tool_result(json!({
                "provider": provider_arg,
                "label": provider.id(),
                "description": Value::Null,
                "enabled": true,
                "status": "ready",
                "modes": modes,
                "selectedModel": selected_model,
                "features": features,
            })))
        }),
    );
}
