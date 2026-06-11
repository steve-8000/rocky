#!/usr/bin/env node
/**
 * Compatibility wrapper for the canonical supervised Rocky daemon.
 *
 * scripts/rockyd.sh is the production launch path. This file remains only so
 * older launchd plists or manual `node server/rockyd.ts` invocations still route
 * through the same supervisor/worker path instead of starting a second direct
 * daemon implementation.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.join(ROOT, "core");
const WEB_UI_DIST = path.join(CORE, "packages", "app", "dist");
const DIST_ENTRY = path.join(
  CORE,
  "packages",
  "server",
  "dist",
  "scripts",
  "supervisor-entrypoint.js",
);
const SRC_ENTRY = path.join(CORE, "packages", "server", "scripts", "supervisor-entrypoint.ts");

process.title = "rockyd";
process.env.ROCKY_HOME ??= path.join(process.env.HOME ?? "~", ".rocky");
process.env.ROCKY_STATIC_DIR ??= path.join(process.env.ROCKY_HOME, "public");
process.env.ROCKY_WEB_UI_DIR ??= WEB_UI_DIST;

if (!existsSync(path.join(process.env.ROCKY_WEB_UI_DIR, "index.html"))) {
  throw new Error(
    `Rocky WebUI bundle missing at ${process.env.ROCKY_WEB_UI_DIR}. Run: npm run build:webui`,
  );
}

const entry = existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY;
const args = entry.endsWith(".ts")
  ? ["--import", "tsx", entry, ...process.argv.slice(2)]
  : [entry, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, {
  cwd: CORE,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
