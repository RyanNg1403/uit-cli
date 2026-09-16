import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, screen, session, shell } from "electron";
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createStudioCore,
  type StudioBrowserSession,
  type StudioHost,
  type StudioHandler,
  type StudioSsoHost,
  type StudioView,
  type StudioWindow
} from "../dist/studio-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execFileAsync = promisify(execFile);
const studioUserData = resolve(process.env.UIT_TEST_PROFILE || join(homedir(), ".uit", "studio"));
const APPLICATION_ID = "vn.edu.uit.studio";
const APPLICATION_ICON = join(__dirname, "renderer", "assets", "uit-dau-dau-icon.png");
const TRUSTED_RENDERER_PROTOCOL = "file:";
const SSO_PARTITION = "persist:uit-sso";

let mainWindow: BrowserWindow | undefined;
let windowCreation: Promise<BrowserWindow> | undefined;
let studioCore: Awaited<ReturnType<typeof createStudioCore>> | undefined;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function configureApplicationIdentity(): void {
  app.setName?.("UIT Studio");
  if (process.platform === "darwin") app.dock?.setIcon?.(APPLICATION_ICON);
  if (process.platform === "win32") app.setAppUserModelId?.(APPLICATION_ID);
}

function createSsoSessionView(): StudioView {
  const view = new WebContentsView({
    webPreferences: {
      partition: SSO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  return view as unknown as StudioView;
}

function closeSsoSessionView(view: StudioView | undefined): void {
  if (!view?.webContents || view.webContents.isDestroyed?.()) return;
  try {
    view.webContents.close?.({ waitForBeforeUnload: false });
  } catch {
    // The view may already be closing.
  }
}

function createLoginWindow(options: Record<string, unknown>): StudioWindow {
  const loginWindow = new BrowserWindow(options as BrowserWindowConstructorOptions);
  const authSession = loginWindow.webContents.session;
  authSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  authSession.setPermissionCheckHandler(() => false);
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return loginWindow as unknown as StudioWindow;
}

const ssoHost: StudioSsoHost = {
  createSessionView: createSsoSessionView,
  closeSessionView: closeSsoSessionView,
  getPartition: (name) => session.fromPartition(name) as unknown as StudioBrowserSession,
  createLoginWindow
};

function restoreMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized?.()) mainWindow.restore();
    if (mainWindow.isVisible && !mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } catch (error) {
    console.error("Could not restore UIT Studio after SSO:", errorMessage(error));
  }
}

async function ensureStudioMcpConfig(): Promise<void> {
  if (process.env.UIT_DISABLE_CONFIG === "1") return;
  const mcp = await import("../dist/mcp-server.js");
  if (typeof mcp.installMcpServer !== "function") throw new Error("UIT MCP configuration is unavailable.");
  mcp.installMcpServer({
    command: process.execPath,
    // Electron's Node mode runs this entrypoint without initializing an app,
    // Dock icon, GPU process, or Studio profile. It is available on every
    // platform supported by Electron, including packaged builds.
    args: [join(__dirname, "..", "dist", "mcp-entry.js")],
    env: { ELECTRON_RUN_AS_NODE: "1" }
  });
}

const host: StudioHost = {
  userDataPath: studioUserData,
  sso: ssoHost,
  ensureMcpConfig: ensureStudioMcpConfig,
  sendAgentEvent: (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:event", message);
  },
  restoreMainWindow,
  openPath: (path) => shell.openPath(path),
  openExternal: (url) => shell.openExternal(url).then(() => undefined),
  writeClipboard: (text) => clipboard.writeText(text),
  openCodexDesktop: async (cwd, threadId) => {
    await execFileAsync("codex", ["app", cwd]).catch(() => undefined);
    setTimeout(() => {
      shell.openExternal(`codex://threads/${threadId}`).catch(() => undefined);
    }, 350);
    setTimeout(() => {
      shell.openExternal(`codex://threads/${threadId}`).catch(() => undefined);
    }, 1000);
  }
};

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const frameUrl = event.senderFrame?.url || event.sender.getURL();
    const parsed = new URL(frameUrl);
    return parsed.protocol === TRUSTED_RENDERER_PROTOCOL && resolve(fileURLToPath(parsed)) === resolve(__dirname, "renderer", "index.html");
  } catch {
    return false;
  }
}

function registerIpc(handlers: Record<string, StudioHandler>): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, input) => {
      if (!isTrustedRenderer(event)) throw new Error("Rejected IPC request from an untrusted renderer.");
      return handler(input);
    });
  }
}

function createWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  if (!windowCreation) {
    const pending = createWindowInternal();
    const tracked = pending.finally(() => {
      if (windowCreation === tracked) windowCreation = undefined;
    });
    windowCreation = tracked;
  }
  return windowCreation;
}

async function createWindowInternal(): Promise<BrowserWindow> {
  const primaryDisplay = screen?.getPrimaryDisplay?.();
  const workArea = primaryDisplay?.workAreaSize || { width: 1440, height: 920 };
  const targetWidth = Math.min(1440, Math.max(900, workArea.width - 40));
  const targetHeight = Math.min(880, Math.max(600, workArea.height - 40));
  const window = new BrowserWindow({
    show: process.env.UIT_TEST_HEADLESS !== "1",
    width: targetWidth,
    height: targetHeight,
    minWidth: 390,
    minHeight: 560,
    title: "UIT Studio",
    icon: APPLICATION_ICON,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  if (!studioCore) {
    studioCore = await createStudioCore(host);
    registerIpc(studioCore.handlers());
  }
  await window.loadFile(join(__dirname, "renderer", "index.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const rejectUntrustedNavigation = (event: { preventDefault(): void }, url: string): void => {
    // Reloading the current trusted document is valid (and required by the
    // renderer's recovery flows); every other navigation remains blocked.
    if (!url.startsWith(TRUSTED_RENDERER_PROTOCOL) || url !== window.webContents.getURL()) event.preventDefault();
  };
  window.webContents.on("will-navigate", rejectUntrustedNavigation);
  // Electron emits will-frame-navigate for renderer-initiated main-frame
  // navigations on some platforms where will-navigate is not delivered for
  // data: and file: targets. Apply the same exact-document allowlist there.
  window.webContents.on("will-frame-navigate", (details) => rejectUntrustedNavigation(details, details.url));
  return window;
}

app.setPath("userData", studioUserData);

app.whenReady().then(() => {
  configureApplicationIdentity();
  return createWindow();
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) void createWindow();
});

app.on("before-quit", () => {
  void studioCore?.shutdown();
});
