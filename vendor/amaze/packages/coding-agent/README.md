# @amaze/coding-agent

Core implementation package for the `amaze` coding agent in the `amaze` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/steve-8000/amaze#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- SDK surface: programmatic session, tool, mode, and extension exports live in `src/index.ts`.
- Task agents: subagent delegation is contract-driven and coordinated through the task runtime.
- Prompt caching: keep stable system/project context separate from volatile goal/session tail content.
- Measurement: coordination quality is evaluated with deterministic acceptance and runtime telemetry.
- MCP: configuration, lifecycle, and server tool authoring are implemented under `src/mcp/`.
- RenderMermaid: Mermaid rendering is provided by the package tool/runtime integration.
- [DEVELOPMENT](./DEVELOPMENT.md)
