<p align="center">
  <img src="assets/logo.svg" alt="uit-cli" width="620">
</p>

<p align="center">
  Access your UIT course materials faster — from your terminal or through AI agents.<br>
  Download lectures, check deadlines, read announcements, submit assignments, and more.
</p>

<p align="center">
  <code>pip install -e .</code>&nbsp;&nbsp;then&nbsp;&nbsp;<code>uit init &lt;token&gt;</code>&nbsp;&nbsp;and you're ready.
</p>

## Setup

**Prerequisites:** Python 3.10+

```bash
git clone <repo-url> && cd uit-cli
pip install -e .
```

Verify it works:

```bash
uit --help
```

If you get `command not found`, Python's script directory isn't on your PATH yet:

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export PATH="$(python3 -m site --user-base)/bin:$PATH"

# Windows (PowerShell)
# pip usually installs to %APPDATA%\Python\PythonXX\Scripts, which may already be on PATH.
# If not, run: pip install -e . --user  and add the Scripts directory to PATH.
```

Get your API token by visiting (in a browser, while logged in):

```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

Initialize:

```bash
uit init <your-token>
```

Credentials are saved to `~/.uit/.env`. You can also place a `.env` file in your project directory — it takes precedence. See `.env.example` for the format.

Works on macOS, Linux, and Windows.

## Workflow

A Moodle course is a tree of sections, modules, and content. The CLI lets you traverse it:

```
uit courses --current                -> course IDs
uit contents  <course_id>           -> module IDs (the course tree)
uit view      <module_id>           -> inspect any module (type-aware)
uit download  <course_id>           -> download files (whole course or targeted)
uit announcements <course_id>       -> read course announcements
uit deadlines                       -> assignment IDs and due dates
uit grades    <course_id>           -> view grades
uit submit    <assign_id> <file>    -> submit to assignment
uit status    <assign_id>           -> check submission result
uit view-discussion <discussion_id> -> read forum thread
uit functions [keyword]             -> discover 420+ raw API functions
uit raw <function> key=value        -> call any Moodle API function
```

**ID chain** — IDs flow between commands:

```
courses   -> course_id  -> contents / download / announcements / deadlines / grades
contents  -> module_id  -> view
view      -> assign_id  -> submit / status
          -> discussion_id -> view-discussion
deadlines -> assign_id  -> submit / status
```

## Commands

### `uit courses`

```bash
uit courses              # all enrolled courses
uit courses --current    # current semester only
```

### `uit contents <course_id>`

Browse the course tree. Shows every section, module, and file — with **module IDs** for drilling down.

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

The left column is the **module ID** — pass it to `uit view` to inspect.

### `uit view <module_id>`

Inspect any module. Type-aware — shows the right details based on what the module is:

```bash
uit view 428837    # assignment -> shows description, due date, submission status
uit view 432640    # lesson -> shows instructions, URLs
uit view 423056    # forum -> lists discussions
uit view 427868    # folder -> lists files
```

**Assignment** output:
```
[assign] Exercise 1 - Feb 24
assign_id:   101617  (use with 'uit submit' / 'uit status')
due:         2026-02-24 13:45
status:      submitted
accepts:     file, onlinetext

Description:
  - List at least four application domains of data mining...
  - Analyze three major challenges in data mining...
```

**Lesson** output (e.g., NVIDIA workshop instructions):
```
[lesson] NVIDIA WORKSHOP - Applications of AI for Anomaly Detection
module_id: 432640

Description:
  - Go to https://learn.nvidia.com/
  - Sign up with your UNIVERSITY EMAIL ACCOUNT
  - Enter the access code: UIT_ANOM_AMBASSADOR_AP26
  - DEADLINE: 11/04/2026
```

**Forum** output:
```
[forum] Cac thong bao
module_id: 423056

ID        SUBJECT                              AUTHOR             RE    DATE
---------------------------------------------------------------------------
79476     Mai lop bat dau 8h nha               Huynh Minh Duc     0     2026-04-20 23:35
```

Supports: `assign`, `forum`, `resource`, `folder`, `lesson`, `url`, `quiz`, `page`, `book`. Unknown types show metadata and files.

### `uit view-discussion <discussion_id>`

Read all posts in a forum discussion thread.

```bash
uit view-discussion 77900
```
```
------------------------------------------------------------
  So tay Gv
  Do Thi Ngat  |  2026-01-27 15:04
------------------------------------------------------------
Q24-CHU NGHIA XA HOI KHOA HOC - Google Trang tinh

  URLs:
    https://docs.google.com/spreadsheets/d/1jYB6...
```

### `uit announcements <course_id>`

Shortcut to read the "Cac thong bao" forum every course has.

```bash
uit announcements 19438            # list recent announcements
uit announcements 19438 -n 3       # last 3 only
uit announcements 19438 --full     # show full message content
```

### `uit download <course_id>`

Download course files. Supports targeting by module or filename.

```bash
uit download 19207                              # everything
uit download 19207 --module 428955              # one module only
uit download 19207 --file "Pre-processing"      # files matching name
uit download 19207 -o ~/UIT                     # custom output directory
uit download 19207 --force                      # re-download existing
```

### `uit deadlines`

```bash
uit deadlines                     # upcoming, all courses
uit deadlines --course-id 19227   # filter to one course
uit deadlines --all               # include past deadlines
```

### `uit submit <assign_id> <file>`

```bash
uit submit 101617 ./report.pdf    # assign_id from 'uit view' or 'uit deadlines'
```

### `uit status <assign_id>`

```bash
uit status 101617
```

### `uit grades <course_id>`

```bash
uit grades 19207
```

### `uit functions [keyword]`

Discover the 420+ Moodle API functions available to your token.

```bash
uit functions                     # list all, grouped by module
uit functions assign              # search for assignment-related
uit functions calendar            # search for calendar functions
```

### `uit raw <function> [key=value ...]`

Call any Moodle API function directly.

```bash
uit raw core_course_get_contents courseid=19589
uit raw mod_forum_get_discussion_posts discussionid=77900
```

**Figuring out parameters:** Call with no params — Moodle's error message names the missing parameter.

## Agent integration

### JSON mode

`--json` before any command. All output becomes structured JSON on stdout — including errors.

```bash
uit --json courses --current
uit --json view 428837
uit --json announcements 19438 --full
uit --json view-discussion 77900
```

### Error format

```json
{
  "error": "Khoa hoc hay hoat dong khong truy cap duoc.",
  "hint": "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit contents' for module IDs, 'uit deadlines' for assignment IDs."
}
```

### Self-discovery

An agent with no prior knowledge can orient itself:

1. `uit --help` — all commands, workflow diagram, ID chain
2. `uit <command> --help` — required args and where each ID comes from
3. `uit courses` -> `uit contents <id>` -> `uit view <id>` — traverse the course tree
4. `uit functions <keyword>` + `uit raw` — escape hatch for anything else

No external documentation needed.

### Typical agent session

```bash
# Orient
uit --json courses --current

# Browse a course
uit --json contents 19207

# Read an assignment
uit --json view 428837
# -> returns assign_id, description, due date, submission status

# Check announcements
uit --json announcements 19207 --full

# Download specific materials
uit --json download 19207 --module 428955 -o /tmp

# Submit
uit submit 101617 ./solution.pdf
```

## Configuration

| Variable | Description |
|---|---|
| `UIT_TOKEN` | Moodle API token |
| `UIT_BASE_URL` | Moodle instance URL (default: `https://courses.uit.edu.vn`) |
| `UIT_USER_ID` | Your Moodle user ID (auto-detected by `uit init`) |

Config is read from `.env` — first checking the working directory (and parents), then `~/.uit/.env`.

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

## License

MIT
