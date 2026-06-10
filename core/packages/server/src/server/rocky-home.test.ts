import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveRockyHome } from "./rocky-home.js";
import { PRIVATE_DIRECTORY_MODE } from "./private-files.js";

const MODE_MASK = 0o777;

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("resolveRockyHome permissions", () => {
  test("creates ROCKY_HOME with private permissions", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "rocky-home-parent-"));
    const rockyHome = path.join(parent, "home");
    try {
      expect(resolveRockyHome({ ROCKY_HOME: rockyHome })).toBe(rockyHome);
      expect(modeOf(rockyHome)).toBe(PRIVATE_DIRECTORY_MODE);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
