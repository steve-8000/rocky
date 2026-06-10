/**
 * rockyd — the single Rocky server runtime.
 *
 * ONE Node process, ONE port (:7767), ONE UI:
 *   - Rocky daemon core (in-process library call) — agents, workspaces,
 *     worktrees, models, attachments, terminals, schedules, MCP, relay.
 *   - Rocky WebUI (Expo SPA) served at the daemon root, so http://host:7767
 *     is the UI and ws://host:7767 is the protocol — same origin, no extra
 *     server, no CORS hop.
 *
 * Orchestrator mode is native: the bundled
 * `rocky-orchestrate` skill drives Leader/Teammate orchestration over the
 * daemon's own MCP tools (chat room = mailbox, TEAM_BOARD.md = task board,
 * worktrees = teammate isolation, permission queue = per-agent dialogs).
 *
 * The vendored amaze runtime is the primary agent provider, registered as an
 * ACP provider in ~/.rocky/config.json (written by setup.sh). It runs as a
 * short-lived CLI per agent session — by design, not a server.
 *
 * Run via scripts/rockyd.sh.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRockyDaemon,
  loadConfig,
  resolveRockyHome,
} from "../core/packages/server/dist/server/server/exports.js";
import { createRootLogger } from "../core/packages/server/dist/server/server/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_UI_DIST = path.join(ROOT, "core", "packages", "app", "dist");

process.title = "rockyd";

async function main() {
  process.env.ROCKY_HOME ??= path.join(process.env.HOME ?? "~", ".rocky");

  const rockyHome = resolveRockyHome(process.env);
  const config = loadConfig(rockyHome);

  const staticDir = path.join(rockyHome, "public");
  mkdirSync(staticDir, { recursive: true });
  config.staticDir = staticDir;

  if (!existsSync(path.join(WEB_UI_DIST, "index.html"))) {
    throw new Error(`Rocky WebUI bundle missing at ${WEB_UI_DIST}. Run: npm run build:webui`);
  }
  config.webUiDir = WEB_UI_DIST;

  const logger = createRootLogger({ log: config.log }, { rockyHome, file: true });
  const daemon = await createRockyDaemon(config, logger);
  await daemon.start();

  const listen = daemon.getListenTarget();
  const listenLabel =
    listen?.type === "tcp" ? `${listen.host}:${listen.port}` : (listen?.path ?? "?");
  console.log(`[rockyd] up — UI + API + WS on http://${listenLabel} (home ${rockyHome})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[rockyd] ${signal} — shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    try {
      await daemon.stop();
      clearTimeout(force);
      process.exit(0);
    } catch {
      clearTimeout(force);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[rockyd] fatal:", err);
  process.exit(1);
});
