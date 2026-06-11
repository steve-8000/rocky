# Team Board — Canonical Rocky daemon and Mission Control implementation

| # | Task | Owner (agent id) | Isolation | Status | Result |
|---|------|------------------|-----------|--------|--------|
| 1 | Source-grounded implementation plan | leader | shared | done | Implement current TypeScript daemon unification plus first-class Mission Control slice before Rust cutover. |
| 2 | Canonical daemon launch unification | leader | shared | done | WebUI/static config moved into loadConfig/bootstrap; scripts/rockyd.sh and server/rockyd.ts now route through supervisor. |
| 3 | Mission Control storage and API domain | leader | shared | done | Added durable mission store, protocol schemas, session RPC handlers, DaemonClient methods, and CLI mission commands. |
| 4 | Mission Control MCP tools | leader | shared | done | Added create/list/inspect mission and create/update task MCP tools. |
| 5 | Tests and verification | leader | shared | done | 7-file Mission Control regression, app stream/supervisor regression, full typecheck, full lint, server build, and WebUI build passed. |
