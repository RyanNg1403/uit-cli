# Desktop UI Verification

## Live dual-portal thesis visibility fix — 2026-09-05

Reproduced with the student's connected current SSO and legacy undergraduate accounts. SSO discovery successfully returned three courses, including course 807, `Khoá luận tốt nghiệp - AI505.R11`; legacy discovery returned 37. There were no portal discovery errors. The thesis lacked semester dates and was grouped under Unknown semester. The renderer automatically selected `startdate-2026`, showing only five legacy courses. This was a dashboard filter bug, not failed SSO or a collision between portal course IDs.

The initial dashboard and newly connected accounts now show All semesters. Explicit semester choices survive refresh; an unavailable selection falls back to All semesters. A filtered view reports hidden course counts and offers Show all semesters. Semester metadata remains unknown when Moodle does not supply it; no thesis ID or inferred academic-year mapping is hardcoded.

Live verification after renderer reload: both sessions remained connected, all 40 courses appeared, and course 807 opened with the Chung section and Các thông báo activity. The native announcements panel still cannot resolve this forum's instance ID; that is a separate existing reader limitation. No assignment submission, download, or agent turn was performed.

Regression coverage includes legacy-first then SSO with an undated thesis, both previous filter choices, explicit-filter refresh/search behavior, and the hidden-course recovery action. Verification: `npm run test:desktop` passed all 100 UI/PDF/sidebar tests; `npm run desktop:check` and `git diff --check` passed. Older verification records below describe earlier revisions.

## Latest Interaction Update

- Codex lists explicitly chosen projects, not every Moodle course. New project is the single project-creation control; each project title has a `+` for starting a thread directly in that project. No global New thread button, center creation button, or course dropdown remains in Codex.
- Unsent threads are temporary and excluded from persisted history. Leaving for another thread/project or Courses discards them. Existing sent-thread follow-up drafts still persist. Branch creation is deferred until its first prompt.
- PDF pages scroll continuously with lazy rendering, bounded canvas memory, page jump/zoom, and cleanup. Sidebar width is draggable and collapse toggles with Cmd+B/Ctrl+B.
- Repeated onboarding/instructional text and sample prompts were removed. Error, approval, and data-loss warnings remain. New project has distinct academic-year sections and a year filter.
- Verified course URL lookup can recover courses absent from enrolment discovery, using the connected portal account and actual access checks. Linked references are account-separated; no enrolment or Moodle write occurs. Course 807 has offline lookup coverage, not a verified live-account result.
- Fixed the reported SSO pagination error: an empty final timeline page with `nextoffset` equal to the requested offset is terminal, not an error. Offset 3 and course 807 are covered by regressions; malformed/backward/non-empty stalled cursors remain guarded.

Latest checks: 453 unit/integration tests passed; 100 headless UI/PDF/sidebar tests passed twice (200 runs); desktop build/syntax and whitespace checks passed. The earlier hidden 60-second Electron soak passed with continuous PDF scrolling and resizable sidebar; later UI changes are covered by the headless suite. No real SSO account was accessed by the tests. Backend changes require a full app restart.

## Course Navigation Follow-Up

The latest follow-up moves generic New thread into Codex and requires an upfront course picker without creating an unassigned draft. Downloads moved from material rows into their actions menu; the redundant Preview action was removed. Dropdown chevrons have a 12px inset and reserved text space.

Course discovery now reconciles successful empty/partial enrolment results with supported timeline buckets and validates pagination. Semester parsing handles additional Vietnamese spellings/year formats. Adding an account resets the initial semester selection; global search and All semesters expose otherwise filtered courses. Portal counts distinguish zero discovered courses from a hidden semester.

Follow-up verification: 371 unit/integration tests passed, 70 headless UI/PDF tests passed three times (210 checks), build/syntax and whitespace checks passed. No live account or visible Electron window was used. These regressions reproduce omission paths but do not establish which one affected the user's actual thesis. Backend discovery updates need an app restart, not just renderer reload.

Verified on macOS with Node 22.21.1 and Electron 41.10.3. This report describes the tested development application, not a packaged release or complete Moodle/Codex parity.

## Implemented

- Neutral, single-sidebar interface with semester selection, searchable course rows, and complete course navigation.
- Concurrent current SSO and legacy portal sessions, with portal/account/course routing and visible partial-portal failures.
- Preview-first materials, assignment descriptions, announcements, and attachments. Download is separate and does not automatically open a file.
- In-memory PDF.js preview with page controls, zoom, extracted text, bounded canvas allocation, and worker cleanup. Text/images also preview without saving; previews are limited to 25 MiB.
- Resource context menus create unsent project threads with removable `@resource` references, resolved again from authoritative service metadata when sent.
- Account-separated persistent threads and drafts, rename, archive/restore, branch, stop, command/file approvals, and course-scoped read/download tools.
- Single-flight metadata and Codex initialization, atomic downloads, account-isolated paths, stale-response guards, frame-coalesced streaming updates, and throttled persistence.
- Explicit unknown/partial metadata rather than invented Moodle activity instance IDs.

## Final Checks

| Check | Result |
| --- | --- |
| `npm test` | 240 passed across 7 files |
| `npm run test:desktop -- --repeat-each=2` | 46 browser/PDF tests, each passed twice: 92 total, no retries |
| `npm run test:electron` | One hidden Electron process; 77 interaction cycles in a 60.7-second active soak |
| TypeScript/build and desktop syntax checks | Passed |
| `npm audit --audit-level=high` | Zero reported vulnerabilities after dependency updates |
| `git diff --check` | Passed |

The Electron soak checks real preload/main authorization before substituting synthetic course responses through test-runner IPC handlers. It checks sandboxing and context isolation, visible PDF pixels and extracted text under the local `file:` protocol, course/thread navigation, saved unsent drafts, mobile/desktop resizing, account dialogs, heartbeat responsiveness, bounded post-warmup memory growth, and canvas/worker cleanup.

All 77 PDF workers were terminated after preview closure; no worker accumulation, crash, unresponsive event, external request, automatic download, or model turn was observed. Its only shutdown was requested by test teardown. Expected authorization-denial errors are retained in diagnostics; they are not crashes. A one-minute soak detects immediate lifecycle regressions, not long-duration memory leaks.

## Test Operation

`test:desktop` runs headless browser tests only. `test:electron` uses one hidden window and isolated HOME, application profile, and Codex environment; no student credentials are loaded. Earlier multi-process smoke runs caused visible launch/close cycles. They are no longer part of either default script; the supplementary smoke suite also now requests hidden windows.

Run artifacts are ignored by git under `test-results/`. The latest Electron directory contains `electron-stability.json`, screenshots of course/agent/PDF/mobile views, and a disposable synthetic profile. The HTML report is `test-results/report/index.html`. A subsequent Playwright invocation replaces the previous run's artifacts.

## Remaining Boundaries

- Live current/legacy/graduate login and course payloads were not exercised in this change. SSO HTML fallbacks have DOM fixture tests but still depend on UIT's deployed theme and permissions.
- No paid Codex model turn was run. Protocol behavior, dynamic tools, concurrent events, and approvals were tested with a fake server and mocked main-process services. Tool schemas were checked against installed Codex 0.149.1.
- Project/thread organization follows Codex conventions but is not an exact replica. External Codex-app synchronization, rich Markdown/diffs, full approval/user-input coverage, and all Codex features are not implemented. Unsupported privileged interactions are denied.
- This is not yet a fully functional Moodle replacement. Grades, complete submission workflows, quizzes/H5P, arbitrary Office/archive previews, and site-wide notifications do not have equivalent native views. The sandboxed Moodle viewer provides an explicit fallback; legacy API login does not supply browser cookies.
- Student content remains untrusted. HTML/XML/SVG are shown as text rather than executed. Unavailable descriptions, forum identities, and other partial reads are reported explicitly.
- Inferred semesters are not guaranteed to match institutional term boundaries; absent metadata goes into Unknown semester.
- Legacy tokens remain in memory; SSO still needs an explicit connection after restart. Local thread content is not encrypted, and disconnected accounts retain their local thread index.
- Workspace layout changed to site/account/course identity. Existing workspaces are not migrated or deleted.
- Electron was upgraded from 40.10.6 to patched 41.10.3 because of a sandbox advisory. Desktop development now needs Node 22.12+. CLI's published Node 20 range is unchanged.
- Windows/Linux, packaged distribution, notarization, and long-duration production load were not validated.

No commit or push was made. Existing unrelated worktree changes were preserved.
