import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

async function runSupervisorFixture(options: {
  workerSource: string;
  restartOnCrash?: boolean;
  maxPreReadyCrashRestarts?: number;
  preReadyCrashRestartDelayMs?: number;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
  stdout: string;
  stderr: string;
}> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "rocky-supervisor-log-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  await writeFile(workerPath, options.workerSource);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: ${JSON.stringify(options.restartOnCrash ?? false)},
        maxPreReadyCrashRestarts: ${JSON.stringify(options.maxPreReadyCrashRestarts ?? 5)},
        preReadyCrashRestartDelayMs: ${JSON.stringify(options.preReadyCrashRestartDelayMs ?? 1000)},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("supervisor fixture timed out"));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const log = await readFile(logPath, "utf8");
  return { code, signal, log, stdout, stderr };
}

describe("supervisor durable logging", () => {
  test("resolves rotation defaults", () => {
    const rockyHome = path.join(path.sep, "tmp", "rocky-home");
    const logFile = resolveSupervisorLogFile(rockyHome, {}, {});

    expect(logFile).toEqual({
      path: path.join(rockyHome, "daemon.log"),
      rotate: { maxSize: "10m", maxFiles: 3 },
    });
  });

  test("lets persisted rotation override env rotation defaults", () => {
    const rockyHome = path.join(path.sep, "tmp", "rocky-home");
    const logFile = resolveSupervisorLogFile(
      rockyHome,
      {
        log: {
          file: {
            path: "logs/daemon.log",
            rotate: { maxSize: "25m", maxFiles: 4 },
          },
        },
      },
      {
        ROCKY_LOG_ROTATE_SIZE: "200m",
        ROCKY_LOG_ROTATE_COUNT: "12",
      },
    );

    expect(logFile).toEqual({
      path: path.resolve(rockyHome, "logs", "daemon.log"),
      rotate: { maxSize: "25m", maxFiles: 4 },
    });
  });

  test("uses env rotation when persisted rotation is absent", () => {
    const rockyHome = path.join(path.sep, "tmp", "rocky-home");
    const logFile = resolveSupervisorLogFile(
      rockyHome,
      {},
      {
        ROCKY_LOG_ROTATE_SIZE: "50m",
        ROCKY_LOG_ROTATE_COUNT: "8",
      },
    );

    expect(logFile).toEqual({
      path: path.join(rockyHome, "daemon.log"),
      rotate: { maxSize: "50m", maxFiles: 8 },
    });
  });

  test("writes supervised worker stdout and stderr to daemon.log", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('{"level":30,"msg":"worker-json-stdout"}\\n');
        process.stderr.write('{"level":50,"msg":"worker-json-stderr"}\\n');
        process.exit(0);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"worker-json-stdout"');
    expect(result.log).toContain('"worker-json-stderr"');
    expect(result.stdout).toContain('"worker-json-stdout"');
    expect(result.stderr).toContain('"worker-json-stderr"');
  });

  test("preserves raw non-JSON stdout and stderr lines", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('raw stdout line\\n');
        process.stderr.write('raw stderr line\\n');
        process.exit(0);
      `,
    });

    expect(result.log).toContain("raw stdout line\n");
    expect(result.log).toContain("raw stderr line\n");
  });

  // POSIX-only: Windows reports the worker self-kill as an exit code, not SIGKILL.
  test.skipIf(isPlatform("win32"))(
    "logs worker signal exits even when the worker cannot log",
    async () => {
      const result = await runSupervisorFixture({
        workerSource: `
        process.kill(process.pid, "SIGKILL");
      `,
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.log).toContain('"msg":"Worker exited"');
      expect(result.log).toContain('"signal":"SIGKILL"');
      expect(result.log).toContain("Supervisor exiting");
    },
  );

  test("gives up after repeated pre-ready crashes instead of looping forever", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        // Simulate a worker that can never start (e.g. EADDRINUSE).
        process.exit(1);
      `,
      restartOnCrash: true,
      maxPreReadyCrashRestarts: 2,
      preReadyCrashRestartDelayMs: 10,
    });

    expect(result.code).toBe(1);
    const restartLogs = result.log.match(/Worker crashed before becoming ready/g) ?? [];
    expect(restartLogs.length).toBe(2);
    expect(result.log).toContain("times without ever becoming ready");
    expect(result.log).not.toContain("Restarting worker...");
  });

  test("resets the pre-ready crash budget once the worker reports ready", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.send({ type: "rocky:ready", listen: "127.0.0.1:0" });
        setTimeout(() => process.exit(0), 50);
      `,
      restartOnCrash: true,
      maxPreReadyCrashRestarts: 1,
      preReadyCrashRestartDelayMs: 10,
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain('"msg":"Worker ready"');
    expect(result.log).not.toContain("without ever becoming ready");
  });
});
