# UIT Studio implementation plan

> UI/UX implementation update: see [UI verification](UI_VERIFICATION.md) for the current implementation, passing automated checks, dependency/runtime changes, and remaining limitations. Historical status and phase checklists below predate this update and must not be treated as fresh verification. The newer user requirements supersede the earlier renderer-only scope and Materialize terminology: previews are memory-only and saving is an explicit Download action.

This is the living implementation plan and handoff document for the UIT Studio desktop application. It is intentionally written so another agent can continue the work without reconstructing decisions from chat history.

Last updated: 2026-09-05
Current branch: `codex/uit-app`
Current status: Electron foundation implemented; current-site SSO and authenticated course discovery are working in the first end-to-end student test. The desktop app now supports connecting the current SSO site and legacy token-backed portals concurrently, merges their course lists, and preserves each course's origin for follow-up operations.

2026-09-05 live follow-up: verified that current SSO returns thesis course 807 alongside legacy courses. Its missing semester dates caused the automatic newest-semester filter to hide it. Fixed the dashboard to default to All semesters when first loading or adding accounts, preserve explicit filters on refresh, and expose a Show all semesters action when courses are hidden. Live verification showed 40 merged courses and opened the thesis materials. Its native announcement reader still lacks the forum instance ID; do not mark that separate limitation resolved. Evidence and regression scope are recorded in `docs/UI_VERIFICATION.md`.

## 1. Product goal

UIT Studio is a local-first, bilingual (Vietnamese and English) desktop application for UIT students. It combines an improved student course portal with a native Codex-powered workspace.

The application has two explicit modes:

1. **Vanilla Course View**
   - UIT account login and session recovery.
   - Course dashboard.
   - Course sections and contents.
   - Material preview and download.
   - Assignments, deadlines, grades, and announcements.
   - Correct multi-file assignment submission.

2. **Agentic Mode**
   - Codex-like chat and task display.
   - One local workspace per course.
   - Multiple independent agent tasks per course.
   - Filesystem and shell work inside the local workspace.
   - Explicit, typed UIT course tools for remote operations.
   - Confirmation before any upstream mutation.
   - Thread branching, artifacts, and task status.

The initial audience is 100% students. Teacher, administrator, and Moodle-agnostic behavior are explicitly out of scope for the MVP.

## 2. Decisions already made

- Build a desktop application with Electron.
- Start macOS-first, while keeping the architecture portable to Windows and Linux.
- Keep the current UIT CLI as a usable sibling application and preserve its history.
- Use branch `codex/uit-app`.
- Keep UIT-specific behavior; do not introduce a Moodle provider abstraction yet.
- Support the three official UIT course-site profiles explicitly:
  - current site: `https://courses.uit.edu.vn` (2026–2027 onward, UIT SSO);
  - legacy undergraduate: `https://coursesold.uit.edu.vn` (Moodle local/token login);
  - legacy graduate: `https://coursesold.uit.edu.vn/sdh` (Moodle local/token login).
- Reuse the existing CLI authentication and Moodle API knowledge.
- Use browser-backed UIT SSO for the current site and allow explicit legacy Moodle token login for the old portals. Both modes may be connected at the same time, and merged courses must retain their originating base URL. Never persist a password; desktop legacy sign-in keeps the returned token in memory per portal, while an existing CLI `.env` token may be hydrated for compatibility. Browser-backed legacy sessions remain a future hardening option.
- Require an installed and authenticated Codex CLI for the MVP. Bundling Codex is a later distribution improvement.
- Use Codex app-server as the agent protocol. Prefer local stdio transport; do not depend on experimental network WebSockets.
- Codex thread synchronization is a nice-to-have. CLI resumption is useful; automatic visibility in the Codex desktop app and ChatGPT cloud mirroring must not block MVP delivery.
- Use a two-tree model:
  - Remote/course tree: typed, mostly read-only UIT resources and metadata.
  - Local workspace: real operating-system files where agents can run code and create artifacts.
- Fetch lightweight metadata automatically. Materialize binary resources only on preview or explicit agent request.
- Do not implement a virtual filesystem where a shell read silently causes a network download.
- Default workspace location: `~/UIT/<academic-year>/<course-shortname>-<course-id>/`.
- External writes (submission, replies, posts, etc.) always require explicit confirmation.

## 3. Current repository state

The repository began as a TypeScript CLI for `courses.uit.edu.vn`:

- `src/api.ts`: REST, upload, and download primitives.
- `src/commands.ts`: existing CLI workflows for courses, contents, assignments, deadlines, grades, announcements, and submissions.
- `src/config.ts`: current `.env` token configuration.
- `src/types.ts`: shared API types.
- `test/`: the original CLI suite; the desktop branch now has 38 passing tests across five test files.

The desktop foundation currently consists of:

- `desktop/main.cjs`: Electron main process and IPC handlers.
- `desktop/preload.cjs`: isolated, allow-listed renderer API.
- `desktop/renderer/index.html`: two-mode UI shell, sign-in modal, course and agent views.
- `desktop/renderer/styles.css`: initial visual system.
- `desktop/renderer/renderer.js`: renderer state, navigation, course loading, materialization, and workspace actions.
- `src/desktop-service.ts`: desktop-facing UIT service layer.
- `src/moodle-session-client.ts`: session-backed Moodle AJAX client for SSO-authenticated current-site reads and same-origin materialization.
- `test/desktop-service.test.ts`: session and Codex detection tests.
- `test/moodle-session-client.test.ts`: AJAX argument, response, and origin-safety tests.

The current package scripts are:

```text
npm run build          TypeScript compilation
npm run typecheck      TypeScript validation without emit
npm test               Vitest suite
npm run desktop:check  Build plus JS syntax checks
npm run desktop        Build and launch Electron
```

Verification completed on this branch so far:

- `npm test`: 38 tests pass.
- `npm run typecheck`: passes.
- `npm run desktop:check`: passes.
- `npm run desktop`: launches the Electron process successfully; SSO, legacy course discovery, merged course labeling, and course-page fallback were exercised against authenticated UIT sites.

## 4. Target architecture

```text
Electron renderer (React or current DOM shell)
        │ isolated preload IPC
        ▼
Desktop application service
        ├── UIT auth/session service
        ├── UIT course client (typed Moodle calls)
        ├── metadata/cache database
        ├── materialization/content cache
        ├── course workspace manager
        ├── Codex app-server client
        └── local UIT MCP/course-tools server
                │
                ├── courses.uit.edu.vn
                ├── CODEX_HOME / Codex app-server
                └── local filesystem workspaces
```

The renderer must never receive a UIT token, session cookie, `sesskey`, filesystem credentials, or arbitrary Node.js access. The main process/service owns those capabilities and exposes narrow, typed IPC operations.

### Recommended package evolution

The first implementation can stay in the existing package while behavior stabilizes. Then extract toward this structure without breaking the CLI:

```text
apps/
  desktop/
  cli/
packages/
  uit-core/
  uit-agent-tools/
  codex-client/
  workspace/
  shared/
```

Do not perform a large monorepo migration until the domain contracts and desktop tests are stable. Mechanical extraction should preserve CLI behavior with its existing test suite.

## 5. Core domain contracts

These concepts should be represented as typed objects rather than passing arbitrary Moodle records through the UI:

- `StudentSession`: authentication mode, base URL, user ID, display name, expiry/reauth state; current-site credentials remain browser-session-only.
- `CourseSummary`: course ID, short name, full name, summary, dates, progress.
- `CourseSection`: section ID, title, sequence/order.
- `CourseModule`: module ID, course ID, type, title, description, URL, section, files.
- `CourseFile`: filename, remote URL, size, MIME type, content hash if cached.
- `Assignment`: assignment ID, course ID, module ID, due date, cutoff date, grading state, attempt state, submission state.
- `Announcement`: forum/discussion identifiers, title, author, timestamp, content, attachments.
- `Grade`: course/module context, grade, maximum grade, feedback, grading timestamp.
- `Workspace`: course ID, local path, created-at, schema version.
- `AgentTask`: local task ID, Codex thread ID, course ID, context binding, status, timestamps.
- `CourseContextBinding`: source type and source ID plus an immutable snapshot of the initiating item.
- `Materialization`: remote file identity, local path, cache state, checksum, last access.

Remote Moodle payloads should be normalized at the service boundary. UI components and agent tools should not depend on Moodle’s inconsistent field naming.

## 6. UIT integration plan

### Authentication

The app presents an explicit UIT site selector so the authentication method matches the site rather than assuming every site supports the same endpoint.

Current site (`courses.uit.edu.vn`):

1. Open a visible, isolated Electron authentication window at the Moodle login page.
2. Let the student choose UIT SSO and complete Keycloak authentication in that window. The app never reads or stores the password.
3. Detect the post-login Moodle page and obtain the page `M.cfg.sesskey` and `M.cfg.userId` from the authenticated page context.
4. Keep the session in a persistent Electron session partition and route typed Moodle AJAX calls through that browser context.
5. Send same-origin materialization requests with the session cookie held only in the main process.
6. Do not expose a password/token login option for this site; reject attempts to use the legacy token endpoint.

The session client sends the documented JSON request batch to Moodle's AJAX endpoint. The request body must be an explicit JSON string. Because several legacy mobile web-service names are not AJAX-whitelisted on modern Moodle, it tries the complete (`all`) enrollment timeline plus other timeline buckets and then falls back to authenticated course-page parsing for read-only data.

Legacy sites (`coursesold.uit.edu.vn` and `/sdh`):

1. Request a Moodle mobile token using the existing `login/token.php` flow and validate it with `core_webservice_get_site_info`.
2. Keep a separate in-memory token API client per selected legacy base URL so undergraduate and graduate sessions can coexist with each other and with current-site SSO. Desktop sign-in does not overwrite the CLI `.env` file.
3. The existing CLI `.env` token may be loaded once at startup as an explicit compatibility session. It remains a bearer-secret risk and is not the cookie-only contract used by current-site SSO.
4. **Future hardening option:** open the selected legacy Moodle login page in an isolated Electron session and use the resulting Moodle session cookie plus in-memory `sesskey`, removing the need for a legacy API token.

For either mode, an expired/invalid session pauses the operation and surfaces a reauthentication action. The renderer never receives a token, session cookie, or arbitrary browser capability. Current-site logout clears the persistent browser partition; per-site legacy logout removes only that in-memory legacy session. “Sign out all sites” clears every active session in the running app. The cookie-only guarantee applies to the current SSO site; legacy token sessions are an explicit compatibility tradeoff.

### Read operations

Implement typed service methods for:

- `listCourses`
- `getCourseContents`
- `getAssignments`
- `getDeadlines`
- `getGrades`
- `getAnnouncements`
- `getDiscussion`
- `getModuleDetails`
- `getResourceMetadata`
- `materializeResource`

Metadata calls should be cacheable and refreshable. Every response should preserve enough source identifiers to support later actions.

### Write operations

Implement and test as explicit commands with confirmation payloads:

- `prepareSubmission`
- `uploadSubmissionFile`
- `saveSubmissionDraft`
- `submitForGrading`
- `replyToDiscussion` (if included in MVP)

Assignment submission must support multiple files, draft versus final state, required statements, attempt numbers, group settings, and stale/conflict detection. The existing CLI implementation uploads a file and saves a submission but does not yet fully finalize grading submission; do not copy that behavior unchanged.

## 7. Lazy materialization and filesystem semantics

The agent receives explicit course tools, not a remote mount:

```text
uit_list_course_contents
uit_read_assignment
uit_read_announcement
uit_materialize_resource
uit_list_submission_files
uit_prepare_submission
uit_submit_assignment
```

Rules:

- Listing and reading structured metadata may use the metadata cache.
- Reading a binary file requires explicit materialization.
- Materialized files are placed in a managed course location and returned as a real local path.
- Repeated requests should reuse a verified cached file.
- A failed download must not leave a misleading complete file; use a temporary file and atomic rename.
- Shell/filesystem operations are restricted to the course workspace and explicitly materialized local files.
- Materialization is not the same as “installation”; use that terminology in UI and tools.

Suggested local layout:

```text
<course-workspace>/
  .uit/
    context/
    manifest.json
  materials/
  submissions/
  artifacts/
```

## 8. Codex integration plan

Use the installed `codex` executable and start `codex app-server` from the Electron main/service process. The app-server is the integration boundary for rich clients: initialization, threads, turns, streamed events, approvals, resumption, and forks.

MVP sequence:

1. Detect `codex --version` and show a clear setup message if unavailable.
2. Add a typed JSONL client for `initialize`, `thread/start`, `turn/start`, event notifications, `thread/resume`, and `thread/fork`.
3. Start each task with the course workspace as its working directory.
4. Register UIT course tools through a local MCP server or another stable app-server tool mechanism.
5. Map `tool/requestUserInput` and approval requests to visible UI controls.
6. Persist our course-to-thread mapping separately from Codex’s own thread history.
7. Add a CLI “resume in Codex” affordance once thread IDs are stable.

Do not make the MVP depend on ChatGPT cloud conversation mirroring or automatic sidebar synchronization in the Codex desktop app. If same-machine thread discovery works in testing, document it as supported convenience behavior, not a core data contract.

## 9. Electron security and reliability requirements

- `contextIsolation: true`.
- `nodeIntegration: false`.
- `sandbox: true` for all remote-auth renderers.
- Keep the preload bridge allow-listed and typed.
- Validate all IPC inputs in the main process.
- Validate IPC senders and reject non-local renderer frames.
- Never expose tokens, cookies, or `sesskey` to renderer JavaScript.
- Preserve the cookie-only authentication contract for all new work; never add new token/password plumbing to the renderer.
- Restrict SSO top-level navigation to the official UIT course and SSO hosts; deny popups and permission requests.
- Clear the persistent SSO session partition on logout.
- Add a restrictive Content Security Policy to the local renderer.
- Restrict “open path” actions to the managed UIT workspace root.
- Treat all course titles, descriptions, announcements, and filenames as untrusted text.
- Use safe path joining and basename sanitization for downloaded files.
- Use atomic downloads and clear partial-cache state.
- Add structured error classes for authentication, network, permission, stale submission, and upstream validation errors.
- Make all external mutation UI flows visibly distinguish preview/draft/final actions.

## 10. UI implementation sequence

### Phase 0 — foundation (current)

- Electron shell and preload bridge.
- Two-mode navigation.
- UIT sign-in modal.
- Explicit current/legacy UIT site selection with SSO login and legacy token login available concurrently; merged courses retain an origin label and base URL.
- Course dashboard and course contents.
- Workspace creation.
- Lazy materialize action.
- Codex availability indicator.

### Phase 1 — stabilize the data layer

- Normalize typed domain models.
- Add request cancellation and retry behavior.
- Add metadata cache/database.
- Add secure token storage.
- Add loading, empty, expired-session, and offline states.

Acceptance criteria: a student can sign in, reload the app, see courses and contents, and recover from a transient network failure without restarting the application.

### Phase 2 — complete Vanilla Course View

- Assignment list and detail pages.
- Deadline calendar/list.
- Grades and feedback.
- Announcements and discussion detail.
- Material preview for common document types.
- Download/materialization history.

Acceptance criteria: the student can complete the common read-only workflows they use on the UIT site without opening a browser.

### Phase 3 — correct submission workflow

- Submission file picker.
- Multiple-file upload.
- Draft state and attempt display.
- Required statement handling.
- Final “submit for grading” confirmation.
- Conflict/stale-state protection.
- Submission receipt and retry state.

Acceptance criteria: a test assignment can be prepared, reviewed, submitted, and verified through the same upstream state transitions expected by Moodle.

### Phase 4 — Codex Agentic Mode

- App-server JSONL client.
- Thread/task list.
- Streaming assistant/tool events.
- Approval and user-input cards.
- Workspace terminal/artifact views.
- Course item context launch.
- Thread resume and fork.

Acceptance criteria: an agent can inspect a course assignment, materialize only the required files, create an artifact locally, and ask for confirmation before a submission.

### Phase 5 — course tools and interoperability

- Local UIT MCP server.
- Explicit read and mutation tool schemas.
- CLI resume/export affordance.
- Optional same-machine Codex app discovery experiment.

Acceptance criteria: a Codex CLI task can resume a thread created by UIT Studio and use the documented local course tools when configured.

### Phase 6 — packaging and release quality

- macOS packaging and signing strategy.
- Windows/Linux build validation.
- Automatic update decision.
- Crash/error reporting that is opt-in and local-first.
- First-run setup wizard.
- Vietnamese/English language completeness audit.

## 11. Testing strategy

### Unit tests

- API parameter construction and error normalization.
- Moodle payload normalization.
- Safe path handling and filename sanitization.
- Cache/materialization state transitions.
- Workspace naming and academic-year layout.
- Submission state machine.
- Codex JSONL request/notification correlation.
- i18n key completeness.

### Contract tests

Use recorded/sanitized Moodle fixtures for:

- course lists;
- nested course contents;
- assignments with multiple files;
- announcements with attachments;
- grades and feedback;
- expired tokens and Moodle exception payloads.

Do not commit real UIT credentials, tokens, or private course content.

### Integration tests

- Main process ↔ preload IPC.
- Service ↔ mocked `ApiClient`.
- Service ↔ fake Codex app-server process.
- Atomic materialization and retry behavior.
- Workspace creation idempotency.

### Electron smoke tests

Run the real Electron process in a clean temporary profile and verify:

1. The window loads the renderer.
2. The unauthenticated state shows the sign-in action.
3. Login errors are rendered without crashing.
4. Mocked courses render cards and sidebar entries.
5. Opening a course renders grouped modules.
6. Materialization updates the action state and opens only an allowed path.
7. Agentic Mode is reachable and shows the selected context.
8. Closing the window exits cleanly.

The smoke suite should use a local fake UIT service or intercepted requests, never a student account in CI.

### Required checks before handoff

```text
npm run typecheck
npm test
npm run desktop:check
npm run desktop
```

For every changed Python file (if Python is introduced later), run the repository-required Ruff check and format workflow before handoff.

## 12. Progress ledger

Legend: `[x]` complete, `[~]` partial/in progress, `[ ]` not started.

### Repository and decisions

- [x] Study current UIT CLI implementation.
- [x] Study t3code, deepseek-harness, Codex app-server, and Moodle App references.
- [x] Choose Electron and a local-first architecture.
- [x] Define two-tree course/workspace model.
- [x] Define selective materialization policy.
- [x] Defer broad Codex synchronization from MVP critical path.
- [x] Create branch `codex/uit-app`.

### Desktop foundation

- [x] Add Electron dependency.
- [x] Add Electron main process.
- [x] Add isolated preload bridge.
- [x] Add initial Vanilla Course View.
- [x] Add initial Agentic Mode surface with course-scoped chat composer.
- [x] Add Codex app-server JSONL client with thread start, resume, fork, and streamed notifications.
- [x] Wire streamed Codex deltas, turn completion, and thread branching into the renderer.
- [x] Add legacy-only token login compatibility using the existing UIT token endpoint (transitional; not current-site auth).
- [x] Confirm current-site SSO requirement from UIT notice and login page behavior.
- [x] Add a session-backed Moodle AJAX client with same-origin download protection.
- [x] Wire Electron SSO authentication window and persistent browser session.
- [x] Update renderer sign-in modal with current/legacy site selector and SSO action.
- [x] Add course list and contents service methods.
- [x] Add typed assignment and announcement service methods plus course insight cards.
- [x] Add lazy materialization service method.
- [x] Add course workspace creation.
- [x] Add Codex CLI detection.
- [x] Add renderer path and bridge guards.
- [x] Enforce same-origin materialization URLs before passing them to a download client.
- [x] Enforce SSO-only login for the current course site.
- [x] Support concurrent current-site SSO and per-portal legacy token sessions without overwriting the CLI configuration.
- [x] Merge course lists from connected sites and preserve each course's originating base URL/auth mode.
- [x] Clear the persistent SSO session partition on logout.
- [x] Validate IPC senders and restrict remote-auth navigation/popups.
- [x] Add a local-renderer Content Security Policy.
- [~] Replace existing CLI `.env` persistence with OS keychain (desktop sign-in is already in-memory per legacy portal).
- [ ] Optionally replace legacy token login with browser-backed legacy Moodle session login.
- [~] Perform automated Electron UI smoke testing (startup, styling, Agentic Mode, SSO-only current-site modal, logout/session clearing, and sign-in states exercised interactively; dedicated harness remains).

### Verification

- [x] TypeScript build passes.
- [x] Typecheck passes.
- [x] Existing CLI tests pass.
- [x] Desktop service tests pass.
- [x] Desktop JavaScript syntax checks pass.
- [x] Test against an authenticated UIT account (current-site SSO and course discovery exercised with user ID 13687).
- [x] Smoke-test the Electron sign-in modal, site selector, and embedded current-site SSO window.
- [x] Smoke-test current-site SSO-only controls and sign-out clearing the persistent Electron session partition.
- [x] Verify same-origin material URL validation is present in the main-process IPC path.
- [x] Verify current-site SSO login and course dashboard with a student account; corrected the JSON AJAX body after live Moodle diagnostics.
- [~] Verify legacy undergraduate and graduate login with a student account (legacy undergraduate course discovery exercised; graduate and fresh dual-login coverage remain).
- [ ] Test complete assignment submission against a safe test assignment.
- [~] Test Codex app-server streaming and approvals (fake-server streaming covered; live approvals remain).
- [ ] Test packaged macOS build.

## 13. Frontend/UI agent brief

The next agent may focus on visual polish and interaction quality without adding product capabilities. Treat the existing preload IPC surface and service contracts as stable for this UI pass.

### In scope

- `desktop/renderer/index.html`: semantic structure, labels, empty/loading/error states, and accessible interaction affordances.
- `desktop/renderer/styles.css` and `desktop/renderer/insights.css`: layout, typography, responsive behavior, focus/hover/disabled states, and bilingual presentation.
- `desktop/renderer/renderer.js`: renderer-only state presentation, copy, formatting, view transitions, and non-functional interaction polish.
- Keep the two major modes visually distinct: Vanilla Course View and Agentic Mode.
- Preserve explicit current/legacy site selection and make the current-site SSO-only behavior obvious in the login modal.
- Preserve lazy materialization language (“Materialize”/“Saved”), course context, workspace status, agent status, and upstream-action confirmation cues.

### Out of scope for this UI pass

- Do not add or change UIT endpoints, Moodle payload handling, authentication semantics, token storage, session-cookie handling, `sesskey` handling, Codex protocol behavior, submission behavior, or IPC channel contracts.
- Do not reintroduce password/token fields for the current site.
- Show legacy token login as a distinct, explicit authentication mode; it is supported for old portals but remains more sensitive than browser-backed SSO.
- Do not type real credentials or upload/submit real course work during UI testing.

### UI acceptance checklist

1. `npm run desktop:check` passes after renderer changes.
2. Unauthenticated startup clearly offers UIT sign-in and does not show a current-site password form.
3. Current-site login modal shows SSO as the primary action; legacy selection reveals only the legacy compatibility form.
4. Loading, empty, network-error, and expired-session states remain understandable in both languages.
5. Course cards, course detail, materialization, workspace, assignments, announcements, and Agentic Mode remain reachable without changing IPC payloads.
6. Focus, keyboard navigation, contrast, disabled states, and long Vietnamese course/material titles are tested visually.
7. Any visual change that affects behavior is covered by a renderer-level test or documented manual smoke check.

## 14. Handoff protocol for future agents

Before changing code:

1. Read this document completely.
2. Run `git status --short --branch`.
3. Run `npm test` and `npm run typecheck` to establish a baseline.
4. Inspect the relevant existing CLI command before adding another UIT endpoint.
5. Preserve the separation between renderer, desktop service, and UIT API.

When finishing a task:

1. Update the progress ledger in this file.
2. Add or update tests for the behavior changed.
3. Run the required checks listed above.
4. Record any external-authentication or packaging test that could not be run.
5. Leave the working tree understandable; do not commit credentials, downloaded course content, or generated build artifacts.

## 15. Risks and deferred decisions

- UIT may require reauthentication, CAPTCHA, or browser-assisted login in some environments. Current-site SSO and legacy token portals are both supported, with independent per-site sessions.
- A Moodle API token is a bearer credential. The current-site path is cookie/session-backed; do not describe the combined app as entirely cookie-only while legacy token compatibility remains enabled.
- Moodle feature availability can differ by course and plugin. The UI must handle unsupported modules gracefully.
- Codex app-server and WebSocket APIs evolve. Pin/test against the installed CLI version and generate schemas from that version where appropriate.
- Electron packaging and native keychain dependencies differ across operating systems. Keep secure-storage access behind a small adapter.
- Full parity with every UIT website feature is larger than the MVP. Prioritize student read workflows and safe submission.
- Automatic synchronization with the Codex desktop app and ChatGPT cloud remains explicitly deferred until it proves low-cost and reliable.
