---
title: CLI
description: "Rocky CLI reference: manage agents, daemons, permissions, and worktrees from your terminal."
nav: CLI
order: 6
---

# CLI

The Rocky CLI lets you manage agents from your terminal. It's the same interface exposed by the daemon's API, so anything you can do in the app you can do from the command line.

> **Agent orchestration:** You can tell coding agents to use the Rocky CLI to spawn and manage other agents. This enables multi-agent workflows where one agent delegates subtasks to others and waits for results.

## Quick reference

```bash
rocky run "fix the tests"            # Start an agent
rocky ls                             # List running agents
rocky attach <id>                    # Stream agent output
rocky send <id> "also fix linting"   # Send follow-up task
rocky logs <id>                      # View agent timeline
rocky stop <id>                      # Stop an agent
```

## Running agents

Use `rocky run` to start a new agent with a task:

```bash
rocky run "implement user authentication"
rocky run --provider codex "refactor the API layer"
rocky run --detach "run the full test suite"  # background
rocky run --worktree feature-x "implement feature X"
rocky run --output-schema schema.json "extract release notes"
rocky run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

The `--worktree` flag creates the agent in an isolated git worktree, useful for parallel feature development.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--detach`.

By default, `rocky run` waits for completion. Use `--detach` to run in the background.

## Listing agents

```bash
rocky ls                    # Running agents in current directory
rocky ls -a                 # Include completed/stopped agents
rocky ls -g                 # All directories
rocky ls -a -g --json       # Full list as JSON
```

## Streaming output

Use `rocky attach` to stream an agent's output in real-time:

```bash
rocky attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent IDs can be shortened, `abc` works if it's unambiguous.

## Sending messages

Send follow-up tasks to a running or idle agent:

```bash
rocky send <id> "now run the tests"
rocky send <id> --image screenshot.png "what's wrong here?"
rocky send <id> --no-wait "queue this task"
```

## Viewing logs

```bash
rocky logs <id>                  # Full timeline
rocky logs <id> -f               # Follow (streaming)
rocky logs <id> --tail 10        # Last 10 entries
rocky logs <id> --filter tools   # Only tool calls
```

## Waiting for agents

Block until an agent finishes its current task:

```bash
rocky wait <id>
rocky wait <id> --timeout 60   # 60 second timeout
```

Useful in scripts or when one agent needs to wait for another.

## Permissions

Agents may request permission for certain actions. Manage these from the CLI:

```bash
rocky permit ls                # List pending requests
rocky permit allow <id>        # Allow all pending for agent
rocky permit deny <id> --all   # Deny all pending
```

## Agent modes

Change an agent's operational mode (provider-specific):

```bash
rocky agent mode <id> --list   # Show available modes
rocky agent mode <id> bypass   # Set bypass mode
rocky agent mode <id> plan     # Set plan mode
```

## Daemon management

```bash
rocky daemon start             # Start the daemon
rocky daemon status            # Check status
rocky daemon stop              # Stop the daemon
```

Use `ROCKY_HOME` to run multiple isolated daemon instances.

## Connecting to a remote daemon

`--host` accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a pairing offer URL, the same `https://app.rocky.sh/#offer=...` link the mobile app uses for QR pairing. With an offer URL the CLI connects through the Rocky relay with end-to-end encryption, so you can drive a daemon on another machine without exposing it to the network.

Get an offer URL from the daemon you want to control:

```bash
rocky daemon pair --json   # prints { url, qr, ... }
```

Use it from anywhere:

```bash
rocky ls --host 'https://app.rocky.sh/#offer=eyJ2IjoyLC...'
rocky run --host "$OFFER_URL" "fix the failing tests"
```

You can also set it once via `ROCKY_HOST` instead of passing `--host` on every command.

## Multi-agent workflows

The CLI is designed to be used by agents themselves. You can instruct an agent to spawn sub-agents for parallel work:

```bash
# Agent A spawns Agent B and waits for it
rocky run --detach "implement the API" --name api-agent
rocky wait api-agent
rocky logs api-agent --tail 5
```

Simple implement + verify loop:

```bash
# Requires jq
while true; do
  rocky run --provider codex "make the tests pass" >/dev/null

  verdict=$(rocky run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

This pattern enables hierarchical task decomposition, a lead agent can break down work, delegate to specialists, and synthesize results.

## Output formats

Most commands support multiple output formats for scripting:

```bash
rocky ls --json                # JSON output
rocky ls --format yaml         # YAML output
rocky ls -q                    # IDs only (quiet)
```

## Global options

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or `https://app.rocky.sh/#offer=...` for relay). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
