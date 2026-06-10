/**
 * rockyd — the single Rocky server runtime.
 *
 * One Node process hosting all three integrated layers:
 *   1. Paseo daemon (in-process library call)       → ws/http :7767
 *   2. Rocky WebUI (Expo SPA, static)               → http    :7780
 *   3. AionUi WebUI (SPA + /api proxy via web-host) → http    :25808
 *      - aioncore (Rust backend, prebuilt binary) runs as a managed child;
 *        its source is not in the AionUi repo, so in-process is impossible.
 *
 * The vendored amaze runtime is registered on both sides:
 *   - Paseo: ACP provider in ~/.rocky/config.json (written by setup.sh)
 *   - AionUi: custom ACP agent registered against aioncore's HTTP API below
 *
 * Run via scripts/rockyd.sh (node --import tsx, cwd=vendor/paseo).
 */

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPaseoDaemon,
  loadConfig,
  resolvePaseoHome,
} from "../vendor/paseo/packages/server/dist/server/server/exports.js";
import { createRootLogger } from "../vendor/paseo/packages/server/dist/server/server/logger.js";
import { startWebHost } from "../vendor/aionui/packages/web-host/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROCKY_WEBUI_PORT = Number(process.env.ROCKY_WEBUI_PORT ?? 7780);
const AIONUI_PORT = Number(process.env.ROCKY_AIONUI_PORT ?? 25808);
const ALLOW_REMOTE = process.env.ROCKY_ALLOW_REMOTE !== "0";

const PASEO_APP_DIST = path.join(ROOT, "vendor", "paseo", "packages", "app", "dist");
const AIONUI_STATIC = path.join(ROOT, "vendor", "aionui", "out", "renderer");
const AIONCORE_BIN = path.join(
  ROOT,
  "vendor",
  "aionui",
  "resources",
  "bundled-aioncore",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "aioncore.exe" : "aioncore",
);
const AMAZE_CLI = path.join(ROOT, "vendor", "amaze", "packages", "coding-agent", "src", "cli.ts");

process.title = "rockyd";

// ───────────────────────── Layer 2: Paseo daemon ─────────────────────────

async function startDaemon() {
  const paseoHome = resolvePaseoHome(process.env); // ROCKY home via PASEO_HOME
  const config = loadConfig(paseoHome);
  const staticDir = path.join(paseoHome, "public");
  mkdirSync(staticDir, { recursive: true });
  config.staticDir = staticDir;

  const logger = createRootLogger({ log: config.log }, { paseoHome, file: true });
  const daemon = await createPaseoDaemon(config, logger);
  await daemon.start();
  const listen = daemon.getListenTarget();
  const listenLabel =
    listen?.type === "tcp" ? `${listen.host}:${listen.port}` : (listen?.path ?? "?");
  console.log(`[rockyd] paseo daemon    : ws://${listenLabel} (home ${paseoHome})`);
  return daemon;
}

// ──────────────────── Layer 2 UI: Rocky WebUI (static) ────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

function startRockyWebUI(): Promise<http.Server> {
  if (!existsSync(path.join(PASEO_APP_DIST, "index.html"))) {
    throw new Error(`Rocky WebUI bundle missing at ${PASEO_APP_DIST}. Run: npm run build:webui`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let filePath = path.join(PASEO_APP_DIST, decodeURIComponent(url.pathname));
    const rel = path.relative(PASEO_APP_DIST, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory() || !path.extname(filePath)) {
      filePath = path.join(PASEO_APP_DIST, "index.html");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    createReadStream(filePath).pipe(res);
  });
  const host = ALLOW_REMOTE ? "0.0.0.0" : "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ROCKY_WEBUI_PORT, host, () => {
      console.log(`[rockyd] rocky webui     : http://${host}:${ROCKY_WEBUI_PORT}`);
      resolve(server);
    });
  });
}

// ─────────────── Layer 3: AionUi web-host (+ aioncore child) ───────────────

async function startAionUi() {
  if (!existsSync(AIONCORE_BIN)) {
    throw new Error(`aioncore backend missing at ${AIONCORE_BIN}`);
  }
  if (!existsSync(path.join(AIONUI_STATIC, "index.html"))) {
    throw new Error(`AionUi renderer missing at ${AIONUI_STATIC}`);
  }
  const paseoHome = resolvePaseoHome(process.env);
  const dataDir = path.join(paseoHome, "aionui");
  const logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });

  const handle = await startWebHost({
    app: {
      version: "0.1.0",
      isPackaged: false,
      resourcesPath: path.join(ROOT, "vendor", "aionui"),
      userDataPath: dataDir,
    },
    staticDir: AIONUI_STATIC,
    port: AIONUI_PORT,
    allowRemote: ALLOW_REMOTE,
    dataDir,
    logDir,
    dirs: { cacheDir: dataDir, workDir: dataDir, logDir },
    backend: { kind: "ownBackend", resolveBackend: () => AIONCORE_BIN },
  });
  console.log(`[rockyd] aionui webui    : ${handle.localUrl} (backend :${handle.backendPort})`);
  if (handle.networkUrl) console.log(`[rockyd] aionui network  : ${handle.networkUrl}`);
  await registerAmazeWithAionUi(handle.backendPort);
  await printAionUiCredentials(handle.backendPort);
  return handle;
}

/** Mirror of vendor/aionui/scripts/webui.ts registerLocalAmazeAgent, pointed at vendor/amaze. */
async function registerAmazeWithAionUi(backendPort: number): Promise<void> {
  if (!existsSync(AMAZE_CLI)) {
    console.warn(`[rockyd] vendored amaze missing at ${AMAZE_CLI}; skipping AionUi registration`);
    return;
  }
  const payload = {
    name: "Amaze",
    command: "bun",
    icon: "✨",
    args: [AMAZE_CLI, "acp"],
    advanced: {
      yolo_id: "yolo",
      native_skills_dirs: [],
      behavior_policy: { supports_side_question: false },
      description: "Rocky vendored Amaze ACP agent",
    },
  };
  const api = async <T>(method: string, apiPath: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${backendPort}${apiPath}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${apiPath} → ${response.status}: ${text}`);
    const json = text ? JSON.parse(text) : undefined;
    return json && typeof json === "object" && "data" in json ? (json.data as T) : (json as T);
  };
  try {
    const agents = await api<
      Array<{ id: string; name?: string; command?: string; args?: string[]; agent_source?: string }>
    >("GET", "/api/agents");
    const existing = agents.find(
      (agent) =>
        agent.agent_source === "custom" &&
        agent.name === payload.name &&
        (agent.command === payload.command || agent.args?.includes(AMAZE_CLI)),
    );
    if (existing) {
      await api("PUT", `/api/agents/custom/${existing.id}`, payload);
    } else {
      await api("POST", "/api/agents/custom", payload);
    }
    await api("POST", "/api/agents/refresh");
    console.log(`[rockyd] amaze registered with AionUi (${AMAZE_CLI})`);
  } catch (err) {
    console.warn(`[rockyd] AionUi amaze registration failed: ${String(err)}`);
  }
}

/** Mirror of webui.ts credential seeding: fresh installs print initial admin creds. */
async function printAionUiCredentials(backendPort: number): Promise<void> {
  try {
    const statusRes = await fetch(`http://127.0.0.1:${backendPort}/api/auth/status`);
    if (!statusRes.ok) return;
    const status = (await statusRes.json()) as { needs_setup?: boolean };
    if (status.needs_setup === true) {
      const resetRes = await fetch(`http://127.0.0.1:${backendPort}/api/webui/reset-password`, {
        method: "POST",
      });
      if (resetRes.ok) {
        const payload = (await resetRes.json()) as { data?: { new_password?: string } };
        if (payload.data?.new_password) {
          console.log(`[rockyd] aionui admin    : admin / ${payload.data.new_password}`);
        }
      }
    }
  } catch {
    // credentials query is best-effort
  }
}

// ───────────────────────────────── main ─────────────────────────────────

async function main() {
  process.env.PASEO_HOME ??= path.join(process.env.HOME ?? "~", ".rocky");

  const daemon = await startDaemon();
  const rockyWebUI = await startRockyWebUI();
  const aionui = await startAionUi();

  console.log("[rockyd] all layers up — single runtime, one process");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[rockyd] ${signal} — shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    try {
      await Promise.allSettled([
        aionui.stop(),
        new Promise<void>((resolve) => rockyWebUI.close(() => resolve())),
        daemon.stop(),
      ]);
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
