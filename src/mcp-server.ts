import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ApiClient } from "./types.js";
import { createSessionApiClient } from "./api.js";
import { getActiveConfig } from "./config.js";
import { createUitToolExecutor, UIT_ASSIGNMENT_SUBMISSION_TOOL, UIT_TOOLS, type UitToolServices } from "./uit-tools.js";
import * as desktopService from "./desktop-service.js";

function packageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    return String(JSON.parse(readFileSync(packagePath, "utf8")).version || "unknown");
  } catch {
    return "unknown";
  }
}

export type McpLaunch = { command: string; args: string[]; env?: Record<string, string> };

export function resolveMcpLaunch(options: { nodePath?: string; cliPath?: string } = {}): McpLaunch {
  return {
    command: options.nodePath ?? process.execPath,
    args: [options.cliPath ?? fileURLToPath(new URL("cli.js", import.meta.url)), "mcp"]
  };
}

export function isInsideUitWorkspace(cwd: string = process.cwd()): boolean {
  const root = resolve(homedir(), ".uit", "courses");
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

export function resolveAvailableSession(cwd: string = process.cwd()): { api: ApiClient; userId: number; baseUrl: string } {
  if (!isInsideUitWorkspace(cwd)) {
    throw new Error("UIT MCP tools are only available inside a UIT course workspace.");
  }
  // MCP servers are long-lived, so reload the active session on every call.
  // The course is selected by an explicit tool argument, never inferred from cwd.
  const config = getActiveConfig({ fresh: true });
  const userId = Number(config.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("The active UIT session has no valid user ID. Sign in again.");
  }
  if (!config.sesskey || !config.cookies?.length) throw new Error("The active UIT browser session is incomplete. Sign in again.");
  return {
    api: createSessionApiClient(config.baseUrl, config.sesskey, config.cookies),
    userId,
    baseUrl: config.baseUrl
  };
}

export const UIT_MCP_TOOLS = UIT_TOOLS;

const uitToolServices: UitToolServices = {
  listCourses: (api, userId) => desktopService.listCourses(api, userId),
  getCourseContents: (courseId, api) => desktopService.getCourseContents(courseId, api),
  listAssignments: (courseId, api) => desktopService.listAssignments(courseId, api),
  listAnnouncements: (courseId, api) => desktopService.listAnnouncements(courseId, api),
  listCourseParticipants: (courseId, api) => desktopService.listCourseParticipants(courseId, api),
  getCourseGrades: (courseId, api, userId) => desktopService.getCourseGrades(courseId, api, userId),
  resolveCourseResource: (courseId, reference, api) => desktopService.resolveCourseResource(courseId, reference as unknown as desktopService.CourseResourceReference, api),
  materializeCourseFile: (courseId, moduleId, filename, api, identity) => desktopService.materializeCourseFile(courseId, moduleId, filename, api, identity),
  submitAssignment: (courseId, assignmentId, filePath, api) => desktopService.submitAssignment(courseId, assignmentId, filePath, api)
};

const executeUitTool = createUitToolExecutor(uitToolServices);

type JsonRpcId = string | number;
type PendingElicitation = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const SUBMISSION_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1_000;
const ASSIGNMENT_SUBMISSION_REJECTION_MESSAGE = "Assignment submission was declined by the user; no file was uploaded or submitted.";

class AssignmentSubmissionRejectedError extends Error {
  constructor() {
    super(ASSIGNMENT_SUBMISSION_REJECTION_MESSAGE);
    this.name = "AssignmentSubmissionRejectedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assignmentSubmissionElicitation(args: Record<string, unknown>): Record<string, unknown> {
  const courseId = String(args.courseId ?? "unknown");
  const assignmentId = String(args.assignmentId ?? "unknown");
  const filePath = String(args.filePath ?? "unknown");
  return {
    mode: "form",
    message: `Confirm submitting ${filePath} to assignment ${assignmentId} in course ${courseId}. This changes upstream course data.`,
    requestedSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          title: "Confirm assignment submission",
          description: "Accept only if the assignment and file shown above are correct."
        }
      },
      required: ["confirmed"]
    },
    _meta: {
      uit_confirmation: "assignment_submission",
      server_name: "uit",
      tool_name: UIT_ASSIGNMENT_SUBMISSION_TOOL,
      tool_description: "Upload and submit one local file to a UIT assignment. This changes upstream course data.",
      tool_params: args
    }
  };
}

export function acceptsAssignmentSubmissionElicitation(result: unknown): boolean {
  if (!isRecord(result) || result.action !== "accept" || !isRecord(result.content)) return false;
  return result.content.confirmed === true;
}

export interface McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  executeTool?: (name: string, args: Record<string, any>) => Promise<unknown>;
}

function requestElicitation(
  send: (message: Record<string, unknown>) => void,
  pending: Map<JsonRpcId, PendingElicitation>,
  params: Record<string, unknown>
): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Assignment submission confirmation timed out."));
    }, SUBMISSION_CONFIRMATION_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      send({ jsonrpc: "2.0", id, method: "elicitation/create", params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function requestAssignmentSubmissionConfirmation(
  send: (message: Record<string, unknown>) => void,
  pending: Map<JsonRpcId, PendingElicitation>,
  args: Record<string, unknown>
): Promise<void> {
  const result = await requestElicitation(send, pending, assignmentSubmissionElicitation(args));
  if (!acceptsAssignmentSubmissionElicitation(result)) throw new AssignmentSubmissionRejectedError();
}

function markAssignmentSubmissionConfirmed(result: unknown): unknown {
  const confirmation = {
    confirmationStatus: "approved",
    confirmationSource: "UIT Studio"
  };
  return isRecord(result) ? { ...result, ...confirmation } : { result, ...confirmation };
}

function assignmentSubmissionRejectedResult(): Record<string, string> {
  return {
    confirmationStatus: "rejected",
    submissionStatus: "not_submitted",
    message: ASSIGNMENT_SUBMISSION_REJECTION_MESSAGE
  };
}

export async function executeMcpTool(
  name: string,
  args: Record<string, any>,
  cwd: string = process.cwd()
): Promise<unknown> {
  if (!isInsideUitWorkspace(cwd)) {
    throw new Error("UIT MCP tools are only available inside a UIT course workspace.");
  }
  const session = resolveAvailableSession(cwd);
  return await executeUitTool(name, args, { ...session, workspacePath: resolve(cwd) });
}

export function runMcpServer(options: McpServerOptions = {}): void {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const executeTool = options.executeTool || ((name, args) => executeMcpTool(name, args));
  const rl = createInterface({
    input,
    output,
    terminal: false
  });

  const send = (message: Record<string, unknown>) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const pendingElicitations = new Map<JsonRpcId, PendingElicitation>();

  // A pipe-based smoke test and a real MCP host both signal shutdown by
  // closing stdin. Do not keep the closed input stream referenced after the
  // last response has flushed; active requests still keep their own handles.
  rl.on("close", () => {
    for (const pending of pendingElicitations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client disconnected before assignment submission confirmation."));
    }
    pendingElicitations.clear();
    if (input === process.stdin) process.stdin.unref?.();
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: any;
    try {
      request = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const { id, method, params } = request;

    if (method === undefined) {
      if (typeof id === "string" || typeof id === "number") {
        const pending = pendingElicitations.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingElicitations.delete(id);
          if (request.error) pending.reject(new Error(request.error.message || "MCP elicitation failed."));
          else pending.resolve(request.result);
        }
      }
      return;
    }

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "uit-mcp", version: packageVersion() }
        }
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      // Only advertise tools inside the managed UIT course workspace.
      const inside = isInsideUitWorkspace(process.cwd());
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: inside ? UIT_MCP_TOOLS : []
        }
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        if (toolName === UIT_ASSIGNMENT_SUBMISSION_TOOL) {
          await requestAssignmentSubmissionConfirmation(send, pendingElicitations, toolArgs);
        }
        const result = await executeTool(toolName, toolArgs);
        const output = toolName === UIT_ASSIGNMENT_SUBMISSION_TOOL ? markAssignmentSubmissionConfirmed(result) : result;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof output === "string" ? output : JSON.stringify(output, null, 2)
              }
            ]
          }
        });
      } catch (error) {
        if (error instanceof AssignmentSubmissionRejectedError) {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(assignmentSubmissionRejectedResult(), null, 2) }]
            }
          });
          return;
        }
        send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error)
              }
            ]
          }
        });
      }
      return;
    }

    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  });
}

const MCP_PARENT_KEY = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;

function tomlArrayEnd(lines: string[], start: number, limit: number): number {
  let depth = 0;
  let started = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < limit; index += 1) {
    const line = index === start ? lines[index].slice(lines[index].indexOf("=") + 1) : lines[index];
    for (const character of line) {
      if (escaped) { escaped = false; continue; }
      if (quote) {
        if (quote === '"' && character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "#") break;
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === "[") { depth += 1; started = true; }
      else if (character === "]" && depth > 0) depth -= 1;
    }
    if (started && depth === 0) return index + 1;
  }
  return start + 1;
}

export function upsertMcpConfig(
  existing: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): string {
  const commandLine = `command = ${JSON.stringify(command)}`;
  const argsLine = `args = [${args.map((argument) => JSON.stringify(argument)).join(", ")}]`;
  const envLine = env && Object.keys(env).length > 0
    ? `env = { ${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`
    : undefined;
  const lines = existing.split("\n");
  const uitSection = new RegExp(String.raw`^\s*\[\s*${MCP_PARENT_KEY}\s*\.\s*(?:uit|"uit"|'uit')\s*\]\s*(?:#.*)?$`);
  const commandKey = /^\s*(?:command|"command"|'command')\s*=/;
  const argsKey = /^\s*(?:args|"args"|'args')\s*=/;
  const envKey = /^\s*(?:env|"env"|'env')\s*=/;
  const sectionStart = lines.findIndex((line) => uitSection.test(line));

  if (sectionStart === -1) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}[mcp_servers.uit]\n${commandLine}\n${argsLine}${envLine ? `\n${envLine}` : ""}\n`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const commandIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && commandKey.test(line)
  );
  if (commandIndex === -1) {
    lines.splice(sectionStart + 1, 0, commandLine);
  } else {
    lines[commandIndex] = commandLine;
  }

  sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const argsIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && argsKey.test(line)
  );
  if (argsIndex === -1) {
    const currentCommandIndex = lines.findIndex(
      (line, index) => index > sectionStart && index < sectionEnd && commandKey.test(line)
    );
    lines.splice(currentCommandIndex + 1, 0, argsLine);
  } else {
    lines.splice(argsIndex, tomlArrayEnd(lines, argsIndex, sectionEnd) - argsIndex, argsLine);
  }

  sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const envIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && envKey.test(line)
  );
  if (envLine) {
    if (envIndex === -1) {
      const currentArgsIndex = lines.findIndex(
        (line, index) => index > sectionStart && index < sectionEnd && argsKey.test(line)
      );
      lines.splice(currentArgsIndex + 1, 0, envLine);
    } else {
      lines[envIndex] = envLine;
    }
  } else if (envIndex !== -1) {
    lines.splice(envIndex, 1);
  }

  return lines.join("\n");
}

export function writeFileAtomically(path: string, content: string, mode = 0o600): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome ? resolve(codexHome) : join(homedir(), ".codex"), "config.toml");
}

function removeLegacyMcpWrapper(): void {
  const wrapperPath = join(homedir(), ".local", "bin", "uit-mcp");
  try {
    const info = lstatSync(wrapperPath);
    if (info.isSymbolicLink() || !info.isFile()) return;
    if (!readFileSync(wrapperPath, "utf8").startsWith("#!/usr/bin/env bash\n# Managed by uit-cli\n")) return;
    rmSync(wrapperPath);
  } catch {
    // A missing or inaccessible legacy wrapper should not block config setup.
  }
}

export function installMcpServer(options: { command?: string; args?: string[]; env?: Record<string, string> } = {}): void {
  const configPath = codexConfigPath();
  const launch = resolveMcpLaunch();
  const command = options.command ?? launch.command;
  const args = options.args ?? (options.command ? ["mcp"] : launch.args);
  const configured = (existing: string) => upsertMcpConfig(existing, command, args, options.env);
  const verify = () => {
    const persisted = readFileSync(configPath, "utf8");
    if (configured(persisted) !== persisted) {
      throw new Error(`UIT MCP configuration could not be verified in ${configPath}.`);
    }
  };

  if (!existsSync(configPath)) {
    const codexDir = dirname(configPath);
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }
    writeFileAtomically(configPath, configured(""));
    removeLegacyMcpWrapper();
    verify();
    console.log(`Created ${configPath} and added [mcp_servers.uit]`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  const updated = configured(existing);
  if (updated === existing) {
    removeLegacyMcpWrapper();
    verify();
    console.log(`uit MCP server is already configured in ${configPath}`);
    return;
  }
  writeFileAtomically(configPath, updated, statSync(configPath).mode & 0o777);
  removeLegacyMcpWrapper();
  verify();
  console.log(new RegExp(String.raw`^\s*\[\s*${MCP_PARENT_KEY}\s*\.\s*(?:uit|"uit"|'uit')\s*\]`, "m").test(existing)
    ? `Updated uit MCP server path in ${configPath} to ${command}`
    : `Configured uit MCP server in ${configPath}`);
}
