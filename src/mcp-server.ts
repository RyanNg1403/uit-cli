import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ApiClient, MoodleRecord } from "./types.js";
import { createTokenApiClient, fetchCourseFile, writeCourseFile } from "./api.js";
import { buildAjaxInfo, unwrapAjaxResponse } from "./moodle-session-client.js";
import { get } from "./config.js";
import {
  configuredLegacySession,
  getCourseContents,
  listAssignments,
  listAnnouncements,
  resolveCourseResource,
  materializeFile,
  listCourseParticipants,
  getCourseGrades,
  listCourses
} from "./desktop-service.js";

class NodeSessionApiClient implements ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sesskey: string,
    private readonly cookieHeader: string
  ) {}

  async call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    const info = buildAjaxInfo(name, params);
    const endpoint = `${this.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookieHeader
      },
      body: JSON.stringify(info)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return unwrapAjaxResponse(data) as T;
  }

  async downloadFile(fileUrl: string, destPath: string): Promise<void> {
    await writeCourseFile(
      await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: this.cookieHeader }),
      destPath
    );
  }

  async uploadFile(_filepath: string): Promise<MoodleRecord> {
    throw new Error("File uploads are not supported through the MCP server.");
  }
}

interface SsoSessionData {
  baseUrl: string;
  userId: number;
  sesskey: string;
  cookies: Array<{ name: string; value: string }>;
}

export function isInsideUitWorkspace(cwd: string = process.cwd()): boolean {
  const root = resolve(homedir(), "UIT");
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

export function resolveAvailableSession(): { api: ApiClient; userId: number; baseUrl: string } {
  // 1. Check SSO session in ~/.uit/sso-session.json
  const ssoPath = join(homedir(), ".uit", "sso-session.json");
  if (existsSync(ssoPath)) {
    try {
      const data: SsoSessionData = JSON.parse(readFileSync(ssoPath, "utf8"));
      if (data.baseUrl && data.sesskey && data.userId && Array.isArray(data.cookies)) {
        const cookieHeader = data.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        return {
          api: new NodeSessionApiClient(data.baseUrl, data.sesskey, cookieHeader),
          userId: data.userId,
          baseUrl: data.baseUrl
        };
      }
    } catch {
      // Fallback to legacy
    }
  }

  // 2. Check legacy session in ~/.uit/.env
  try {
    const legacy = configuredLegacySession();
    if (legacy?.session?.baseUrl && legacy.session.userId) {
      return {
        api: legacy.api,
        userId: legacy.session.userId,
        baseUrl: legacy.session.baseUrl
      };
    }
  } catch {
    // None
  }

  // 3. Fallback to basic token client if UIT_TOKEN is set
  try {
    const token = get("token");
    const baseUrl = get("baseUrl");
    const userId = Number(get("userId") || 0);
    if (token && baseUrl) {
      return {
        api: createTokenApiClient(baseUrl, token),
        userId,
        baseUrl
      };
    }
  } catch {
    // None
  }

  throw new Error("No active UIT session found. Log in via UIT Studio or run 'uit init'.");
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

export async function executeMcpTool(name: string, args: Record<string, any>): Promise<unknown> {
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
          serverInfo: { name: "uit-mcp", version: "1.1.0" }
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
      // Workspace Gating: only return tools if cwd is inside ~/UIT
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

export function installMcpServer(): void {
  const configPath = join(homedir(), ".codex", "config.toml");
  const snippet = `\n[mcp_servers.uit]\ncommand = "uit"\nargs = ["mcp"]\n`;

  if (!existsSync(configPath)) {
    writeFileSync(configPath, snippet, "utf8");
    console.log(`Created ~/.codex/config.toml and added [mcp_servers.uit]`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  if (/\[mcp_servers\.uit\]/i.test(existing)) {
    console.log(`uit MCP server is already configured in ~/.codex/config.toml`);
    return;
  }

  writeFileSync(configPath, `${existing}${snippet}`, "utf8");
  console.log(`Configured uit MCP server in ~/.codex/config.toml`);
}
