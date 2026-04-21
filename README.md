# uit

A CLI for [courses.uit.edu.vn](https://courses.uit.edu.vn) — the Moodle LMS at UIT (University of Information Technology, VNU-HCM).

Download course materials, track deadlines, submit assignments, and check grades — all from your terminal.

Designed to be used by both humans and AI agents.

## Setup

**Prerequisites:** Python 3.10+

```bash
git clone <repo-url> && cd uit-cli
pip install -e .
```

Get your API token by visiting (in a browser, while logged in):

```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

Initialize:

```bash
uit init <your-token>
```

Credentials are saved to `~/.uit/.env` (chmod 600). You can also place a `.env` file in your project directory — it takes precedence. See `.env.example` for the format.

## Workflow

Commands produce IDs that feed into other commands:

```
uit courses --current             -> course IDs
uit contents  <course_id>         -> browse modules and files
uit download  <course_id>         -> download all course files
uit deadlines                     -> assignment IDs and due dates
uit grades    <course_id>         -> view grades
uit submit    <assign_id> <file>  -> submit to assignment
uit status    <assign_id>         -> check submission result
uit functions [keyword]           -> discover 420+ raw API functions
uit raw <function> key=value      -> call any Moodle API function

ID chain: courses -> course_id -> contents / download / deadlines / grades
          deadlines -> assign_id -> submit / status
```

Use `--json` before any command for structured JSON output.

## Commands

### `uit courses`

List enrolled courses. Each row includes a **course ID** used by other commands.

```bash
uit courses              # all enrolled courses
uit courses --current    # current semester only
```
```
ID        SHORT                 COURSE
----------------------------------------------------------------------------------
19589     SE362.Q21             An toan phan mem va he thong - SE362.Q21
19227     CS410.Q21             Mang neural va thuat giai di truyen - CS410.Q21
```

### `uit contents <course_id>`

Browse sections, modules, and files in a course.

```bash
uit contents 19589       # course_id from 'uit courses'
```
```
============================================================
  General
============================================================
  [folder    ] Tai Lieu Mon Hoc
               -> Chapter 1 - Introduction.pdf  (2.7MB)
               -> Chapter 2 - Cryptography.pdf  (8.9MB)
  [resource  ] Danh sach de tai
               -> Security subjects.docx  (21KB)
```

### `uit download <course_id>`

Download all files from a course, organized by section and subfolder.

```bash
uit download 19589                # download to ./SE362.Q21/
uit download 19589 -o ~/UIT       # download to ~/UIT/SE362.Q21/
uit download 19589 --force        # re-download existing files
```

Existing files are skipped by default.

### `uit deadlines`

List assignment deadlines. Each row includes an **assignment ID** used by `submit` and `status`.

```bash
uit deadlines                     # upcoming, all courses
uit deadlines --course-id 19227   # filter to one course
uit deadlines --all               # include past deadlines
```
```
DUE                 COURSE       COURSE NAME                       ASSIGNMENT                   ID
-------------------------------------------------------------------------------------------------------
2026-04-12 23:59    CS410.Q21    Mang neural va thuat giai...      DE & CEM Exercise            102727
```

### `uit submit <assign_id> <file>`

Upload and submit a file to an assignment.

```bash
uit submit 102727 ./report.pdf    # assign_id from 'uit deadlines'
```

### `uit status <assign_id>`

Check submission status and grade for an assignment.

```bash
uit status 102727                 # assign_id from 'uit deadlines'
```
```
assign_id: 102727
status: submitted
submitted: 2026-04-12 16:34
attempt: 1
files: [{'name': 'BT2_23521146.zip', 'size': 4427807}]
```

### `uit grades <course_id>`

Show grade report for a course.

```bash
uit grades 19207                  # course_id from 'uit courses'
```
```
ITEM                                               GRADE       MAX     %
--------------------------------------------------------------------------------
Exercise 1                                         85          100     85.00 %
Exercise 2                                         -           100
```

### `uit functions [keyword]`

Discover the 420+ Moodle API functions available to your token. This is the entry point for anything not covered by the built-in commands.

```bash
uit functions                     # list all, grouped by module
uit functions assign              # search for assignment-related functions
uit functions quiz                # search for quiz-related functions
uit functions calendar            # search for calendar functions
```
```
mod_assign (23)
  mod_assign_get_assignments
  mod_assign_get_submission_status
  mod_assign_save_submission
  ...
```

### `uit raw <function> [key=value ...]`

Call any Moodle API function directly. Use `uit functions` to discover function names.

```bash
uit raw core_course_get_contents courseid=19589
uit raw mod_assign_get_assignments "courseids[0]=19227"
uit raw core_calendar_get_action_events_by_timesort "timesortfrom=$(date +%s)"
```

**Figuring out parameters:** Function names are descriptive (e.g., `core_course_get_contents` takes `courseid`). If you guess wrong, Moodle returns an error naming the missing/invalid parameter — this is the fastest way to learn the signature. Call with no params first if unsure.

## Agent integration

### JSON mode

Add `--json` before any command. All output becomes structured JSON on stdout — including errors.

```bash
uit --json courses --current
uit --json deadlines --course-id 19227
uit --json status 102727
uit --json functions assign
```

### Error format

Errors exit with code 1 and include actionable hints:

```json
{
  "error": "Khoa hoc hay hoat dong khong truy cap duoc.",
  "hint": "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit deadlines' for assignment IDs."
}
```

### Typical agent workflow

```bash
# 1. Discover courses
uit --json courses --current

# 2. Pick a course, get its assignments
uit --json deadlines --course-id 19589

# 3. Check what's been submitted
uit --json status <assign_id>

# 4. Download materials if needed
uit --json download <course_id> -o /tmp/materials

# 5. Submit when ready
uit submit <assign_id> ./solution.pdf

# 6. For anything else, discover and call raw API
uit --json functions <keyword>
uit --json raw <function_name> key=value
```

### Self-discovery

An agent with no prior knowledge can orient itself:

1. `uit --help` — shows all commands, the workflow diagram, and the ID chain
2. `uit <command> --help` — shows required args and where each ID comes from
3. `uit functions <keyword>` — searches available API functions
4. `uit raw <function>` — call with wrong/no params to get Moodle's error revealing the required parameters

No external documentation is needed. The Moodle instance's own API docs (`/admin/webservice/documentation.php`) require admin access, so the CLI is designed to be self-documenting.

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
