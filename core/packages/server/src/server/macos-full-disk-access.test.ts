import { describe, expect, test } from "vitest";

import {
  formatMacOSFullDiskAccessError,
  isMacOSFullDiskAccessError,
} from "./macos-full-disk-access.js";

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("macOS Full Disk Access helpers", () => {
  test("identifies macOS TCC filesystem denials", () => {
    withPlatform("darwin", () => {
      const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

      expect(isMacOSFullDiskAccessError(error)).toBe(true);
    });
  });

  test("does not classify non-macOS permission errors as Full Disk Access", () => {
    withPlatform("linux", () => {
      const error = Object.assign(new Error("permission denied"), { code: "EACCES" });

      expect(isMacOSFullDiskAccessError(error)).toBe(false);
    });
  });

  test("formats actionable one-time grant guidance for remote daemon users", () => {
    withPlatform("darwin", () => {
      const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

      const formatted = formatMacOSFullDiskAccessError("/Users/me/Documents/project", error);

      expect(formatted.message).toContain("Full Disk Access");
      expect(formatted.message).toContain("restart the daemon");
      expect(formatted.message).toContain("same daemon launcher");
      expect(formatted.message).toContain(process.execPath);
    });
  });
});
