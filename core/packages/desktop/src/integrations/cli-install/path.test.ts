import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Rocky.app/Contents/MacOS/Rocky",
        shimPath: "/Applications/Rocky.app/Contents/Resources/bin/rocky",
      }),
    ).toBe("/Applications/Rocky.app/Contents/Resources/bin/rocky");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_rocky123/rocky",
        shimPath: "/tmp/.mount_rocky123/resources/bin/rocky",
        appImagePath: "/home/user/Applications/Rocky.AppImage",
      }),
    ).toBe("/home/user/Applications/Rocky.AppImage");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Rocky\\Rocky.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Rocky\\resources\\bin\\rocky.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Rocky\\resources\\bin\\rocky.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Rocky/rocky",
        shimPath: "/opt/Rocky/resources/bin/rocky",
      }),
    ).toBe("/opt/Rocky/resources/bin/rocky");
  });
});
