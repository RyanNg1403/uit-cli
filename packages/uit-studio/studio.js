#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const version = packageMetadata.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("UIT Studio package version is missing or invalid.");
}

const launcherArgs = process.argv.slice(2);
if (launcherArgs.includes("--version") || launcherArgs.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (launcherArgs.length === 1 && (launcherArgs[0] === "--help" || launcherArgs[0] === "-h")) {
  console.log("Usage: uit-studio [options]");
  console.log();
  console.log("Options:");
  console.log("  -v, --version  output the version number");
  console.log("  -h, --help     display help for command");
  process.exit(0);
}

const webMode = process.env.UIT_STUDIO_WEB === "1";
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("uit-runtime/package.json"));

if (webMode) {
  try {
    const { runStudioWebLauncher } = await import(join(packageRoot, "dist", "studio-web-launcher.js"));
    await runStudioWebLauncher(launcherArgs, { runtimeRoot: packageRoot });
  } catch (error) {
    console.error(`Could not start UIT Studio in web mode: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  process.exit();
}

const electron = require("electron");
const main = join(packageRoot, "desktop-build", "main.js");
const child = spawn(electron, [main, ...process.argv.slice(2)], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Could not start UIT Studio: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
