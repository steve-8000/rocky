#!/usr/bin/env npx tsx

import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRockyHomePath, resolveRockyWorktreesDir } from "../src/commands/worktree/ls.js";

console.log("=== Worktree LS Path Helper Tests ===\n");

const originalRockyHome = process.env.ROCKY_HOME;

try {
  {
    console.log("Test 1: resolves explicit ROCKY_HOME when set");
    process.env.ROCKY_HOME = "/tmp/rocky-explicit-home";

    assert.strictEqual(resolveRockyHomePath(), "/tmp/rocky-explicit-home");
    assert.strictEqual(resolveRockyWorktreesDir(), "/tmp/rocky-explicit-home/worktrees");
    console.log("\u2713 explicit ROCKY_HOME is respected\n");
  }

  {
    console.log("Test 2: falls back to homedir/.rocky when ROCKY_HOME is unset");
    delete process.env.ROCKY_HOME;

    assert.strictEqual(resolveRockyHomePath(), join(homedir(), ".rocky"));
    assert.strictEqual(resolveRockyWorktreesDir(), join(homedir(), ".rocky", "worktrees"));
    console.log("\u2713 fallback home path is derived from os.homedir()\n");
  }
} finally {
  if (originalRockyHome === undefined) {
    delete process.env.ROCKY_HOME;
  } else {
    process.env.ROCKY_HOME = originalRockyHome;
  }
}

console.log("=== All worktree ls path helper tests passed ===");
