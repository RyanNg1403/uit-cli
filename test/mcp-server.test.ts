import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeMcpTool,
  isInsideUitWorkspace,
  upsertMcpConfig,
  UIT_MCP_TOOLS
} from "../src/mcp-server.js";

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

  it("exposes the expected 5 UIT tools in UIT_MCP_TOOLS", () => {
    const toolNames = UIT_MCP_TOOLS.map((t) => t.name);
    expect(toolNames).toContain("uit_courses");
    expect(toolNames).toContain("uit_course_contents");
    expect(toolNames).toContain("uit_course_members");
    expect(toolNames).toContain("uit_course_grades");
    expect(toolNames).toContain("uit_download_material");
    expect(toolNames.length).toBe(5);
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
      ["--uit-mcp"]
    );

    expect(updated).toContain('command = "/Users/Student/Applications/UIT Studio.app/Contents/MacOS/UIT Studio"');
    expect(updated).toContain('args = ["--uit-mcp"]');
    expect(updated).toContain("enabled = true");
    expect(updated).toContain('[mcp_servers.other]\ncommand = "other"');
  });

  it("adds a new MCP section without a leading blank line", () => {
    expect(upsertMcpConfig("", "uit", ["mcp"])).toBe(
      '[mcp_servers.uit]\ncommand = "uit"\nargs = ["mcp"]\n'
    );
  });
});
