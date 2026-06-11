import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createRockyHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rocky-config-webui-"));
  roots.push(root);
  const rockyHome = path.join(root, ".rocky");
  await mkdir(rockyHome, { recursive: true });
  await writeFile(path.join(rockyHome, "config.json"), JSON.stringify(config, null, 2));
  return rockyHome;
}

async function createWebUiBundle(): Promise<string> {
  const webUiDir = await mkdtemp(path.join(os.tmpdir(), "rocky-webui-"));
  roots.push(webUiDir);
  await writeFile(path.join(webUiDir, "index.html"), "<!doctype html><title>Rocky</title>");
  return webUiDir;
}

describe("daemon WebUI config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("uses ROCKY_HOME/public as the canonical static directory", async () => {
    const rockyHome = await createRockyHome({ version: 1 });

    const config = loadConfig(rockyHome, { env: {} });

    expect(config.staticDir).toBe(path.join(rockyHome, "public"));
  });

  test("loads explicit WebUI bundle directory from environment", async () => {
    const rockyHome = await createRockyHome({ version: 1 });
    const webUiDir = await createWebUiBundle();

    const config = loadConfig(rockyHome, { env: { ROCKY_WEB_UI_DIR: webUiDir } });

    expect(config.webUiDir).toBe(webUiDir);
  });

  test("fails fast when explicit WebUI bundle is missing", async () => {
    const rockyHome = await createRockyHome({ version: 1 });
    const missingWebUiDir = path.join(path.dirname(rockyHome), "missing-webui");

    expect(() => loadConfig(rockyHome, { env: { ROCKY_WEB_UI_DIR: missingWebUiDir } })).toThrow(
      `Rocky WebUI bundle missing at ${missingWebUiDir}. Run: npm run build:webui`,
    );
  });
});
