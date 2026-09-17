import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireOpenableWorkspacePath, requiresExplicitUitMcpApproval } from "../src/studio-core.js";

function approval(toolName: string) {
  return {
    id: "request-1",
    method: "mcpServer/elicitation/request",
    params: {
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: toolName
      },
      requestedSchema: { type: "object", properties: {} }
    }
  } as Parameters<typeof requiresExplicitUitMcpApproval>[0];
}

describe("Studio MCP approval policy", () => {
  it("requires a fresh approval for assignment submission", () => {
    expect(requiresExplicitUitMcpApproval(approval("uit_submit_assignment"))).toBe(true);
    expect(requiresExplicitUitMcpApproval(approval("uit.uit_submit_assignment"))).toBe(true);
  });

  it("recognizes the Studio-owned assignment elicitation", () => {
    const request = approval("uit_submit_assignment");
    request.params._meta = { uit_confirmation: "assignment_submission", tool_name: "uit_submit_assignment" };
    request.params.requestedSchema = { type: "object", properties: { confirmed: { type: "boolean" } } };
    expect(requiresExplicitUitMcpApproval(request)).toBe(true);
  });

  it("recognizes Codex forms that omit the custom MCP metadata", () => {
    const request = {
      id: "request-2",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        serverName: "uit",
        message: "Confirm submitting /course/assignment.txt to assignment 50664 in course 11782. This changes upstream course data.",
        requestedSchema: { type: "object", properties: { confirmed: { type: "boolean" } } }
      }
    } as Parameters<typeof requiresExplicitUitMcpApproval>[0];
    expect(requiresExplicitUitMcpApproval(request)).toBe(true);
  });

  it("does not mark read-only UIT tools as mandatory confirmation", () => {
    expect(requiresExplicitUitMcpApproval(approval("uit_course_contents"))).toBe(false);
  });
});

describe("Studio workspace attachments", () => {
  it("opens a non-material text file from the managed workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "uit-studio-open-")));
    const path = join(root, "SS010.O23", "assignment-submission.txt");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "submission");
      await expect(requireOpenableWorkspacePath(path, { root })).resolves.toBe(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open executable workspace files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "uit-studio-open-")));
    const path = join(root, "SS010.O23", "run.txt");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "#!/bin/sh\n");
      await chmod(path, 0o700);
      await expect(requireOpenableWorkspacePath(path, { root })).rejects.toThrow("non-executable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
