#!/usr/bin/env node
/**
 * Serve the built Rocky WebUI (Expo web export) for remote browsers.
 *
 * The WebUI is a static SPA; in the browser you add the Rocky daemon as a host
 * (ws://<host>:7767 + daemon password). This server only ships the static
 * bundle — all agent traffic goes browser → daemon directly.
 *
 * Usage: node scripts/serve-webui.mjs [--port 7780] [--host 0.0.0.0]
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "vendor", "paseo", "packages", "app", "dist");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(argOf("--port", "7780"));
const host = argOf("--host", "0.0.0.0");

if (!existsSync(path.join(dist, "index.html"))) {
  console.error(`WebUI bundle not found at ${dist}. Run: npm run build:webui`);
  process.exit(1);
}

const MIME = {
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

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let filePath = path.join(dist, decodeURIComponent(url.pathname));
    const rel = path.relative(dist, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory() || !path.extname(filePath)) {
      filePath = path.join(dist, "index.html"); // SPA fallback
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    createReadStream(filePath).pipe(res);
  })
  .listen(port, host, () => {
    console.log(`Rocky WebUI: http://${host === "0.0.0.0" ? "<this-host>" : host}:${port}`);
    console.log("Add your Rocky daemon in the UI: ws://<this-host>:7767 (+ daemon password).");
  });
