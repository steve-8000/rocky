import { contextBridge, ipcRenderer, webUtils } from "electron";

type EventHandler = (payload: unknown) => void;

contextBridge.exposeInMainWorld("rockyDesktop", {
  platform: process.platform,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("rocky:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("rocky:get-pending-open-project") as Promise<string | null>,
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`rocky:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`rocky:event:${event}`, listener);
      });
    },
  },
  window: {
    getCurrentWindow: () => ({
      toggleMaximize: () => ipcRenderer.invoke("rocky:window:toggleMaximize"),
      isFullscreen: () => ipcRenderer.invoke("rocky:window:isFullscreen"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
      }) => ipcRenderer.invoke("rocky:window:updateWindowControls", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("rocky:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("rocky:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("rocky:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("rocky:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("rocky:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("rocky:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("rocky:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("rocky:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("rocky:opener:openUrl", url),
  },
  editor: {
    listTargets: () => ipcRenderer.invoke("rocky:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      path: string;
      cwd?: string;
      mode?: "open" | "reveal";
    }) => ipcRenderer.invoke("rocky:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("rocky:menu:showContextMenu", input),
  },
  browser: {
    setWorkspaceActiveBrowser: (browserId: string | null) =>
      ipcRenderer.invoke("rocky:browser:set-workspace-active-browser", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("rocky:browser:open-devtools", browserId),
    clearPartition: (browserId: string) =>
      ipcRenderer.invoke("rocky:browser:clear-partition", browserId),
  },
});
