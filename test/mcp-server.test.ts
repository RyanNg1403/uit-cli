import { describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  ensureLocalBinWrapper,
  executeMcpTool,
  isInsideUitWorkspace,
  upsertMcpConfig,
  writeFileAtomically,
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


  it("creates a separately named wrapper without following an npm-owned uit symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-mcp-wrapper-"));
    try {
      const cli = join(directory, "cli.js");
      writeFileSync(cli, "export const intact = true;\n");
      symlinkSync(cli, join(directory, "uit"));

      const wrapper = ensureLocalBinWrapper(directory);

      expect(basename(wrapper)).toBe("uit-mcp");
      expect(lstatSync(join(directory, "uit")).isSymbolicLink()).toBe(true);
      expect(readFileSync(cli, "utf8")).toBe("export const intact = true;\n");
      expect(readFileSync(wrapper, "utf8")).toContain("# Managed by uit-cli");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
