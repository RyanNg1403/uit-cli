#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const timeoutMs = 30_000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    shell: options.shell ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`.trim());
  return result;
}

function runLauncher(root, args, env) {
  const launcher = join(root, "bin", process.platform === "win32" ? "uit-studio.cmd" : "uit-studio");
  assert(existsSync(launcher), `Native Studio launcher is missing: ${launcher}`);
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(launcher, args, {
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else child.kill("SIGTERM");
      rejectProcess(new Error(`Native Studio launcher timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProcess(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveProcess({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}

async function waitForMissing(path) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fail(`The packaged Studio control file was not removed: ${path}`);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fail(`The packaged Studio backend did not exit: ${pid}`);
}

async function stopServer(controlFile) {
  const control = JSON.parse(await readFile(controlFile, "utf8"));
  const response = await fetch(`http://127.0.0.1:${control.port}/api/control/stop`, {
    method: "POST",
    headers: {
      Host: `127.0.0.1:${control.port}`,
      "X-Studio-Control-Secret": control.controlSecret
    }
  });
  assert(response.ok, `Native Studio shutdown returned ${response.status}.`);
  await response.arrayBuffer();
  await waitForMissing(controlFile);
  await waitForProcessExit(control.pid);
}

async function extractArchive(archive) {
  const extraction = await mkdtemp(join(tmpdir(), "uit-studio-smoke-"));
  if (process.platform === "win32") {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:UIT_STUDIO_ARCHIVE -DestinationPath $env:UIT_STUDIO_EXTRACTION -Force"], {
      env: { ...process.env, UIT_STUDIO_ARCHIVE: resolve(archive), UIT_STUDIO_EXTRACTION: extraction }
    });
  } else {
    run("tar", ["-xf", resolve(archive), "-C", extraction]);
  }
  return { root: join(extraction, "uit-studio"), extraction };
}

function smokeEnvironment(profile) {
  const env = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: profile,
    LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: profile,
    XDG_CACHE_HOME: profile,
    UIT_TEST_PROFILE: profile,
    UIT_STUDIO_CONTROL_FILE: join(profile, "server.json"),
    UIT_DISABLE_CONFIG: "1",
    CODEX_HOME: join(profile, "codex")
  };
  return env;
}

async function main() {
  const archive = process.env.UIT_STUDIO_ARCHIVE || process.argv[2];
  const packageRoot = process.env.UIT_STUDIO_PACKAGE_ROOT || (!archive ? resolve("release/uit-studio") : undefined);
  const extracted = archive ? await extractArchive(archive) : undefined;
  const root = extracted?.root || packageRoot;
  if (!root) fail("Set UIT_STUDIO_ARCHIVE or UIT_STUDIO_PACKAGE_ROOT to the native Studio package.");

  const version = (await readFile(join(root, "VERSION"), "utf8")).trim();
  assert(/^\d+\.\d+\.\d+$/.test(version), "Native Studio VERSION is missing or invalid.");
  const profile = await mkdtemp(join(tmpdir(), "uit-studio-smoke-profile-"));
  const env = smokeEnvironment(profile);
  const originalEnvironment = { ...process.env };
  Object.assign(process.env, env);
  const controlFile = env.UIT_STUDIO_CONTROL_FILE;
  let serverStarted = false;
  try {
    const versionResult = await runLauncher(root, ["--version"], env);
    assert(versionResult.code === 0, `Native Studio --version failed: ${versionResult.stderr}`);
    assert(versionResult.stdout === `${version}\n`, "Native Studio --version produced unexpected output.");

    const helpResult = await runLauncher(root, ["--help"], env);
    assert(helpResult.code === 0 && helpResult.stdout.includes("Usage: uit-studio [options]"), "Native Studio --help failed.");

    const runtimeRoot = join(root, "app", "node_modules", "uit-runtime");
    let launchUrl;
    const { runStudioWebLauncher } = await import(pathToFileURL(join(runtimeRoot, "dist", "studio-web-launcher.js")).href);
    await runStudioWebLauncher([], {
      runtimeRoot,
      controlFile,
      userDataPath: join(profile, "studio"),
      openTarget: async (target) => { launchUrl = target; }
    });
    assert(typeof launchUrl === "string", "Native Studio did not return a launch URL.");
    assert(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[A-Za-z0-9_-]{20,}$/.test(launchUrl), `Native Studio returned an unsafe launch URL: ${launchUrl}`);
    serverStarted = true;

    const control = JSON.parse(await readFile(controlFile, "utf8"));
    assert(Number.isSafeInteger(control.pid) && control.pid > 0, "Native Studio control record has no valid backend PID.");
    assert(Number.isSafeInteger(control.port) && control.port > 0, "Native Studio control record has no valid port.");
    const origin = `http://127.0.0.1:${control.port}`;
    const health = await fetch(`${origin}/api/health`, {
      headers: {
        Host: `127.0.0.1:${control.port}`,
        "X-Studio-Control-Secret": control.controlSecret
      }
    });
    assert(health.ok, `Native Studio health endpoint returned ${health.status}.`);
    const healthBody = await health.json();
    assert(healthBody.ok === true && healthBody.pid === control.pid && healthBody.port === control.port, "Native Studio health response is inconsistent with its control record.");

    const browserRoot = join(runtimeRoot, "browsers");
    const manifest = JSON.parse(await readFile(join(browserRoot, "chromium.json"), "utf8"));
    const executablePath = resolve(browserRoot, manifest.executablePath);
    assert(manifest.playwrightVersion === "1.63.0", "Native Studio contains the wrong Playwright Chromium revision.");
    assert(existsSync(executablePath), `Native Studio Chromium executable is missing: ${executablePath}`);
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
    const require = createRequire(pathToFileURL(join(root, "app", "package.json")));
    const { chromium } = require("playwright");
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: process.getuid?.() === 0 ? ["--no-sandbox"] : []
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForSelector("#account-label", { state: "visible", timeout: timeoutMs });
      const accountLabel = await page.locator("#account-label").textContent();
      assert(accountLabel === "Connect accounts", `Native Studio did not render the packaged web UI in a clean profile (account label: ${JSON.stringify(accountLabel)}).`);
      assert(errors.length === 0, `Native Studio renderer errors: ${errors.join(" | ")}`);
    } finally {
      await browser.close();
    }

    await stopServer(controlFile);
    serverStarted = false;
    console.log(`Verified native Studio archive ${archive || root} (${version}).`);
  } finally {
    if (serverStarted) await stopServer(controlFile).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    if (extracted) await rm(extracted.extraction, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
