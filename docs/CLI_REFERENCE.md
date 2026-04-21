# CLI Reference

Full reference for every `uit` command. For a quick overview, see [README.md](../README.md).

---

## Global flags

| Flag | Description |
|---|---|
| `--json` | Output structured JSON on stdout. Errors also return JSON. |
| `--help` | Show help with workflow diagram and ID chain. |

---

## `uit init <token>`

Set up credentials. Fetches your user ID automatically.

```bash
uit init <token>
uit init <token> --url https://your-moodle-instance.com   # non-default Moodle
```

Get your token:
```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

Saves to `~/.uit/.env` (chmod 600 on Unix). A `.env` file in the working directory takes precedence.

---

## `uit courses`

List enrolled courses. Each row includes a **course ID** used by most other commands.

```bash
uit courses              # all courses
uit courses --current    # current semester only (heuristic based on category ID)
```

**Output columns:** ID, SHORT (course code), COURSE (full name)

---

## `uit contents <course_id>`

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

## `uit view <id>`

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

**url** — Shows the target URL.

**quiz** — Shows open/close times, time limit, max grade, and attempt count.

**page** — Shows page content as text with extracted URLs.

**book** — Shows description and attached files.

**Unknown types** — Falls back to showing metadata and any attached files.

---

## `uit view-discussion <discussion_id>`

Read all posts in a forum discussion thread. Shows author, date, message content, extracted URLs, and attachments.

```bash
uit view-discussion 77900
```

Works on any forum discussion — announcements, course forums, or any discussion ID from a Moodle URL (`discuss.php?d=XXXXX`). Each post includes a **post ID** for use with `uit reply`.

---

## `uit reply <post_id> <message>`

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

## `uit announcements <course_id>`

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

## `uit download <course_id>`

Download course files. Preserves the Moodle folder structure (section/subfolder/file). Existing files are skipped by default.

```bash
uit download 19207                              # everything
uit download 19207 --module 428955              # one module only
uit download 19207 --file "Pre-processing"      # files matching name (substring)
uit download 19207 -o ~/UIT                     # custom output directory
uit download 19207 --force                      # re-download existing files
```

| Flag | Description |
|---|---|
| `-o`, `--output` | Output directory (default: `.`) |
| `--module` | Only download from this module ID (from `uit contents`) |
| `--file` | Only download files matching this name (case-insensitive substring) |
| `--force` | Re-download even if the file already exists locally |

---

## `uit deadlines`

List assignment deadlines across all courses. Each row includes an **assignment ID** for use with `uit submit` and `uit status`.

```bash
uit deadlines                     # upcoming only
uit deadlines --course-id 19227   # filter to one course
uit deadlines --all               # include past deadlines
```

**Output columns:** DUE, COURSE, COURSE NAME, ASSIGNMENT, ID

Assignments with no due date show an empty DUE column but are still listed.

---

## `uit submit <assign_id> <file>`

Upload a file and submit it to an assignment. Shows confirmation with submission status.

```bash
uit submit 101617 ./report.pdf
```

The `assign_id` comes from `uit deadlines` (ID column) or `uit view` on an assignment module (assign_id field).

---

## `uit status <assign_id>`

Check your submission status, attempt number, submitted files, and grade (if available).

```bash
uit status 101617
```

---

## `uit grades <course_id>`

Show grade report for a course.

```bash
uit grades 19207
```

**Note:** Some courses may return an error if the grade report has data types the API can't serialize. This is a Moodle-side limitation.

---

## `uit functions [keyword]`

List the 420+ Moodle web service functions available to your token. Grouped by module.

```bash
uit functions                     # list all
uit functions assign              # filter by keyword
uit functions calendar            # search calendar functions
uit functions quiz                # search quiz functions
```

---

## `uit raw <function> [key=value ...]`

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

## JSON mode

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

## Configuration

| Variable | Description |
|---|---|
| `UIT_TOKEN` | Moodle API token |
| `UIT_BASE_URL` | Moodle instance URL (default: `https://courses.uit.edu.vn`) |
| `UIT_USER_ID` | Your Moodle user ID (auto-detected by `uit init`) |

Config is read from `.env` — first checking the working directory and parents, then `~/.uit/.env`. The project-local file takes precedence.

---

## Project structure

```
uit-cli/
  src/uit/
    cli.py        # commands, output formatting, arg parsing
    api.py        # Moodle REST client (call, upload, download)
    config.py     # .env file loader
  pyproject.toml  # package definition and 'uit' entry point
  .env.example    # credential template
```
