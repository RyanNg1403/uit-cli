import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./output.js";

export interface SsoCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface SsoSessionData {
  baseUrl: string;
  userId: number;
  sesskey: string;
  cookies: SsoCookie[];
  savedAt?: number;
}

export interface Config {
  authType: "token" | "sso";
  baseUrl: string;
  userId: number | null;
  token?: string;
  sesskey?: string;
  cookies?: SsoCookie[];
}

let cfg: Config | undefined;

export function resetConfigCache(): void {
  cfg = undefined;
}

function findLocalEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
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

  // 1. Check local .env file in cwd hierarchy
  const localEnvPath = findLocalEnvFile();
  if (localEnvPath) {
    const env = parseEnv(readFileSync(localEnvPath, "utf8"));
    if (env.UIT_TOKEN) {
      const baseUrl = (env.UIT_BASE_URL || "https://courses.uit.edu.vn").replace(/\/+$/, "");
      const userId = env.UIT_USER_ID ? Number.parseInt(env.UIT_USER_ID, 10) : null;
      cfg = {
        authType: "token",
        token: env.UIT_TOKEN,
        baseUrl,
        userId: Number.isFinite(userId) ? userId : null
      };
      return cfg;
    }
  }

  // 2. Check active SSO session in ~/.uit/sso-session.json
  const ssoPath = join(homedir(), ".uit", "sso-session.json");
  if (existsSync(ssoPath)) {
    try {
      const data: SsoSessionData = JSON.parse(readFileSync(ssoPath, "utf8"));
      if (data.baseUrl && data.sesskey && data.userId && Array.isArray(data.cookies)) {
        cfg = {
          authType: "sso",
          token: "",
          baseUrl: data.baseUrl.replace(/\/+$/, ""),
          userId: Number(data.userId),
          sesskey: data.sesskey,
          cookies: data.cookies
        };
        return cfg;
      }
    } catch {
      // Fall through if parsing fails
    }
  }

  // 3. Fallback to legacy global ~/.uit/.env token
  const homeEnvPath = join(homedir(), ".uit", ".env");
  if (existsSync(homeEnvPath)) {
    try {
      const env = parseEnv(readFileSync(homeEnvPath, "utf8"));
      if (env.UIT_TOKEN) {
        const baseUrl = (env.UIT_BASE_URL || "https://courses.uit.edu.vn").replace(/\/+$/, "");
        const userId = env.UIT_USER_ID ? Number.parseInt(env.UIT_USER_ID, 10) : null;
        cfg = {
          authType: "token",
          token: env.UIT_TOKEN,
          baseUrl,
          userId: Number.isFinite(userId) ? userId : null
        };
        return cfg;
      }
    } catch {
      // Fall through
    }
  }

  throw new CliError("No active UIT session found. Run: uit login (or uit login --token <token>)");
}

export function get(key: "token"): string;
export function get(key: "baseUrl"): string;
export function get(key: "userId"): number | null;
export function get(key: "sesskey"): string | undefined;
export function get(key: "cookies"): SsoCookie[] | undefined;
export function get(key: "authType"): "token" | "sso";
export function get(key: keyof Config): Config[keyof Config] {
  const c = load();
  if (key === "token") return c.token || "";
  return c[key];
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
  cfg = {
    authType: "token",
    token,
    userId,
    baseUrl: baseUrl.replace(/\/+$/, "")
  };
  return path;
}

export function saveSsoSession(sessionData: SsoSessionData): string {
  const dir = join(homedir(), ".uit");
  const path = join(dir, "sso-session.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(sessionData, null, 2), "utf8");
  if (process.platform !== "win32") chmodSync(path, 0o600);
  console.error(`SSO session saved to ${path}`);
  cfg = {
    authType: "sso",
    token: "",
    baseUrl: sessionData.baseUrl.replace(/\/+$/, ""),
    userId: sessionData.userId,
    sesskey: sessionData.sesskey,
    cookies: sessionData.cookies
  };
  return path;
}
