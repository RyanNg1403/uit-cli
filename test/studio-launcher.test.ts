import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const studioDirectory = resolve("packages/uit-studio");
const studioLauncher = resolve(studioDirectory, "studio.js");
const studioPackage = JSON.parse(readFileSync(resolve(studioDirectory, "package.json"), "utf8")) as { version: string };

describe("Studio launcher", () => {
  it.each(["--version", "-v"])("prints %s without starting a backend", (flag) => {
    const result = spawnSync(process.execPath, [studioLauncher, flag], {
      cwd: studioDirectory,
      encoding: "utf8",
      timeout: 5_000
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${studioPackage.version}\n`);
    expect(result.stderr).toBe("");
  });

  it("prints help without starting a backend", () => {
    const result = spawnSync(process.execPath, [studioLauncher, "--help"], {
      cwd: studioDirectory,
      encoding: "utf8",
      timeout: 5_000
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: uit-studio [options]");
    expect(result.stderr).toBe("");
  });
});
