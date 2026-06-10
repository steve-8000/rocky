# Troubleshooting rockyd

Postmortem-grade notes for failures we have actually hit. Read this before
"fixing" the daemon by restarting things blindly.

## Incident: "the daemon is down" (2026-06-10)

Symptom report was "rockyd isn't working". The daemon was actually **up and
serving 200** the whole time. Two independent problems made it look dead:

### 1. Duplicate launchd jobs fighting over port 7767

Two LaunchAgents existed for the same daemon:

- `~/Library/LaunchAgents/one.clab.rocky.plist` → `scripts/rockyd.sh` (the real one)
- `~/Library/LaunchAgents/one.clab.rocky.rockyd.plist` → `npm start` (a stale duplicate)

Both had `KeepAlive: true`. Whichever bound `127.0.0.1:7767` first won; the
other crash-looped forever with `EADDRINUSE` (348 fatals in
`~/.rocky/rockyd.launchd.err.log`), burning CPU and filling logs. Depending on
which job won a given boot, the daemon could also be running **stale dist
code**.

**Fix applied:** the duplicate was removed:

```sh
launchctl bootout gui/$(id -u)/one.clab.rocky.rockyd
launchctl disable gui/$(id -u)/one.clab.rocky.rockyd
```

**Rules:**

- There is exactly ONE LaunchAgent for rockyd: `one.clab.rocky`.
  Never add a second plist that starts the daemon. If you need different env
  or args, edit the existing plist.
- Restart with `launchctl kickstart -k gui/$(id -u)/one.clab.rocky`,
  not by loading another job.
- `EADDRINUSE` on 7767 in the logs ⇒ check `launchctl list | grep rocky` for
  duplicates and `lsof -nP -iTCP:7767 -sTCP:LISTEN` for the owner. Do not
  "fix" it by changing the port.

### 2. Stale boot-scoped `rockyToken` → HTTP 401 spam after every restart

The daemon mints a fresh internal MCP secret on every boot
(`bootstrap.ts`: `internalMcpToken = randomUUID()`). When the daemon is
password-protected, that token is embedded in the rocky MCP URL injected into
every agent config:

```
http://127.0.0.1:7767/mcp/agents?rockyToken=<boot-uuid>&callerAgentId=<agent-id>
```

That full URL was **persisted** with the agent record under
`~/.rocky/agents/**/*.json`. After a daemon restart the token rotates, but
resumed agents replayed the persisted URL with the dead token → every MCP call
failed with `HTTP 401` ("Rejected HTTP request with invalid daemon password"
in `rockyd.out.log`, `rocky: HTTP 401` on the agent side), indefinitely.

**Fix applied** (`core/packages/server/src/server/agent/agent-manager.ts`):
`refreshInjectedRockyMcpServer()` re-derives the injected rocky entry from the
live `mcpBaseUrl` in both `resumeAgentFromPersistence` and
`reloadAgentSession`. Detection key: only daemon injection appends
`callerAgentId=` to the URL — user-provided rocky MCP configs lack it and are
left byte-for-byte untouched. If injection is disabled at resume time, the
stale entry is dropped instead of resurrected. Regression tests live in
`agent-manager.test.ts` ("refreshes stale injected rocky token" et al.).

**Rules:**

- `rockyToken` is **boot-scoped by design**. Any code path that replays a
  persisted agent config (resume, reload, import, future snapshot features)
  MUST pass it through `refreshInjectedRockyMcpServer()` (or equivalent)
  before the config reaches a provider session or re-persistence.
- Never widen token acceptance (e.g. accepting old tokens) to paper over 401s
  — refresh the URL at the consumer instead.
- A burst of `Rejected HTTP request with invalid daemon password` for
  `/mcp/agents` right after a restart ⇒ some path is replaying a persisted
  MCP URL without refreshing it.

## Incident: "Default permission mode: Bypass" still asks for permission (2026-06-10)

The global setting **Settings → Default permission mode → Bypass** kept being
ignored for Amaze (and any generic ACP provider): every `bash`/`edit` tool call
still raised a permission prompt.

### Root cause

The setting is a *mode-id mapping*, not a switch. The app's
`resolveGlobalAgentMode()` (`core/packages/app/src/provider-selection/resolve-agent-form.ts`)
looks for a mode named `bypass`/`bypassPermissions`/`full-access`/`allow-all`
**in the provider's advertised mode list**. Amaze only advertises `default` and
`plan` over ACP, so the lookup returned `null` and silently fell back to the
provider default (`default`) — that's the "when the provider supports it"
caveat in the settings UI.

The irony: the server plumbing already supported autonomous approval.
`GenericACPAgentClient` treats the modeId aliases above as "Rocky-handled
bypass" (`isRockyAutonomousApprovalPolicy` → `autonomousPermissionsEnabled` →
auto-allow in `ACPAgentSession.requestPermission`). The only gap was that no
such mode ever reached the agent config, because the UI filtered it out.

### Fix applied (`core/packages/server/src/server/agent/providers/generic-acp-agent.ts`)

1. `modesTransformer: appendRockyBypassMode` — generic ACP providers now
   advertise a synthetic `bypass` mode (`isUnattended: true`) alongside the
   agent's own modes, unless the agent already exposes an autonomous mode.
   The mode is handled entirely by Rocky (`providerModeWriter` swallows it; it
   is never forwarded to the agent, which would reject it).
2. `resolveCreateConfig` override — Rocky approval aliases (`never`,
   `bypassPermissions`, `full-access`, `allow-all`) are normalized to the
   advertised `bypass` id at create time so MCP callers, team rosters, and the
   CLI all pass validation regardless of which alias they use.
3. Team roster repair: the live `~/.rocky/config.json` `daemon.teamAgents`
   entries had lost their `"approvalPolicy": "never"` fields (present in the
   repo template `config/rocky.config.json`). Restored, so Leader-spawned
   Teammates run unattended again.

Regression tests: `generic-acp-agent.test.ts` ("advertises a Rocky bypass
mode…", "normalizes Rocky approval aliases…").

### Rules

- The global permission preference only works for mode ids the provider
  *advertises*. If a provider should support bypass, make its client advertise
  an autonomous mode (or reuse `appendRockyBypassMode`) — do NOT special-case
  the app-side mapping.
- Autonomous approval for generic ACP agents is Rocky-side
  (`autonomousPermissionsEnabled`), never forwarded to the agent. Don't try to
  `setSessionMode("bypass")` on an agent that doesn't list it.
- `daemon.teamAgents[*].approvalPolicy: "never"` is required for unattended
  team agents. If team agents start prompting, diff the live config against
  `config/rocky.config.json` first.

## Diagnostic quick reference

```sh
launchctl list | grep rocky                      # exactly one job: one.clab.rocky
lsof -nP -iTCP:7767 -sTCP:LISTEN                 # who owns the port
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7767/   # expect 200
tail -f ~/.rocky/rockyd.out.log                  # live daemon log (launchd stdout)
~/.rocky/rockyd.launchd.err.log                  # fatal crashes (EADDRINUSE etc.)
~/.rocky/daemon.log                              # structured daemon log
```

Restart (drops live agent sessions — coordinate first):

```sh
launchctl kickstart -k gui/$(id -u)/one.clab.rocky
```

After changing server code, the daemon runs **dist**, not src — rebuild before
restarting or you restart into the old bug:

```sh
cd core && npm run build:server
```
