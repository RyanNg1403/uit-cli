import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./output.js";

interface Config {
  token: string;
  baseUrl: string;
  userId: number | null;
}

let cfg: Config | undefined;

export function resetConfigCache(): void {
  cfg = undefined;
}

function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const homeCandidate = join(homedir(), ".uit", ".env");
  if (existsSync(homeCandidate)) return homeCandidate;
  return undefined;
}

export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function load(): Config {
  if (cfg) return cfg;

  const path = findEnvFile();
  if (!path) throw new CliError("No .env file found. Run:  uit init");

  const env = parseEnv(readFileSync(path, "utf8"));
  const token = env.UIT_TOKEN;
  const baseUrl = (env.UIT_BASE_URL || "https://courses.uit.edu.vn").replace(/\/+$/, "");
  const userId = env.UIT_USER_ID ? Number.parseInt(env.UIT_USER_ID, 10) : null;

  if (!token) throw new CliError("UIT_TOKEN not set in .env. Run:  uit init");

  cfg = {
    token,
    baseUrl,
    userId: Number.isFinite(userId) ? userId : null
  };
  return cfg;
}

export function get(key: "token"): string;
export function get(key: "baseUrl"): string;
export function get(key: "userId"): number | null;
export function get(key: keyof Config): Config[keyof Config] {
  return load()[key];
}

export function save(token: string, userId: number, baseUrl: string): string {
  const dir = join(homedir(), ".uit");
  const path = join(dir, ".env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `UIT_TOKEN="${token}"\nUIT_BASE_URL="${baseUrl}"\nUIT_USER_ID=${userId}\n`,
    "utf8"
  );
  if (process.platform !== "win32") chmodSync(path, 0o600);
  console.error(`Saved to ${path}`);
  cfg = { token, userId, baseUrl: baseUrl.replace(/\/+$/, "") };
  return path;
}
