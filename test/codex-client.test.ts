import { execPath } from "node:process";
import { EventEmitter } from "node:events";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexClient, type CodexDynamicToolSpec, type CodexMessage } from "../src/codex-client.js";

const clients: CodexClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect()));
  vi.useRealTimers();
});

function mockServer(onMessage?: (message: CodexMessage) => void) {
  const messages: CodexMessage[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as CodexMessage;
      messages.push(message);
      onMessage?.(message);
      callback();
    }
  });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn(() => true) }) as unknown as ChildProcessWithoutNullStreams;
  const spawnProcess = vi.fn(() => child);
  const client = new CodexClient({ spawnProcess: spawnProcess as unknown as typeof spawn, requestTimeoutMs: 100 });
  clients.push(client);
  return {
    client, child, messages, spawnProcess,
    send(message: unknown) { stdout.write(`${JSON.stringify(message)}\n`); }
  };
}

const fakeServer = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake-codex" } }) + "\\n");
    if (message.method === "thread/start") process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thr_fake", sessionId: "thr_fake" } } }) + "\\n");
    if (message.method === "thread/fork") process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thr_branch" } } }) + "\\n");
    if (message.method === "turn/start") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn_fake", status: "inProgress" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Hello from fake Codex" } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_fake", status: "completed" } } }) + "\\n");
    }
  }
});
`;

describe("CodexClient", () => {
  it("initializes, starts a thread, and streams notifications", async () => {
    const client = new CodexClient({ command: execPath, args: ["-e", fakeServer], requestTimeoutMs: 2_000 });
    clients.push(client);
    const notifications: string[] = [];
    client.on("notification", (message) => notifications.push(String(message.method)));

    const init = await client.connect();
    const thread = await client.startThread("/tmp/uit-studio-test");
    const turn = await client.startTurn(thread.thread.id, "Say hello");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(init.userAgent).toBe("fake-codex");
    expect(thread.thread.id).toBe("thr_fake");
    expect(turn.id).toBe("turn_fake");
    expect(notifications).toEqual(["item/agentMessage/delta", "turn/completed"]);
    await client.disconnect();
  });

  it("surfaces JSON-RPC errors", async () => {
    const failingServer = `process.stdin.on("data", (chunk) => { const message = JSON.parse(String(chunk)); process.stdout.write(JSON.stringify({ id: message.id, error: { message: "denied" } }) + "\\n"); });`;
    const client = new CodexClient({ command: execPath, args: ["-e", failingServer], requestTimeoutMs: 2_000 });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow("denied");
    await client.disconnect();
  });

  it("shares one initialization across simultaneous connect, thread, and send calls", async () => {
    const server = mockServer((message) => {
      if (message.method === "thread/start") server.send({ id: message.id, result: { thread: { id: "thread" } } });
      if (message.method === "turn/start") server.send({ id: message.id, result: { turn: { id: "turn" } } });
    });
    const first = server.client.connect();
    const second = server.client.connect();
    const thread = server.client.startThread("/workspace");
    const turn = server.client.startTurn("existing", "hello", "/workspace");
    expect(second).toBe(first);
    await Promise.resolve();
    expect(server.spawnProcess).toHaveBeenCalledTimes(1);
    expect(server.messages).toEqual([{
      id: 1, method: "initialize", params: {
        clientInfo: { name: "uit_studio", title: "UIT Studio", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }
    }]);
    expect(server.client.isConnected).toBe(false);
    server.send({ id: 1, result: { userAgent: "mock" } });
    expect(await Promise.all([first, second])).toEqual([{ userAgent: "mock" }, { userAgent: "mock" }]);
    expect(await thread).toEqual({ thread: { id: "thread" } });
    expect(await turn).toEqual({ id: "turn" });
    expect(server.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(server.client.isConnected).toBe(true);
    await server.client.connect();
    expect(server.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("handles replies received synchronously while writing and preserves start/resume/fork/stop parameters", async () => {
    const server = mockServer((message) => {
      if (message.id !== undefined) server.send({ id: message.id, result: { thread: { id: "thread" }, turn: { id: "turn" } } });
    });
    await server.client.startThread("/workspace");
    await server.client.resumeThread("thread");
    await server.client.forkThread("thread", "last");
    await server.client.forkThread("thread");
    await server.client.startTurn("thread", "hello");
    await server.client.deleteThread("thread");
    await server.client.setThreadName("thread", "renamed");
    await server.client.interruptTurn("thread", "turn");
    expect(server.messages.slice(2).map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "thread/start", params: { cwd: "/workspace", serviceName: "uit_studio", sandbox: "workspace-write", approvalPolicy: "on-request" } },
      { method: "thread/resume", params: { threadId: "thread" } },
      { method: "thread/fork", params: { threadId: "thread", lastTurnId: "last" } },
      { method: "thread/fork", params: { threadId: "thread" } },
      { method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "hello" }] } },
      { method: "thread/delete", params: { threadId: "thread" } },
      { method: "thread/name/set", params: { threadId: "thread", name: "renamed" } },
      { method: "turn/interrupt", params: { threadId: "thread", turnId: "turn" } }
    ]);
  });

  it("registers verified function and namespace tool specs, including an explicit empty list", async () => {
    const server = mockServer((message) => {
      if (message.id !== undefined) server.send({ id: message.id, result: { thread: { id: "thread" } } });
    });
    const dynamicTools: CodexDynamicToolSpec[] = [
      { type: "function", name: "courses", description: "List courses", inputSchema: { type: "object", properties: {} }, deferLoading: false },
      { type: "namespace", name: "uit", description: "UIT tools", tools: [
        { type: "function", name: "course", description: "Read course", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }
      ] }
    ];
    await server.client.startThread("/workspace", { dynamicTools });
    await server.client.startThread("/workspace", { dynamicTools: [] });
    expect(server.messages[2]?.params).toMatchObject({ dynamicTools, sandbox: "workspace-write", approvalPolicy: "on-request" });
    expect(server.messages[3]?.params?.dynamicTools).toEqual([]);
  });

  it("passes model and effort through thread and turn start, and lists models", async () => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
      if (message.method === "thread/start") server.send({ id: message.id, result: { thread: { id: "thread" }, model: "gpt-5.6-sol" } });
      if (message.method === "turn/start") server.send({ id: message.id, result: { turn: { id: "turn" } } });
      if (message.method === "model/list") server.send({ id: message.id, result: { data: [
        { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Workhorse", supportedReasoningEfforts: ["low", { reasoningEffort: "high" }], defaultServiceTier: "default", serviceTiers: [{ id: "default", name: "Standard", description: "Standard speed" }, { id: "fast", name: "Fast", description: "Faster responses" }] },
        { id: "hidden-model", displayName: "Hidden", hidden: true },
        { id: 42 },
      ] } });
    });
    await expect(server.client.startThread("/workspace", { model: "gpt-5.6-sol" })).resolves.toEqual({ thread: { id: "thread" }, model: "gpt-5.6-sol" });
    await server.client.startTurn("thread", "hello", "/workspace", { model: "gpt-5.6-sol", effort: "high", serviceTierForTurn: "fast" });
    await expect(server.client.listModels()).resolves.toEqual([{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Workhorse", efforts: ["low", "high"], defaultServiceTier: "default", serviceTiers: [{ id: "default", name: "Standard", description: "Standard speed" }, { id: "fast", name: "Fast", description: "Faster responses" }] }]);
    const started = server.messages.find((message) => message.method === "thread/start");
    expect(started?.params).toMatchObject({ model: "gpt-5.6-sol" });
    const turn = server.messages.find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({ model: "gpt-5.6-sol", effort: "high", serviceTierForTurn: "fast" });
  });

  it.each([0, 1, "1", "approval-id"])("routes server request ID %s independently from pending responses", async (id) => {
    const server = mockServer();
    const requests = vi.fn();
    const notifications = vi.fn();
    server.client.on("request", requests);
    server.client.on("notification", notifications);
    const connection = server.client.connect();
    await Promise.resolve();
    const request = { id, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: "call", namespace: null, tool: "courses", arguments: {} } };
    server.send(request);
    expect(requests).toHaveBeenCalledExactlyOnceWith(request);
    expect(notifications).not.toHaveBeenCalled();
    expect(server.client.isConnected).toBe(false);
    const result = { success: true, contentItems: [{ type: "inputText", text: "[]" }] };
    server.client.respond(id, result);
    expect(server.messages[1]).toEqual({ id, result });
    expect(() => server.client.respond(id, result)).toThrow("Unknown Codex server request");
    server.send({ id: 1, result: { userAgent: "mock" } });
    await expect(connection).resolves.toEqual({ userAgent: "mock" });
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"])("emits explicit approvals for %s without automatically answering", async (method) => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
    });
    await server.client.connect();
    const approval = vi.fn();
    const request = vi.fn();
    server.client.on("approval", approval);
    server.client.on("request", request);
    const message = { id: "approval", method, params: { threadId: "thread", turnId: "turn" } };
    server.send(message);
    expect(approval).toHaveBeenCalledExactlyOnceWith(message);
    expect(request).toHaveBeenCalledExactlyOnceWith(message);
    expect(server.messages).toHaveLength(2);
    expect(() => server.client.respond("approval", undefined)).toThrow("requires a result");
    const result = method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
      : method === "execCommandApproval" || method === "applyPatchApproval" ? { decision: "abort" }
      : { decision: "decline" };
    server.client.respond("approval", result);
    expect(server.messages[2]).toEqual({ id: "approval", result });
  });

  it("allows an immediate response inside the request handler", async () => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
    });
    await server.client.connect();
    server.client.on("request", ({ id }) => server.client.respond(id, { success: false, contentItems: [] }));
    server.send({ id: 7, method: "item/tool/call", params: {} });
    expect(server.messages[2]).toEqual({ id: 7, result: { success: false, contentItems: [] } });
  });

  it("preserves JSON-RPC error code/data and does not reject unrelated requests", async () => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
    });
    await server.client.connect();
    const failed = server.client.startThread("/workspace");
    const succeeds = server.client.resumeThread("thread");
    const failure = expect(failed).rejects.toMatchObject({ message: "denied", code: -32000, data: { reason: "policy" } });
    await Promise.resolve();
    server.send({ id: 2, error: { message: "denied", code: -32000, data: { reason: "policy" } } });
    server.send({ id: 3, result: { thread: { id: "thread" } } });
    await failure;
    await expect(succeeds).resolves.toEqual({ id: "thread" });
    expect(server.client.isConnected).toBe(true);
  });

  it("rejects all simultaneous callers when initialization times out, and permits retry", async () => {
    vi.useFakeTimers();
    const server = mockServer();
    const first = expect(server.client.connect()).rejects.toThrow("timed out: initialize");
    const second = expect(server.client.startThread("/workspace")).rejects.toThrow("timed out: initialize");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    expect(server.child.kill).toHaveBeenCalledTimes(1);
    expect(server.client.isConnected).toBe(false);
    const replacement = mockServer((message) => {
      if (message.method === "initialize") replacement.send({ id: message.id, result: {} });
    });
    server.spawnProcess.mockReturnValue(replacement.child);
    await server.client.connect();
    expect(server.client.isConnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out one request without breaking subsequent requests", async () => {
    vi.useFakeTimers();
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
      if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
    });
    await server.client.connect();
    const failure = expect(server.client.startThread("/workspace")).rejects.toThrow("timed out: thread/start");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    server.send({ id: 2, result: { thread: { id: "late" } } });
    await server.client.interruptTurn("thread", "turn");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects asynchronous spawn failures safely without an error listener", async () => {
    const client = new CodexClient({ command: "/nonexistent/uit-codex-test", requestTimeoutMs: 2_000 });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow("ENOENT");
    expect(client.isConnected).toBe(false);
  });

  it("shares synchronous spawn failures and permits retry", async () => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
    });
    server.spawnProcess.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    const first = server.client.connect();
    expect(server.client.connect()).toBe(first);
    await expect(first).rejects.toThrow("spawn failed");
    await server.client.connect();
    expect(server.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it.each(["exit", "error", "stdin", "stdout", "disconnect"])("rejects all pending work on %s and ignores stale process events after reconnect", async (cause) => {
    const server = mockServer((message) => {
      if (message.method === "initialize") server.send({ id: message.id, result: {} });
    });
    await server.client.connect();
    const first = expect(server.client.startThread("/workspace")).rejects.toThrow();
    const second = expect(server.client.startTurn("thread", "hello")).rejects.toThrow();
    await Promise.resolve();
    server.send({ id: "stale", method: "item/tool/call", params: {} });
    if (cause === "exit") server.child.emit("exit", 0, null);
    if (cause === "error") server.child.emit("error", new Error("child failed"));
    if (cause === "stdin") server.child.stdin.emit("error", new Error("broken pipe"));
    if (cause === "stdout") server.child.stdout.emit("end");
    if (cause === "disconnect") await server.client.disconnect();
    await Promise.all([first, second]);
    expect(server.client.isConnected).toBe(false);
    expect(() => server.client.respond("stale", {})).toThrow("Unknown Codex server request");
    const replacement = mockServer((message) => {
      if (message.method === "initialize") replacement.send({ id: message.id, result: {} });
    });
    server.spawnProcess.mockReturnValue(replacement.child);
    await server.client.connect();
    const pending = server.client.startThread("/workspace");
    await Promise.resolve();
    server.child.emit("exit", 1, null);
    server.child.emit("error", new Error("stale error"));
    server.send({ id: 5, result: { thread: { id: "wrong" } } });
    replacement.send({ id: 5, result: { thread: { id: "new" } } });
    await expect(pending).resolves.toEqual({ thread: { id: "new" } });
    expect(server.client.isConnected).toBe(true);
  });

  it("cancels connect before spawning and while initialization is pending", async () => {
    const server = mockServer();
    const beforeSpawn = expect(server.client.connect()).rejects.toThrow("disconnected");
    await server.client.disconnect();
    await beforeSpawn;
    expect(server.spawnProcess).not.toHaveBeenCalled();
    const initializing = expect(server.client.connect()).rejects.toThrow("disconnected");
    await Promise.resolve();
    await server.client.disconnect();
    server.send({ id: 1, result: {} });
    await initializing;
    expect(server.client.isConnected).toBe(false);
  });

  it("rejects write failures immediately and clears pending timers", async () => {
    vi.useFakeTimers();
    const server = mockServer();
    vi.spyOn(server.child.stdin, "write").mockImplementation(() => { throw new Error("write failed"); });
    await expect(server.client.connect()).rejects.toThrow("write failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects write callback errors safely", async () => {
    const server = mockServer();
    vi.spyOn(server.child.stdin, "write").mockImplementation((_chunk, callback: any) => {
      callback(new Error("write callback failed"));
      return false;
    });
    await expect(server.client.connect()).rejects.toThrow("write callback failed");
    expect(server.client.isConnected).toBe(false);
  });

  it("cleans up pending work before emitting observed process errors", async () => {
    vi.useFakeTimers();
    const server = mockServer();
    const error = new Error("process failed");
    const listener = vi.fn(() => {
      expect(server.client.isConnected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
    server.client.on("error", listener);
    const failure = expect(server.client.connect()).rejects.toBe(error);
    await Promise.resolve();
    server.child.emit("error", error);
    await failure;
    expect(listener).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("reports malformed messages without consuming pending requests or breaking notifications", async () => {
    const server = mockServer();
    const protocolError = vi.fn();
    const notification = vi.fn();
    server.client.on("protocolError", protocolError);
    server.client.on("notification", notification);
    const connection = server.client.connect();
    await Promise.resolve();
    server.child.stdout.emit("data", "bad json\nnull\n[]\n");
    server.send({ id: 1 });
    server.send({ id: 999, result: {} });
    server.send({ id: "1", result: { userAgent: "wrong id type" } });
    server.send({ method: "turn/completed", params: {} });
    server.send({ id: 1, result: { userAgent: "valid" } });
    await expect(connection).resolves.toEqual({ userAgent: "valid" });
    expect(protocolError).toHaveBeenCalledTimes(4);
    expect(notification).toHaveBeenCalledExactlyOnceWith({ method: "turn/completed", params: {} });
  });
});
