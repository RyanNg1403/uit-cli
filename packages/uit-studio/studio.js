#!/usr/bin/env node

import { createRequire } from "node:module";
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
  console.log("Usage: uit-studio [command]");
  console.log();
  console.log("Commands:");
  console.log("  stop          stop the running UIT Studio server");
  console.log();
  console.log("Options:");
  console.log("  -v, --version  output the version number");
  console.log("  -h, --help     display help for command");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("uit-runtime/package.json"));

try {
  const launcher = await import(join(packageRoot, "dist", "studio-web-launcher.js"));
  if (launcherArgs.length === 1 && launcherArgs[0] === "stop") {
    const stopped = await launcher.stopStudioWebServer();
    console.log(stopped ? "UIT Studio stopped." : "UIT Studio is not running.");
  } else {
    await launcher.runStudioWebLauncher(launcherArgs, { runtimeRoot: packageRoot });
  }
} catch (error) {
  console.error(`Could not start UIT Studio: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
