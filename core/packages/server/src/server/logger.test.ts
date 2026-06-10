import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveLogConfig } from "./logger.js";
import { loadConfig } from "./config.js";
import type { PersistedConfig } from "./persisted-config.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const loggerModuleUrl = new URL("./logger.ts", import.meta.url).href;

async function runLoggerFixture(source: string): Promise<{ stdout: string; stderr: string }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "rocky-logger-fixture-"));
  const runnerPath = path.join(tempDir, "runner.mjs");
  await writeFile(
    runnerPath,
    `
      import { createRootLogger } from ${JSON.stringify(loggerModuleUrl)};

      ${source}
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  expect(code, stderr).toBe(0);
  return { stdout, stderr };
}

describe("resolveLogConfig", () => {
  const rockyHome = "/tmp/rocky-logger-tests";

  it("defaults to stdout JSON without file logging", () => {
    const result = resolveLogConfig(undefined, { rockyHome });

    expect(result).toEqual({
      level: "info",
      console: {
        level: "info",
        format: "json",
      },
    });
  });

  it("keeps legacy level and format as stdout configuration", () => {
    const result = resolveLogConfig({ level: "warn", format: "pretty" }, { rockyHome });

    expect(result).toEqual({
      level: "warn",
      console: {
        level: "warn",
        format: "pretty",
      },
    });
  });

  it("enables file output only when log.file is present", () => {
    const config: PersistedConfig = {
      log: {
        console: {
          level: "warn",
          format: "json",
        },
        file: {
          level: "debug",
          path: "logs/programmatic.log",
          rotate: {
            maxSize: "25m",
            maxFiles: 5,
          },
        },
      },
    };

    expect(resolveLogConfig(config, { rockyHome })).toEqual({
      level: "debug",
      console: {
        level: "warn",
        format: "json",
      },
      file: {
        level: "debug",
        path: path.resolve(rockyHome, "logs", "programmatic.log"),
      },
    });
  });

  it("defaults file output to info when log.file is present without a level", () => {
    const config: PersistedConfig = {
      log: {
        console: {
          level: "warn",
        },
        file: {
          path: "daemon.log",
        },
      },
    };

    expect(resolveLogConfig(config, { rockyHome })).toEqual({
      level: "info",
      console: {
        level: "warn",
        format: "json",
      },
      file: {
        level: "info",
        path: path.resolve(rockyHome, "daemon.log"),
      },
    });
  });
});

describe("loadConfig logger config", () => {
  it("applies log format env at the config boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rocky-logger-config-"));
    const rockyHome = path.join(root, ".rocky");
    await mkdir(rockyHome, { recursive: true });
    await writeFile(
      path.join(rockyHome, "config.json"),
      JSON.stringify({ version: 1, log: { format: "json" } }),
    );

    const config = loadConfig(rockyHome, {
      env: { ROCKY_LOG_FORMAT: "pretty" },
    });

    expect(config.log?.format).toBe("pretty");
    expect(resolveLogConfig(config, { rockyHome }).console.format).toBe("pretty");
  });
});

describe("createRootLogger", () => {
  it("writes JSON to stdout by default and does not initialize file logging", async () => {
    const rockyHome = await mkdtemp(path.join(tmpdir(), "rocky-logger-default-"));
    const missingLogDir = path.join(rockyHome, "logs");

    const { stdout } = await runLoggerFixture(`
      const logger = createRootLogger(undefined, { rockyHome: ${JSON.stringify(rockyHome)} });
      logger.info({ proof: "stdout-default" }, "default logger");
      logger.flush();
    `);

    expect(stdout).toContain('"proof":"stdout-default"');
    expect(stdout).toContain('"msg":"default logger"');
    expect(existsSync(path.join(rockyHome, "daemon.log"))).toBe(false);
    expect(existsSync(missingLogDir)).toBe(false);
  });

  it("writes to an explicit file target without creating rotation files", async () => {
    const rockyHome = await mkdtemp(path.join(tmpdir(), "rocky-logger-file-"));
    const logPath = path.join(rockyHome, "logs", "programmatic.log");

    await runLoggerFixture(`
      const logger = createRootLogger(
        { log: { file: { path: ${JSON.stringify(logPath)} } } },
        { rockyHome: ${JSON.stringify(rockyHome)} },
      );
      logger.info({ proof: "file-explicit" }, "explicit file logger");
      logger.flush();
    `);

    const logText = await readFile(logPath, "utf8");
    const files = await readdir(path.dirname(logPath));

    expect(logText).toContain('"proof":"file-explicit"');
    expect(logText).toContain('"msg":"explicit file logger"');
    expect(files).toEqual(["programmatic.log"]);
  });

  it("can disable file output for supervised workers", async () => {
    const rockyHome = await mkdtemp(path.join(tmpdir(), "rocky-logger-no-worker-file-"));
    const logPath = path.join(rockyHome, "daemon.log");

    const { stdout } = await runLoggerFixture(`
      const logger = createRootLogger(
        { log: { file: { path: ${JSON.stringify(logPath)} } } },
        { rockyHome: ${JSON.stringify(rockyHome)}, file: false },
      );
      logger.info({ proof: "stdout-only" }, "worker logger");
      logger.flush();
    `);

    expect(stdout).toContain('"proof":"stdout-only"');
    expect(stdout).toContain('"msg":"worker logger"');
    expect(existsSync(logPath)).toBe(false);
  });

  it("keeps pretty output available as a format choice", async () => {
    const rockyHome = await mkdtemp(path.join(tmpdir(), "rocky-logger-pretty-"));

    const { stdout } = await runLoggerFixture(`
      const logger = createRootLogger({ level: "info", format: "pretty" }, {
        rockyHome: ${JSON.stringify(rockyHome)},
      });
      logger.info("pretty logger");
      logger.flush();
    `);

    expect(stdout).toContain("pretty logger");
  });
});
