import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(repositoryRoot, "desktop-build");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

for (const config of ["tsconfig.desktop-main.json", "tsconfig.desktop-preload.json"]) {
  const result = spawnSync(npmCommand, ["exec", "--", "tsc", "-p", config], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

renameSync(join(outputDirectory, "preload.js"), join(outputDirectory, "preload.cjs"));
cpSync(join(repositoryRoot, "desktop", "renderer"), join(outputDirectory, "renderer"), { recursive: true });
