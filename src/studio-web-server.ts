import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import open from "open";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionApiClient } from "./api.js";
import type { SsoSessionData } from "./config.js";
import {
  createStudioCore,
  type StudioCore,
  type StudioHandler,
  type StudioHost
} from "./studio-core.js";
import { StudioSsoService } from "./studio-sso.js";

type JsonRecord = Record<string, unknown>;

export type StudioCoreFactory = (host: StudioHost) => Promise<StudioCore>;

export interface StudioStaticRoot {
  prefix: string;
  root: string;
  allow?: (relativePath: string) => boolean;
}

export interface StudioWebServerOptions {
  staticRoot?: string;
  additionalStaticRoots?: StudioStaticRoot[];
  controlFile?: string;
  userDataPath?: string;
  runtimeRoot?: string;
  port?: number;
  writeControlFile?: boolean;
  host?: StudioHost;
  createCore?: StudioCoreFactory;
  platform?: NodeJS.Platform;
}

export interface StudioWebControlRecord {
  version: 2;
  pid: number;
  port: number;
  nonce: string;
  controlSecret: string;
}

export interface StudioWebServer {
  readonly origin: string;
  readonly port: number;
  readonly controlSecret: string;
  readonly controlFile: string;
  launchUrl(): string;
  publish(message: JsonRecord): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

const MAX_REQUEST_BODY = 1_048_576;
const MAX_BOOTSTRAP_FAILURES = 5;
const BOOTSTRAP_FAILURE_WINDOW_MS = 60_000;
const BOOTSTRAP_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const EVENT_BUFFER_SIZE = 256;
const SESSION_COOKIE = "uit_studio_session";
const CONTROL_HEADER = "x-studio-control-secret";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';";

class BodyTooLargeError extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function token(length = 32): string {
  return randomBytes(length).toString("base64url");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? undefined : value;
}

function defaultControlFile(): string {
  return join(homedir(), ".uit", "studio", "server.json");
}

function defaultUserDataPath(): string {
  return resolve(process.env.UIT_TEST_PROFILE || join(homedir(), ".uit", "studio"));
}

function defaultRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultStaticRoot(runtimeRoot: string): string {
  return join(runtimeRoot, "studio-build", "renderer");
}

function defaultPdfRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("pdfjs-dist/package.json"));
  } catch {
    return undefined;
  }
}

function pdfAssetAllowed(relativePath: string): boolean {
  return /^(?:build\/pdf(?:\.worker)?\.mjs|standard_fonts\/[A-Za-z0-9._-]+|cmaps\/[A-Za-z0-9._-]+)$/.test(relativePath);
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store"
  };
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord, extra: Record<string, string | string[]> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders(),
    ...extra,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { ok: false, error: { message } });
}

function methodNotAllowed(response: ServerResponse, methods: string[]): void {
  sendJson(response, 405, { ok: false, error: { message: "Method not allowed." } }, { Allow: methods.join(", ") });
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    request.once("aborted", () => reject(new Error("Request aborted.")));
    request.once("error", reject);
    request.once("end", () => {
      if (tooLarge) reject(new BodyTooLargeError("Request body exceeds the 1 MiB limit."));
      else resolveBody(Buffer.concat(chunks));
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function exactKeys(value: JsonRecord, allowed: string[], required: string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => hasOwn(value, key));
}

function sessionCookie(request: IncomingMessage): string | undefined {
  const cookieHeader = header(request, "cookie");
  if (!cookieHeader) return undefined;
  const values = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);
  const matches = values.filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32,}$/.test(value) ? value : undefined;
}

function safeRelativePath(root: string, relativePath: string): string | undefined {
  if (relativePath.includes("\0") || relativePath.includes("\\")) return undefined;
  if (relativePath.split("/").some((segment) => segment === ".." || segment === ".")) return undefined;
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) return undefined;
  return target;
}

async function containedFile(root: string, relativePath: string): Promise<string | undefined> {
  const target = safeRelativePath(root, relativePath);
  if (!target) return undefined;
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) return undefined;
    if (!(await stat(targetReal)).isFile()) return undefined;
    return targetReal;
  } catch {
    return undefined;
  }
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".bcmap": "application/octet-stream"
  };
  return types[extension] || "application/octet-stream";
}

async function sendStatic(
  response: ServerResponse,
  request: IncomingMessage,
  root: string,
  relativePath: string
): Promise<void> {
  const file = await containedFile(root, relativePath);
  if (!file) {
    sendError(response, 404, "Not found.");
    return;
  }
  const fileStats = await stat(file);
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": contentType(file),
    "Content-Length": fileStats.size
  });
  if (request.method === "HEAD") response.end();
  else {
    const body = await readFile(file);
    response.end(body);
  }
}

function parseAddress(request: IncomingMessage, origin: string): URL | undefined {
  try {
    const rawPath = (request.url || "/").split(/[?#]/, 1)[0];
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.split("/").some((segment) => segment === ".." || segment === ".")) return undefined;
    const parsed = new URL(request.url || "/", origin);
    return parsed.origin === origin ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validHost(request: IncomingMessage, expectedHost: string): boolean {
  return header(request, "host") === expectedHost;
}

function validBrowserRequest(request: IncomingMessage, origin: string, expectedHost: string, allowMissingOrigin = false): boolean {
  if (!validHost(request, expectedHost)) return false;
  const requestOrigin = header(request, "origin");
  if (requestOrigin === undefined ? !allowMissingOrigin : requestOrigin !== origin) return false;
  const fetchSite = header(request, "sec-fetch-site");
  return fetchSite === undefined || fetchSite === "same-origin";
}

function validControlRequest(request: IncomingMessage, origin: string, expectedHost: string, secret: string): boolean {
  return validHost(request, expectedHost) && equalSecret(header(request, CONTROL_HEADER), secret) && (header(request, "origin") === undefined || header(request, "origin") === origin);
}

function validJsonContentType(request: IncomingMessage): boolean {
  return (header(request, "content-type") || "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function parseLastEventId(request: IncomingMessage): number {
  const value = header(request, "last-event-id");
  if (!value || !/^\d+$/.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function detachedSpawn(command: string, args: string[]): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

export async function openSystemTarget(target: string): Promise<void> {
  await open(target);
}

function clipboardWrite(text: string, platform: NodeJS.Platform): void {
  const candidates = platform === "darwin"
    ? [["pbcopy", []] as const]
    : platform === "win32"
      ? [["clip.exe", []] as const]
      : [["wl-copy", []] as const, ["xclip", ["-selection", "clipboard"]] as const];
  let lastError = "No clipboard command is available.";
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { input: text, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] });
    if (result.status === 0) return;
    if (result.error) lastError = result.error.message;
    else if (result.stderr) lastError = String(result.stderr).trim() || lastError;
  }
  throw new Error(`Could not write to the system clipboard. ${lastError}`);
}

export function createStudioWebHost(options: {
  userDataPath: string;
  runtimeRoot: string;
  platform?: NodeJS.Platform;
}): StudioHost {
  const platform = options.platform || process.platform;
  const ssoService = new StudioSsoService();
  const sessionResult = (session: SsoSessionData) => ({
    session,
    api: createSessionApiClient(session.baseUrl, session.sesskey, session.cookies)
  });
  return {
    userDataPath: options.userDataPath,
    ssoLogin: async (baseUrl) => sessionResult(await ssoService.login(baseUrl)),
    restoreSsoSession: async (session) => session.cookies.length > 0 ? sessionResult(session) : null,
    clearSsoBrowserData: async (_options) => ssoService.cancel(),
    ensureMcpConfig: async () => {
      if (process.env.UIT_DISABLE_CONFIG === "1") return;
      const mcp = await import("./mcp-server.js");
      mcp.installMcpServer({ command: process.execPath, args: [join(options.runtimeRoot, "dist", "mcp-entry.js")] });
    },
    sendAgentEvent: () => undefined,
    openPath: async (path: string) => {
      try {
        await openSystemTarget(path);
        return "";
      } catch (error) {
        return errorMessage(error);
      }
    },
    openExternal: (url: string) => openSystemTarget(url),
    writeClipboard: (text: string) => clipboardWrite(text, platform),
    openCodexDesktop: async (cwd: string, threadId: string) => {
      await detachedSpawn("codex", ["app", cwd]).catch(() => undefined);
      const openThread = () => { openSystemTarget(`codex://threads/${threadId}`).catch(() => undefined); };
      setTimeout(openThread, 350);
      setTimeout(openThread, 1_000);
    }
  };
}

export async function readControlRecord(path: string): Promise<StudioWebControlRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 2 || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
        typeof parsed.port !== "number" || !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535 ||
        typeof parsed.nonce !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(parsed.nonce) ||
        typeof parsed.controlSecret !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(parsed.controlSecret)) return undefined;
    return parsed as unknown as StudioWebControlRecord;
  } catch {
    return undefined;
  }
}

async function writeControlRecord(path: string, record: StudioWebControlRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeOwnedControlRecord(path: string, record: StudioWebControlRecord): Promise<void> {
  const current = await readControlRecord(path);
  if (current?.pid === record.pid && current.nonce === record.nonce) await unlink(path).catch(() => undefined);
}

function requestPath(request: IncomingMessage, origin: string): string | undefined {
  const parsed = parseAddress(request, origin);
  if (!parsed || parsed.username || parsed.password || parsed.hash) return undefined;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

export async function startStudioWebServer(options: StudioWebServerOptions = {}): Promise<StudioWebServer> {
  const runtimeRoot = resolve(options.runtimeRoot || defaultRuntimeRoot());
  const staticRoot = resolve(options.staticRoot || defaultStaticRoot(runtimeRoot));
  const additionalRoots = [...(options.additionalStaticRoots || [])];
  const pdfRoot = defaultPdfRoot();
  if (pdfRoot && !additionalRoots.some((entry) => entry.prefix === "/node_modules/pdfjs-dist/")) {
    additionalRoots.push({ prefix: "/node_modules/pdfjs-dist/", root: pdfRoot, allow: pdfAssetAllowed });
  }
  const controlFile = resolve(options.controlFile || defaultControlFile());
  const userDataPath = resolve(options.userDataPath || defaultUserDataPath());
  const writeRecord = options.writeControlFile !== false;
  const controlRecord: StudioWebControlRecord = {
    version: 2,
    pid: process.pid,
    port: 0,
    nonce: token(24),
    controlSecret: token(32)
  };
  const events: { id: number; message: JsonRecord }[] = [];
  const sessions = new Map<string, { csrf: string; createdAt: number; lastUsedAt: number }>();
  const bootstraps = new Map<string, number>();
  const bootstrapFailures = new Map<string, { count: number; resetAt: number }>();
  const clients = new Set<ServerResponse>();
  let nextEventId = 1;
  let origin = "";
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let core: StudioCore | undefined;
  let httpServer: Server | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const host = options.host || createStudioWebHost({ userDataPath, runtimeRoot, platform: options.platform });
  const originalSendAgentEvent = host.sendAgentEvent.bind(host);
  const publish = (message: JsonRecord): void => {
    const event = { id: nextEventId++, message };
    events.push(event);
    while (events.length > EVENT_BUFFER_SIZE) events.shift();
    const payload = `id: ${event.id}\ndata: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) {
      if (client.destroyed) {
        clients.delete(client);
        continue;
      }
      client.write(payload);
    }
  };
  host.sendAgentEvent = (message: JsonRecord) => {
    originalSendAgentEvent(message);
    publish(message);
  };

  try {
    core = await (options.createCore || createStudioCore)(host);
    const handlers = core.handlers();
    httpServer = createServer((request, response) => {
      void handleRequest(request, response, handlers).catch((error: unknown) => {
        if (!response.headersSent) sendError(response, 500, "The Studio server could not handle the request.");
        else response.destroy();
        console.error("UIT Studio web request failed:", errorMessage(error));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      httpServer?.once("error", onError);
      httpServer?.listen(options.port || 0, "127.0.0.1", () => {
        httpServer?.off("error", onError);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("The Studio web server did not receive a local port.");
    controlRecord.port = address.port;
    origin = `http://127.0.0.1:${address.port}`;
    heartbeat = setInterval(() => {
      const now = Date.now();
      for (const [value, session] of sessions) if (now - session.lastUsedAt > SESSION_TTL_MS) sessions.delete(value);
      for (const [value, expiresAt] of bootstraps) if (expiresAt <= now) bootstraps.delete(value);
      for (const [addressKey, failure] of bootstrapFailures) if (failure.resetAt <= now) bootstrapFailures.delete(addressKey);
      for (const client of clients) {
        if (client.destroyed) clients.delete(client);
        else client.write(": heartbeat\n\n");
      }
    }, 15_000);
    heartbeat.unref();
    if (writeRecord) await writeControlRecord(controlFile, controlRecord);
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    if (httpServer) await new Promise<void>((resolveClose) => httpServer?.close(() => resolveClose()));
    await core?.shutdown().catch(() => undefined);
    throw error;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse, handlers: Record<string, StudioHandler>): Promise<void> {
    const path = requestPath(request, origin);
    if (!path) {
      sendError(response, 400, "Invalid request URL.");
      return;
    }
    const expectedHost = `127.0.0.1:${controlRecord.port}`;
    if (!validHost(request, expectedHost)) {
      sendError(response, 400, "Invalid Host header.");
      return;
    }
    if (path === "/favicon.ico" && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }

    if (path === "/api/health") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      if (!validControlRequest(request, origin, expectedHost, controlRecord.controlSecret)) {
        sendError(response, 401, "Control authentication required.");
        return;
      }
      sendJson(response, 200, { ok: true, pid: process.pid, port: controlRecord.port });
      return;
    }
    if (path === "/api/control/launch" || path === "/api/control/stop") {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      if (!validControlRequest(request, origin, expectedHost, controlRecord.controlSecret)) {
        sendError(response, 401, "Control authentication required.");
        return;
      }
      if (path.endsWith("/launch")) {
        const launchToken = token(32);
        bootstraps.set(launchToken, Date.now() + BOOTSTRAP_TTL_MS);
        sendJson(response, 200, { ok: true, launchUrl: `${origin}/#bootstrap=${encodeURIComponent(launchToken)}` });
      } else {
        sendJson(response, 200, { ok: true });
        setImmediate(() => { void close(); });
      }
      return;
    }

    if (path === "/api/session/bootstrap") {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      if (!validBrowserRequest(request, origin, expectedHost)) {
        sendError(response, 403, "The browser request origin is not trusted.");
        return;
      }
      if (!validJsonContentType(request)) {
        sendError(response, 415, "JSON content is required.");
        return;
      }
      const remoteAddress = request.socket.remoteAddress || "unknown";
      const failure = bootstrapFailures.get(remoteAddress);
      const now = Date.now();
      if (failure && failure.resetAt > now && failure.count >= MAX_BOOTSTRAP_FAILURES) {
        sendError(response, 429, "Too many launch attempts. Try again in a minute.");
        return;
      }
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        sendError(response, error instanceof BodyTooLargeError ? 413 : 400, errorMessage(error));
        return;
      }
      const secret = isRecord(body) && exactKeys(body, ["secret"], ["secret"]) && typeof body.secret === "string" ? body.secret : undefined;
      const matchingToken = secret && [...bootstraps.keys()].find((candidate) => equalSecret(secret, candidate));
      if (!matchingToken || (bootstraps.get(matchingToken) || 0) <= now) {
        const next = failure && failure.resetAt > now ? { count: failure.count + 1, resetAt: failure.resetAt } : { count: 1, resetAt: now + BOOTSTRAP_FAILURE_WINDOW_MS };
        bootstrapFailures.set(remoteAddress, next);
        sendError(response, next.count > MAX_BOOTSTRAP_FAILURES ? 429 : 401, "The Studio launch token is invalid or expired.");
        return;
      }
      bootstraps.delete(matchingToken);
      const session = token(32);
      const csrf = token(32);
      sessions.set(session, { csrf, createdAt: now, lastUsedAt: now });
      sendJson(response, 200, { ok: true, csrfToken: csrf }, { "Set-Cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` });
      return;
    }

    if (path === "/api/session/csrf") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      if (!validBrowserRequest(request, origin, expectedHost, true)) {
        sendError(response, 403, "The browser request origin is not trusted.");
        return;
      }
      const sessionValue = sessionCookie(request);
      const session = sessionValue ? sessions.get(sessionValue) : undefined;
      if (!session) {
        sendError(response, 401, "Studio session authentication required.");
        return;
      }
      session.lastUsedAt = Date.now();
      sendJson(response, 200, { ok: true, csrfToken: session.csrf });
      return;
    }

    if (path === "/api/events") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      if (!validBrowserRequest(request, origin, expectedHost, true)) {
        sendError(response, 403, "The browser request origin is not trusted.");
        return;
      }
      const sessionValue = sessionCookie(request);
      const session = sessionValue ? sessions.get(sessionValue) : undefined;
      if (!session) {
        sendError(response, 401, "Studio session authentication required.");
        return;
      }
      session.lastUsedAt = Date.now();
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write(": connected\n\n");
      const lastEventId = parseLastEventId(request);
      for (const event of events) if (event.id > lastEventId) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event.message)}\n\n`);
      clients.add(response);
      const removeClient = () => clients.delete(response);
      response.once("close", removeClient);
      response.once("error", removeClient);
      return;
    }

    if (path === "/api/rpc") {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      if (!validBrowserRequest(request, origin, expectedHost)) {
        sendError(response, 403, "The browser request origin is not trusted.");
        return;
      }
      const sessionValue = sessionCookie(request);
      const session = sessionValue ? sessions.get(sessionValue) : undefined;
      if (!session) {
        sendError(response, 401, "Studio session authentication required.");
        return;
      }
      if (!equalSecret(header(request, "x-csrf-token"), session.csrf)) {
        sendError(response, 403, "A valid CSRF token is required.");
        return;
      }
      if (!validJsonContentType(request)) {
        sendError(response, 415, "JSON content is required.");
        return;
      }
      session.lastUsedAt = Date.now();
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        sendError(response, error instanceof BodyTooLargeError ? 413 : 400, errorMessage(error));
        return;
      }
      if (!isRecord(body) || !exactKeys(body, ["method", "input"], ["method"]) || typeof body.method !== "string" || body.method.length === 0 || body.method.length > 100) {
        sendError(response, 400, "RPC body must contain only a non-empty method and optional input.");
        return;
      }
      if (!hasOwn(handlers, body.method)) {
        sendJson(response, 200, { ok: false, error: { message: "Unknown Studio method." } });
        return;
      }
      try {
        const result = await handlers[body.method](hasOwn(body, "input") ? body.input : undefined);
        sendJson(response, 200, { ok: true, result: result === undefined ? null : result });
      } catch (error) {
        sendJson(response, 200, { ok: false, error: { message: errorMessage(error) } });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response, ["GET", "HEAD"]);
      return;
    }
    let relativePath = path === "/" ? "index.html" : path.slice(1);
    const additional = additionalRoots
      .filter((entry) => path.startsWith(entry.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0];
    if (additional) {
      relativePath = path.slice(additional.prefix.length);
      if (!relativePath || (additional.allow && !additional.allow(relativePath))) {
        sendError(response, 404, "Not found.");
        return;
      }
      await sendStatic(response, request, additional.root, relativePath);
      return;
    }
    await sendStatic(response, request, staticRoot, relativePath);
  }

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      bootstraps.clear();
      sessions.clear();
      for (const client of clients) {
        clients.delete(client);
        // SSE responses are intentionally long-lived. Destroy them during
        // shutdown so server.close() cannot wait for a browser reconnect or
        // an otherwise-open event stream to finish naturally.
        client.destroy();
      }
      // Fetch keep-alive sockets are not represented by the SSE response set.
      // Close those too so the server shutdown promise cannot remain pending
      // after the browser has gone away.
      httpServer?.closeAllConnections();
      await core?.shutdown().catch(() => undefined);
      await new Promise<void>((resolveClose) => {
        if (!httpServer) {
          resolveClose();
          return;
        }
        httpServer.close(() => resolveClose());
      });
      if (writeRecord) await removeOwnedControlRecord(controlFile, controlRecord);
    })();
    return closePromise;
  };

  return {
    get origin() { return origin; },
    get port() { return controlRecord.port; },
    get controlSecret() { return controlRecord.controlSecret; },
    get controlFile() { return controlFile; },
    launchUrl: () => {
      const launchToken = token(32);
      bootstraps.set(launchToken, Date.now() + BOOTSTRAP_TTL_MS);
      return `${origin}/#bootstrap=${encodeURIComponent(launchToken)}`;
    },
    publish,
    stop: close,
    close
  };
}

export async function runStudioWebServer(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.includes("--serve")) throw new Error("The Studio web server requires --serve.");
  const valueFor = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  };
  const portValue = valueFor("--port");
  const port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65_535)) throw new Error("--port must be an integer between 0 and 65535.");
  const running = await startStudioWebServer({
    controlFile: valueFor("--control-file"),
    staticRoot: valueFor("--static-root"),
    userDataPath: valueFor("--user-data"),
    port
  });
  console.error(`UIT Studio web server listening at ${running.origin}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

const isDirectInvocation = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (isDirectInvocation) {
  runStudioWebServer().catch((error: unknown) => {
    console.error(`Could not start UIT Studio web server: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
