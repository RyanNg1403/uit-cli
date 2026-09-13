import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeMcpTool,
  installMcpServer,
  isInsideUitWorkspace,
  upsertMcpConfig,
  writeFileAtomically,
  UIT_MCP_TOOLS,
  resolveMcpLaunch
} from "../src/mcp-server.js";
import { createUitToolExecutor, type UitToolServices } from "../src/uit-tools.js";
import type { ApiClient } from "../src/types.js";

describe("mcp-server workspace gating and tools", () => {
  it("gates tools based on whether cwd is inside ~/UIT", () => {
    const uitRoot = resolve(homedir(), ".uit", "courses");
    expect(isInsideUitWorkspace(uitRoot)).toBe(true);
    expect(isInsideUitWorkspace(join(uitRoot, "CS01"))).toBe(true);
    expect(isInsideUitWorkspace(join(uitRoot, "course-123", "subfolder"))).toBe(true);

    expect(isInsideUitWorkspace(homedir())).toBe(false);
    expect(isInsideUitWorkspace(resolve(homedir(), "Desktop"))).toBe(false);
    expect(isInsideUitWorkspace("/tmp")).toBe(false);
  });

  it("exposes the canonical UIT tools in UIT_MCP_TOOLS", () => {
    const toolNames = UIT_MCP_TOOLS.map((t) => t.name);
    expect(toolNames).toContain("uit_courses");
    expect(toolNames).toContain("uit_course_contents");
    expect(toolNames).toContain("uit_read_resource");
    expect(toolNames).toContain("uit_course_members");
    expect(toolNames).toContain("uit_course_grades");
    expect(toolNames).toContain("uit_download_material");
    expect(toolNames.length).toBe(6);
  });

  it("resolves downloads by module ID and filename instead of a model-supplied URL", () => {
    const download = UIT_MCP_TOOLS.find((tool) => tool.name === "uit_download_material");
    expect(download?.inputSchema.required).toEqual(["courseId", "moduleId", "filename"]);
    expect(download?.inputSchema.properties).not.toHaveProperty("fileUrl");

    const read = UIT_MCP_TOOLS.find((tool) => tool.name === "uit_read_resource");
    expect(read?.inputSchema.properties).not.toHaveProperty("fileUrl");
    expect(read?.inputSchema.properties).toHaveProperty("filename");
  });

  it("passes the ID-based download reference to the course service", async () => {
    const materializeCourseFile = vi.fn().mockResolvedValue("/course/material.pdf");
    const execute = createUitToolExecutor({
      listCourses: vi.fn(),
      getCourseContents: vi.fn(),
      listAssignments: vi.fn(),
      listAnnouncements: vi.fn(),
      listCourseParticipants: vi.fn(),
      getCourseGrades: vi.fn(),
      resolveCourseResource: vi.fn(),
      materializeCourseFile
    } as unknown as UitToolServices);
    const api = {} as ApiClient;

    await expect(execute("uit_download_material", { courseId: 42, moduleId: 10, filename: "lecture.pdf" }, { api, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).resolves.toEqual({ path: "/course/material.pdf" });
    expect(materializeCourseFile).toHaveBeenCalledWith(42, 10, "lecture.pdf", api, { baseUrl: "https://courses.uit.edu.vn", userId: 7 });
  });

  it("passes the ID-based resource reference without a file URL", async () => {
    const resolveCourseResource = vi.fn().mockResolvedValue({ kind: "file", id: 10, name: "lecture.pdf" });
    const execute = createUitToolExecutor({
      listCourses: vi.fn(),
      getCourseContents: vi.fn(),
      listAssignments: vi.fn(),
      listAnnouncements: vi.fn(),
      listCourseParticipants: vi.fn(),
      getCourseGrades: vi.fn(),
      resolveCourseResource,
      materializeCourseFile: vi.fn()
    } as unknown as UitToolServices);
    const api = {} as ApiClient;

    await expect(execute("uit_read_resource", { courseId: 42, kind: "file", id: 10, filename: "lecture.pdf" }, { api, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).resolves.toMatchObject({ name: "lecture.pdf" });
    expect(resolveCourseResource).toHaveBeenCalledWith(42, { kind: "file", id: 10, filename: "lecture.pdf" }, api);
    await expect(execute("uit_read_resource", { courseId: 42, kind: "file", id: 10, fileUrl: "https://courses.uit.edu.vn/file.pdf" }, { api, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).rejects.toThrow("File URL is not accepted");
  });

  it("rejects direct tool calls outside a UIT workspace", async () => {
    await expect(executeMcpTool("uit_courses", {}, resolve(homedir(), "Desktop"))).rejects.toThrow(
      "only available inside a UIT course workspace"
    );
  });

  it("updates both command and arguments without discarding other MCP settings", () => {
    const existing = `[mcp_servers.uit]\ncommand = "uit"\nargs = ["mcp"]\nenabled = true\n\n[mcp_servers.other]\ncommand = "other"\n`;
    const updated = upsertMcpConfig(
      existing,
      "/Users/Student/Applications/UIT Studio.app/Contents/MacOS/UIT Studio",
      ["mcp-entry.js"],
      { ELECTRON_RUN_AS_NODE: "1" }
    );

    expect(updated).toContain('command = "/Users/Student/Applications/UIT Studio.app/Contents/MacOS/UIT Studio"');
    expect(updated).toContain('args = ["mcp-entry.js"]');
    expect(updated).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    expect(updated).toContain("enabled = true");
    expect(updated).toContain('[mcp_servers.other]\ncommand = "other"');
  });

  it("adds a new MCP section without a leading blank line", () => {
    expect(upsertMcpConfig("", "uit", ["mcp"])).toBe(
      '[mcp_servers.uit]\ncommand = "uit"\nargs = ["mcp"]\n'
    );
  });

  it("removes a managed Electron Node-mode environment when the CLI owns the launch", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers.uit]\ncommand = "Electron"\nargs = ["mcp-entry.js"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n',
      "node",
      ["cli.js", "mcp"]
    );
    expect(updated).toBe('[mcp_servers.uit]\ncommand = "node"\nargs = ["cli.js", "mcp"]\n');
  });

  it("registers the real Node executable and CLI entrypoint directly", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-direct-mcp-test-"));
    const executable = join(directory, "uit");
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousExecutable = process.env.UIT_CLI_EXECUTABLE;
    try {
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
      process.env.HOME = directory;
      delete process.env.CODEX_HOME;
      process.env.UIT_CLI_EXECUTABLE = executable;
      installMcpServer();
      const config = readFileSync(join(directory, ".codex", "config.toml"), "utf8");
      const launch = resolveMcpLaunch();
      expect(config).toContain(`command = ${JSON.stringify(launch.command)}`);
      expect(config).toContain(`args = [${launch.args.map((argument) => JSON.stringify(argument)).join(", ")}]`);
      expect(readdirSync(join(directory, ".codex"))).toEqual(["config.toml"]);
      expect(existsSync(join(directory, ".local", "bin", "uit-mcp"))).toBe(false);
      installMcpServer();
      expect(readFileSync(join(directory, ".codex", "config.toml"), "utf8")).toBe(config);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousExecutable === undefined) delete process.env.UIT_CLI_EXECUTABLE;
      else process.env.UIT_CLI_EXECUTABLE = previousExecutable;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes only the legacy managed MCP wrapper", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-legacy-mcp-test-"));
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      const wrapperDirectory = join(directory, ".local", "bin");
      const wrapper = join(wrapperDirectory, "uit-mcp");
      mkdirSync(wrapperDirectory, { recursive: true });
      writeFileSync(wrapper, "#!/usr/bin/env bash\n# Managed by uit-cli\nexec node old-cli.js\n");
      process.env.HOME = directory;
      delete process.env.CODEX_HOME;

      installMcpServer();

      expect(existsSync(wrapper)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates a commented MCP section header without creating a duplicate table", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers.uit] # configured manually\ncommand = "old"\nargs = ["mcp"]\n\n[mcp_servers.other] # keep\ncommand = "other"\n',
      "/Applications/UIT Studio.app/Contents/MacOS/UIT Studio",
      ["--uit-mcp"]
    );
    expect(updated.match(/\[mcp_servers\.uit\]/g)).toHaveLength(1);
    expect(updated).toContain('command = "/Applications/UIT Studio.app/Contents/MacOS/UIT Studio"');
    expect(updated).toContain('[mcp_servers.other] # keep\ncommand = "other"');
  });

  it("updates an equivalent quoted MCP section without creating a duplicate table", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers."uit"] # quoted TOML key\ncommand = "old"\nargs = ["old"]\n',
      "uit-mcp",
      ["mcp"]
    );
    expect(updated.match(/\[mcp_servers\.(?:uit|"uit")\]/g)).toHaveLength(1);
    expect(updated).toContain('[mcp_servers."uit"] # quoted TOML key');
    expect(updated).toContain('command = "uit-mcp"\nargs = ["mcp"]');
  });

  it.each(['["mcp_servers".uit]', "['mcp_servers'.uit]"])(
    "updates the equivalent quoted parent table %s without creating a duplicate",
    (header) => {
      const updated = upsertMcpConfig(`${header}\ncommand = "old"\nargs = ["old"]\n`, "uit-mcp", ["mcp"]);
      expect(updated).toContain(`${header}\ncommand = "uit-mcp"\nargs = ["mcp"]`);
      expect(updated.match(/mcp_servers/g)).toHaveLength(1);
    }
  );

  it("preserves a case-distinct TOML table and creates the lowercase UIT server", () => {
    const existing = '[mcp_servers.UIT]\ncommand = "other"\nargs = ["other"]\n';
    const updated = upsertMcpConfig(existing, "uit-mcp", ["mcp"]);
    expect(updated).toContain(existing);
    expect(updated).toContain('[mcp_servers.uit]\ncommand = "uit-mcp"\nargs = ["mcp"]');
  });

  it("replaces quoted option keys without adding equivalent duplicates", () => {
    const updated = upsertMcpConfig(
      "[mcp_servers.uit]\n'command' = \"old\"\n\"args\" = [\"old\"]\n",
      "uit-mcp",
      ["mcp"]
    );
    expect(updated).toBe('[mcp_servers.uit]\ncommand = "uit-mcp"\nargs = ["mcp"]\n');
  });

  it("replaces an entire multiline args array", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers.uit]\ncommand = "old"\nargs = [\n  "mcp", # old argument\n  "--legacy"\n]\nenabled = true\n',
      "uit-mcp",
      ["mcp"]
    );
    expect(updated).toBe('[mcp_servers.uit]\ncommand = "uit-mcp"\nargs = ["mcp"]\nenabled = true\n');
  });

  it("stops MCP updates before a TOML array table", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers.uit]\n\n[[profiles]] # unrelated\ncommand = "profile-command"\nargs = ["profile-arg"]\n',
      "uit-mcp",
      ["mcp"]
    );
    expect(updated).toContain('[mcp_servers.uit]\ncommand = "uit-mcp"\nargs = ["mcp"]\n\n[[profiles]] # unrelated');
    expect(updated).toContain('command = "profile-command"\nargs = ["profile-arg"]');
  });


  it("resolves a Windows-style Node launch without a shell wrapper", () => {
    expect(resolveMcpLaunch({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "C:\\Users\\Student\\node_modules\\uit-cli\\dist\\cli.js"
    })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\Student\\node_modules\\uit-cli\\dist\\cli.js", "mcp"]
    });
  });

  it("atomically replaces configuration content while preserving its mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-mcp-config-"));
    try {
      const config = join(directory, "config.toml");
      writeFileSync(config, "original\n", { mode: 0o640 });
      chmodSync(config, 0o640);

      writeFileAtomically(config, "updated\n", statSync(config).mode & 0o777);

      expect(readFileSync(config, "utf8")).toBe("updated\n");
      expect(statSync(config).mode & 0o777).toBe(0o640);
      expect(readdirSync(directory)).toEqual(["config.toml"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
