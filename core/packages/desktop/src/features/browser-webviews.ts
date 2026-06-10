import { webContents as allWebContents, type WebContents } from "electron";

const browserIdsByWebContentsId = new Map<number, string>();
let workspaceActiveBrowserId: string | null = null;

export function listRegisteredRockyBrowserIds(): string[] {
  return Array.from(new Set(browserIdsByWebContentsId.values())).sort();
}

export function registerRockyBrowserWebContents(contents: WebContents, browserId: string): void {
  browserIdsByWebContentsId.set(contents.id, browserId);
  contents.once("destroyed", () => {
    browserIdsByWebContentsId.delete(contents.id);
    if (workspaceActiveBrowserId === browserId) {
      workspaceActiveBrowserId = null;
    }
  });
}

export function getRockyBrowserIdForWebContents(contents: WebContents | null): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserIdsByWebContentsId.get(contents.id) ?? null;
}

export function setWorkspaceActiveRockyBrowserId(browserId: string | null): void {
  workspaceActiveBrowserId = browserId;
}

export function getRockyBrowserWebContents(browserId: string): WebContents | null {
  for (const [contentsId, registeredBrowserId] of browserIdsByWebContentsId) {
    if (registeredBrowserId !== browserId) continue;
    const contents = allWebContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) {
      return contents;
    }
  }
  return null;
}

export function getWorkspaceActiveRockyBrowserWebContents(): WebContents | null {
  if (!workspaceActiveBrowserId) {
    return null;
  }
  return getRockyBrowserWebContents(workspaceActiveBrowserId);
}
