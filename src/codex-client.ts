import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export type CodexRequestId = string | number;

export interface CodexMessage {
  id?: CodexRequestId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexServerRequest {
  id: CodexRequestId;
  method: string;
  params: Record<string, unknown>;
}

export type CodexJsonValue = null | boolean | number | string | CodexJsonValue[] | { [key: string]: CodexJsonValue };

// Matches the experimental dynamic tool schema in codex-cli 0.149.1.
export interface CodexDynamicToolFunction {
  type: "function";
  name: string;
  description: string;
  inputSchema: CodexJsonValue;
  deferLoading?: boolean;
}

export type CodexDynamicToolSpec = CodexDynamicToolFunction | {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexDynamicToolFunction[];
};

export interface CodexThreadStartOptions {
  dynamicTools?: CodexDynamicToolSpec[];
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export class CodexClient extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private connected = false;
  private connecting: Promise<Record<string, unknown>> | undefined;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private serverRequests = new Set<CodexRequestId>();

  constructor(options: CodexClientOptions = {}) {
    super();
    this.command = options.command || "codex";
    this.args = options.args || ["app-server", "--listen", "stdio://"];
    this.requestTimeoutMs = options.requestTimeoutMs || 20_000;
    this.spawnProcess = options.spawnProcess || spawn;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<Record<string, unknown>> {
    if (this.connecting) return this.connecting;
    if (this.connected && this.process) return Promise.resolve({});
    let process: ChildProcessWithoutNullStreams | undefined;
    // Defer spawning until the shared promise is installed, including synchronous spawn failures.
    const connection = Promise.resolve().then(async () => {
      if (this.connecting !== connection) throw new Error("Codex client disconnected");
      process = this.spawnProcess(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
      this.process = process;
      const child = process;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (this.process === child) this.handleLine(line);
      });
      child.once("close", () => lines.close());
      child.stderr.on("data", (chunk) => {
        if (this.process === child) this.emit("stderr", String(chunk));
      });
      child.on("error", (error) => this.handleProcessError(child, error));
      child.stdin.on("error", (error) => this.handleProcessError(child, error));
      child.stdout.on("error", (error) => this.handleProcessError(child, error));
      child.stderr.on("error", (error) => this.handleProcessError(child, error));
      lines.on("error", (error) => this.handleProcessError(child, error));
      lines.once("close", () => this.handleProcessError(child, new Error("Codex app-server output closed")));
      child.once("exit", (code, signal) => {
        if (this.process !== child) return;
        this.closeProcess(child, new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
        this.emit("exit", { code, signal });
      });

      const result = await this.request("initialize", {
        clientInfo: { name: "uit_studio", title: "UIT Studio", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      });
      if (this.process !== child) throw new Error("Codex client disconnected");
      this.notify("initialized", {});
      if (this.process !== child) throw new Error("Codex client disconnected");
      this.connected = true;
      return result;
    }).catch((error: Error) => {
      if (process) this.closeProcess(process, error);
      throw error;
    }).finally(() => {
      if (this.connecting === connection) this.connecting = undefined;
    });
    this.connecting = connection;
    return connection;
  }

  async startThread(cwd: string, options: CodexThreadStartOptions = {}): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/start", {
      cwd,
      serviceName: "uit_studio",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      ...(options.dynamicTools !== undefined ? { dynamicTools: options.dynamicTools } : {})
    });
    return result.thread as CodexThread;
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/resume", { threadId });
    return result.thread as CodexThread;
  }

  async startTurn(threadId: string, text: string, cwd?: string): Promise<CodexTurn> {
    await this.connect();
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(cwd ? { cwd } : {})
    });
    return result.turn as CodexTurn;
  }

  async forkThread(threadId: string, lastTurnId?: string): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/fork", { threadId, ...(lastTurnId ? { lastTurnId } : {}) });
    return result.thread as CodexThread;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  /** Answer a pending server request on this connection; never approves automatically. */
  respond(id: CodexRequestId, result: unknown): void {
    if (!this.serverRequests.has(id)) throw new Error(`Unknown Codex server request: ${id}`);
    if (result === undefined) throw new Error("Codex server response requires a result");
    this.write({ id, result });
    this.serverRequests.delete(id);
  }

  async disconnect(): Promise<void> {
    this.connecting = undefined;
    if (this.process) this.closeProcess(this.process, new Error("Codex client disconnected"));
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (method !== "initialize" && !this.connected) return Promise.reject(new Error("Codex app-server is not initialized"));
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(message: { id?: CodexRequestId; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
    const process = this.process;
    if (!process?.stdin.writable || process.stdin.destroyed) throw new Error("Codex app-server is not running");
    process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.handleProcessError(process, error);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: CodexMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid message");
      message = parsed as CodexMessage;
    } catch {
      this.emit("protocolError", new Error("Codex app-server emitted invalid JSON-RPC message"));
      return;
    }
    // Server request IDs are independent of our outgoing request IDs and may collide.
    if (typeof message.method === "string") {
      if (typeof message.id === "number" || typeof message.id === "string") {
        const request: CodexServerRequest = { id: message.id, method: message.method, params: message.params ?? {} };
        this.serverRequests.add(request.id);
        this.emit("request", request);
        if (request.method.endsWith("/requestApproval") || request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
          this.emit("approval", request);
        }
      } else if (message.id === undefined) {
        this.emit("notification", message);
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (!("result" in message) && !message.error) {
        this.emit("protocolError", new Error("Codex response is missing result or error"));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "Codex request failed"), {
        code: message.error.code,
        data: message.error.data
      }));
      else pending.resolve(message.result);
      return;
    }
  }

  private handleProcessError(process: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== process) return;
    this.closeProcess(process, error);
    // EventEmitter's unobserved 'error' event throws; promise callers still receive the failure.
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  private closeProcess(process: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== process) return;
    this.process = undefined;
    this.connected = false;
    this.connecting = undefined;
    this.rejectPending(error);
    this.serverRequests.clear();
    process.kill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
