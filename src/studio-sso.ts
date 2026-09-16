import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";
import type { SsoSessionData } from "./config.js";
import { CliError } from "./output.js";

export const PLAYWRIGHT_VERSION = "1.63.0";
const SSO_ALLOWED_HOSTS = new Set(["courses.uit.edu.vn", "sso.uit.edu.vn"]);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const BROWSER_MANIFEST = "chromium.json";

type ChromiumManifest = {
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  executablePath: string;
};

export interface SsoBrowserRuntime {
  executablePath(): string;
  launch(options?: LaunchOptions): Promise<Browser>;
}

export interface StudioSsoOptions {
  runtime?: SsoBrowserRuntime;
  executablePath?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new CliError("UIT SSO requires a valid HTTPS course-site URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "courses.uit.edu.vn" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new CliError("UIT SSO is available for the current UIT course site only.");
  }
  return parsed.origin;
}

function allowedNavigation(rawUrl: string, baseUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    const base = new URL(baseUrl);
    return target.protocol === "https:" && (target.hostname === base.hostname || SSO_ALLOWED_HOSTS.has(target.hostname));
  } catch {
    return false;
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function browserDirectory(): string {
  return resolve(process.env.UIT_STUDIO_CHROMIUM_DIR || join(packageRoot(), "browsers"));
}

function manifestPath(): string {
  return join(browserDirectory(), BROWSER_MANIFEST);
}

function developmentExecutablePath(runtime: SsoBrowserRuntime): string | undefined {
  // A source checkout may use the developer's Playwright cache for local tests
  // and `npm run dev`. Published packages and native artifacts must provide the
  // manifest below, so they never silently use that cache.
  return existsSync(join(packageRoot(), "src", "studio-sso.ts")) ? runtime.executablePath() : undefined;
}

function manifestExecutablePath(): string | undefined {
  let manifest: Partial<ChromiumManifest>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as Partial<ChromiumManifest>;
  } catch {
    return undefined;
  }
  if (manifest.playwrightVersion !== PLAYWRIGHT_VERSION || manifest.platform !== process.platform || manifest.architecture !== process.arch || typeof manifest.executablePath !== "string" || !manifest.executablePath) {
    throw new CliError(
      "UIT Studio's bundled Chromium does not match this package.",
      "Reinstall UIT Studio with lifecycle scripts enabled so its pinned Chromium browser is provisioned."
    );
  }
  const root = browserDirectory();
  const executablePath = resolve(root, manifest.executablePath);
  if (executablePath !== root && !executablePath.startsWith(`${root}${sep}`)) {
    throw new CliError("UIT Studio's Chromium manifest points outside its package-owned browser directory.");
  }
  return executablePath;
}

function bundledExecutablePath(runtime: SsoBrowserRuntime, configured?: string): string {
  const explicit = configured || process.env.UIT_STUDIO_CHROMIUM_EXECUTABLE;
  const executablePath = explicit || manifestExecutablePath() || developmentExecutablePath(runtime);
  if (executablePath && existsSync(executablePath)) return executablePath;
  throw new CliError(
    `UIT Studio's bundled Playwright Chromium is missing${executablePath ? ` at ${executablePath}` : "."}`,
    "Reinstall UIT Studio with lifecycle scripts enabled so its pinned Chromium browser is provisioned. System Chrome and Edge are not used."
  );
}

function installedPlaywrightExecutablePath(): string {
  const browserRoot = browserDirectory();
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import(\"playwright\").then(({ chromium }) => process.stdout.write(chromium.executablePath())).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })"],
    { cwd: packageRoot(), env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot }, encoding: "utf8" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not resolve the installed Playwright Chromium executable. ${String(result.stderr || "").trim()}`.trim());
  return String(result.stdout).trim();
}

function writeChromiumManifest(executablePath: string): void {
  const root = browserDirectory();
  const relativeExecutablePath = relative(root, executablePath);
  if (!relativeExecutablePath || relativeExecutablePath.startsWith(`..${sep}`) || relativeExecutablePath === ".." || resolve(root, relativeExecutablePath) !== executablePath) {
    throw new Error("Playwright returned a Chromium executable outside the package-owned browser directory.");
  }
  mkdirSync(root, { recursive: true });
  const manifest: ChromiumManifest = {
    playwrightVersion: PLAYWRIGHT_VERSION,
    platform: process.platform,
    architecture: process.arch,
    executablePath: relativeExecutablePath
  };
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

function sessionCookies(context: BrowserContext, baseUrl: string): Promise<SsoSessionData["cookies"]> {
  return context.cookies(baseUrl).then((cookies) => cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly
  })));
}

function readIdentity(page: { evaluate<T>(pageFunction: () => T): Promise<T> }): Promise<{ sesskey: string; userId: number } | null> {
  return page.evaluate(() => {
    const cfg = (globalThis as { M?: { cfg?: { sesskey?: unknown; userId?: unknown; userid?: unknown } } }).M?.cfg || {};
    const sesskey = String(cfg.sesskey || "");
    const userId = Number(cfg.userId || cfg.userid || 0);
    return sesskey && Number.isInteger(userId) && userId > 0 ? { sesskey, userId } : null;
  }).catch(() => null);
}

/**
 * Runs the interactive SSO flow in the exact Playwright Chromium revision
 * shipped with the package. The context is intentionally ephemeral: only the
 * Moodle cookies, sesskey, and account ID leave the authentication browser.
 */
export class StudioSsoService {
  private readonly runtime: SsoBrowserRuntime;
  private readonly executablePath?: string;
  private readonly timeoutMs: number;
  private readonly onStatus?: (message: string) => void;
  private activeBrowser?: Browser;

  constructor(options: StudioSsoOptions = {}) {
    this.runtime = options.runtime || chromium;
    this.executablePath = options.executablePath;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.onStatus = options.onStatus;
  }

  async login(rawBaseUrl: string): Promise<SsoSessionData> {
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (this.activeBrowser) throw new CliError("UIT SSO login is already in progress.");

    const executablePath = bundledExecutablePath(this.runtime, this.executablePath);
    const browser = await this.runtime.launch({
      executablePath,
      headless: false,
      args: ["--window-size=980,760"]
    });
    this.activeBrowser = browser;
    this.onStatus?.("Opening bundled Chromium for UIT SSO login...");

    try {
      const context = await browser.newContext({ viewport: { width: 980, height: 760 } });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();
        if (!request.isNavigationRequest() || allowedNavigation(url, baseUrl) || /^(?:about|blob|data):/i.test(url)) await route.continue();
        else await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login/index.php`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      this.onStatus?.("Sign in with your UIT account in the Chromium window.");

      const startedAt = Date.now();
      while (Date.now() - startedAt <= this.timeoutMs) {
        if (page.isClosed() || !browser.isConnected()) {
          throw new CliError("UIT SSO login window was closed before login completed.");
        }
        let currentUrl = "";
        try { currentUrl = page.url(); } catch { /* The page may be closing during a redirect. */ }
        if (currentUrl && allowedNavigation(currentUrl, baseUrl)) {
          const identity = await readIdentity(page);
          if (identity) {
            return {
              baseUrl,
              userId: identity.userId,
              sesskey: identity.sesskey,
              cookies: await sessionCookies(context, baseUrl),
              savedAt: Date.now()
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new CliError("UIT SSO login timed out. Please try again.");
    } finally {
      await browser.close().catch(() => undefined);
      this.activeBrowser = undefined;
    }
  }

  async cancel(): Promise<void> {
    const browser = this.activeBrowser;
    this.activeBrowser = undefined;
    await browser?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

/** Provision the pinned Chromium revision during npm package installation. */
export function installBundledChromium(): void {
  const require = createRequire(import.meta.url);
  const playwrightPackage = require.resolve("playwright/package.json");
  const cliPath = join(dirname(playwrightPackage), "cli.js");
  const browserRoot = browserDirectory();
  const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Playwright Chromium installation failed with exit code ${result.status ?? "unknown"}.`);
  const executablePath = installedPlaywrightExecutablePath();
  if (!existsSync(executablePath)) throw new Error(`Playwright did not install Chromium at ${executablePath}.`);
  writeChromiumManifest(executablePath);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]) && process.argv[2] === "--install-browser") {
  try {
    installBundledChromium();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
