# Architectural Analysis: UIT CLI vs. UIT MCP

This document evaluates the coexistence, trade-offs, and relationship between the **UIT CLI** and the **UIT MCP Server**.

---

## 1. Direct Answers to Core Questions

| Question | Answer | Explanation |
| :--- | :---: | :--- |
| **Can both operate without AI Studio running?** | **Yes** | The CLI and MCP server both run independently of UIT Studio. They share `~/.uit/sessions.json`; `UIT_TOKEN`/`UIT_BASE_URL`/`UIT_USER_ID` remain optional process-environment overrides for scripts and CI. No `.env` file is read. |
| **Can the agent use the CLI in any folder?** | **Yes** | `uit` is a global CLI and can run from any directory. MCP tools intentionally remain gated to managed course workspaces under `~/.uit/courses` via `isInsideUitWorkspace(process.cwd())`, preventing course tools from appearing in unrelated projects. |
| **Does only MCP have access to SSO-based courses?** | **No** | `uit login` stores the current-site SSO session in `~/.uit/sessions.json`, and the CLI, MCP server, and UIT Studio resolve that same session. Legacy Moodle accounts remain available through `uit login --legacy`. |
| **Is the CLI overwhelming for agents compared to MCP?** | **Yes** | The CLI exposes **17 fine-grained commands** requiring argument formatting, terminal paging, and multi-turn bash calls. The MCP server provides **6 focused, pre-bundled tools** that return structured JSON directly into agent memory. |
| **Does UIT Studio use the same MCP tools as direct Codex?** | **Yes** | Studio starts Codex with `~/.uit/courses` as its working root, so its configured UIT MCP server and standalone `uit mcp` use the same canonical registry and dispatcher in `src/uit-tools.ts`. |

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
   • 17 granular commands              • 6 bundled JSON tools
   • Browser launch (uit open)         • Native JSON-RPC stdio
   • Submission & file uploads         • Workspace-gated (~/.uit/courses)
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
├── uit-tools.ts              <-- Canonical MCP tool registry/dispatcher (Studio + standalone MCP)
├── moodle-session-client.ts <-- Moodle AJAX & session scraper
└── desktop-service.ts       <-- Shared data resolvers (courses, grades, files)
```

---

## 4. Current Authentication Model

The CLI and MCP server now use the same session model:

1. `uit login` opens UIT SSO and stores the authenticated session in `~/.uit/sessions.json`.
2. `uit login --legacy` handles the old Moodle portal and stores its token in the same file.
3. CLI commands, MCP tools, and UIT Studio can reuse the saved session without requiring the desktop app to be running.
