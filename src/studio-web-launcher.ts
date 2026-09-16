import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openSystemTarget,
  readControlRecord,
  type StudioWebControlRecord
} from "./studio-web-server.js";

export interface StudioWebLauncherOptions {
  runtimeRoot?: string;
  controlFile?: string;
  staticRoot?: string;
  userDataPath?: string;
  spawnProcess?: typeof spawn;
  openTarget?: typeof openSystemTarget;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

type JsonRecord = Record<string, unknown>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function defaultRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultControlFile(): string {
  return join(homedir(), ".uit", "studio", "server.json");
}

function defaultUserDataPath(): string {
  return resolve(process.env.UIT_TEST_PROFILE || join(homedir(), ".uit", "studio"));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function parseFlags(args: string[]): {
  help: boolean;
  noOpen: boolean;
  foreground: boolean;
  stop: boolean;
  controlFile?: string;
  staticRoot?: string;
  userDataPath?: string;
} {
  const result = { help: false, noOpen: false, foreground: false, stop: false, controlFile: undefined as string | undefined, staticRoot: undefined as string | undefined, userDataPath: undefined as string | undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--no-open") result.noOpen = true;
    else if (argument === "--foreground") result.foreground = true;
    else if (argument === "--stop") result.stop = true;
    else if (["--control-file", "--static-root", "--user-data"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--control-file") result.controlFile = value;
      else if (argument === "--static-root") result.staticRoot = value;
      else result.userDataPath = value;
    } else {
      throw new Error(`Unknown web launch option: ${argument}`);
    }
  }
  return result;
}

function originFor(record: StudioWebControlRecord): string {
  return `http://127.0.0.1:${record.port}`;
}

function controlHeaders(record: StudioWebControlRecord): Record<string, string> {
  return {
    Host: `127.0.0.1:${record.port}`,
    "X-Studio-Control-Secret": record.controlSecret,
    Accept: "application/json",
    "Cache-Control": "no-store"
  };
}

async function controlRequest(record: StudioWebControlRecord, pathname: string, method: "GET" | "POST"): Promise<Response | undefined> {
  try {
    return await fetch(`${originFor(record)}${pathname}`, {
      method,
      headers: controlHeaders(record),
      signal: AbortSignal.timeout(1_000)
    });
  } catch {
    return undefined;
  }
}

async function healthy(record: StudioWebControlRecord): Promise<boolean> {
  const response = await controlRequest(record, "/api/health", "GET");
  if (!response?.ok) return false;
  try {
    const body: unknown = await response.json();
    return isRecord(body) && body.ok === true && body.port === record.port;
  } catch {
    return false;
  }
}

async function launchUrl(record: StudioWebControlRecord): Promise<string> {
  const response = await controlRequest(record, "/api/control/launch", "POST");
  if (!response?.ok) throw new Error("The UIT Studio web server rejected the launch request.");
  const body: unknown = await response.json();
  if (!isRecord(body) || body.ok !== true || typeof body.launchUrl !== "string") throw new Error("The UIT Studio web server returned an invalid launch URL.");
  const expectedOrigin = originFor(record);
  const parsed = new URL(body.launchUrl);
  if (parsed.origin !== expectedOrigin || !parsed.hash.startsWith("#bootstrap=") || parsed.hash.length < 20) throw new Error("The UIT Studio web server returned an unsafe launch URL.");
  return parsed.href;
}

async function stopServer(record: StudioWebControlRecord): Promise<boolean> {
  const response = await controlRequest(record, "/api/control/stop", "POST");
  return Boolean(response?.ok);
}

async function removeStaleControlFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

function spawnWebServer(
  options: StudioWebLauncherOptions,
  runtimeRoot: string,
  controlFile: string,
  userDataPath: string,
  foreground: boolean
): ChildProcess {
  const serverModule = join(runtimeRoot, "dist", "studio-web-server.js");
  const args = [serverModule, "--serve", "--control-file", controlFile, "--user-data", userDataPath];
  if (options.staticRoot) args.push("--static-root", resolve(options.staticRoot));
  const spawnOptions: SpawnOptions = {
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore"
  } satisfies SpawnOptions;
  const child = (options.spawnProcess || spawn)(process.execPath, args, spawnOptions);
  child.once("error", () => undefined);
  if (!foreground) child.unref();
  return child;
}

async function waitForServer(
  controlFile: string,
  initialChild: ChildProcess | undefined,
  timeoutMs: number,
  intervalMs: number
): Promise<StudioWebControlRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readControlRecord(controlFile);
    if (record && await healthy(record)) return record;
    if (initialChild && initialChild.exitCode !== null && initialChild.exitCode !== 0) throw new Error(`The UIT Studio web server exited before becoming ready (code ${initialChild.exitCode ?? "unknown"}).`);
    await sleep(intervalMs);
  }
  throw new Error("Timed out while starting the UIT Studio web server.");
}

export function printStudioWebHelp(): void {
  console.log("Usage: uit-studio --web [options]");
  console.log();
  console.log("Options:");
  console.log("  --no-open     print the temporary launch URL instead of opening it");
  console.log("  --foreground  keep the server attached to this terminal");
  console.log("  --stop        stop the running web server");
  console.log("  -h, --help    display help for command");
}

export async function runStudioWebLauncher(argv: string[] = process.argv.slice(2), options: StudioWebLauncherOptions = {}): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    printStudioWebHelp();
    return;
  }
  const runtimeRoot = resolve(options.runtimeRoot || defaultRuntimeRoot());
  const controlFile = resolve(options.controlFile || flags.controlFile || process.env.UIT_STUDIO_CONTROL_FILE || defaultControlFile());
  const userDataPath = resolve(options.userDataPath || flags.userDataPath || defaultUserDataPath());
  const openTarget = options.openTarget || openSystemTarget;
  let record = await readControlRecord(controlFile);
  if (record && !(await healthy(record))) {
    await removeStaleControlFile(controlFile);
    record = undefined;
  }

  if (flags.stop) {
    if (!record) {
      console.log("UIT Studio web server is not running.");
      return;
    }
    if (await stopServer(record)) console.log("Stopped UIT Studio web server.");
    else await removeStaleControlFile(controlFile);
    return;
  }

  let child: ChildProcess | undefined;
  if (!record) {
    child = spawnWebServer(options, runtimeRoot, controlFile, userDataPath, flags.foreground);
    record = await waitForServer(controlFile, child, options.startupTimeoutMs || 10_000, options.pollIntervalMs || 100);
  }
  const url = await launchUrl(record);
  if (flags.noOpen) {
    console.log(url);
  } else {
    try {
      await openTarget(url);
    } catch (error) {
      console.error(`Could not open the UIT Studio browser: ${errorMessage(error)}`);
      console.error(`Open this temporary URL manually: ${url}`);
      process.exitCode = 1;
    }
  }

  if (flags.foreground && child) {
    await new Promise<void>((resolveChild) => {
      child?.once("exit", () => resolveChild());
    });
  }
}
