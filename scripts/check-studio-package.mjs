import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function pack(cwd) {
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    { cwd, encoding: "utf8" }
  );

  if (packed.status !== 0) {
    process.stderr.write(packed.stderr);
    process.exit(packed.status ?? 1);
  }

  return JSON.parse(packed.stdout)[0];
}

const studio = pack("packages/uit-studio");
const studioFiles = studio.files.map(({ path }) => path);
const studioExpected = new Set(["LICENSE", "README.md", "package.json", "studio.js"]);
const studioUnexpected = studioFiles.filter((path) => !studioExpected.has(path));
if (studioUnexpected.length > 0) {
  throw new Error(`uit-studio package contains unexpected files: ${studioUnexpected.join(", ")}`);
}
if (!studioFiles.includes("studio.js")) {
  throw new Error("uit-studio package is missing studio.js");
}

const studioPackage = JSON.parse(readFileSync("packages/uit-studio/package.json", "utf8"));
if (studioPackage.dependencies?.["uit-cli"] || !studioPackage.dependencies?.["uit-runtime"]) {
  throw new Error("uit-studio must depend on uit-runtime, not uit-cli");
}
if (studioPackage.dependencies?.playwright || studioPackage.devDependencies?.playwright) {
  throw new Error("uit-studio must not declare Playwright");
}

const runtimePackage = JSON.parse(readFileSync("packages/uit-runtime/package.json", "utf8"));
if (runtimePackage.dependencies?.playwright || runtimePackage.optionalDependencies?.playwright) {
  throw new Error("uit-runtime must not install Playwright");
}

const runtime = pack("packages/uit-runtime");
const runtimeFiles = runtime.files.map(({ path }) => path);
const runtimeUnexpected = runtimeFiles.filter((path) => (
  path !== "LICENSE" &&
  path !== "README.md" &&
  path !== "package.json" &&
  !path.startsWith("dist/") &&
  !path.startsWith("desktop-build/")
));
if (runtimeUnexpected.length > 0) {
  throw new Error(`uit-runtime package contains unexpected files: ${runtimeUnexpected.join(", ")}`);
}
for (const required of [
  "dist/desktop-service.js",
  "dist/mcp-server.js",
  "desktop-build/main.js",
  "desktop-build/preload.cjs",
  "desktop-build/renderer/assets/uit-dau-dau-icon.png"
]) {
  if (!runtimeFiles.includes(required)) throw new Error(`uit-runtime package is missing ${required}`);
}
for (const forbidden of ["dist/cli.js", "dist/sso-login.js"]) {
  if (runtimeFiles.includes(forbidden)) throw new Error(`uit-runtime package must not contain ${forbidden}`);
}

console.log(`Verified uit-studio npm package (${studio.size} bytes).`);
console.log(`Verified Playwright-free uit-runtime package (${runtime.size} bytes).`);
