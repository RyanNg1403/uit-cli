import { _electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = process.env.UIT_PACKAGED_EXECUTABLE;
if (!executable) throw new Error("UIT_PACKAGED_EXECUTABLE is required");
const samePath = (left, right) => {
  const paths = [resolve(left), resolve(right)];
  return process.platform === "win32" ? paths[0].toLowerCase() === paths[1].toLowerCase() : paths[0] === paths[1];
};

const profile = await mkdtemp(join(tmpdir(), "uit-studio-packaged-"));
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: profile,
  LOCALAPPDATA: profile,
  XDG_CONFIG_HOME: profile,
  XDG_CACHE_HOME: profile,
  UIT_TEST_PROFILE: profile,
  UIT_TEST_HEADLESS: "1",
  UIT_DISABLE_CONFIG: "1",
  CODEX_HOME: join(profile, "codex"),
};
delete env.ELECTRON_RUN_AS_NODE;

const errors = [];
let app;
try {
  app = await _electron.launch({
    executablePath: resolve(executable),
    args: [
      "--disable-background-networking",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
    ],
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.waitForSelector("#account-label", { state: "visible", timeout: 30_000 });
  const label = await page.locator("#account-label").textContent();
  if (label !== "Connect accounts") throw new Error(`Unexpected account label: ${label}`);

  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    packaged: electronApp.isPackaged,
    userData: electronApp.getPath("userData"),
    windows: BrowserWindow.getAllWindows().length,
  }));
  if (!state.packaged) throw new Error("Smoke test launched an unpackaged Electron app");
  if (!samePath(state.userData, profile)) throw new Error(`Unexpected userData path: ${state.userData}`);
  if (state.windows !== 1) throw new Error(`Expected one window, got ${state.windows}`);
  if (errors.length > 0) throw new Error(`Packaged renderer errors: ${errors.join(" | ")}`);
} finally {
  try {
    if (app) await app.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
