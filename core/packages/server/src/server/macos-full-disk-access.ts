import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface MacOSFullDiskAccessProbeResult {
  ok: boolean;
  error: string | null;
  guidance: string | null;
}

const MACOS_FULL_DISK_ACCESS_ERROR_CODES = new Set(["EACCES", "EPERM"]);

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function describeDaemonIdentity(): string {
  const execPath = process.execPath ? path.basename(process.execPath) : "the Rocky daemon launcher";
  return `${execPath} (${process.execPath})`;
}

function buildFullDiskAccessGuidance(targetPath: string): string {
  return [
    `macOS blocked the Rocky daemon from accessing ${targetPath}.`,
    "Grant Full Disk Access once on the Mac that runs the daemon, then restart the daemon.",
    `Allow this daemon identity in System Settings → Privacy & Security → Full Disk Access: ${describeDaemonIdentity()}.`,
    'From a local Mac terminal you can open the panel with: open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles".',
    "For remote web use, keep starting Rocky with the same daemon launcher so macOS can reuse that one-time grant.",
  ].join(" ");
}

export function isMacOSFullDiskAccessError(error: unknown): boolean {
  return (
    process.platform === "darwin" &&
    MACOS_FULL_DISK_ACCESS_ERROR_CODES.has(readErrorCode(error) ?? "")
  );
}

export function formatMacOSFullDiskAccessError(targetPath: string, error: unknown): Error {
  if (!isMacOSFullDiskAccessError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const causeMessage = error instanceof Error ? error.message : String(error);
  return new Error(`${buildFullDiskAccessGuidance(targetPath)} Cause: ${causeMessage}`);
}

export async function probeMacOSFullDiskAccess(
  targetPath: string,
): Promise<MacOSFullDiskAccessProbeResult> {
  if (process.platform !== "darwin") {
    return { ok: true, error: null, guidance: null };
  }

  try {
    await access(targetPath, constants.R_OK);
    await readdir(targetPath, { withFileTypes: true });
    return { ok: true, error: null, guidance: null };
  } catch (error) {
    if (!isMacOSFullDiskAccessError(error)) {
      throw error;
    }
    const guidance = buildFullDiskAccessGuidance(targetPath);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      guidance,
    };
  }
}

export async function assertMacOSFullDiskAccess(targetPath: string): Promise<void> {
  const result = await probeMacOSFullDiskAccess(targetPath);
  if (!result.ok) {
    throw new Error(result.guidance ?? buildFullDiskAccessGuidance(targetPath));
  }
}
