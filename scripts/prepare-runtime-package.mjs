import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "uit-runtime");
const sourceDist = join(repositoryRoot, "dist");
const targetDist = join(packageRoot, "dist");
const sourceStudio = join(repositoryRoot, "studio-build");
const targetStudio = join(packageRoot, "studio-build");

const sharedModules = [
  "ajax-helpers",
  "api",
  "codex-client",
  "commands",
  "config",
  "desktop-service",
  "mcp-server",
  "mcp-entry",
  "studio-core",
  "studio-sso",
  "studio-web-server",
  "studio-web-launcher",
  "moodle-session-client",
  "output",
  "types",
  "uit-tools",
  "unzip"
];

if (!existsSync(join(sourceDist, "desktop-service.js"))) {
  throw new Error("Build dist/ before preparing the UIT runtime package.");
}
if (!existsSync(join(sourceStudio, "renderer", "index.html"))) {
  throw new Error("Build studio-build/ before preparing the UIT runtime package.");
}

rmSync(targetDist, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });

for (const moduleName of sharedModules) {
  for (const suffix of [".js", ".js.map", ".d.ts"]) {
    const source = join(sourceDist, `${moduleName}${suffix}`);
    if (existsSync(source)) copyFileSync(source, join(targetDist, `${moduleName}${suffix}`));
  }
}

rmSync(targetStudio, { recursive: true, force: true });
cpSync(sourceStudio, targetStudio, { recursive: true });

console.log(`Prepared ${packageRoot} from ${sourceDist}.`);
