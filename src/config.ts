import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export interface LegacySessionData {
  baseUrl: string;
  userId: number;
  token: string;
}

export interface SessionsData {
  sso?: SsoSessionData | null;
  legacy?: LegacySessionData[] | null;
}

export interface Config {
  authType: "token" | "sso";
  baseUrl: string;
  userId: number | null;
  token?: string;
  sesskey?: string;
  cookies?: SsoCookie[];
}

export const getSessionsFilePath = (): string => join(homedir(), ".uit", "sessions.json");

let cfg: Config | undefined;

export function resetConfigCache(): void {
  cfg = undefined;
}

export function readSessionsFile(): SessionsData {
  const sessionsFile = getSessionsFilePath();
  if (existsSync(sessionsFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
      if (Array.isArray(data)) return { legacy: data };
    } catch {
      // Fall through
    }
  }
  // Migration fallback: check legacy files if present
  const oldSsoPaths = [
    join(homedir(), ".uit", "sso-session.json"),
    join(homedir(), ".uit", ".sso-session.json")
  ];
  let migratedSso: SsoSessionData | null = null;
  for (const p of oldSsoPaths) {
    if (existsSync(p)) {
      try {
        migratedSso = JSON.parse(readFileSync(p, "utf8"));
        break;
      } catch {}
    }
  }
  const oldLegacyPath = join(homedir(), ".uit", "legacy-sessions.json");
  let migratedLegacy: LegacySessionData[] | null = null;
  if (existsSync(oldLegacyPath)) {
    try {
      const records = JSON.parse(readFileSync(oldLegacyPath, "utf8"));
      if (Array.isArray(records)) migratedLegacy = records;
      else if (records && typeof records === "object" && records.token) migratedLegacy = [records];
    } catch {}
  }
  return { sso: migratedSso, legacy: migratedLegacy };
}

export function writeSessionsFile(data: SessionsData): void {
  const path = getSessionsFilePath();
  const dir = join(homedir(), ".uit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function load(): Config {
  if (cfg) return cfg;

  // 1. Environment variable override (e.g. CI/CD or scripts)
  if (process.env.UIT_TOKEN) {
    const baseUrl = (process.env.UIT_BASE_URL || "https://courses.uit.edu.vn").replace(/\/+$/, "");
    const userId = process.env.UIT_USER_ID ? Number.parseInt(process.env.UIT_USER_ID, 10) : null;
    cfg = {
      authType: "token",
      token: process.env.UIT_TOKEN,
      baseUrl,
      userId: Number.isFinite(userId) ? userId : null
    };
    return cfg;
  }

  // 2. Read ~/.uit/sessions.json
  const sessions = readSessionsFile();

  // 2a. Check SSO session
  if (
    sessions.sso &&
    sessions.sso.baseUrl &&
    sessions.sso.sesskey &&
    sessions.sso.userId &&
    Array.isArray(sessions.sso.cookies)
  ) {
    cfg = {
      authType: "sso",
      token: "",
      baseUrl: sessions.sso.baseUrl.replace(/\/+$/, ""),
      userId: Number(sessions.sso.userId),
      sesskey: sessions.sso.sesskey,
      cookies: sessions.sso.cookies
    };
    return cfg;
  }

  // 2b. Check Legacy token session
  if (sessions.legacy && sessions.legacy.length > 0) {
    const record = sessions.legacy[0];
    if (record && record.token) {
      const baseUrl = (record.baseUrl || "https://coursesold.uit.edu.vn").replace(/\/+$/, "");
      const userId = record.userId ? Number.parseInt(String(record.userId), 10) : null;
      cfg = {
        authType: "token",
        token: record.token,
        baseUrl,
        userId: Number.isFinite(userId) ? userId : null
      };
      return cfg;
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
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  const sessions = readSessionsFile();
  const legacyList = (sessions.legacy || []).filter((item) => item.baseUrl !== cleanBaseUrl);
  legacyList.unshift({ baseUrl: cleanBaseUrl, userId, token });
  sessions.legacy = legacyList;
  writeSessionsFile(sessions);
  const path = getSessionsFilePath();
  console.error(`Saved to ${path}`);
  cfg = {
    authType: "token",
    token,
    userId,
    baseUrl: cleanBaseUrl
  };
  return path;
}

export function saveSsoSession(sessionData: SsoSessionData): string {
  const sessions = readSessionsFile();
  sessions.sso = sessionData;
  writeSessionsFile(sessions);
  const path = getSessionsFilePath();
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

export function deleteSsoSession(): void {
  const sessions = readSessionsFile();
  delete sessions.sso;
  writeSessionsFile(sessions);
  cfg = undefined;
}

export function deleteLegacySession(baseUrl?: string): void {
  const sessions = readSessionsFile();
  if (baseUrl) {
    const clean = baseUrl.replace(/\/+$/, "");
    sessions.legacy = (sessions.legacy || []).filter((item) => item.baseUrl !== clean);
  } else {
    sessions.legacy = [];
  }
  writeSessionsFile(sessions);
  cfg = undefined;
}
