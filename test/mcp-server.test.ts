import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  executeMcpTool,
  acceptsAssignmentSubmissionElicitation,
  assignmentSubmissionElicitation,
  installMcpServer,
  isInsideUitWorkspace,
  runMcpServer,
  upsertMcpConfig,
  writeFileAtomically,
  UIT_MCP_TOOLS,
  resolveMcpLaunch
} from "../src/mcp-server.js";
import { createUitToolExecutor, type UitToolServices } from "../src/uit-tools.js";
import type { ApiClient } from "../src/types.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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
    expect(toolNames).toContain("uit_submit_assignment");
    expect(toolNames.length).toBe(15);
  });

  it("advertises messaging read/write semantics and rejects account arguments", async () => {
    for (const name of ["uit_notifications", "uit_notification_counts", "uit_inbox", "uit_conversation_messages"]) {
      expect(UIT_MCP_TOOLS.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["uit_mark_notification_read", "uit_mark_all_notifications_read", "uit_mark_conversation_read", "uit_send_message"]) {
      expect(UIT_MCP_TOOLS.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(UIT_MCP_TOOLS.find((tool) => tool.name === "uit_send_message")?.annotations?.idempotentHint).toBe(false);
    const execute = createUitToolExecutor({} as UitToolServices);
    const api = { call: vi.fn() } as unknown as ApiClient;
    const context = { api, baseUrl: "https://courses.example", userId: 7 };
    for (const args of [{ userId: 99 }, { baseUrl: "https://other.example" }, { offset: -1 }, { all: true }]) {
      await expect(execute("uit_notifications", args, context)).rejects.toThrow();
    }
    expect(api.call).not.toHaveBeenCalled();
  });

  it.each([
    ["uit_notifications", { offset: 20 }, "message_popup_get_popup_notifications", { useridto: 7, newestfirst: 1, limit: 20, offset: 20 }, { notifications: [], unreadcount: 0 }],
    ["uit_inbox", {}, "core_message_get_conversations", { userid: 7, limitfrom: 0, limitnum: 20 }, { conversations: [] }],
    ["uit_conversation_messages", { id: 3, offset: 20 }, "core_message_get_conversation_messages", { currentuserid: 7, convid: 3, limitfrom: 20, limitnum: 20, newest: 1 }, { messages: [], members: [] }],
    ["uit_mark_notification_read", { id: 2 }, "core_message_mark_notification_read", { notificationid: 2 }, true],
    ["uit_mark_all_notifications_read", {}, "core_message_mark_all_notifications_as_read", { useridto: 7 }, true],
    ["uit_mark_conversation_read", { id: 3 }, "core_message_mark_all_conversation_messages_as_read", { userid: 7, conversationid: 3 }, true],
    ["uit_send_message", { id: 3, text: "Hello" }, "core_message_send_messages_to_conversation", { conversationid: 3, messages: [{ text: "Hello", textformat: 2 }] }, [{ id: 5, text: "Hello" }]]
  ])("routes %s through the shared service without extra calls", async (name, args, method, params, response) => {
    const api = { call: vi.fn().mockResolvedValue(response) } as unknown as ApiClient;
    const execute = createUitToolExecutor({} as UitToolServices);
    await execute(name as string, args as Record<string, unknown>, { api, baseUrl: "https://courses.example", userId: 7 });
    expect(api.call).toHaveBeenCalledExactlyOnceWith(method, params);
  });

  it("keeps MCP sends single-shot on failure and validates message size", async () => {
    const api = { call: vi.fn().mockRejectedValue(new Error("Connection lost")) } as unknown as ApiClient;
    const execute = createUitToolExecutor({} as UitToolServices);
    const context = { api, baseUrl: "https://courses.example", userId: 7 };
    await expect(execute("uit_send_message", { id: 3, text: "é".repeat(2049) }, context)).rejects.toThrow("4096");
    expect(api.call).not.toHaveBeenCalled();
    await expect(execute("uit_send_message", { id: 3, text: "Hello" }, context)).rejects.toThrow("Connection lost");
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it("returns separate unread counts through MCP", async () => {
    const api = { call: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(3) } as unknown as ApiClient;
    const execute = createUitToolExecutor({} as UitToolServices);
    await expect(execute("uit_notification_counts", {}, { api, baseUrl: "https://courses.example", userId: 7 })).resolves.toEqual([2, 3]);
  });

  it("does not expose Studio approval policy in the submission tool description", () => {
    const submission = UIT_MCP_TOOLS.find((tool) => tool.name === "uit_submit_assignment");
    expect(submission?.description).not.toMatch(/approval|confirmation|never call/i);
  });

  it("describes the exact submission target in the Studio-owned confirmation request", () => {
    const request = assignmentSubmissionElicitation({ courseId: 11782, assignmentId: 50664, filePath: "/course/assignment.txt" });
    expect(request.mode).toBe("form");
    expect(request.message).toContain("50664");
    expect(request.message).toContain("/course/assignment.txt");
    expect(request._meta).toMatchObject({ uit_confirmation: "assignment_submission", tool_name: "uit_submit_assignment" });
    expect(acceptsAssignmentSubmissionElicitation({ action: "accept", content: { confirmed: true } })).toBe(true);
    expect(acceptsAssignmentSubmissionElicitation({ action: "accept", content: { confirmed: false } })).toBe(false);
    expect(acceptsAssignmentSubmissionElicitation({ action: "decline" })).toBe(false);
  });

  it("blocks the submission executor until the Studio response is accepted", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const executeTool = vi.fn().mockResolvedValue({ status: "submitted" });
    const messages: Array<Record<string, any>> = [];
    let buffered = "";
    let wake: (() => void) | undefined;
    output.on("data", (chunk) => {
      buffered += String(chunk);
      while (buffered.includes("\n")) {
        const end = buffered.indexOf("\n");
        messages.push(JSON.parse(buffered.slice(0, end)));
        buffered = buffered.slice(end + 1);
        wake?.();
        wake = undefined;
      }
    });
    const nextMessage = async (): Promise<Record<string, any>> => {
      while (messages.length === 0) await new Promise<void>((resolveNext) => { wake = resolveNext; });
      return messages.shift()!;
    };

    runMcpServer({ input, output, executeTool });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await expect(nextMessage()).resolves.toMatchObject({ id: 1, result: { serverInfo: { name: "uit-mcp" } } });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "uit_submit_assignment", arguments: { courseId: 11782, assignmentId: 50664, filePath: "/course/test.txt" } } })}\n`);
    const elicitation = await nextMessage();
    expect(elicitation).toMatchObject({ method: "elicitation/create", params: { _meta: { uit_confirmation: "assignment_submission" } } });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: elicitation.id, result: { action: "decline" } })}\n`);
    await expect(nextMessage()).resolves.toMatchObject({
      id: 2,
      result: {
        isError: true,
        content: [{
          text: JSON.stringify({
            confirmationStatus: "rejected",
            submissionStatus: "not_submitted",
            message: "Assignment submission was declined by the user; no file was uploaded or submitted."
          }, null, 2)
        }]
      }
    });
    expect(executeTool).not.toHaveBeenCalled();
    input.end();
  });

  it("passes an assignment submission to the executor only after acceptance", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const executeTool = vi.fn().mockResolvedValue({ status: "submitted" });
    const messages: Array<Record<string, any>> = [];
    let buffered = "";
    let wake: (() => void) | undefined;
    output.on("data", (chunk) => {
      buffered += String(chunk);
      while (buffered.includes("\n")) {
        const end = buffered.indexOf("\n");
        messages.push(JSON.parse(buffered.slice(0, end)));
        buffered = buffered.slice(end + 1);
        wake?.();
        wake = undefined;
      }
    });
    const nextMessage = async (): Promise<Record<string, any>> => {
      while (messages.length === 0) await new Promise<void>((resolveNext) => { wake = resolveNext; });
      return messages.shift()!;
    };

    runMcpServer({ input, output, executeTool });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await nextMessage();
    const args = { courseId: 11782, assignmentId: 50664, filePath: "/course/test.txt" };
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "uit_submit_assignment", arguments: args } })}\n`);
    const elicitation = await nextMessage();
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: elicitation.id, result: { action: "accept", content: { confirmed: true } } })}\n`);
    await expect(nextMessage()).resolves.toMatchObject({
      id: 2,
      result: {
        content: [{ text: JSON.stringify({ status: "submitted", confirmationStatus: "approved", confirmationSource: "UIT Studio" }, null, 2) }]
      }
    });
    expect(executeTool).toHaveBeenCalledWith("uit_submit_assignment", args);
    input.end();
  });

  it("resolves downloads by module ID and filename instead of a model-supplied URL", () => {
    const download = UIT_MCP_TOOLS.find((tool) => tool.name === "uit_download_material");
    expect(download?.inputSchema.required).toEqual(["courseId", "moduleId", "filename"]);
    expect(download?.inputSchema.properties).not.toHaveProperty("fileUrl");

    const read = UIT_MCP_TOOLS.find((tool) => tool.name === "uit_read_resource");
    const variants = read?.inputSchema.oneOf as Array<{ properties: Record<string, unknown>; required: string[] }>;
    expect(variants).toHaveLength(4);
    expect(variants.every((variant) => !("fileUrl" in variant.properties) && !("moduleId" in variant.properties))).toBe(true);
    expect(variants.map((variant) => variant.required)).toEqual([
      ["courseId", "kind", "id"],
      ["courseId", "kind", "id", "filename"],
      ["courseId", "kind", "id"],
      ["courseId", "kind", "id"]
    ]);
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

  it("confines assignment submissions to the active workspace and verifies the course", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-submit-tool-"));
    const filePath = join(directory, "report.pdf");
    writeFileSync(filePath, "report");
    const submitAssignment = vi.fn().mockResolvedValue({ status: "submitted", assignId: 7, file: "report.pdf" });
    const execute = createUitToolExecutor({
      listCourses: vi.fn(),
      getCourseContents: vi.fn(),
      listAssignments: vi.fn(),
      listAnnouncements: vi.fn(),
      listCourseParticipants: vi.fn(),
      getCourseGrades: vi.fn(),
      resolveCourseResource: vi.fn(),
      materializeCourseFile: vi.fn(),
      submitAssignment
    } as unknown as UitToolServices);
    const api = {} as ApiClient;

    try {
      await expect(execute("uit_submit_assignment", { courseId: 42, assignmentId: 7, filePath }, {
        api, baseUrl: "https://courses.uit.edu.vn", userId: 7, workspacePath: directory
      })).resolves.toEqual({ status: "submitted", assignId: 7, file: "report.pdf" });
      expect(submitAssignment).toHaveBeenCalledWith(42, 7, realpathSync(filePath), api);
      await expect(execute("uit_submit_assignment", { courseId: 42, assignmentId: 7, filePath: "/tmp/report.pdf" }, {
        api, baseUrl: "https://courses.uit.edu.vn", userId: 7, workspacePath: directory
      })).rejects.toThrow("inside managed UIT course storage");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    await expect(execute("uit_read_resource", { courseId: 42, kind: "module", id: 10, moduleId: 20 }, { api, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).rejects.toThrow("moduleId is not accepted");
    await expect(execute("uit_read_resource", { courseId: 42, kind: "module", id: 10, filename: "lecture.pdf" }, { api, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).rejects.toThrow("filename is accepted only for file resources");
  });

  it.each(["uit_list_course_contents", "uit_download_resource", "uit_list_participants", "uit_get_grades"])("rejects removed tool alias %s", async (name) => {
    const execute = createUitToolExecutor({
      listCourses: vi.fn(),
      getCourseContents: vi.fn(),
      listAssignments: vi.fn(),
      listAnnouncements: vi.fn(),
      listCourseParticipants: vi.fn(),
      getCourseGrades: vi.fn(),
      resolveCourseResource: vi.fn(),
      materializeCourseFile: vi.fn()
    } as unknown as UitToolServices);

    await expect(execute(name, {}, { api: {} as ApiClient, baseUrl: "https://courses.uit.edu.vn", userId: 7 })).rejects.toThrow(`Unknown UIT tool: ${name}`);
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
      "/Users/Student/.local/bin/uit-studio",
      ["mcp"],
      { UIT_TEST_MODE: "1" }
    );

    expect(updated).toContain('command = "/Users/Student/.local/bin/uit-studio"');
    expect(updated).toContain('args = ["mcp"]');
    expect(updated).toContain('env = { UIT_TEST_MODE = "1" }');
    expect(updated).toContain("enabled = true");
    expect(updated).toContain('[mcp_servers.other]\ncommand = "other"');
  });

  it("adds a new MCP section without a leading blank line", () => {
    expect(upsertMcpConfig("", "uit", ["mcp"])).toBe(
      '[mcp_servers.uit]\ncommand = "uit"\nargs = ["mcp"]\n'
    );
  });

  it("registers the real Node executable and CLI entrypoint directly", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-direct-mcp-test-"));
    const executable = join(directory, "uit");
    const home = vi.spyOn(os, "homedir").mockReturnValue(directory);
    const previousCodexHome = process.env.CODEX_HOME;
    const previousExecutable = process.env.UIT_CLI_EXECUTABLE;
    try {
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
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
      home.mockRestore();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousExecutable === undefined) delete process.env.UIT_CLI_EXECUTABLE;
      else process.env.UIT_CLI_EXECUTABLE = previousExecutable;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes only the legacy managed MCP wrapper", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-legacy-mcp-test-"));
    const home = vi.spyOn(os, "homedir").mockReturnValue(directory);
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      const wrapperDirectory = join(directory, ".local", "bin");
      const wrapper = join(wrapperDirectory, "uit-mcp");
      mkdirSync(wrapperDirectory, { recursive: true });
      writeFileSync(wrapper, "#!/usr/bin/env bash\n# Managed by uit-cli\nexec node old-cli.js\n");
      delete process.env.CODEX_HOME;

      installMcpServer();

      expect(existsSync(wrapper)).toBe(false);
    } finally {
      home.mockRestore();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates a commented MCP section header without creating a duplicate table", () => {
    const updated = upsertMcpConfig(
      '[mcp_servers.uit] # configured manually\ncommand = "old"\nargs = ["mcp"]\n\n[mcp_servers.other] # keep\ncommand = "other"\n',
      "/Users/Student/.local/bin/uit-studio",
      ["mcp"]
    );
    expect(updated.match(/\[mcp_servers\.uit\]/g)).toHaveLength(1);
    expect(updated).toContain('command = "/Users/Student/.local/bin/uit-studio"');
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
      if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o640);
      expect(readdirSync(directory)).toEqual(["config.toml"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
