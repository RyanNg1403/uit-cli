import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./output.js";

export interface MoodleSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface MoodleBrowserSessionData {
  baseUrl: string;
  userId: number;
  sesskey: string;
  cookies: MoodleSessionCookie[];
  savedAt?: number;
}

export interface LegacyBrowserSessionData extends MoodleBrowserSessionData {
  authType: "session";
}

export type LegacySessionData = LegacyBrowserSessionData;

export type SessionAuthType = "sso" | "session";

export interface SessionsData {
  sso?: MoodleBrowserSessionData | null;
  legacy?: LegacySessionData[] | null;
  active?: { authType: SessionAuthType; baseUrl: string } | null;
}

export interface Config {
  authType: SessionAuthType;
  baseUrl: string;
  userId: number | null;
  sesskey?: string;
  cookies?: MoodleSessionCookie[];
}

export const getSessionsFilePath = (): string => join(homedir(), ".uit", "sessions.json");

let cfg: Config | undefined;

export function resetConfigCache(): void {
  cfg = undefined;
}

export function readSessionsFile(): SessionsData {
  const sessionsFile = getSessionsFilePath();
  if (!existsSync(sessionsFile)) return {};
  try {
    const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // load() will report that no active session exists.
  }
  return {};
}

export function writeSessionsFile(data: SessionsData): void {
  const path = getSessionsFilePath();
  const dir = join(homedir(), ".uit");
  const temporaryPath = `${path}.part-${randomUUID()}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    renameSync(temporaryPath, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function load(): Config {
  if (cfg) return cfg;

  // Web-service-token authentication is no longer supported. Fail explicitly
  // instead of silently selecting another saved session when stale env vars remain.
  if (process.env.UIT_TOKEN) {
    throw new CliError("UIT_TOKEN authentication is no longer supported. Run uit login or uit login --legacy to sign in in a browser.");
  }

  // Read the shared browser-session store.
  const sessions = readSessionsFile();

  // An explicit selection is authoritative. Never fall through to another
  // account when the selected session is missing or uses a retired auth mode.
  if (sessions.active) {
    const activeBaseUrl = sessions.active.baseUrl?.replace(/\/+$/, "");
    if (sessions.active.authType === "session") {
      const record = (sessions.legacy || []).find((item) => item.baseUrl?.replace(/\/+$/, "") === activeBaseUrl);
      if (record && record.authType === "session" && record.sesskey && Array.isArray(record.cookies) && record.cookies.length) {
        cfg = {
          authType: "session",
          baseUrl: record.baseUrl.replace(/\/+$/, ""),
          userId: Number(record.userId),
          sesskey: record.sesskey,
          cookies: record.cookies
        };
        return cfg;
      }
      throw new CliError("The selected UIT session is no longer saved. Sign in again.");
    }
    if (sessions.active.authType === "sso") {
      const record = sessions.sso;
      if (record && record.baseUrl?.replace(/\/+$/, "") === activeBaseUrl && record.sesskey && Array.isArray(record.cookies) && record.cookies.length) {
        cfg = {
          authType: "sso",
          baseUrl: record.baseUrl.replace(/\/+$/, ""),
          userId: Number(record.userId),
          sesskey: record.sesskey,
          cookies: record.cookies
        };
        return cfg;
      }
      throw new CliError("The selected UIT session is no longer saved. Sign in again.");
    }
    throw new CliError("The saved active UIT session uses an unsupported authentication method. Sign in again.");
  }

  // With no explicit selection, use a saved SSO session before legacy sessions.
  if (
    sessions.sso &&
    sessions.sso.baseUrl &&
    sessions.sso.sesskey &&
    sessions.sso.userId &&
    Array.isArray(sessions.sso.cookies) &&
    sessions.sso.cookies.length
  ) {
    cfg = {
      authType: "sso",
      baseUrl: sessions.sso.baseUrl.replace(/\/+$/, ""),
      userId: Number(sessions.sso.userId),
      sesskey: sessions.sso.sesskey,
      cookies: sessions.sso.cookies
    };
    return cfg;
  }

  // Use a saved legacy browser session if no account was explicitly selected.
  const record = (sessions.legacy || []).find((item) => item.authType === "session" && item.sesskey && Array.isArray(item.cookies) && item.cookies.length);
  if (record) {
    cfg = {
      authType: "session",
      baseUrl: record.baseUrl.replace(/\/+$/, ""),
      userId: Number(record.userId),
      sesskey: record.sesskey,
      cookies: record.cookies
    };
    return cfg;
  }

  throw new CliError("No active UIT session found. Run: uit login (SSO) or uit login --legacy");
}

/** Resolve the same active session configuration for CLI, MCP, and Studio callers. */
export function getActiveConfig(options: { fresh?: boolean } = {}): Readonly<Config> {
  if (options.fresh) resetConfigCache();
  return load();
}

export function get(key: "baseUrl"): string;
export function get(key: "userId"): number | null;
export function get(key: "sesskey"): string | undefined;
export function get(key: "cookies"): MoodleSessionCookie[] | undefined;
export function get(key: "authType"): SessionAuthType;
export function get(key: keyof Config): Config[keyof Config] {
  const c = load();
  return c[key];
}

export function saveSsoSession(sessionData: MoodleBrowserSessionData): string {
  const sessions = readSessionsFile();
  sessions.sso = sessionData;
  sessions.active = { authType: "sso", baseUrl: sessionData.baseUrl.replace(/\/+$/, "") };
  writeSessionsFile(sessions);
  const path = getSessionsFilePath();
  console.error(`SSO session saved to ${path}`);
  cfg = {
    authType: "sso",
    baseUrl: sessionData.baseUrl.replace(/\/+$/, ""),
    userId: sessionData.userId,
    sesskey: sessionData.sesskey,
    cookies: sessionData.cookies
  };
  return path;
}

export function saveLegacyBrowserSession(sessionData: MoodleBrowserSessionData): string {
  const cleanBaseUrl = sessionData.baseUrl.replace(/\/+$/, "");
  const sessions = readSessionsFile();
  sessions.legacy = (sessions.legacy || []).filter((item) => item.authType === "session" && item.baseUrl !== cleanBaseUrl);
  sessions.legacy.unshift({ ...sessionData, baseUrl: cleanBaseUrl, authType: "session" });
  sessions.active = { authType: "session", baseUrl: cleanBaseUrl };
  writeSessionsFile(sessions);
  const path = getSessionsFilePath();
  console.error(`Legacy Moodle session saved to ${path}`);
  cfg = {
    authType: "session",
    baseUrl: cleanBaseUrl,
    userId: sessionData.userId,
    sesskey: sessionData.sesskey,
    cookies: sessionData.cookies
  };
  return path;
}

/** Select an already-persisted account without changing or re-saving credentials. */
export function activateSession(authType: SessionAuthType, baseUrl: string): void {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  const sessions = readSessionsFile();
  const available = authType === "sso"
    ? sessions.sso?.baseUrl?.replace(/\/+$/, "") === cleanBaseUrl
    : (sessions.legacy || []).some((item) => item.baseUrl?.replace(/\/+$/, "") === cleanBaseUrl && item.authType === "session" && Boolean(item.sesskey && item.cookies?.length));
  if (!available) throw new CliError("The selected UIT account is no longer saved. Sign in again.");
  sessions.active = { authType, baseUrl: cleanBaseUrl };
  writeSessionsFile(sessions);
  cfg = undefined;
}

export function deleteSsoSession(): void {
  const sessions = readSessionsFile();
  delete sessions.sso;
  if (sessions.active?.authType === "sso") delete sessions.active;
  writeSessionsFile(sessions);
  cfg = undefined;
}

export function deleteLegacySession(baseUrl?: string): void {
  const sessions = readSessionsFile();
  if (baseUrl) {
    const clean = baseUrl.replace(/\/+$/, "");
    sessions.legacy = (sessions.legacy || []).filter((item) => item.baseUrl !== clean);
    if (sessions.active?.authType === "session" && sessions.active.baseUrl === clean) delete sessions.active;
  } else {
    sessions.legacy = [];
    if (sessions.active?.authType === "session") delete sessions.active;
  }
  writeSessionsFile(sessions);
  cfg = undefined;
}
