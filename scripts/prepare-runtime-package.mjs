import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "uit-runtime");
const sourceDist = join(repositoryRoot, "dist");
const targetDist = join(packageRoot, "dist");

const sharedModules = [
  "ajax-helpers",
  "api",
  "codex-client",
  "commands",
  "config",
  "desktop-service",
  "mcp-server",
  "moodle-session-client",
  "output",
  "types",
  "unzip"
];

if (!existsSync(join(sourceDist, "desktop-service.js"))) {
  throw new Error("Build dist/ before preparing the UIT runtime package.");
}

rmSync(targetDist, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });

for (const moduleName of sharedModules) {
  for (const suffix of [".js", ".js.map", ".d.ts"]) {
    const source = join(sourceDist, `${moduleName}${suffix}`);
    if (existsSync(source)) copyFileSync(source, join(targetDist, `${moduleName}${suffix}`));
  }
}

rmSync(join(packageRoot, "desktop"), { recursive: true, force: true });
cpSync(join(repositoryRoot, "desktop"), join(packageRoot, "desktop"), { recursive: true });

console.log(`Prepared ${packageRoot} from ${sourceDist}.`);
