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
import { createTokenApiClient, createSessionApiClient } from "./api.js";
import { getActiveConfig } from "./config.js";
import { createUitToolExecutor, UIT_TOOLS, type UitToolServices } from "./uit-tools.js";
import * as desktopService from "./desktop-service.js";

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

export function resolveAvailableSession(cwd: string = process.cwd()): { api: ApiClient; userId: number; baseUrl: string } {
  if (!isInsideUitWorkspace(cwd)) {
    throw new Error("UIT MCP tools are only available inside a UIT course workspace.");
  }
  // MCP servers are long-lived, so reload the active session on every call.
  // The course is selected by an explicit tool argument, never inferred from cwd.
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

export const UIT_MCP_TOOLS = UIT_TOOLS;

const uitToolServices: UitToolServices = {
  listCourses: (api, userId) => desktopService.listCourses(api, userId),
  getCourseContents: (courseId, api) => desktopService.getCourseContents(courseId, api),
  listAssignments: (courseId, api) => desktopService.listAssignments(courseId, api),
  listAnnouncements: (courseId, api) => desktopService.listAnnouncements(courseId, api),
  listCourseParticipants: (courseId, api) => desktopService.listCourseParticipants(courseId, api),
  getCourseGrades: (courseId, api, userId) => desktopService.getCourseGrades(courseId, api, userId),
  resolveCourseResource: (courseId, reference, api) => desktopService.resolveCourseResource(courseId, reference as unknown as desktopService.CourseResourceReference, api),
  materializeFile: (courseId, fileUrl, filename, api, identity) => desktopService.materializeFile(courseId, fileUrl, filename, api, identity)
};

const executeUitTool = createUitToolExecutor(uitToolServices);

export async function executeMcpTool(
  name: string,
  args: Record<string, any>,
  cwd: string = process.cwd()
): Promise<unknown> {
  if (!isInsideUitWorkspace(cwd)) {
    throw new Error("UIT MCP tools are only available inside a UIT course workspace.");
  }
  const session = resolveAvailableSession(cwd);
  return await executeUitTool(name, args, session);
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

  // A pipe-based smoke test and a real MCP host both signal shutdown by
  // closing stdin. Do not keep the closed input stream referenced after the
  // last response has flushed; active requests still keep their own handles.
  rl.on("close", () => process.stdin.unref());

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

export function upsertMcpConfig(existing: string, command: string, args: string[]): string {
  const commandLine = `command = ${JSON.stringify(command)}`;
  const argsLine = `args = [${args.map((argument) => JSON.stringify(argument)).join(", ")}]`;
  const lines = existing.split("\n");
  const uitSection = new RegExp(String.raw`^\s*\[\s*${MCP_PARENT_KEY}\s*\.\s*(?:uit|"uit"|'uit')\s*\]\s*(?:#.*)?$`);
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

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome ? resolve(codexHome) : join(homedir(), ".codex"), "config.toml");
}

export function installMcpServer(options: { command?: string; args?: string[] } = {}): void {
  const configPath = codexConfigPath();
  const standalonePath = process.env.UIT_CLI_EXECUTABLE;
  const binPath = options.command
    ? undefined
    : standalonePath && existsSync(standalonePath)
      ? standalonePath
      : ensureLocalBinWrapper();
  const command = options.command || (binPath && existsSync(binPath) ? binPath : "uit");
  const args = options.args || ["mcp"];
  const configured = (existing: string) => upsertMcpConfig(existing, command, args);

  if (!existsSync(configPath)) {
    const codexDir = dirname(configPath);
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }
    writeFileAtomically(configPath, configured(""));
    console.log(`Created ${configPath} and added [mcp_servers.uit]`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  const updated = configured(existing);
  if (updated === existing) {
    console.log(`uit MCP server is already configured in ${configPath}`);
    return;
  }
  writeFileAtomically(configPath, updated, statSync(configPath).mode & 0o777);
  console.log(new RegExp(String.raw`^\s*\[\s*${MCP_PARENT_KEY}\s*\.\s*(?:uit|"uit"|'uit')\s*\]`, "m").test(existing)
    ? `Updated uit MCP server path in ${configPath} to ${command}`
    : `Configured uit MCP server in ${configPath}`);
}
