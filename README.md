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

---

## Quick start

```bash
git clone <repo-url> && cd uit-cli
pip install -e .
```

Get your token by visiting (in a browser, while logged in):

```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

```bash
uit init <your-token>
uit courses --current       # verify it works
```

<details>
<summary><code>uit</code> not found? Fix your PATH</summary>

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export PATH="$(python3 -m site --user-base)/bin:$PATH"

# Windows — pip usually handles this. If not:
# pip install -e . --user  and add %APPDATA%\Python\PythonXX\Scripts to PATH.
```
</details>

Works on macOS, Linux, and Windows.

---

## What can it do?

| Task | Command |
|---|---|
| List your courses | `uit courses --current` |
| Browse course contents | `uit contents <course_id>` |
| Inspect any module | `uit view <module_id>` |
| Read announcements | `uit announcements <course_id>` |
| Download materials | `uit download <course_id>` |
| Check deadlines | `uit deadlines` |
| Submit an assignment | `uit submit <assign_id> <file>` |
| Check submission status | `uit status <assign_id>` |
| View grades | `uit grades <course_id>` |
| Read a forum thread | `uit view-discussion <discussion_id>` |
| Discover raw API functions | `uit functions [keyword]` |
| Call any Moodle API | `uit raw <function> key=value` |

IDs flow between commands:

```
courses  -> course_id  -> contents / download / announcements / deadlines / grades
contents -> module_id  -> view
view     -> assign_id  -> submit / status
         -> discussion_id -> view-discussion
```

For flags, output formats, and detailed behavior of each command, see the [CLI Reference](docs/CLI_REFERENCE.md).

---

## Examples

**Browse and drill down into a course:**

```bash
uit contents 19207                   # see sections, modules, files
uit view 428837                      # inspect an assignment — shows description, due date, status
uit view 432640                      # inspect a lesson — shows instructions, URLs
```

**Download materials:**

```bash
uit download 19207                   # everything in the course
uit download 19207 --module 428955   # one specific module
uit download 19207 --file "Crypto"   # files matching a name
```

**Assignment workflow:**

```bash
uit deadlines                        # what's due?
uit view 428837                      # read the assignment description
uit submit 101617 ./report.pdf       # submit
uit status 101617                    # check result
```

**Stay updated:**

```bash
uit announcements 19438 --full       # read announcements with full content
uit view-discussion 77900            # read a specific forum thread
```

---

## Configuration

`uit init` saves credentials to `~/.uit/.env`. You can also place a `.env` file in your project directory (takes precedence). See `.env.example`.

| Variable | Description |
|---|---|
| `UIT_TOKEN` | Moodle API token |
| `UIT_BASE_URL` | Moodle instance URL (default: `https://courses.uit.edu.vn`) |
| `UIT_USER_ID` | Your Moodle user ID (auto-detected by `uit init`) |

---

## License

MIT
