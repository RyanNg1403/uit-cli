import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  /** Working directory for the app-server process (and its MCP children). */
  cwd?: string;
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
  model?: string;
  approvalPolicy?: "on-request" | "never";
}

export interface CodexTurnStartOptions {
  model?: string;
  effort?: string;
  approvalPolicy?: "on-request" | "never";
  /** Service tier for this turn; use `default` for standard speed or `fast` when available. */
  serviceTierForTurn?: "default" | "fast" | string;
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModelOption {
  id: string;
  displayName: string;
  description?: string;
  efforts: string[];
  serviceTiers?: CodexServiceTier[];
  defaultServiceTier?: string;
}

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export interface CodexThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  status?: CodexThreadStatus;
  [key: string]: unknown;
}

export interface CodexAccountReadResult {
  account: { type: string } | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexThreadResumeOptions {
  excludeTurns?: boolean;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly data: unknown,
    message: string
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export function isCodexThreadNotFoundError(error: unknown, method: string, threadId: string): boolean {
  return error instanceof CodexRpcError
    && error.method === method
    && error.code === -32600
    && error.message === `thread not loaded: ${threadId}`;
}

export interface CodexTurn {
  id: string;
  status?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isCodexThreadStatus(value: unknown): value is CodexThreadStatus {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (["notLoaded", "idle", "systemError"].includes(value.type)) return true;
  return value.type === "active" && Array.isArray(value.activeFlags) && value.activeFlags.every((flag) => typeof flag === "string");
}

function parseThreadStatus(value: unknown, context: string): CodexThreadStatus {
  if (!isCodexThreadStatus(value)) {
    throw new Error(`${context} must contain a valid Codex thread status.`);
  }
  return value.type === "active"
    ? { type: "active", activeFlags: [...value.activeFlags] }
    : { type: value.type };
}

function parseAccountReadResult(value: unknown): CodexAccountReadResult {
  if (!isRecord(value)) throw new Error("Malformed account/read response: result must be an object.");
  if (typeof value.requiresOpenaiAuth !== "boolean") {
    throw new Error("Malformed account/read response: result.requiresOpenaiAuth must be a boolean.");
  }
  if (value.account !== null && (!isRecord(value.account) || typeof value.account.type !== "string" || value.account.type.trim() === "")) {
    throw new Error("Malformed account/read response: result.account must be null or contain a non-empty type.");
  }
  const account = value.account;
  return {
    account: account === null ? null : { type: account.type as string },
    requiresOpenaiAuth: value.requiresOpenaiAuth
  };
}

function parseThreadResumeResult(value: unknown): CodexThread {
  if (!isRecord(value)) throw new Error("Malformed thread/resume response: result must be an object.");
  if (!isRecord(value.thread) || typeof value.thread.id !== "string" || value.thread.id.trim() === "") {
    throw new Error("Malformed thread/resume response: result.thread.id must be a non-empty string.");
  }
  const status = parseThreadStatus(value.thread.status, "Malformed thread/resume response: result.thread.status");
  return { ...value.thread, id: value.thread.id, status };
}

function parseThreadReadResult(value: unknown): CodexThread {
  if (!isRecord(value)) throw new Error("Malformed thread/read response: result must be an object.");
  if (!isRecord(value.thread) || typeof value.thread.id !== "string" || value.thread.id.trim() === "") {
    throw new Error("Malformed thread/read response: result.thread.id must be a non-empty string.");
  }
  return { ...value.thread, id: value.thread.id };
}

function parseThreadStatusChangedParams(value: unknown): { threadId: string; status: CodexThreadStatus } {
  if (!isRecord(value) || typeof value.threadId !== "string" || value.threadId.trim() === "") {
    throw new Error("Malformed thread/status/changed notification: params.threadId must be a non-empty string.");
  }
  return {
    threadId: value.threadId,
    status: parseThreadStatus(value.status, "Malformed thread/status/changed notification: params.status")
  };
}

export class CodexClient extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private connected = false;
  private connecting: Promise<Record<string, unknown>> | undefined;
  private disconnecting: Promise<void> | undefined;
  private pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private serverRequests = new Set<CodexRequestId>();

  constructor(options: CodexClientOptions = {}) {
    super();
    this.command = options.command || "codex";
    this.args = options.args || ["app-server", "--listen", "stdio://"];
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs || 20_000;
    this.spawnProcess = options.spawnProcess || spawn;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<Record<string, unknown>> {
    if (this.disconnecting) return this.disconnecting.then(() => this.connect());
    if (this.connecting) return this.connecting;
    if (this.connected && this.process) return Promise.resolve({});
    let process: ChildProcessWithoutNullStreams | undefined;
    // Defer spawning until the shared promise is installed, including synchronous spawn failures.
    const connection = Promise.resolve().then(async () => {
      if (this.connecting !== connection) throw new Error("Codex client disconnected");
      process = this.spawnProcess(this.command, this.args, {
        ...(this.cwd ? { cwd: this.cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"]
      });
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

  async startThread(cwd: string, options: CodexThreadStartOptions = {}): Promise<{ thread: CodexThread; model?: string }> {
    await this.connect();
    const result = await this.request("thread/start", {
      cwd,
      serviceName: "uit_studio",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.dynamicTools !== undefined ? { dynamicTools: options.dynamicTools } : {})
    });
    return { thread: result.thread as CodexThread, model: typeof result.model === "string" ? result.model : undefined };
  }

  async readAccount(): Promise<CodexAccountReadResult> {
    await this.connect();
    const result = await this.request("account/read", { refreshToken: false });
    return parseAccountReadResult(result);
  }

  async listModels(): Promise<CodexModelOption[]> {
    await this.connect();
    const result = await this.request("model/list", {});
    const entries = Array.isArray(result?.data) ? result.data : [];
    return entries
      .filter((entry: any) => entry && typeof entry.id === "string" && !entry.hidden)
      .map((entry: any) => {
        const serviceTiers = Array.isArray(entry.serviceTiers)
          ? entry.serviceTiers
            .filter((tier: any) => tier && typeof tier.id === "string" && typeof tier.name === "string" && typeof tier.description === "string")
            .map((tier: any) => ({ id: tier.id, name: tier.name, description: tier.description }))
          : [];
        return {
          id: entry.id,
          displayName: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id,
          description: typeof entry.description === "string" ? entry.description : undefined,
          efforts: Array.isArray(entry.supportedReasoningEfforts)
            ? entry.supportedReasoningEfforts.map((item: any) => typeof item === "string" ? item : item?.reasoningEffort).filter((effort: unknown): effort is string => typeof effort === "string" && Boolean(effort))
            : [],
          ...(serviceTiers.length ? { serviceTiers } : {}),
          ...(typeof entry.defaultServiceTier === "string" ? { defaultServiceTier: entry.defaultServiceTier } : {})
        };
      });
  }

  async resumeThread(threadId: string, options: CodexThreadResumeOptions = {}): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/resume", {
      threadId,
      ...(options.excludeTurns !== undefined ? { excludeTurns: options.excludeTurns } : {})
    });
    return parseThreadResumeResult(result);
  }

  async readThread(threadId: string): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    return parseThreadReadResult(result);
  }

  async startTurn(threadId: string, text: string, cwd?: string, options: CodexTurnStartOptions = {}): Promise<CodexTurn> {
    await this.connect();
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(cwd ? { cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.serviceTierForTurn !== undefined ? { serviceTierForTurn: options.serviceTierForTurn } : {})
    });
    return result.turn as CodexTurn;
  }

  async forkThread(threadId: string, lastTurnId?: string): Promise<CodexThread> {
    await this.connect();
    const result = await this.request("thread/fork", { threadId, ...(lastTurnId ? { lastTurnId } : {}) });
    return result.thread as CodexThread;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.connect();
    await this.request("thread/delete", { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.connect();
    await this.request("thread/name/set", { threadId, name });
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
    await this.disconnectInternal(false);
  }

  /**
   * Disconnect and wait until the child process has actually exited.
   *
   * This is required before handing a thread to another app-server: the
   * rollout store permits only one active writer for a thread.
   */
  async disconnectAndWait(): Promise<void> {
    await this.disconnectInternal(true);
  }

  private async disconnectInternal(waitForExit: boolean): Promise<void> {
    if (this.disconnecting) {
      if (waitForExit) await this.disconnecting;
      return;
    }
    this.connecting = undefined;
    const process = this.process;
    if (!process) return;
    if (!waitForExit) {
      this.closeProcess(process, new Error("Codex client disconnected"));
      return;
    }
    const exited = this.waitForProcessExit(process);
    const disconnection = exited.finally(() => {
      if (this.disconnecting === disconnection) this.disconnecting = undefined;
    });
    this.disconnecting = disconnection;
    this.closeProcess(process, new Error("Codex client disconnected"));
    await disconnection;
  }

  private waitForProcessExit(process: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolveExit, rejectExit) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        process.removeListener("close", onExit);
        process.removeListener("error", onError);
        rejectExit(new Error("Codex app-server did not exit after disconnect."));
      }, 5_000);
      timer.unref();
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.removeListener("close", onExit);
        process.removeListener("error", onError);
        resolveExit();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.removeListener("close", onExit);
        process.removeListener("error", onError);
        rejectExit(error);
      };
      process.once("close", onExit);
      process.once("error", onError);
    });
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
      this.pending.set(id, { method, resolve, reject, timer });
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
        if (message.method === "thread/status/changed") {
          try {
            const params = parseThreadStatusChangedParams(message.params);
            this.emit("notification", { ...message, params });
          } catch (error) {
            this.emit("protocolError", error);
          }
        } else {
          this.emit("notification", message);
        }
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
      if (message.error) pending.reject(new CodexRpcError(
        pending.method,
        message.error.code,
        message.error.data,
        message.error.message || "Codex request failed"
      ));
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
