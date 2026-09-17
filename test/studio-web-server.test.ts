import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readControlRecord,
  startStudioWebServer,
  type StudioWebServer
} from "../src/studio-web-server.js";

type TestSession = { cookie: string; csrfToken: string };

const servers: StudioWebServer[] = [];
const temporaryDirectories: string[] = [];

async function createServer(): Promise<{ server: StudioWebServer; staticRoot: string; controlFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "uit-studio-web-test-"));
  temporaryDirectories.push(directory);
  const staticRoot = join(directory, "renderer");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>UIT Studio fixture</title>");
  await writeFile(join(staticRoot, "app.js"), "console.log('fixture');");
  const controlFile = join(directory, "studio", "server.json");
  const server = await startStudioWebServer({
    staticRoot,
    controlFile,
    userDataPath: join(directory, "profile"),
    createCore: async () => ({
      handlers: () => ({ "test:echo": (input) => input, "test:error": () => { throw new Error("expected handler failure"); } }),
      shutdown: async () => undefined
    })
  });
  servers.push(server);
  return { server, staticRoot, controlFile };
}

async function request(server: StudioWebServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Host", `127.0.0.1:${server.port}`);
  if (!headers.has("Origin")) headers.set("Origin", server.origin);
  return fetch(`${server.origin}${path}`, { ...init, headers });
}

async function rawRequest(server: StudioWebServer, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: server.port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolveRequest({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function authenticate(server: StudioWebServer): Promise<TestSession> {
  const launch = new URL(server.launchUrl());
  const bootstrap = decodeURIComponent(launch.hash.slice("#bootstrap=".length));
  const response = await request(server, "/api/session/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: bootstrap })
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toMatch(/^uit_studio_session=[A-Za-z0-9_-]{32,}; HttpOnly; SameSite=Strict; Path=\/$/);
  return { cookie: setCookie!.split(";", 1)[0], csrfToken: body.csrfToken };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Studio web server", () => {
  it("serves the renderer with containment and browser security headers", async () => {
    const { server, controlFile } = await createServer();
    const response = await request(server, "/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("UIT Studio fixture");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const traversal = await rawRequest(server, "/%2e%2e/index.html", { Host: `127.0.0.1:${server.port}`, Origin: server.origin });
    expect(traversal.status).toBe(400);
    const record = await readControlRecord(controlFile);
    expect(record?.version).toBe(2);
    expect(record?.port).toBe(server.port);
    // Windows does not expose POSIX file permissions through stat.
    if (process.platform !== "win32") expect((await stat(controlFile)).mode & 0o777).toBe(0o600);
  });

  it("rejects forged Host and browser origins", async () => {
    const { server } = await createServer();
    const forgedHost = await rawRequest(server, "/", { Host: "127.0.0.1:1", Origin: server.origin });
    expect(forgedHost.status).toBe(400);

    const launch = new URL(server.launchUrl());
    const forgedOrigin = await fetch(`${server.origin}/api/session/bootstrap`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${server.port}`, Origin: "http://127.0.0.1:9", "Content-Type": "application/json" },
      body: JSON.stringify({ secret: decodeURIComponent(launch.hash.slice("#bootstrap=".length)) })
    });
    expect(forgedOrigin.status).toBe(403);
  });

  it("exchanges one-time launch tokens for a cookie and CSRF token", async () => {
    const { server } = await createServer();
    const session = await authenticate(server);
    const launch = new URL(server.launchUrl());
    const bootstrap = decodeURIComponent(launch.hash.slice("#bootstrap=".length));
    const firstUse = await request(server, "/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: bootstrap })
    });
    expect(firstUse.status).toBe(200);
    const replay = await request(server, "/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: bootstrap })
    });
    expect(replay.status).toBe(401);

    const csrf = await request(server, "/api/session/csrf", { headers: { Cookie: session.cookie } });
    expect(csrf.status).toBe(200);
    expect((await csrf.json()).csrfToken).toBe(session.csrfToken);

    const reloadCsrf = await fetch(`${server.origin}/api/session/csrf`, {
      headers: { Host: `127.0.0.1:${server.port}`, Cookie: session.cookie }
    });
    expect(reloadCsrf.status).toBe(200);
    expect((await reloadCsrf.json()).csrfToken).toBe(session.csrfToken);
  });

  it("protects RPC with the session, exact origin, and CSRF token", async () => {
    const { server } = await createServer();
    const unauthenticated = await request(server, "/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "missing" },
      body: JSON.stringify({ method: "test:echo", input: "nope" })
    });
    expect(unauthenticated.status).toBe(401);
    const session = await authenticate(server);

    const wrongCsrf = await request(server, "/api/rpc", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": "wrong" },
      body: JSON.stringify({ method: "test:echo", input: "nope" })
    });
    expect(wrongCsrf.status).toBe(403);

    const extraField = await request(server, "/api/rpc", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ method: "test:echo", input: "nope", extra: true })
    });
    expect(extraField.status).toBe(400);

    const valid = await request(server, "/api/rpc", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ method: "test:echo", input: { value: 42 } })
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ ok: true, result: { value: 42 } });

    const handlerError = await request(server, "/api/rpc", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ method: "test:error" })
    });
    expect(await handlerError.json()).toEqual({ ok: false, error: { message: "expected handler failure" } });
  });

  it("replays ordered SSE events after a reconnect cursor", async () => {
    const { server } = await createServer();
    const session = await authenticate(server);
    const stream = await request(server, "/api/events", { headers: { Cookie: session.cookie } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain(": connected");

    server.publish({ method: "agent/event", params: { sequence: 1 } });
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("data: {\"method\":\"agent/event\",\"params\":{\"sequence\":1}}\n");
    const eventId = Number(first.match(/^id: (\d+)$/m)?.[1]);
    expect(Number.isSafeInteger(eventId)).toBe(true);
    await reader.cancel();

    server.publish({ method: "agent/event", params: { sequence: 2 } });
    const replay = await request(server, "/api/events", {
      headers: { Cookie: session.cookie, "Last-Event-ID": String(eventId) }
    });
    const replayReader = replay.body!.getReader();
    let replayFrame = "";
    for (let attempt = 0; attempt < 3 && !replayFrame.includes('"sequence":2'); attempt += 1) {
      replayFrame += new TextDecoder().decode((await replayReader.read()).value);
    }
    expect(replayFrame).toContain('"sequence":2');
    await replayReader.cancel();
  });

  it("accepts same-origin EventSource requests without an Origin header", async () => {
    const { server } = await createServer();
    const session = await authenticate(server);
    const stream = await fetch(`${server.origin}/api/events`, {
      headers: { Host: `127.0.0.1:${server.port}`, Cookie: session.cookie }
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });

  it("keeps mutating requests strict-origin even when read-only browser requests omit Origin", async () => {
    const { server } = await createServer();
    const session = await authenticate(server);
    const response = await fetch(`${server.origin}/api/rpc`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Cookie: session.cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken
      },
      body: JSON.stringify({ method: "test:echo", input: "no-origin" })
    });
    expect(response.status).toBe(403);
  });

  it("closes an open SSE stream without waiting for the browser", async () => {
    const { server } = await createServer();
    const session = await authenticate(server);
    const stream = await request(server, "/api/events", { headers: { Cookie: session.cookie } });
    const reader = stream.body!.getReader();
    await reader.read();
    await expect(server.close()).resolves.toBeUndefined();
    await reader.cancel().catch(() => undefined);
  });
});
