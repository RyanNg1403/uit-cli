<p align="center">
  <img src="assets/logo.svg" alt="uit-cli" width="560">
</p>

<p align="center">
  <strong>The modern, AI-powered toolkit for UIT Moodle LMS (courses.uit.edu.vn).</strong><br>
  Access course materials, inspect assignments, read announcements, and study with an AI tutor.<br>
  Available as a <strong>Desktop Application (UIT Studio)</strong> and a <strong>Terminal CLI (uit-cli)</strong>.
</p>

<p align="center">
  <a href="#uit-studio-desktop-application"><strong>UIT Studio (Desktop)</strong></a> &bull;
  <a href="#features--screenshots"><strong>Features & Screenshots</strong></a> &bull;
  <a href="#quick-start"><strong>Quick Start</strong></a> &bull;
  <a href="#how-ids-flow"><strong>CLI Reference</strong></a> &bull;
  <a href="#security-and-ethics"><strong>Security & Privacy</strong></a>
</p>

<p align="center">
  <img src="assets/studio-chat.png" alt="UIT Studio Desktop App - Codex Assistant" width="880" style="border-radius: 8px;">
</p>

---

## Quick start

```bash
npm install -g uit-cli
uit init                    # prompts for student ID/password and stores a Moodle token locally
uit courses --current       # verify it works
```

`uit init` uses your password once to request a Moodle Mobile web-service token. The password is not saved; only the returned token is written to `~/.uit/.env` on your machine.

Nothing is sent to any third-party server. Credentials and tokens stay local; the CLI talks directly from your machine to the Moodle server configured by `UIT_BASE_URL`.

<details>
<summary>Prefer pasting a token manually?</summary>

Get your token by visiting this URL in a browser while logged in:

```
https://courses.uit.edu.vn/login/token.php?username=YOUR_STUDENT_ID&password=YOUR_PASSWORD&service=moodle_mobile_app
```

```bash
uit init --token <your-token>
# Positional token form is still supported:
# uit init <your-token>
```
</details>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/RyanNg1403/uit-cli.git && cd uit-cli
npm install
npm run build
npm link

# Or run without linking globally:
npm run dev -- courses --current
```
</details>

Requires Node.js 20 or newer. Works on macOS, Linux, and Windows.

---

## How IDs Flow

```
courses   -> course_id  -> contents / download / announcements / deadlines / grades
contents  -> module_id  -> view
view      -> assign_id  -> submit / status
          -> discussion_id -> view-discussion
view-discussion -> post_id -> reply
deadlines -> assign_id  -> view / submit / status
```

For flags, output formats, and detailed behavior of each command, see the [CLI Reference](docs/CLI_REFERENCE.md).

## Features & Screenshots

### 1. Codex AI Assistant & Study Partner
Ask questions about your courses, lecture slides, assignments, and deadlines. Codex operates with real-time course context and dedicated Moodle tools to inspect files and materials on demand.

<p align="center">
  <img src="assets/studio-chat.png" alt="Codex AI workspace in UIT Studio" width="880" style="border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
</p>

* **Smart Course Context**: Codex reads lecture slides, syllabus, and course modules via built-in Moodle tools to answer your questions accurately.
* **Clean & Distraction-Free**: Minimal header design with title rename via double-click and full action controls (Branch, Delete permanently) tucked into the sidebar menu.
* **Branching & Persistence**: Branch any thread to explore alternative study tracks; drafts and conversation history automatically persist per account.

---

### 2. Dedicated Course Hub: Materials, Members, and Grades
Each course features three dedicated, student-centered tabs:

| Materials & Announcements | Class Members & Lecturers | Grades & Feedback |
| :---: | :---: | :---: |
| <img src="assets/course-materials.png" width="280" alt="Materials Tab" style="border-radius: 6px;"> | <img src="assets/course-members.png" width="280" alt="Members Tab" style="border-radius: 6px;"> | <img src="assets/course-grades.png" width="280" alt="Grades Tab" style="border-radius: 6px;"> |
| Explore sections, lecture slides, assignments, and in-app document previews. | Complete class roster with lecturers pinned on top, role badges, and live search. | Course Total summary card, component score breakdown, and teacher feedback. |

* **In-App Previews**: Read PDFs, images, code files, and Word documents (`.docx`) directly inside the app without opening external software.
* **Continuous Multi-Page PDF Viewer**: Native canvas rendering with page jumping, zoom controls, and automatic dark mode adaptation.
* **Lecturer & TA Highlights**: Course lecturers are pinned on top with distinct graduation cap avatars and teacher badges.

---

### 3. Dual Portals & Academic Year Dashboard
Connect your UIT SSO account for current semester courses, and connect Legacy Moodle to browse previous academic terms — all unified into a single clean list.

<p align="center">
  <img src="assets/studio-courses.png" alt="UIT Studio Courses view" width="880" style="border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
</p>

* **Clean Calendar Year Groups**: Courses from the same calendar year (`2026`, `2025`) merge into clean cards without cluttered inferred labels.
* **Instant Search & Filter**: Search across all semesters, course titles, course codes, and portal sources.
* **Dual Portal Synchronization**: Connect both `courses.uit.edu.vn` (SSO) and `coursesold.uit.edu.vn` (Student ID) side-by-side.

---

## UIT Studio desktop application

The desktop application runs on macOS, Linux, and Windows:

```bash
npm install
npm run desktop:check   # build and validate the desktop foundation
npm run desktop         # launch UIT Studio
```

* **Appearance**: Switch between **System**, **Light**, and **Dark** at the bottom of the sidebar. System follows OS appearance changes; document pages and images retain their natural colors.
* **Sidebar Controls**: Drag the sidebar boundary to resize it, or press <kbd>Cmd</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>B</kbd> to toggle navigation.
* **Workspace Isolation**: Course files and artifacts are safely organized under `~/UIT/<site-key>/user-<id>/course-<id>/`.

### Testing UIT Studio

```bash
npm run test:desktop    # 112 headless renderer, sidebar, and PDF tests
npm run test:electron   # isolated 60-second Electron stability and memory soak test
```

---

## Examples

For every command, add `--json` before the command name to get structured output:

```bash
uit --json courses --current
uit --json view 428837
```

<details>
<summary>Browse and drill down into a course</summary>

```bash
uit contents 19207                   # see sections, modules, files
uit view 428837                      # inspect an assignment — shows description, due date, status
uit view 432640                      # inspect a lesson — shows instructions, URLs
```
</details>

<details>
<summary>Download course materials</summary>

```bash
uit download 19207                   # everything in the course (incl. H5P packages)
uit download 19207 --module 428955   # one specific module
uit download 19207 --file "Crypto"   # files matching a name
uit download 19207 --extract         # also unpack .h5p packages into their media
```

Interactive H5P lessons (the `h5pactivity` type) download as their `.h5p` package — a ZIP holding the slides, images, and lesson data. Add `--extract` to unpack the media too.
</details>

<details>
<summary>See upcoming work</summary>

```bash
uit events                           # assignments, quizzes, calendar events
uit events -n 50                     # more events
uit events --course-id 19207         # filter to one course
```
</details>

<details>
<summary>Assignment workflow</summary>

```bash
uit deadlines                        # what's due?
uit view 428837                      # read the assignment description
uit submit 101617 ./report.pdf       # submit
uit status 101617                    # check result
```
</details>

<details>
<summary>Read announcements and forum threads</summary>

```bash
uit announcements 19438 --full       # read announcements with full content
uit view-discussion 77900            # read a specific forum thread
```
</details>

<details>
<summary>Jump to browser from any ID</summary>

```bash
uit open 428837                      # opens the module page
uit open --course 19207              # opens the course page
uit open --discussion 77900          # opens the discussion thread
```
</details>

<details>
<summary>Paste Moodle URLs directly — no need to extract IDs</summary>

```bash
uit view 'https://courses.uit.edu.vn/mod/assign/view.php?id=428837'
uit contents 'https://courses.uit.edu.vn/course/view.php?id=19207'
uit view-discussion 'https://courses.uit.edu.vn/mod/forum/discuss.php?d=77900'
```
</details>

---

## Configuration

`uit init` saves credentials to `~/.uit/.env`. You can also place a `.env` file in your project directory (takes precedence). See `.env.example`.

By default, `uit init` prompts for your student ID and password, requests a Moodle Mobile web-service token from `/login/token.php`, and stores only the returned token. If you already have a token, use `uit init --token <token>`. The older positional form, `uit init <token>`, still works.

## Development

```bash
npm run build       # compile TypeScript into dist/
npm test            # run the regression suite
npm run typecheck   # type-check without emitting files
```

The npm package exposes the `uit` binary from `dist/cli.js`.

## Releasing

Releases are tag-driven. After changes are merged to `main`:

```bash
git switch main
git pull origin main
npm version patch   # or minor / major
git push origin main --follow-tags
```

Pushing the `v*` tag runs GitHub Actions, publishes to npm, and creates a GitHub Release. The repository must have an npm automation token saved as the `NPM_TOKEN` GitHub secret.

---

## Security and ethics

This tool uses Moodle's official [Web Services API](https://moodledev.io/docs/apis/subsystems/external) — the same interface the Moodle Mobile app uses. It does not scrape, bypass authentication, or exploit any vulnerability. All data accessed is scoped to what your account already has permission to see through the web interface.

UIT-CLI has no backend service. Your student ID, password, Moodle token, downloaded files, and submitted files stay on your local machine except for direct requests from your machine to the Moodle server.

- Keep your API token private — treat it like a password. Never commit `.env` files or share your token.
- Rotate your token if you suspect it has been compromised by running `uit init` again.
- Prefer the interactive `uit init` prompt over `uit init --password ...`; command-line passwords can be saved in shell history.
- This tool does not escalate privileges — it cannot access anything your account cannot access on the website.

---

## License

MIT
