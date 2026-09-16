import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLAYWRIGHT_VERSION = "1.63.0";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserRoot = resolve(process.env.UIT_STUDIO_CHROMIUM_DIR || join(packageRoot, "browsers"));
const manifestPath = join(browserRoot, "chromium.json");

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") {
  console.log("Skipped UIT Studio Chromium provisioning because PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1.");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const playwrightPackage = require.resolve("playwright/package.json");
const playwrightMetadata = JSON.parse(readFileSync(playwrightPackage, "utf8"));
if (playwrightMetadata.version !== PLAYWRIGHT_VERSION) {
  throw new Error(`UIT Studio requires Playwright ${PLAYWRIGHT_VERSION}, found ${playwrightMetadata.version}.`);
}

mkdirSync(browserRoot, { recursive: true });
const cliPath = join(dirname(playwrightPackage), "cli.js");
const install = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
  stdio: "inherit"
});
if (install.error) throw install.error;
if (install.status !== 0) throw new Error(`Playwright Chromium installation failed with exit code ${install.status ?? "unknown"}.`);

const executable = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", "import(\"playwright\").then(({ chromium }) => process.stdout.write(chromium.executablePath())).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })"],
  { cwd: packageRoot, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot }, encoding: "utf8" }
);
if (executable.error) throw executable.error;
if (executable.status !== 0) throw new Error(`Could not resolve the installed Playwright Chromium executable. ${String(executable.stderr || "").trim()}`.trim());

const executablePath = String(executable.stdout).trim();
const relativeExecutablePath = relative(browserRoot, executablePath);
if (!executablePath || !existsSync(executablePath) || !relativeExecutablePath || relativeExecutablePath.startsWith(`..${sep}`) || relativeExecutablePath === ".." || resolve(browserRoot, relativeExecutablePath) !== executablePath) {
  throw new Error(`Playwright did not install Chromium inside ${browserRoot}.`);
}

writeFileSync(manifestPath, `${JSON.stringify({
  playwrightVersion: PLAYWRIGHT_VERSION,
  platform: process.platform,
  architecture: process.arch,
  executablePath: relativeExecutablePath
}, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(`Provisioned UIT Studio Chromium at ${executablePath}.`);
