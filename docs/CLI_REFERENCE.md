# UIT CLI and Studio CLI Reference

This reference covers both user-facing commands:

| Command | Purpose |
|---|---|
| `uit` | Terminal-first access to UIT Moodle courses, materials, assignments, and submissions. |
| `uit-studio` | Starts the local UIT Studio backend and opens the Studio web app in the default browser. |

For installation instructions, see [README.md](../README.md). The canonical
Studio command is `uit-studio`; this project does not add `uit studio`.

## `uit-studio`

UIT Studio is a local web application. The command starts (or reuses) one
loopback-only Studio backend and opens its authenticated URL in the system
browser. npm and native installations expose the same command and behavior.

```bash
uit-studio
```

The browser used to display Studio may be Chrome, Edge, Firefox, Safari, or
another current browser. UIT SSO is handled separately by the Studio-managed,
package-owned Playwright Chromium runtime, so users do not need to install a
browser specifically for sign-in. The temporary SSO browser closes after the
session is captured.

### Studio options

| Flag | Description |
|---|---|
| `-v, --version` | Print the installed Studio package version and exit without starting anything. |
| `-h, --help` | Show Studio command help and exit. |

### Studio commands

| Command | Description |
|---|---|
| `uit-studio stop` | Stop the currently running local Studio server. If no server is running, it exits without changing anything. |

Examples:

```bash
uit-studio --version
```

### Studio authentication and shared state

Sign in through the Studio UI with UIT SSO or a legacy Moodle account. Studio
shares the canonical session store at `~/.uit/sessions.json` with `uit` and
preserves course workspaces and Studio state under `~/.uit`.

The native Studio archive includes Node.js and the pinned SSO Chromium runtime.
The npm installation requires Node.js 24.0+ and provisions that Chromium
revision during installation. Neither installation requires system Chrome,
Edge, or Chromium for SSO.

---

## `uit`

The `uit` command is the terminal-first Moodle interface. Run `uit --help` for
the workflow diagram and ID chain.

### Global flags

| Flag | Description |
|---|---|
| `-v, --version` | Print the installed CLI version and exit. |
| `--json` | Output structured JSON on stdout. Errors also return JSON. |
| `-h, --help` | Show help with workflow diagram and ID chain. |

### URL support

Any command that accepts an ID also accepts a Moodle URL. The CLI extracts the ID from the URL automatically.

```bash
uit view 'https://courses.uit.edu.vn/mod/assign/view.php?id=428837'
uit contents 'https://courses.uit.edu.vn/course/view.php?id=19207'
uit view-discussion 'https://courses.uit.edu.vn/mod/forum/discuss.php?d=77900'
uit grades 'https://courses.uit.edu.vn/course/view.php?id=19207'
```

---

### `uit login`

Sign in to UIT Moodle. **UIT SSO is the default**; `--legacy` restores the v1.0/v1.1 Student ID/password flow for the old Moodle portal.

```bash
# Recommended: Sign in via UIT SSO in browser (default)
uit login

# Explicit SSO:
uit login --sso

# Legacy Moodle: prompts for Student ID and password, then stores the returned token:
uit login --legacy

# Non-interactive legacy token setup:
uit login --legacy --username YOUR_STUDENT_ID --password YOUR_PASSWORD
```

Prefer the interactive browser login (`uit login`) or `uit login --legacy` for normal use. Passwords passed as command-line arguments can be saved in shell history. The CLI does not save your password; it stores only the session/token.

SSO and token sessions are saved to `~/.uit/sessions.json` (mode `0600` on Unix) and shared with UIT Studio. The user ID is discovered during login and stored with the session. Re-run `uit login` at any time to refresh or rotate it.

---

### `uit courses`

List enrolled courses. Each row includes a **course ID** used by most other commands.

```bash
uit courses              # all courses
uit courses --current    # current semester only (heuristic based on category ID)
```

**Output columns:** ID, SHORT (course code), COURSE (full name)

---

### `uit contents <course_id>`

Browse the full course tree — sections, modules, and files.

```bash
uit contents 19207
```
```
============================================================
  General
============================================================
  426303   [resource  ] Groups
                          -> Groups.pdf  (200KB)
  431317   [forum     ] Discussion forum

============================================================
  Feb 24
============================================================
  428837   [assign    ] Exercise 1 - Feb 24
  428955   [resource  ] Data Pre-processing
                          -> Data Pre-processing.pdf  (870KB)
```

The left column is the **module ID** — pass it to `uit view`.

**JSON mode** flattens the tree into an array of objects with `section`, `module_id`, `type`, `name`, and optional `files`.

---

### `uit view <id>`

Inspect any module. Type-aware — shows different details based on the module type. Accepts a **module ID** (from `uit contents`) or an **assignment ID** (from `uit deadlines`).

```bash
uit view 428837    # module_id from 'uit contents'
uit view 50664     # assign_id from 'uit deadlines' — also works
uit view 432640    # lesson
uit view 423056    # forum
uit view 427868    # folder
uit view 429314    # resource (single file)
```

### Supported types

**assign** — Shows description (HTML converted to text), due date, cutoff date, submission status, accepted file types, and attachments. Outputs `assign_id` for use with `uit submit` and `uit status`.

```
[assign] Exercise 1 - Feb 24
assign_id:   101617  (use with 'uit submit' / 'uit status')
due:         2026-02-24 13:45
status:      submitted
submitted:   2026-02-24 13:35
accepts:     file, onlinetext

Description:
  - List at least four application domains of data mining...
```

**forum** — Lists discussions with subject, author, reply count, and date. Outputs `discussion_id` for use with `uit view-discussion`.

**lesson** — Shows intro text with instructions and extracted URLs. Useful for workshop/lab instructions that lecturers post as lessons.

**resource / folder** — Lists files with sizes. Shows a download tip.

**h5pactivity** — Lists the interactive lesson's `.h5p` package and shows a download tip (`uit download <course_id> --module <module_id>`, add `--extract` to unpack media).

**url** — Shows the target URL.

**quiz** — Shows open/close times, time limit, max grade, and attempt count.

**page** — Shows page content as text with extracted URLs.

**book** — Shows description and attached files.

**Unknown types** — Falls back to showing metadata and any attached files.

---

### `uit view-discussion <discussion_id>`

Read all posts in a forum discussion thread. Shows author, date, message content, extracted URLs, and attachments.

```bash
uit view-discussion 77900
```

Works on any forum discussion — announcements, course forums, or any discussion ID from a Moodle URL (`discuss.php?d=XXXXX`). Each post includes a **post ID** for use with `uit reply`.

---

### `uit reply <post_id> <message>`

Reply to a forum post. The subject line defaults to `Re: <original subject>`.

```bash
uit reply 149187 "Thanks for sharing!"
uit reply 149187 "See attached notes" -s "Custom subject line"
```

The `post_id` comes from `uit view-discussion`.

| Flag | Description |
|---|---|
| `-s`, `--subject` | Custom subject line (default: `Re: <original subject>`) |

---

### `uit announcements <course_id>`

Shortcut to read the "Cac thong bao" (announcements) forum that every course has. Automatically finds the forum module.

```bash
uit announcements 19438            # list subjects only
uit announcements 19438 -n 5       # last 5 only
uit announcements 19438 --full     # show full message content with URLs
```

| Flag | Description |
|---|---|
| `-n`, `--limit` | Show only the N most recent announcements |
| `--full` | Show full message content, not just subjects |

---

### `uit download <course_id>`

Download course files. Preserves the Moodle folder structure (section/subfolder/file). Existing files are skipped by default.

The first argument is a **course ID** (from `uit courses`), not a module ID. To grab a single module, pass its **module ID** (from `uit contents`) to `--module`. Passing a module ID as the course ID is rejected with a hint.

**H5P activities** (interactive lessons — the `h5pactivity` type in `uit contents`) are included automatically: their `.h5p` package, which holds the slides, images, and lesson data, is downloaded alongside regular files. Add `--extract` to also unpack each package's media into a folder next to it.

```bash
uit download 19207                              # everything, including H5P packages
uit download 19207 --module 428955              # one module only
uit download 19207 --file "Pre-processing"      # files matching name (substring)
uit download 19207 --extract                    # also unpack downloaded .h5p packages
uit download 19207 -o ~/UIT                     # custom output directory
uit download 19207 --force                      # re-download existing files
```

| Flag | Description |
|---|---|
| `-o`, `--output` | Output directory (default: `.`) |
| `--module` | Only download from this module ID (from `uit contents`) |
| `--file` | Only download files matching this name (case-insensitive substring) |
| `--extract` | Unpack downloaded `.h5p` packages into their media (slides, images, video) |
| `--force` | Re-download even if the file already exists locally |

A `.h5p` file is a ZIP — you can also open it directly in [H5P](https://h5p.org/) / [Lumi](https://lumi.education/), or by renaming it to `.zip`.

---

### `uit deadlines`

List assignment deadlines across all courses. Each row includes an **assignment ID** for use with `uit submit` and `uit status`.

```bash
uit deadlines                     # upcoming only
uit deadlines --course-id 19227   # filter to one course
uit deadlines --all               # include past deadlines
```

**Output columns:** DUE, COURSE, COURSE NAME, ASSIGNMENT, ID

Assignments with no due date show an empty DUE column but are still listed.

---

### `uit events`

List upcoming events across all courses — assignments, quizzes, calendar events, and more. A superset of `uit deadlines` that includes non-assignment events.

```bash
uit events                           # next 20 upcoming events
uit events -n 50                     # next 50
uit events --course-id 19207         # filter to one course
```

| Flag | Description |
|---|---|
| `-n`, `--limit` | Max events to show (default: 20) |
| `--course-id` | Filter to a specific course ID or URL |

**Output columns:** DUE, TYPE, COURSE, EVENT

Uses Moodle's calendar API (`core_calendar_get_action_events_by_timesort`) under the hood.

**JSON mode** includes additional fields: `url`, `instance`.

---

### `uit open <id>`

Open a Moodle page in the default browser. Accepts module IDs, assignment IDs, or Moodle URLs.

```bash
uit open 428837                      # module ID — resolves type automatically
uit open 101617                      # assign ID — also works (falls back)
uit open --course 19207              # course page
uit open --discussion 77900          # discussion thread
uit open 'https://courses.uit.edu.vn/mod/assign/view.php?id=428837'   # URL — opens directly
```

| Flag | Description |
|---|---|
| `--course` | Treat the ID as a course ID |
| `--discussion` | Treat the ID as a discussion ID |

By default, the ID is treated as a module ID (cmid). If that fails, the CLI tries to resolve it as an assignment ID. Use flags to specify other ID types.

**JSON mode** returns `{"url": "...", "id": ...}` without opening the browser.

---

### `uit submit <assign_id> <file>`

Upload a file and submit it to an assignment. Shows confirmation with submission status.

```bash
uit submit 101617 ./report.pdf
```

The `assign_id` comes from `uit deadlines` (ID column) or `uit view` on an assignment module (assign_id field).

---

### `uit status <assign_id>`

Check your submission status, attempt number, submitted files, and grade (if available).

```bash
uit status 101617
```

---

### `uit grades <course_id>`

Show grade report for a course.

```bash
uit grades 19207
```

**Note:** Some courses may return an error if the grade report has data types the API can't serialize. This is a Moodle-side limitation.

---

### `uit functions [keyword]`

List the 420+ Moodle web service functions available to your token. Grouped by module.

```bash
uit functions                     # list all
uit functions assign              # filter by keyword
uit functions calendar            # search calendar functions
uit functions quiz                # search quiz functions
```

---

### `uit raw <function> [key=value ...]`

Call any Moodle API function directly. The escape hatch for anything the built-in commands don't cover.

```bash
uit raw core_course_get_contents courseid=19589
uit raw mod_forum_get_discussion_posts discussionid=77900
uit raw core_calendar_get_action_events_by_timesort "timesortfrom=$(date +%s)"
uit raw mod_assign_get_assignments "courseids[0]=19227" "courseids[1]=19589"
```

### Array parameters

Moodle uses indexed keys for arrays:

```bash
uit raw mod_assign_get_assignments "courseids[0]=19227" "courseids[1]=19589"
```

### Discovering parameters

Call a function with no params — Moodle's error message names the required parameter. This is the fastest way to learn any function's signature.

```bash
uit raw core_course_get_contents
# -> Error: missing required parameter 'courseid'
```

For full parameter schemas, see the [Moodle Web Service API functions reference](https://docs.moodle.org/dev/Web_service_API_functions).

---

### `uit notifications` and `uit inbox`

Use the active CLI account. Lists return up to 20 entries; use `--offset` for
the next page. Listing or reading content does not mark it as read.

| Command | Purpose |
|---|---|
| `uit notifications list [--full] [--offset <n>]` | List notifications; `--full` includes message bodies. |
| `uit notifications counts` | Show unread notification and conversation counts. |
| `uit notifications read <id>` | Mark one notification as read. |
| `uit notifications read-all` | Mark all account notifications as read. |
| `uit inbox list [--offset <n>]` | List conversations. |
| `uit inbox messages <id> [--offset <n>]` | Read conversation messages; larger offsets load older messages. |
| `uit inbox read <id>` | Mark a conversation as read. |
| `uit inbox send <id> "Message"` | Send a plain-text reply, up to 4096 UTF-8 bytes. |

Add `--json` before the command for structured output; pages include `nextOffset`
(null at the end). After a failed send, check the conversation before retrying.

---

### `uit mcp`

Run the UIT Model Context Protocol (MCP) server for Codex over stdin/stdout,
or register it in the Codex configuration.

```bash
uit mcp          # Run the long-lived MCP server; normally started by Codex
uit mcp install  # Add or update [mcp_servers.uit] in ~/.codex/config.toml
```

`uit mcp install` writes the configuration atomically and verifies the saved
entry. The MCP server is available only from inside a UIT course workspace and
uses the active session from `~/.uit/sessions.json`.

| Tool | Purpose | Effect |
|---|---|---|
| `uit_courses` | List accessible courses. | Read |
| `uit_course_contents` | Read course modules, assignments, and announcements. | Read |
| `uit_read_resource` | Read a course resource. | Read |
| `uit_course_members` | List course members. | Read |
| `uit_course_grades` | Read course grades. | Read |
| `uit_download_material` | Download a course file. | Local write |
| `uit_submit_assignment` | Submit a local file to an assignment. | Moodle write |
| `uit_notifications` | Read a notification page (`offset?`). | Read |
| `uit_notification_counts` | Read unread counts: `[notifications, conversations]`; null means unavailable. | Read |
| `uit_inbox` | Read a conversation page (`offset?`). | Read |
| `uit_conversation_messages` | Read messages (`id`, `offset?`). | Read |
| `uit_mark_notification_read` | Mark one notification read (`id`). | Moodle write |
| `uit_mark_all_notifications_read` | Mark all account notifications read. | Moodle write |
| `uit_mark_conversation_read` | Mark a conversation read (`id`). | Moodle write |
| `uit_send_message` | Send an authorized reply (`id`, `text`). | Moodle write |

Messaging tools use the active account and the same pagination as the CLI.
Sending is never retried automatically. Host approval policies apply;
`uit_submit_assignment` additionally requires fresh confirmation in Studio,
including with YOLO enabled.

---

### JSON mode

Add `--json` before any command. All output becomes structured JSON on stdout.

```bash
uit --json courses --current
uit --json view 428837
uit --json deadlines
uit --json announcements 19438 --full
```

### Error format

```json
{
  "error": "Khoa hoc hay hoat dong khong truy cap duoc.",
  "hint": "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit contents' for module IDs, 'uit deadlines' for assignment IDs."
}
```

Errors exit with code 1. The `hint` field is included when the CLI can suggest a fix.

---
