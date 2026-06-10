# Rocky Design Notes

Version 0.1.0 — the first fully Rocky-branded release.

## Principles

1. **One process, one port, one UI.** `server/rockyd.ts` boots the daemon
   core as an in-process library and serves the SPA, REST API, WebSocket
   stream, and agent MCP endpoint from port 7767. No sidecar processes
   except per-session agent CLIs.
2. **Self-contained.** Everything needed to run lives in this repository:
   the runtime monorepo (`core/`), the vendored agent runtime
   (`vendor/amaze`), skills, scripts, and config templates. No hosted relay,
   no update feed, no telemetry.
3. **amaze stays a separate CLI.** Per-session process isolation: rockyd
   spawns `bun vendor/amaze/.../cli.ts acp` for each agent session over ACP
   (stdio). A crashed agent never takes the server down.
4. **Orchestrator mode is a skill, not a subsystem.** A Leader agent
   decomposes a goal and delegates to parallel Teammate agents using the
   daemon's own MCP tools (`create_agent`, `wait_for_agent`,
   `send_agent_prompt`, …). Teammates default to isolated git worktrees;
   permissions stay per-agent in the daemon permission queue. See
   `skills/rocky-orchestrate/SKILL.md`.

## Identity

- Package scope `@getrocky/*`, version `0.1.0`, app/bundle id
  `one.clab.rocky`, home `~/.rocky`, port `7767`.
- Brand mark: a faceted rock. One geometry drives the desktop icon, web
  favicons (idle/running/attention), PWA icons, splash, and the in-app
  `RockyLogo` component. `npm run icons` regenerates all of them from
  `scripts/brand/make-icons.py`.
- Default theme: warm charcoal + copper (`rockyDarkColors` in
  `core/packages/app/src/styles/theme.ts`).

## Operational decisions

- Daemon binds loopback; remote access terminates TLS at an edge proxy
  (e.g. Caddy at `rocky.clab.one`) and reverse-proxies to 127.0.0.1:7767.
- Daemon password (bcrypt) gates all surfaces except `/api/health`.
  Agent-injected MCP self-calls use a boot-scoped `?rockyToken=` query
  secret accepted only under `/mcp/`.
- Relay/pairing is disabled by default (`relayEnabled: false`) since no
  hosted relay exists for a self-contained deployment.
- The amaze provider pins a known-good default model via
  `additionalModels[].isDefault` in `config/rocky.config.json`, so agent
  runs do not depend on whatever default the local agent config happens to
  carry.

## Regression contract

`scripts/smoke.sh` is the acceptance gate (run via `npm run smoke`):
single binary process, single origin for UI/SPA/API, a real end-to-end
agent run that writes a file, and a brand scrub asserting no upstream
branding ships in the served bundle.
