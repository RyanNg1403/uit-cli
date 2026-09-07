<p align="center">
  <img src="assets/logo.svg" alt="uit-cli" width="620">
</p>

<p align="center">
  Access your UIT course materials faster — from your terminal or through AI agents.<br>
  Download lectures, check deadlines, read announcements, submit assignments, and more.<br>
  Built on <a href="https://docs.moodle.org/dev/Web_service_API_functions">Moodle Web Services</a> — works with any Moodle instance.
</p>

<p align="center">
  <code>npm install -g uit-cli</code>&nbsp;&nbsp;then&nbsp;&nbsp;<code>uit init</code>.
</p>

<p align="center">
  <img src="assets/demo.gif" alt="uit-cli demo" width="780">
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

## UIT Studio desktop application

Choose **Appearance: System, Light, or Dark** at the bottom of the sidebar. Your preference is saved on this device; System follows OS appearance changes. Document pages and images retain their original colors.

In **Codex**, add a course with **New project**, then use the **+** beside its title to start a thread. Threads enter saved history only after their first prompt. Course resource clicks open previews (forum modules show their announcements); use their **...** menu for Download or a resource-tagged thread. **Open in Moodle** opens the page in your system browser. Missing courses can be added with **Add course by URL**, which verifies access without enrolling you. Search covers every semester, including Unknown semester; the semester selector also offers All semesters. Connected portals show their individual discovered-course counts. PDF pages scroll continuously. Drag the sidebar edge to resize it, or press Cmd+B/Ctrl+B to toggle it.

The `codex/uit-app` branch contains the Electron-based UIT Studio application: semester-organized Moodle courses and course-scoped Codex projects. Desktop development requires Node.js 22.12 or newer. The CLI supports Node.js 20 or newer.

```bash
npm ci
npm run desktop:check   # build and validate the desktop foundation
npm run desktop         # launch UIT Studio
npm run test:desktop    # headless renderer and PDF regression tests
npm run test:electron   # one hidden, isolated 60-second Electron stability test
```

The desktop app supports browser-backed UIT SSO for the current course site and explicit legacy Moodle token login for the old undergraduate/graduate portals at the same time. Courses are merged and labeled by their originating site. Desktop legacy sign-in keeps its token in memory and does not overwrite the CLI `.env`; the legacy token path remains more sensitive than current-site SSO. It is under active development. Do not use real assignment submission for testing until the submission workflow phase is marked complete in the implementation plan.

Click resources to read them; use **Download** only when you want a local copy. PDF, image, and text previews stay in memory and are limited to 25 MiB. Other formats and Moodle activities have an **Open in Moodle** viewer; legacy browser viewing may require a separate sign-in. This is not yet a complete replacement for every Moodle feature.

Right-click a material, assignment, or announcement, or use its actions button, to create a course thread with an `@resource` attachment. Threads and drafts persist per account, with rename, archive/restore, branch, stop, and approval controls. Codex receives service-resolved context and read/download course tools. Sending a message can send course content to the configured Codex model provider. External Codex-app synchronization and exact feature parity are not implemented.

Workspaces use `~/UIT/<site-key>/user-<id>/course-<id>/` to separate portals and accounts. Earlier workspace files are not migrated. See [UI verification](docs/UI_VERIFICATION.md) for test scope and remaining limitations.

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
