# uit

A CLI for [courses.uit.edu.vn](https://courses.uit.edu.vn) — the Moodle LMS at UIT (University of Information Technology, VNU-HCM).

Download course materials, track deadlines, submit assignments, and check grades — all from your terminal. Designed to be both human-readable and agent-friendly.

## Setup

**Prerequisites:** Python 3.10+

```bash
git clone <repo-url> && cd uit-cli
pip install -e .
```

Get your API token:

```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

Initialize:

```bash
uit init <your-token>
```

This saves credentials to `~/.uit/.env` (chmod 600). Alternatively, copy `.env.example` to `.env` in the project directory and fill in your values.

## Commands

### List courses

```bash
uit courses              # all enrolled courses
uit courses --current    # current semester only
```
```
ID        SHORT                 COURSE
----------------------------------------------------------------------------------
19589     SE362.Q21             An toan phan mem va he thong - SE362.Q21
19227     CS410.Q21             Mang neural va thuat giai di truyen - CS410.Q21
19207     CS313.Q23             Khai thac du lieu va ung dung - CS313.Q23
```

### Browse course contents

```bash
uit contents <course_id>
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

### Download course materials

```bash
uit download <course_id>                # download to ./
uit download <course_id> -o ~/UIT       # download to ~/UIT/
uit download <course_id> --force        # re-download existing files
```

Files are organized by section and subfolder, matching the Moodle structure. Existing files are skipped by default.

### Track deadlines

```bash
uit deadlines                           # upcoming deadlines, all courses
uit deadlines --course-id <id>          # filter to one course
uit deadlines --all                     # include past deadlines
```
```
DUE                 COURSE            COURSE NAME                  ASSIGNMENT                  ID
---------------------------------------------------------------------------------------------------------
2026-04-12 23:55    CS410.Q21         Mang neural va thuat...      DE & CEM Exercise           102727
```

### Submit assignments

```bash
uit submit <assign_id> ./report.pdf
```

The `assign_id` comes from the `ID` column in `uit deadlines`.

```
Uploading ./report.pdf...
Submitting to assignment 102727...
status: submitted
submission_status: submitted
time: 2026-04-10 14:32
```

### Check submission status

```bash
uit status <assign_id>
```
```
assign_id: 102727
status: submitted
submitted: 2026-04-10 14:32
attempt: 1
files: [{'name': 'report.pdf', 'size': 245760}]
```

### View grades

```bash
uit grades <course_id>
```
```
ITEM                                               GRADE       MAX     %
--------------------------------------------------------------------------------
Exercise 1                                         85          100     85.00 %
Exercise 2                                         -           100
```

### Raw API access

Call any of Moodle's 400+ web service functions directly:

```bash
uit raw core_course_get_contents courseid=19589
uit raw mod_assign_get_assignments "courseids[0]=19227"
```

## Workflow

IDs flow between commands:

```
uit courses --current        -> get course IDs
uit contents  <course_id>   -> browse modules and files
uit download  <course_id>   -> download all course files
uit deadlines                -> get assignment IDs and due dates
uit grades    <course_id>   -> view grades
uit submit    <assign_id> <file>  -> submit to assignment
uit status    <assign_id>   -> check submission result

ID chain: courses -> course_id -> contents/download/deadlines/grades
          deadlines -> assign_id -> submit/status
```

## Agent-friendly mode

Add `--json` before any command to get structured JSON output:

```bash
uit --json courses --current
uit --json deadlines
uit --json status 102727
uit --json raw core_webservice_get_site_info
```

```json
[
  {
    "id": 19589,
    "short": "SE362.Q21",
    "name": "An toan phan mem va he thong - SE362.Q21"
  }
]
```

Errors also return JSON with actionable hints:

```json
{
  "error": "Khóa học hay hoạt động không truy cập được.",
  "hint": "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit deadlines' for assignment IDs."
}
```

## Configuration

`uit init` saves credentials to `~/.uit/.env`. You can also place a `.env` file in your working directory (it takes precedence). See `.env.example` for the format.

| Variable | Description |
|---|---|
| `UIT_TOKEN` | Moodle API token |
| `UIT_BASE_URL` | Moodle instance URL (default: `https://courses.uit.edu.vn`) |
| `UIT_USER_ID` | Your Moodle user ID (auto-detected by `uit init`) |

## Project structure

```
uit-cli/
  src/uit/
    cli.py        # commands and output formatting
    api.py        # moodle REST client (call, upload, download)
    config.py     # .env loader
  pyproject.toml  # package definition, entry point
  .env.example    # credential template
```

## License

MIT
