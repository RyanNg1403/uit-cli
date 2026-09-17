import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync, type ChildProcess, type spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runStudioWebLauncher, stopStudioWebServer } from "../src/studio-web-launcher.js";
import { readControlRecord, startStudioWebServer, type StudioWebServer } from "../src/studio-web-server.js";

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
    expect(result.stdout).toContain("Usage: uit-studio [command]");
    expect(result.stdout).toContain("stop");
    expect(result.stderr).toBe("");
  });

  it("loads the standalone runtime launcher through a file URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-wrapper-test-"));
    const appDirectory = join(directory, "app");
    const runtimeDirectory = join(appDirectory, "node_modules", "uit-runtime");
    const runtimeDist = join(runtimeDirectory, "dist");
    try {
      await mkdir(runtimeDist, { recursive: true });
      await writeFile(join(appDirectory, "package.json"), JSON.stringify({ type: "module", version: studioPackage.version }));
      await writeFile(join(appDirectory, "studio.js"), readFileSync(studioLauncher, "utf8"));
      await writeFile(join(runtimeDirectory, "package.json"), JSON.stringify({ name: "uit-runtime", version: studioPackage.version, type: "module" }));
      await writeFile(join(runtimeDist, "studio-web-launcher.js"), "export async function stopStudioWebServer() { return false; }\n");

      const result = spawnSync(process.execPath, [join(appDirectory, "studio.js"), "stop"], {
        cwd: appDirectory,
        encoding: "utf8",
        timeout: 5_000
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("UIT Studio is not running.\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses one healthy backend for repeated launches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-launcher-test-"));
    const staticRoot = join(directory, "renderer");
    const controlFile = join(directory, "server.json");
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>UIT Studio fixture</title>");
    const server = await startStudioWebServer({
      staticRoot,
      controlFile,
      userDataPath: join(directory, "profile"),
      createCore: async () => ({ handlers: () => ({}), shutdown: async () => undefined })
    });
    const opened: string[] = [];
    const spawnProcess = vi.fn();
    try {
      const options = {
        controlFile,
        staticRoot,
        userDataPath: join(directory, "profile"),
        openTarget: async (target: string) => { opened.push(target); },
        spawnProcess: spawnProcess as unknown as typeof spawn
      };
      await runStudioWebLauncher([], options);
      await runStudioWebLauncher([], options);

      expect(spawnProcess).not.toHaveBeenCalled();
      expect(opened).toHaveLength(2);
      expect(new URL(opened[0]).origin).toBe(server.origin);
      expect(new URL(opened[1]).origin).toBe(server.origin);
      expect(new URL(opened[0]).hash).not.toBe(new URL(opened[1]).hash);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops the healthy backend through its authenticated control record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-stop-test-"));
    const staticRoot = join(directory, "renderer");
    const controlFile = join(directory, "server.json");
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>UIT Studio fixture</title>");
    const server = await startStudioWebServer({
      staticRoot,
      controlFile,
      userDataPath: join(directory, "profile"),
      createCore: async () => ({ handlers: () => ({}), shutdown: async () => undefined })
    });
    try {
      await expect(stopStudioWebServer({ controlFile, pollIntervalMs: 10, shutdownTimeoutMs: 2_000 })).resolves.toBe(true);
      await expect(readControlRecord(controlFile)).resolves.toBeUndefined();
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats a missing backend as a successful no-op", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-stop-empty-"));
    try {
      await expect(stopStudioWebServer({ controlFile: join(directory, "server.json") })).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces an unreachable control record before launching a new backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-launcher-test-"));
    const staticRoot = join(directory, "renderer");
    const controlFile = join(directory, "server.json");
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>UIT Studio fixture</title>");
    await writeFile(controlFile, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      port: 1,
      nonce: "n".repeat(32),
      controlSecret: "s".repeat(32)
    })}\n`);
    let replacement: StudioWebServer | undefined;
    const child = { exitCode: null, once: vi.fn(), unref: vi.fn() } as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      void startStudioWebServer({
        staticRoot,
        controlFile,
        userDataPath: join(directory, "profile"),
        createCore: async () => ({ handlers: () => ({}), shutdown: async () => undefined })
      }).then((server) => { replacement = server; });
      return child;
    });
    const opened: string[] = [];
    try {
      await runStudioWebLauncher([], {
        runtimeRoot: resolve("."),
        controlFile,
        staticRoot,
        userDataPath: join(directory, "profile"),
        spawnProcess: spawnProcess as unknown as typeof spawn,
        openTarget: async (target: string) => { opened.push(target); }
      });

      const record = await readControlRecord(controlFile);
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(record?.port).toBe(replacement?.port);
      expect(record?.port).not.toBe(1);
      expect(opened).toHaveLength(1);
    } finally {
      await replacement?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
