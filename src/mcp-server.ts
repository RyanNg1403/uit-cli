import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
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
import { createTokenApiClient, createSessionApiClient } from "./api.js";
import { getActiveConfig, readSessionsFile, type Config } from "./config.js";
import {
  getCourseContents,
  listAssignments,
  listAnnouncements,
  materializeFile,
  listCourseParticipants,
  getCourseGrades,
  listCourses
} from "./desktop-service.js";
import { workspacePath } from "./desktop-service.js";

function packageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    return String(JSON.parse(readFileSync(packagePath, "utf8")).version || "unknown");
  } catch {
    return "unknown";
  }
}

export function isInsideUitWorkspace(cwd: string = process.cwd()): boolean {
  const root = resolve(homedir(), ".uit", "courses");
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

function persistedConfigs(): Config[] {
  const sessions = readSessionsFile();
  const configs: Config[] = [];
  // Environment credentials remain the active CLI default, but must not hide a
  // saved account that is explicitly encoded in a Studio course workspace.
  if (process.env.UIT_TOKEN) configs.push(getActiveConfig({ fresh: true }) as Config);
  if (sessions.sso?.baseUrl && sessions.sso.sesskey && sessions.sso.userId && Array.isArray(sessions.sso.cookies)) {
    configs.push({
      authType: "sso",
      baseUrl: sessions.sso.baseUrl.replace(/\/+$/, ""),
      userId: Number(sessions.sso.userId),
      sesskey: sessions.sso.sesskey,
      cookies: sessions.sso.cookies
    });
  }
  for (const session of sessions.legacy || []) {
    if (session?.baseUrl && session.token && session.userId) {
      configs.push({ authType: "token", baseUrl: session.baseUrl.replace(/\/+$/, ""), userId: Number(session.userId), token: session.token });
    }
  }
  return configs;
}

function workspaceCourseId(cwd: string): number | undefined {
  const root = resolve(homedir(), ".uit", "courses");
  const current = resolve(cwd);
  if (!current.startsWith(`${root}${sep}`)) return undefined;
  const parts = current.slice(root.length + 1).split(sep);
  const match = /^course-([1-9]\d*)$/.exec(parts[2] || "");
  return match ? Number(match[1]) : undefined;
}

export function resolveAvailableSession(cwd: string = process.cwd()): { api: ApiClient; userId: number; baseUrl: string } {
  // Bind credentials to the portal/account encoded by the course workspace.
  // MCP servers are long-lived, so reload persisted sessions on every call.
  const courseId = workspaceCourseId(cwd);
  if (!courseId) throw new Error("UIT MCP tools require a specific UIT course workspace.");
  const current = resolve(cwd);
  const config = persistedConfigs().find((candidate) => {
    const userId = Number(candidate.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return false;
    const workspace = workspacePath(courseId, candidate.baseUrl, userId);
    return current === workspace || current.startsWith(`${workspace}${sep}`);
  });
  if (!config) throw new Error("No saved UIT session matches this course workspace. Reconnect its portal account.");
  const userId = Number(config.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("The active UIT session has no valid user ID. Sign in again or set UIT_USER_ID.");
  }
  if (config.authType === "sso") {
    if (!config.sesskey || !config.cookies) throw new Error("The active UIT SSO session is incomplete. Sign in again.");
    return {
      api: createSessionApiClient(config.baseUrl, config.sesskey, config.cookies),
      userId,
      baseUrl: config.baseUrl
    };
  }
  if (!config.token) throw new Error("The active UIT token session is incomplete. Sign in again.");
  return {
    api: createTokenApiClient(config.baseUrl, config.token),
    userId,
    baseUrl: config.baseUrl
  };
}

export const UIT_MCP_TOOLS = [
  {
    name: "uit_courses",
    description: "List accessible UIT courses for the authenticated student account.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "uit_course_contents",
    description: "Read course modules, sections, assignments, and announcements for a UIT course.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID (positive integer)" }
      },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    name: "uit_course_members",
    description: "List course instructors, teaching assistants, and enrolled students.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID" },
        role: {
          type: "string",
          enum: ["all", "teacher", "student"],
          description: "Filter: 'teacher' for instructors, 'student' for students, or 'all'."
        }
      },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    name: "uit_course_grades",
    description: "Read student grade report, scores, maximum points, and teacher feedback for a course.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID" }
      },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    name: "uit_download_material",
    description: "Explicitly download a course file into the project's materials folder. Returns the local filepath.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID" },
        fileUrl: { type: "string", description: "Full URL of the file from course contents" },
        filename: { type: "string", description: "Optional filename to save as" }
      },
      required: ["courseId", "fileUrl"],
      additionalProperties: false
    }
  }
];

export async function executeMcpTool(
  name: string,
  args: Record<string, any>,
  cwd: string = process.cwd()
): Promise<unknown> {
  if (!isInsideUitWorkspace(cwd)) {
    throw new Error("UIT MCP tools are only available inside a UIT course workspace.");
  }
  const session = resolveAvailableSession(cwd);
  const courseId = Number(args.courseId);
  const scopedCourseId = workspaceCourseId(cwd)!;
  if (name !== "uit_courses" && courseId !== scopedCourseId) {
    throw new Error(`This MCP server is scoped to course ${scopedCourseId}; cross-course access is not allowed.`);
  }

  switch (name) {
    case "uit_courses": {
      return await listCourses(session.api, session.userId);
    }
    case "uit_course_contents": {
      if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid courseId");
      const [modules, assignments, announcements] = await Promise.allSettled([
        getCourseContents(courseId, session.api),
        listAssignments(courseId, session.api),
        listAnnouncements(courseId, session.api)
      ]);
      return {
        modules: modules.status === "fulfilled" ? modules.value : { error: modules.reason.message },
        assignments: assignments.status === "fulfilled" ? assignments.value : { error: assignments.reason.message },
        announcements: announcements.status === "fulfilled" ? announcements.value : { error: announcements.reason.message }
      };
    }
    case "uit_course_members": {
      if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid courseId");
      const roleFilter = args.role || "all";
      if (!new Set(["all", "teacher", "student"]).has(roleFilter)) throw new Error("Invalid role filter");
      const participants = await listCourseParticipants(courseId, session.api);
      return participants.filter((p) => {
        if (roleFilter === "all") return true;
        const roleStrings = p.roles.map((r: string) => r.toLowerCase());
        if (roleFilter === "teacher") return roleStrings.some((r: string) => /gv|teacher|instructor|giảng|trợ/i.test(r));
        if (roleFilter === "student") return roleStrings.some((r: string) => /student|học\s*viên/i.test(r));
        return true;
      });
    }
    case "uit_course_grades": {
      if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid courseId");
      return await getCourseGrades(courseId, session.api, session.userId);
    }
    case "uit_download_material": {
      if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid courseId");
      const fileUrl = String(args.fileUrl || "");
      const filename = String(args.filename || "material");
      const localPath = await materializeFile(courseId, fileUrl, filename, session.api, session);
      return { path: localPath };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function runMcpServer(): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

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
        const result = await executeMcpTool(toolName, toolArgs);
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
              }
            ]
          }
        });
      } catch (error) {
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

export function ensureLocalBinWrapper(localBin: string = join(homedir(), ".local", "bin")): string {
  // Never use the public `uit` name here: npm may already own it via a symlink.
  const binPath = join(localBin, "uit-mcp");
  const cliPath = fileURLToPath(new URL("cli.js", import.meta.url));
  try {
    if (!existsSync(localBin)) {
      mkdirSync(localBin, { recursive: true });
    }
    const wrapper = `#!/usr/bin/env bash
# Managed by uit-cli
if ! command -v node >/dev/null 2>&1; then
  for p in "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$p/node" ]; then
      export PATH="$p:$PATH"
      break
    fi
  done
fi
exec node "${cliPath}" "$@"
`;
    if (existsSync(binPath)) {
      const info = lstatSync(binPath);
      if (info.isSymbolicLink() || !info.isFile() || !readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env bash\n# Managed by uit-cli\n")) {
        return "uit";
      }
      if (readFileSync(binPath, "utf8") === wrapper) return binPath;
      const temporary = `${binPath}.part-${process.pid}`;
      try {
        writeFileSync(temporary, wrapper, { flag: "wx", mode: 0o755 });
        renameSync(temporary, binPath);
      } finally { rmSync(temporary, { force: true }); }
    } else {
      writeFileSync(binPath, wrapper, { flag: "wx", mode: 0o755 });
    }
    return binPath;
  } catch {
    return "uit";
  }
}

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

export function upsertMcpConfig(existing: string, command: string, args: string[]): string {
  const commandLine = `command = ${JSON.stringify(command)}`;
  const argsLine = `args = [${args.map((argument) => JSON.stringify(argument)).join(", ")}]`;
  const lines = existing.split("\n");
  const uitSection = /^\s*\[\s*mcp_servers\s*\.\s*(?:uit|"uit"|'uit')\s*\]\s*(?:#.*)?$/i;
  const commandKey = /^\s*(?:command|"command"|'command')\s*=/;
  const argsKey = /^\s*(?:args|"args"|'args')\s*=/;
  const sectionStart = lines.findIndex((line) => uitSection.test(line));

  if (sectionStart === -1) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}[mcp_servers.uit]\n${commandLine}\n${argsLine}\n`;
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

export function installMcpServer(options: { command?: string; args?: string[] } = {}): void {
  const configPath = join(homedir(), ".codex", "config.toml");
  const binPath = options.command ? undefined : ensureLocalBinWrapper();
  const command = options.command || (binPath && existsSync(binPath) ? binPath : "uit");
  const args = options.args || ["mcp"];
  const configured = (existing: string) => upsertMcpConfig(existing, command, args);

  if (!existsSync(configPath)) {
    const codexDir = join(homedir(), ".codex");
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }
    writeFileAtomically(configPath, configured(""));
    console.log(`Created ~/.codex/config.toml and added [mcp_servers.uit]`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  const updated = configured(existing);
  if (updated === existing) {
    console.log(`uit MCP server is already configured in ~/.codex/config.toml`);
    return;
  }
  writeFileAtomically(configPath, updated, statSync(configPath).mode & 0o777);
  console.log(/^\s*\[\s*mcp_servers\s*\.\s*(?:uit|"uit"|'uit')\s*\]/im.test(existing)
    ? `Updated uit MCP server path in ~/.codex/config.toml to ${command}`
    : `Configured uit MCP server in ~/.codex/config.toml`);
}
