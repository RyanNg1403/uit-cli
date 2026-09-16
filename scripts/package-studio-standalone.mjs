#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const minimumNodeMajor = 24;

const platformNames = {
  darwin: "macos",
  linux: "linux",
  win32: "windows"
};

const platformDetails = {
  macos: { nodePlatform: "darwin", archiveExtension: "tar.gz", nodeName: "node" },
  linux: { nodePlatform: "linux", archiveExtension: "tar.gz", nodeName: "node" },
  windows: { nodePlatform: "win32", archiveExtension: "zip", nodeName: "node.exe" }
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    shell: options.shell ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function inside(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function requireFile(path, description) {
  if (!existsSync(path)) fail(`${description} is missing: ${path}`);
}

function sha256(path) {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectDigest);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

function requestedPlatform() {
  const value = process.argv[2] || platformNames[process.platform];
  if (!value || !platformDetails[value]) fail(`Unsupported standalone Studio platform: ${value || "missing"}.`);
  return value;
}

function requestedArchitecture() {
  const value = process.argv[3] || process.arch;
  if (!/^(?:arm64|x64)$/.test(value)) fail(`Unsupported standalone Studio architecture: ${value}.`);
  return value;
}

function createPosixLauncher() {
  return `#!/bin/sh

set -eu

invoked_path="$0"
case "$invoked_path" in
  /*) ;;
  *) invoked_path="$(pwd)/$invoked_path" ;;
esac
script_path="$invoked_path"
while [ -L "$script_path" ]; do
  link_target="$(readlink "$script_path")"
  case "$link_target" in
    /*) script_path="$link_target" ;;
    *) script_path="$(dirname "$script_path")/$link_target" ;;
  esac
done

bundle_root="$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd)"
export UIT_STUDIO_NATIVE=1
exec "$bundle_root/bin/node" "$bundle_root/app/studio.js" "$@"
`;
}

function createWindowsLauncher() {
  return `@echo off
setlocal
set "BUNDLE_ROOT=%~dp0.."
set "UIT_STUDIO_NATIVE=1"
"%BUNDLE_ROOT%\\bin\\node.exe" "%BUNDLE_ROOT%\\app\\studio.js" %*
exit /b %ERRORLEVEL%
`;
}

function chromiumManifest(runtimeRoot, platform, architecture) {
  const browserRoot = join(runtimeRoot, "browsers");
  const path = join(browserRoot, "chromium.json");
  requireFile(path, "The native Studio Chromium manifest");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.playwrightVersion !== "1.63.0" || manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    fail("The native Studio Chromium manifest does not match the build platform or pinned Playwright version.");
  }
  const executablePath = resolve(browserRoot, manifest.executablePath);
  if (!inside(browserRoot, executablePath) || !existsSync(executablePath)) {
    fail("The native Studio Chromium executable is missing or escapes its package-owned directory.");
  }
  if (platform === "windows" && architecture !== "x64") fail("Windows native Studio packages are x64 only.");
  return executablePath;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/package-studio-standalone.mjs [macos|linux|windows] [arm64|x64] [output-directory]");
    return;
  }

  const platform = requestedPlatform();
  const architecture = requestedArchitecture();
  const details = platformDetails[platform];
  if (details.nodePlatform !== process.platform) fail(`Expected ${details.nodePlatform}, running on ${process.platform}.`);
  if (process.arch !== architecture) fail(`Expected ${architecture}, running on ${process.arch}.`);
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < minimumNodeMajor) fail(`Native Studio packaging requires Node.js ${minimumNodeMajor} or newer; found ${process.versions.node}.`);
  if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) fail("The root package version is missing or invalid.");

  const outputDirectory = resolve(process.cwd(), process.argv[4] || "release-assets");
  mkdirSync(outputDirectory, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "uit-studio-package-"));
  const bundleRoot = join(temporaryDirectory, "uit-studio");
  const appRoot = join(bundleRoot, "app");
  const binRoot = join(bundleRoot, "bin");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const archiveName = `UIT-Studio-web-${platform}-${architecture}.${details.archiveExtension}`;
  const archivePath = join(outputDirectory, archiveName);

  try {
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });

    // Use the repository lockfile to install only the root production graph in
    // the temporary application. Electron is a dev dependency and is therefore
    // absent from the native archive.
    copyFileSync(join(repositoryRoot, "package.json"), join(appRoot, "package.json"));
    copyFileSync(join(repositoryRoot, "package-lock.json"), join(appRoot, "package-lock.json"));
    const installEnvironment = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
    run(npmCommand, ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: appRoot,
      env: installEnvironment,
      shell: process.platform === "win32"
    });
    if (existsSync(join(appRoot, "node_modules", "electron"))) {
      fail("The native Studio archive unexpectedly contains Electron.");
    }

    copyFileSync(join(repositoryRoot, "packages", "uit-studio", "studio.js"), join(appRoot, "studio.js"));
    const runtimeRoot = join(appRoot, "node_modules", "uit-runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    copyFileSync(join(repositoryRoot, "packages", "uit-runtime", "package.json"), join(runtimeRoot, "package.json"));
    for (const directory of ["dist", "desktop-build"]) {
      const source = join(repositoryRoot, directory === "dist" ? "packages/uit-runtime/dist" : "packages/uit-runtime/desktop-build");
      const target = join(runtimeRoot, directory);
      const requiredPath = directory === "dist" ? join(source, "studio-web-launcher.js") : join(source, "renderer", "index.html");
      requireFile(requiredPath, `Prepared UIT runtime ${directory}`);
      cpSync(source, target, { recursive: true });
    }

    // The native archive does not need an npm lockfile or the root CLI entry;
    // its launcher and runtime package are the only executable application code.
    rmSync(join(appRoot, "package-lock.json"), { force: true });
    rmSync(join(appRoot, "node_modules", ".package-lock.json"), { force: true });
    writeFileSync(join(appRoot, "package.json"), `${JSON.stringify({
      name: "uit-studio-native",
      version: packageMetadata.version,
      private: true,
      type: "module"
    }, null, 2)}\n`);

    copyFileSync(join(repositoryRoot, "LICENSE"), join(bundleRoot, "LICENSE"));
    writeFileSync(join(bundleRoot, "VERSION"), `${packageMetadata.version}\n`);
    const nodePath = join(binRoot, details.nodeName);
    copyFileSync(process.execPath, nodePath);
    if (process.platform !== "win32") chmodSync(nodePath, 0o755);

    const launcherPath = join(binRoot, process.platform === "win32" ? "uit-studio.cmd" : "uit-studio");
    writeFileSync(launcherPath, process.platform === "win32" ? createWindowsLauncher() : createPosixLauncher(), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(launcherPath, 0o755);

    const browserRoot = join(runtimeRoot, "browsers");
    const browserEnvironment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot, UIT_STUDIO_CHROMIUM_DIR: browserRoot };
    delete browserEnvironment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    const installScript = `import { installBundledChromium } from ${JSON.stringify(pathToFileURL(join(runtimeRoot, "dist", "studio-sso.js")).href)}; installBundledChromium();`;
    run(nodePath, ["--input-type=module", "-e", installScript], { cwd: appRoot, env: browserEnvironment });
    const executablePath = chromiumManifest(runtimeRoot, platform, architecture);
    console.log(`Bundled Chromium: ${executablePath}`);

    rmSync(archivePath, { force: true });
    rmSync(`${archivePath}.sha256`, { force: true });
    if (process.platform === "win32") {
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Compress-Archive -Path (Join-Path $env:UIT_STUDIO_STAGE 'uit-studio') -DestinationPath $env:UIT_STUDIO_ARCHIVE -Force"], {
        env: { ...process.env, UIT_STUDIO_STAGE: temporaryDirectory, UIT_STUDIO_ARCHIVE: archivePath }
      });
    } else {
      run("tar", ["-C", temporaryDirectory, "-czf", archivePath, "uit-studio"]);
    }
    requireFile(archivePath, "The native Studio archive");
    const digest = await sha256(archivePath);
    writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);
    console.log(`Created ${archivePath}`);
    console.log(`SHA-256 ${digest}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
