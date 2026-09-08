# Architectural Analysis: UIT CLI vs. UIT MCP

This document evaluates the coexistence, trade-offs, and relationship between the **UIT CLI** and the **UIT MCP Server**.

---

## 1. Direct Answers to Core Questions

| Question | Answer | Explanation |
| :--- | :---: | :--- |
| **Can both operate without AI Studio running?** | **Yes** | • **CLI**: Operates as a standalone binary in terminal using credentials in `~/.uit/.env`.<br>• **MCP Server**: Runs as a headless stdio background process spawned directly by Codex / Claude / ChatGPT (`node dist/cli.js mcp`). It reads `~/.uit/sso-session.json` or `~/.uit/.env` from disk without requiring any UI window or Electron process to be active. |
| **Can the agent use the CLI in any folder?** | **Yes** | `uit` is a global binary and works in any directory containing or inheriting `~/.uit/.env`. By design, MCP tools are workspace-gated to `~/UIT` via `isInsideUitWorkspace(process.cwd())` to avoid polluting the agent's context when working on unrelated non-UIT projects. |
| **Does only MCP have access to SSO-based courses?** | **Currently, Yes** | `src/config.ts` (CLI) currently only checks `UIT_TOKEN` in `.env`. Meanwhile, `src/mcp-server.ts` checks `~/.uit/sso-session.json` first, allowing it to authenticate via Moodle SSO session cookies and keys. |
| **Is the CLI overwhelming for agents compared to MCP?** | **Yes** | The CLI exposes **17 fine-grained commands** requiring argument formatting, terminal paging, and multi-turn bash calls. The MCP server provides **5 focused, pre-bundled tools** that return structured JSON directly into agent memory. |

---

## 2. Why Both Are Justified: Separate Audiences

The CLI and MCP server are not redundant; they are optimized for fundamentally different consumers:

```
                  ┌────────────────────────┐
                  │      Target Users      │
                  └───────────┬────────────┘
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   👤 Human Developer / Student        🤖 AI Coding Agent
   (Interactive terminal & scripts)    (Codex, Claude, Cursor)
             │                                 │
             ▼                                 ▼
       UIT CLI                              UIT MCP
   • 17 granular commands              • 5 bundled JSON tools
   • Browser launch (uit open)         • Native JSON-RPC stdio
   • Submission & file uploads         • Workspace-gated (~/UIT)
   • Raw Moodle API inspection         • Token-efficient responses
```

### Why MCP is Best for AI Agents
1. **Native Function Calling (No Shell Overhead)**:
   Calling tools via JSON-RPC eliminates subshell spawning, stdout parsing, ANSI escape codes, shell escaping issues, and bash error codes.
2. **Bundled Turns (Token & Time Efficiency)**:
   `uit_course_contents` returns sections, modules, assignments, and announcements in a **single turn**. Doing the same via CLI requires 3–4 sequential shell turns (`uit contents`, `uit deadlines`, `uit announcements`), multiplying LLM latency and context usage.
3. **Safety & Workspace Gating**:
   MCP exposes read-only tools and downloads into isolated course project folders. It prevents accidental forum posts or file submissions from hallucinated bash commands.

### Why the CLI is Essential for Humans
1. **Quick Terminal Access**:
   Running `uit courses --current` or `uit download 19589 --all` in a terminal is vastly faster for a developer than asking an LLM.
2. **Interactive & Mutation Actions**:
   Commands like `uit open <id>` (opens specific course module in the default browser) and `uit submit <assign_id> <file>` are human-first workflows.
3. **Debugging & Extensibility**:
   `uit functions` and `uit raw <function>` allow developers to inspect and query all 420+ Moodle API endpoints without modifying server code.

---

## 3. Current Architecture & Shared Codebase

The CLI and MCP server are already merged into a single package and repository:
* **Entrypoint**: `bin.uit` points to `dist/cli.js`.
* **MCP Command**: Running `uit mcp` boots the MCP server.
* **Codex Setup**: Running `uit mcp install` registers the MCP server in `~/.codex/config.toml`.

```
src/
├── api.ts                   <-- Shared HTTP/REST/Moodle client
├── cli.ts                   <-- Commander CLI definition & 'uit mcp' command
├── mcp-server.ts            <-- MCP JSON-RPC protocol implementation
├── moodle-session-client.ts <-- Moodle AJAX & session scraper
└── desktop-service.ts       <-- Shared data resolvers (courses, grades, files)
```

---

## 4. Next Step Recommendation: Unified Authentication

To eliminate the only remaining asymmetry between the two interfaces, **the CLI should be updated to support SSO session fallback**:

1. When `uit` executes a command, if `~/.uit/.env` is absent, check `~/.uit/sso-session.json`.
2. If an active SSO session exists, allow CLI commands to run using `NodeSessionApiClient`.
3. **Result**: A student who logs in via UIT Studio via SSO will have both UIT Studio, UIT MCP, and the UIT CLI working seamlessly without ever needing to manually obtain a Moodle web service token.
