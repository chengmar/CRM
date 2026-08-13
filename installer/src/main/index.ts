import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { InstallerController } from "./controller.js";
import { InstallerEngine } from "./engine/engine.js";
import { JsonInstallStateRepository } from "./engine/repository.js";
import { EncryptedFileSecretStore, type SecretCodec } from "./engine/secrets.js";
import { createRuntimeStepMap } from "./runtime/steps.js";
import { verifyBasePayload } from "./runtime/customer-payload.js";
import type { InstallerSecretStore } from "./engine/secrets.js";
import type { InstallerConfigurationInput, InstallerSnapshot } from "../shared/contracts.js";

let mainWindow: BrowserWindow | null = null;
let controller: InstallerController | null = null;
let installerSecretStore: InstallerSecretStore | null = null;
const selfTestMode = process.argv.includes("--installer-self-test");
const selfTestDir = process.env.CRM_INSTALLER_SELF_TEST_DIR
  ? path.resolve(process.env.CRM_INSTALLER_SELF_TEST_DIR)
  : path.join(process.env.TEMP ?? process.cwd(), `crm-agent-installer-self-test-${process.pid}`);
if (selfTestMode) app.setPath("userData", selfTestDir);

class ElectronSafeStorageCodec implements SecretCodec {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(value: string): Buffer {
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }
}

function getPayloadDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "payload");
  return path.resolve(app.getAppPath(), "payload");
}

function createWindow(showOnReady = true): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f6f8",
    title: "CRM Agent Installer",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  if (showOnReady) window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return window;
}

function requireController(): InstallerController {
  if (!controller) throw new Error("Installer controller is not ready.");
  return controller;
}

function registerIpc(): void {
  ipcMain.handle("installer:get-snapshot", () => requireController().snapshot());
  ipcMain.handle("installer:save-configuration", (_event, input: InstallerConfigurationInput) =>
    requireController().saveConfiguration(input),
  );
  ipcMain.handle("installer:start", () => requireController().start());
  ipcMain.handle("installer:resume", () => requireController().resume());
  ipcMain.handle("installer:retry", () => requireController().retry());
  ipcMain.handle("installer:rollback", () => requireController().rollback());
  ipcMain.handle("installer:get-pairing-code", () => requireController().getPairingCode());
  ipcMain.handle("installer:open-external", async (_event, url: string) => {
    if (!/^https:\/\//i.test(url)) throw new Error("Only HTTPS links can be opened.");
    await shell.openExternal(url);
  });
  ipcMain.handle("installer:export-diagnostics", async () => {
    const selection = await dialog.showSaveDialog({
      title: "Export installation diagnostics",
      defaultPath: `crm-agent-installer-diagnostics-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) return { path: "" };
    return requireController().exportDiagnostics(selection.filePath);
  });
}

async function bootstrap(showWindow = true): Promise<void> {
  const userData = app.getPath("userData");
  const repository = new JsonInstallStateRepository(path.join(userData, "installer-state.json"));
  const secretStore = new EncryptedFileSecretStore(
    path.join(userData, "installer-secrets.json"),
    new ElectronSafeStorageCodec(),
  );
  installerSecretStore = secretStore;
  const engine = new InstallerEngine(
    repository,
    createRuntimeStepMap({ userDataDir: userData, payloadDir: getPayloadDir(), secretStore }),
    app.getVersion(),
  );
  controller = new InstallerController(engine, secretStore, path.join(userData, "diagnostics"));
  await controller.initialize();
  mainWindow = createWindow(showWindow);
  controller.onSnapshot((snapshot: InstallerSnapshot) => {
    const window = mainWindow;
    if (window && !window.isDestroyed()) window.webContents.send("installer:snapshot", snapshot);
  });
}

async function runPackagedSelfTest(): Promise<void> {
  if (!controller || !installerSecretStore || !mainWindow) {
    throw new Error("Installer self-test runtime is incomplete.");
  }
  await fs.mkdir(selfTestDir, { recursive: true });
  const reportPath = path.join(selfTestDir, "self-test-report.json");
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows DPAPI-backed Electron safeStorage is unavailable.");
    }
    await installerSecretStore.set({ ai_api_key: "installer-self-test-secret" });
    if ((await installerSecretStore.get("ai_api_key")) !== "installer-self-test-secret") {
      throw new Error("Encrypted secret round-trip failed.");
    }
    await installerSecretStore.remove("ai_api_key");
    const payload = await verifyBasePayload(getPayloadDir());
    if (mainWindow.webContents.isLoadingMainFrame()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Renderer load timed out.")), 20_000);
        mainWindow?.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve();
        });
        mainWindow?.webContents.once("did-fail-load", (_event, code, description) => {
          clearTimeout(timer);
          reject(new Error(`Renderer failed to load (${code}): ${description}`));
        });
      });
    }
    const renderer = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        const text = document.body?.innerText || "";
        if (typeof window.installer?.getSnapshot === "function" && text.includes("安装信息") && text.includes("公司与产品")) {
          resolve({ ipc: true, configurationVisible: true, title: document.title });
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("Installer renderer did not reach the configuration screen."));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    })`, true) as { ipc: boolean; configurationVisible: boolean; title: string };
    const snapshot = controller.snapshot();
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      productVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      safeStorage: true,
      stateStatus: snapshot.state.status,
      payload: { file: path.basename(payload.zipPath), sha256: payload.manifest.sha256 },
      renderer,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[OK] Installer packaged self-test: ${reportPath}\n`);
    app.exit(0);
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      productVersion: app.getVersion(),
      error: error instanceof Error ? error.message : String(error),
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => undefined);
    process.stderr.write(`[FAIL] Installer packaged self-test: ${report.error}\n`);
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    registerIpc();
    await bootstrap(!selfTestMode);
    if (selfTestMode) await runPackagedSelfTest();
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
