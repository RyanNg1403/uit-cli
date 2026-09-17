import { describe, expect, it } from "vitest";
import { requiresExplicitUitMcpApproval } from "../src/studio-core.js";

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

  it("does not mark read-only UIT tools as mandatory confirmation", () => {
    expect(requiresExplicitUitMcpApproval(approval("uit_course_contents"))).toBe(false);
  });
});
