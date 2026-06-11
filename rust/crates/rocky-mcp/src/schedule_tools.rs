//! Schedule MCP tools: `create_schedule`, `create_heartbeat`, `list_schedules`,
//! `inspect_schedule`, `pause_schedule`, `resume_schedule`, `delete_schedule`,
//! `update_schedule`, and `schedule_logs`.
//!
//! Ports the 9 schedule tools from
//! `core/packages/server/src/server/agent/mcp-server.ts` (lines 1815-2129),
//! plus the local helpers `resolveScheduleProviderAndModel` (lines 279-299),
//! `resolveScheduleUpdateProviderAndModel` (lines 301-340),
//! `normalizeScheduleCadenceArg`/`normalizeScheduleTimeZoneArg` (lines 358-373),
//! `resolveScheduleUpdateCadence` (lines 375-397),
//! `resolveScheduleUpdateExpiresAt` (lines 399-410),
//! `buildScheduleUpdateInput` (lines 412-435),
//! `buildCronScheduleCadence` (lines 528-542),
//! `buildScheduleExpiry` (lines 544-548),
//! `resolveNewAgentScheduleTarget` (lines 641-666), and
//! `parseDurationString`/`toScheduleSummary` (mcp-shared.ts lines 221-258).
//!
//! All tools delegate to the shared [`rocky_scheduling::ScheduleService`] wired
//! into [`crate::McpServices::schedule_service`]; when unwired they surface a
//! structured `not_wired` error rather than faking success.

use std::sync::{Arc, Mutex};

use rocky_scheduling::{
    CreateScheduleInput, NewAgentConfigPatch, ScheduleService, ScheduleServiceError,
    UpdateScheduleInput,
};
use rocky_store::{ScheduleCadence, ScheduleNewAgentConfig, ScheduleTarget, StoredSchedule};
use serde_json::{json, Map, Value};

use crate::context::CallCtx;
use crate::protocol::{tool_result, ToolDescriptor, ToolError, ToolRegistry};
use crate::tools::{as_object, boxed, object_schema, opt_bool, opt_nullable_str, opt_str, req_str};

/// Register the 9 schedule tools on `registry`.
pub fn register(registry: &mut ToolRegistry) {
    register_create_schedule(registry);
    register_create_heartbeat(registry);
    register_list_schedules(registry);
    register_inspect_schedule(registry);
    register_pause_schedule(registry);
    register_resume_schedule(registry);
    register_delete_schedule(registry);
    register_update_schedule(registry);
    register_schedule_logs(registry);
}

// --- error mapping ----------------------------------------------------------

/// Map a [`ScheduleServiceError`] to a tool execution error
/// (`error.data.code = "schedule_error"`).
fn schedule_err(e: ScheduleServiceError) -> ToolError {
    ToolError::execution("schedule_error", e.to_string())
}

/// Map a JSON serialization failure to a tool execution error.
fn serialize_err(e: serde_json::Error) -> ToolError {
    ToolError::execution("serialize", e.to_string())
}

// --- service access ---------------------------------------------------------

/// Resolve the shared schedule service handle, mirroring the TS
/// `if (!scheduleService) throw new Error("Schedule service is not configured")`
/// guard at the top of every schedule tool (mcp-server.ts lines 1840-1842 etc.).
fn schedule_service(ctx: &CallCtx) -> Result<Arc<Mutex<ScheduleService>>, ToolError> {
    ctx.services()
        .schedule_service
        .clone()
        .ok_or_else(|| ToolError::not_wired("Schedule service is not configured"))
}

// --- summary projection -----------------------------------------------------

/// Port of `toScheduleSummary` (mcp-shared.ts lines 255-258): serialize a
/// [`StoredSchedule`] and strip the `runs` field.
fn schedule_summary(schedule: &StoredSchedule) -> Result<Value, ToolError> {
    let mut value = serde_json::to_value(schedule).map_err(serialize_err)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("runs");
    }
    Ok(value)
}

// --- duration / cadence / expiry helpers ------------------------------------

/// Port of `parseDurationString` (mcp-shared.ts lines 221-253). A trimmed,
/// all-digit input is interpreted as seconds (`n * 1000` ms). Otherwise every
/// `(\d+)([smh])` run is summed (`s*1000`, `m*60000`, `h*3600000`); if no run
/// matches the format is rejected. Implemented without the regex crate by
/// accumulating digit runs and consuming a trailing unit character.
fn parse_duration_string(input: &str) -> Result<i64, ToolError> {
    let trimmed = input.trim();

    if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
        let n: i64 = trimmed.parse().map_err(|_| {
            ToolError::invalid_params(format!(
                "Invalid duration format: {input}. Use formats like: 5m, 30s, 1h, 2h30m"
            ))
        })?;
        return Ok(n * 1000);
    }

    let mut total_ms: i64 = 0;
    let mut has_match = false;
    let mut digits = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        // Mirror `(\d+)([smh])`: a unit only matches when immediately preceded
        // by one or more digits; any other character (or a unit without
        // preceding digits) resets the pending digit run.
        if matches!(ch, 's' | 'm' | 'h') && !digits.is_empty() {
            let value: i64 = digits.parse().map_err(|_| {
                ToolError::invalid_params(format!(
                    "Invalid duration format: {input}. Use formats like: 5m, 30s, 1h, 2h30m"
                ))
            })?;
            total_ms += match ch {
                's' => value * 1000,
                'm' => value * 60 * 1000,
                _ => value * 60 * 60 * 1000,
            };
            has_match = true;
        }
        digits.clear();
    }

    if !has_match {
        return Err(ToolError::invalid_params(format!(
            "Invalid duration format: {input}. Use formats like: 5m, 30s, 1h, 2h30m"
        )));
    }

    Ok(total_ms)
}

/// Format a unix-millisecond instant as a JS `Date.toISOString()`-compatible
/// string (`YYYY-MM-DDTHH:MM:SS.mmmZ`, always UTC, millisecond precision).
///
/// Implemented with `std` only (Howard Hinnant's `civil_from_days`) so this
/// module needs no extra crate dependency; it produces the same shape as the
/// `rocky_scheduling` `to_iso_millis` helper used elsewhere.
fn iso8601_from_unix_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    // civil_from_days: days since 1970-01-01 -> (year, month, day).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

/// Current wall-clock time in unix milliseconds.
fn now_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Port of `buildScheduleExpiry` (mcp-server.ts lines 544-548): `None` when no
/// relative duration is given, else `now + parseDurationString` as an ISO
/// string.
fn build_schedule_expiry(expires_in: Option<&str>) -> Result<Option<String>, ToolError> {
    match expires_in {
        None => Ok(None),
        Some(value) => {
            let ms = parse_duration_string(value)?;
            Ok(Some(iso8601_from_unix_millis(now_unix_millis() + ms)))
        }
    }
}

/// Port of `normalizeScheduleCadenceArg` / `normalizeScheduleTimeZoneArg`
/// (mcp-server.ts lines 358-373): trim, mapping empty to `None`.
fn normalize_cadence_arg(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Port of `buildCronScheduleCadence` (mcp-server.ts lines 528-542): require a
/// non-empty cron expression and attach an optional, normalized timezone.
fn build_cron_cadence(cron: &str, timezone: Option<String>) -> Result<ScheduleCadence, ToolError> {
    let expression = cron.trim();
    if expression.is_empty() {
        return Err(ToolError::invalid_params("cron is required"));
    }
    Ok(ScheduleCadence::Cron {
        expression: expression.to_string(),
        timezone: normalize_cadence_arg(timezone),
    })
}

/// Split a `provider` / `provider/model` pair, mirroring
/// `resolveScheduleProviderAndModel` (mcp-server.ts lines 279-299) for the
/// new-agent create path: no slash -> `(provider, None)`; otherwise
/// `(provider, Some(model))`.
fn split_provider_model(provider: &str) -> (String, Option<String>) {
    match provider.split_once('/') {
        Some((p, m)) if !m.is_empty() => (p.to_string(), Some(m.to_string())),
        _ => (provider.to_string(), None),
    }
}

/// Trim a name argument, mapping empty to `None`, matching the TS
/// `name?.trim() ? { name: name.trim() } : {}` spread.
fn trim_optional_name(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Optional nullable integer patch field: absent -> `None`; JSON null ->
/// `Some(None)` (clear); integer -> `Some(Some(..))`. Mirrors `opt_nullable_str`
/// for the `maxRuns` update argument.
fn opt_nullable_i64(args: &Map<String, Value>, key: &str) -> Result<Option<Option<i64>>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => match v.as_i64() {
            Some(n) => Ok(Some(Some(n))),
            None => Err(ToolError::invalid_params(format!(
                "`{key}` must be an integer or null"
            ))),
        },
    }
}

// --- create_schedule (mcp-server.ts lines 1815-1862) ------------------------

fn register_create_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "create_schedule".into(),
            title: "Create schedule".into(),
            description:
                "Create a recurring schedule that starts a new agent on a cron cadence.".into(),
            input_schema: object_schema(
                &[
                    ("prompt", "string"),
                    ("cron", "string"),
                    ("provider", "string"),
                ],
                &[
                    ("timezone", "string"),
                    ("name", "string"),
                    ("cwd", "string"),
                    ("maxRuns", "number"),
                    ("expiresIn", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;

            // prompt: z.string().trim().min(1, "prompt is required").
            let prompt = opt_str(map, "prompt")?.unwrap_or_default();
            let prompt = prompt.trim();
            if prompt.is_empty() {
                return Err(ToolError::invalid_params("prompt is required"));
            }

            // Resolve the new-agent target (resolveNewAgentScheduleTarget,
            // lines 641-666): provider is required and split into provider/model.
            let provider = opt_str(map, "provider")?.unwrap_or_default();
            let provider = provider.trim();
            if provider.is_empty() {
                return Err(ToolError::invalid_params(
                    "provider is required when target is new-agent",
                ));
            }
            let (provider, model) = split_provider_model(provider);

            // cwd: explicit argument, else the caller agent's cwd.
            let cwd = match opt_str(map, "cwd")? {
                Some(c) if !c.trim().is_empty() => c.trim().to_string(),
                _ => {
                    let caller_cwd = match ctx.caller_agent_id() {
                        Some(id) => ctx.agent_manager().get(id).await.map(|a| a.cwd),
                        None => None,
                    };
                    caller_cwd
                        .ok_or_else(|| ToolError::invalid_params("cwd is required"))?
                }
            };

            let cadence = build_cron_cadence(
                &opt_str(map, "cron")?.unwrap_or_default(),
                opt_str(map, "timezone")?,
            )?;
            let expires_at = build_schedule_expiry(opt_str(map, "expiresIn")?.as_deref())?;
            let max_runs = map.get("maxRuns").and_then(Value::as_i64);
            let name = trim_optional_name(opt_str(map, "name")?);

            let target = ScheduleTarget::NewAgent {
                config: Box::new(ScheduleNewAgentConfig {
                    provider,
                    cwd,
                    mode_id: None,
                    model,
                    thinking_option_id: None,
                    title: None,
                    approval_policy: None,
                    sandbox_mode: None,
                    network_access: None,
                    web_search: None,
                    feature_values: None,
                    extra: None,
                    system_prompt: None,
                    mcp_servers: None,
                }),
            };

            let input = CreateScheduleInput {
                name,
                prompt: prompt.to_string(),
                cadence,
                target,
                expires_at,
                max_runs,
                run_on_create: None,
            };

            let svc = schedule_service(&ctx)?;
            let schedule = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .create_schedule(input)
                .map_err(schedule_err)?;
            Ok(tool_result(schedule_summary(&schedule)?))
        }),
    );
}

// --- create_heartbeat (mcp-server.ts lines 1864-1911) -----------------------

fn register_create_heartbeat(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "create_heartbeat".into(),
            title: "Create heartbeat".into(),
            description:
                "Create a recurring heartbeat that sends you a prompt on a cron cadence.".into(),
            input_schema: object_schema(
                &[("prompt", "string"), ("cron", "string")],
                &[
                    ("timezone", "string"),
                    ("name", "string"),
                    ("maxRuns", "number"),
                    ("expiresIn", "string"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;

            let prompt = opt_str(map, "prompt")?.unwrap_or_default();
            let prompt = prompt.trim();
            if prompt.is_empty() {
                return Err(ToolError::invalid_params("prompt is required"));
            }

            // Heartbeats target the caller agent itself.
            let agent_id = ctx.caller_agent_id().ok_or_else(|| {
                ToolError::invalid_params("create_heartbeat requires an agent-scoped session")
            })?;
            let target = ScheduleTarget::Agent {
                agent_id: agent_id.to_string(),
            };

            let cadence = build_cron_cadence(
                &opt_str(map, "cron")?.unwrap_or_default(),
                opt_str(map, "timezone")?,
            )?;
            let expires_at = build_schedule_expiry(opt_str(map, "expiresIn")?.as_deref())?;
            let max_runs = map.get("maxRuns").and_then(Value::as_i64);
            let name = trim_optional_name(opt_str(map, "name")?);

            let input = CreateScheduleInput {
                name,
                prompt: prompt.to_string(),
                cadence,
                target,
                expires_at,
                max_runs,
                run_on_create: None,
            };

            let svc = schedule_service(&ctx)?;
            let schedule = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .create_schedule(input)
                .map_err(schedule_err)?;
            Ok(tool_result(schedule_summary(&schedule)?))
        }),
    );
}

// --- list_schedules (mcp-server.ts lines 1913-1936) -------------------------

fn register_list_schedules(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "list_schedules".into(),
            title: "List schedules".into(),
            description: "List all schedules managed by the daemon.".into(),
            input_schema: object_schema(&[], &[]),
        },
        boxed(|_args, ctx| async move {
            let svc = schedule_service(&ctx)?;
            let schedules = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .list();
            let summaries: Result<Vec<Value>, ToolError> =
                schedules.iter().map(schedule_summary).collect();
            Ok(tool_result(json!({ "schedules": summaries? })))
        }),
    );
}

// --- inspect_schedule (mcp-server.ts lines 1938-1959) -----------------------

fn register_inspect_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "inspect_schedule".into(),
            title: "Inspect schedule".into(),
            description: "Inspect a schedule and its run history.".into(),
            input_schema: object_schema(&[("id", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let id = req_str(map, "id")?;
            let svc = schedule_service(&ctx)?;
            let schedule = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .inspect(&id)
                .map_err(schedule_err)?;
            Ok(tool_result(
                serde_json::to_value(&schedule).map_err(serialize_err)?,
            ))
        }),
    );
}

// --- pause_schedule (mcp-server.ts lines 1961-1984) -------------------------

fn register_pause_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "pause_schedule".into(),
            title: "Pause schedule".into(),
            description: "Pause an active schedule.".into(),
            input_schema: object_schema(&[("id", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let id = req_str(map, "id")?;
            let svc = schedule_service(&ctx)?;
            svc.lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .pause(&id)
                .map_err(schedule_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

// --- resume_schedule (mcp-server.ts lines 1986-2009) ------------------------

fn register_resume_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "resume_schedule".into(),
            title: "Resume schedule".into(),
            description: "Resume a paused schedule.".into(),
            input_schema: object_schema(&[("id", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let id = req_str(map, "id")?;
            let svc = schedule_service(&ctx)?;
            svc.lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .resume(&id)
                .map_err(schedule_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

// --- delete_schedule (mcp-server.ts lines 2011-2034) ------------------------

fn register_delete_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "delete_schedule".into(),
            title: "Delete schedule".into(),
            description: "Delete a schedule permanently.".into(),
            input_schema: object_schema(&[("id", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let id = req_str(map, "id")?;
            let svc = schedule_service(&ctx)?;
            svc.lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .delete(&id)
                .map_err(schedule_err)?;
            Ok(tool_result(json!({ "success": true })))
        }),
    );
}

// --- update_schedule (mcp-server.ts lines 2036-2104) ------------------------

/// Port of `resolveScheduleUpdateCadence` (mcp-server.ts lines 375-397):
/// normalize `every`/`cron`/`timezone`, reject conflicting/invalid combinations,
/// and build the new cadence (if any).
fn resolve_update_cadence(map: &Map<String, Value>) -> Result<Option<ScheduleCadence>, ToolError> {
    let every = normalize_cadence_arg(opt_str(map, "every")?);
    let cron = normalize_cadence_arg(opt_str(map, "cron")?);
    let timezone = normalize_cadence_arg(opt_str(map, "timezone")?);

    if every.is_some() && cron.is_some() {
        return Err(ToolError::invalid_params(
            "Specify at most one of every or cron",
        ));
    }
    if timezone.is_some() && cron.is_none() {
        return Err(ToolError::invalid_params(
            "timezone can only be used with cron",
        ));
    }
    if let Some(every) = every {
        return Ok(Some(ScheduleCadence::Every {
            every_ms: parse_duration_string(&every)?,
        }));
    }
    if let Some(cron) = cron {
        return Ok(Some(ScheduleCadence::Cron {
            expression: cron,
            timezone,
        }));
    }
    Ok(None)
}

/// Port of `resolveScheduleUpdateExpiresAt` (mcp-server.ts lines 399-410):
/// absent -> `None`; `expiresIn` -> `Some(Some(iso))`; `clearExpires` ->
/// `Some(None)`. The two are mutually exclusive.
fn resolve_update_expires_at(
    map: &Map<String, Value>,
) -> Result<Option<Option<String>>, ToolError> {
    let expires_in = opt_str(map, "expiresIn")?;
    let clear_expires = opt_bool(map, "clearExpires")?.unwrap_or(false);

    if expires_in.is_some() && clear_expires {
        return Err(ToolError::invalid_params(
            "Specify at most one of expiresIn or clearExpires",
        ));
    }
    if let Some(expires_in) = expires_in {
        let ms = parse_duration_string(&expires_in)?;
        return Ok(Some(Some(iso8601_from_unix_millis(now_unix_millis() + ms))));
    }
    if clear_expires {
        return Ok(Some(None));
    }
    Ok(None)
}

/// Port of `resolveScheduleUpdateProviderAndModel` (mcp-server.ts lines
/// 301-340). Returns `(provider, model)` where each `Option` reflects field
/// presence and the inner model `Option` distinguishes a cleared (`null`)
/// value from a set value.
fn resolve_update_provider_model(
    provider_arg: Option<String>,
    model_arg: &Option<Option<String>>,
) -> Result<(Option<String>, Option<Option<String>>), ToolError> {
    // `model !== undefined && modelInput === ""` -> "model cannot be empty".
    if let Some(Some(s)) = model_arg {
        if s.trim().is_empty() {
            return Err(ToolError::invalid_params("model cannot be empty"));
        }
    }
    // modelInput: undefined -> None; null -> Some(None); string -> Some(Some(trim)).
    let model_input: Option<Option<String>> = model_arg
        .as_ref()
        .map(|m| m.as_ref().map(|s| s.trim().to_string()));
    let model_present = model_arg.is_some();

    let provider_input = provider_arg
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let Some(provider_input) = provider_input else {
        // `!providerInput`: return only the model patch (if present).
        return Ok((None, if model_present { model_input } else { None }));
    };

    match provider_input.split_once('/') {
        None => Ok((
            Some(provider_input),
            if model_present { model_input } else { None },
        )),
        Some((provider, model_from_provider)) => {
            let provider = provider.trim();
            let model_from_provider = model_from_provider.trim();
            if provider.is_empty() || model_from_provider.is_empty() {
                return Err(ToolError::invalid_params(
                    "provider must be <provider> or <provider>/<model>",
                ));
            }
            // `params.model === null`.
            if matches!(model_arg, Some(None)) {
                return Err(ToolError::invalid_params(
                    "provider specifies a model but model is null",
                ));
            }
            // `typeof modelInput === "string" && modelInput !== modelFromProvider`.
            if let Some(Some(mi)) = &model_input {
                if mi != model_from_provider {
                    return Err(ToolError::invalid_params("Conflicting model values provided"));
                }
            }
            // `model: modelInput ?? modelFromProvider`.
            let resolved_model = match &model_input {
                Some(Some(mi)) => mi.clone(),
                _ => model_from_provider.to_string(),
            };
            Ok((Some(provider.to_string()), Some(Some(resolved_model))))
        }
    }
}

/// Port of `buildScheduleUpdateInput` (mcp-server.ts lines 412-435): assemble
/// an [`UpdateScheduleInput`] from the present tool arguments only.
fn build_schedule_update_input(map: &Map<String, Value>) -> Result<UpdateScheduleInput, ToolError> {
    let id = req_str(map, "id")?;
    let cadence = resolve_update_cadence(map)?;
    let expires_at = resolve_update_expires_at(map)?;

    let model_arg = opt_nullable_str(map, "model")?;
    let (provider_patch, model_patch) =
        resolve_update_provider_model(opt_str(map, "provider")?, &model_arg)?;
    let mode_patch = opt_nullable_str(map, "mode")?;
    let cwd_patch = opt_str(map, "cwd")?;

    let new_agent_config = if provider_patch.is_some()
        || model_patch.is_some()
        || mode_patch.is_some()
        || cwd_patch.is_some()
    {
        Some(NewAgentConfigPatch {
            provider: provider_patch,
            cwd: cwd_patch,
            model: model_patch,
            mode_id: mode_patch,
        })
    } else {
        None
    };

    Ok(UpdateScheduleInput {
        id,
        prompt: opt_str(map, "prompt")?,
        name: opt_nullable_str(map, "name")?,
        cadence,
        new_agent_config,
        max_runs: opt_nullable_i64(map, "maxRuns")?,
        expires_at,
    })
}

fn register_update_schedule(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "update_schedule".into(),
            title: "Update schedule".into(),
            description:
                "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged."
                    .into(),
            input_schema: object_schema(
                &[("id", "string")],
                &[
                    ("every", "string"),
                    ("cron", "string"),
                    ("timezone", "string"),
                    ("name", "string"),
                    ("prompt", "string"),
                    ("maxRuns", "number"),
                    ("provider", "string"),
                    ("model", "string"),
                    ("mode", "string"),
                    ("cwd", "string"),
                    ("expiresIn", "string"),
                    ("clearExpires", "boolean"),
                ],
            ),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let input = build_schedule_update_input(map)?;
            let svc = schedule_service(&ctx)?;
            let schedule = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .update(input)
                .map_err(schedule_err)?;
            Ok(tool_result(
                serde_json::to_value(&schedule).map_err(serialize_err)?,
            ))
        }),
    );
}

// --- schedule_logs (mcp-server.ts lines 2106-2129) --------------------------

fn register_schedule_logs(registry: &mut ToolRegistry) {
    registry.register(
        ToolDescriptor {
            name: "schedule_logs".into(),
            title: "Schedule logs".into(),
            description: "Get the run history (logs) for a schedule.".into(),
            input_schema: object_schema(&[("id", "string")], &[]),
        },
        boxed(|args, ctx| async move {
            let map = as_object(&args)?;
            let id = req_str(map, "id")?;
            let svc = schedule_service(&ctx)?;
            let schedule = svc
                .lock()
                .map_err(|_| ToolError::execution("poisoned", "schedule service mutex poisoned"))?
                .inspect(&id)
                .map_err(schedule_err)?;
            let runs = serde_json::to_value(&schedule.runs).map_err(serialize_err)?;
            Ok(tool_result(json!({ "runs": runs })))
        }),
    );
}
