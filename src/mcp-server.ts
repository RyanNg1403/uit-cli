import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApiClient } from "./types.js";
import { createTokenApiClient, createSessionApiClient } from "./api.js";
import { getActiveConfig } from "./config.js";
import {
  getCourseContents,
  listAssignments,
  listAnnouncements,
  materializeFile,
  listCourseParticipants,
  getCourseGrades,
  listCourses
} from "./desktop-service.js";

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

export function resolveAvailableSession(): { api: ApiClient; userId: number; baseUrl: string } {
  // MCP servers are long-lived; reload so Studio/CLI login changes take effect.
  const config = getActiveConfig({ fresh: true });
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
  const session = resolveAvailableSession();
  const courseId = Number(args.courseId);

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

export function ensureLocalBinWrapper(): string {
  const localBin = join(homedir(), ".local", "bin");
  const binPath = join(localBin, "uit");
  const cliPath = fileURLToPath(new URL("cli.js", import.meta.url));
  try {
    if (!existsSync(localBin)) {
      mkdirSync(localBin, { recursive: true });
    }
    const wrapper = `#!/usr/bin/env bash
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
    writeFileSync(binPath, wrapper, { mode: 0o755 });
    return binPath;
  } catch {
    return "uit";
  }
}

export function upsertMcpConfig(existing: string, command: string, args: string[]): string {
  const commandLine = `command = ${JSON.stringify(command)}`;
  const argsLine = `args = [${args.map((argument) => JSON.stringify(argument)).join(", ")}]`;
  const lines = existing.split("\n");
  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === "[mcp_servers.uit]");

  if (sectionStart === -1) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}[mcp_servers.uit]\n${commandLine}\n${argsLine}\n`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const commandIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && /^\s*command\s*=/.test(line)
  );
  const argsIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && /^\s*args\s*=/.test(line)
  );

  if (commandIndex === -1) {
    lines.splice(sectionStart + 1, 0, commandLine);
    sectionEnd += 1;
  } else {
    lines[commandIndex] = commandLine;
  }

  const adjustedArgsIndex = argsIndex !== -1 && commandIndex === -1 && argsIndex > sectionStart
    ? argsIndex + 1
    : argsIndex;
  if (adjustedArgsIndex === -1) {
    const currentCommandIndex = lines.findIndex(
      (line, index) => index > sectionStart && index < sectionEnd && /^\s*command\s*=/.test(line)
    );
    lines.splice(currentCommandIndex + 1, 0, argsLine);
  } else {
    lines[adjustedArgsIndex] = argsLine;
  }

  return lines.join("\n");
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
    writeFileSync(configPath, configured(""), "utf8");
    console.log(`Created ~/.codex/config.toml and added [mcp_servers.uit]`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  const updated = configured(existing);
  if (updated === existing) {
    console.log(`uit MCP server is already configured in ~/.codex/config.toml`);
    return;
  }
  writeFileSync(configPath, updated, "utf8");
  console.log(/\[mcp_servers\.uit\]/i.test(existing)
    ? `Updated uit MCP server path in ~/.codex/config.toml to ${command}`
    : `Configured uit MCP server in ~/.codex/config.toml`);
}
