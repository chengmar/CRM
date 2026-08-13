import { contextBridge, ipcRenderer } from "electron";
import type {
  DiagnosticsExportResult,
  InstallerApi,
  InstallerConfigurationInput,
  InstallerSnapshot,
} from "../shared/contracts.js";

const api: InstallerApi & { getPairingCode(): Promise<string> } = {
  getSnapshot: () => ipcRenderer.invoke("installer:get-snapshot") as Promise<InstallerSnapshot>,
  saveConfiguration: (input: InstallerConfigurationInput) =>
    ipcRenderer.invoke("installer:save-configuration", input) as Promise<InstallerSnapshot>,
  start: () => ipcRenderer.invoke("installer:start") as Promise<InstallerSnapshot>,
  resume: () => ipcRenderer.invoke("installer:resume") as Promise<InstallerSnapshot>,
  retry: () => ipcRenderer.invoke("installer:retry") as Promise<InstallerSnapshot>,
  rollback: () => ipcRenderer.invoke("installer:rollback") as Promise<InstallerSnapshot>,
  exportDiagnostics: () =>
    ipcRenderer.invoke("installer:export-diagnostics") as Promise<DiagnosticsExportResult>,
  openExternal: (url: string) => ipcRenderer.invoke("installer:open-external", url) as Promise<void>,
  getPairingCode: () => ipcRenderer.invoke("installer:get-pairing-code") as Promise<string>,
  onSnapshot: (listener: (snapshot: InstallerSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: InstallerSnapshot) => listener(snapshot);
    ipcRenderer.on("installer:snapshot", wrapped);
    return () => ipcRenderer.off("installer:snapshot", wrapped);
  },
};

contextBridge.exposeInMainWorld("installer", api);
