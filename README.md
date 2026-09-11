<p align="center">
  <img src="assets/logo.svg" alt="UIT CLI & UIT Studio" width="460">
</p>

<p align="center">
  <strong>The modern command-line tool and AI desktop workspace for UIT Moodle LMS.</strong>
</p>

---

## Installation matrix

| Product | npm | curl | Node requirement | Supported platforms |
| :--- | :--- | :--- | :--- | :--- |
| UIT CLI | `npm install -g uit-cli` | `curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh \| sh` | 20.19+ for npm; none for curl | npm: macOS, Linux, Windows · curl: macOS arm64, Linux x64/arm64 |
| UIT Studio | `npm install -g uit-studio` then `uit-studio` | `curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh \| sh -s -- --studio` | 20.19+ for npm; none for curl | macOS arm64 (Apple Silicon) only |

Install both npm packages together with `npm install -g uit-cli uit-studio`, or use `--all` with the curl installer on macOS arm64. The CLI includes the MCP server (`uit mcp`); Studio includes its MCP runtime internally.

## 1. UIT CLI

Fast, scriptable terminal client for browsing courses, checking assignments, downloading materials, and tracking grades.

To work from source instead:

```bash
git clone https://github.com/RyanNg1403/uit-cli.git
cd uit-cli
npm ci
npm link
```

### Login

`uit login` supports both **UIT SSO** and **Moodle API tokens**:

```bash
# Recommended: Sign in via UIT SSO in browser (default)
uit login

# Or sign in via Moodle API token
uit login --token <your_token>
```

*Tip: If you already signed in via **UIT Studio**, your SSO session is automatically shared with the CLI.*

### Basic Usage

| Command | Description |
| :--- | :--- |
| `uit courses` | List enrolled courses with course IDs |
| `uit contents <course_id>` | Browse sections, lecture slides, and files |
| `uit deadlines` | View assignment deadlines and submission status |
| `uit grades <course_id>` | Check grades, weights, and teacher feedback |
| `uit download <course_id>` | Download course materials and lecture slides |

<p align="center">
  <img src="assets/demo.gif" alt="UIT CLI Demo" width="860">
</p>

---

## 2. UIT Studio

The native desktop workspace combining Moodle course management with an intelligent Codex AI study copilot.

### Launch

The npm package launches with `uit-studio`. The curl installer places the unsigned Apple Silicon app in `~/Applications` and verifies its SHA-256 checksum. If macOS blocks the first launch, use **System Settings → Privacy & Security → Open Anyway**. You can also download the [latest GitHub release](https://github.com/RyanNg1403/uit-cli/releases/latest).

```bash
npm install -g uit-studio
uit-studio
```

To launch from source instead, install Node.js 20.19 or later and run:

```bash
git clone https://github.com/RyanNg1403/uit-cli.git
cd uit-cli
npm ci
npm run desktop
```

### Login

Sign in directly using **UIT SSO** (single sign-on) or your **Legacy Moodle** student account. Sessions are stored securely on your local device.

### What UIT Studio includes

- A unified dashboard for current and legacy UIT Moodle portals.
- Course materials with PDF, Word, image, text, and code previews.
- Class members, lecturers, grades, feedback, and deadlines.
- Codex study threads grounded in selected courses and resources.

<p align="center">
  <img src="assets/studio-courses.png" alt="UIT Studio courses dashboard" width="860">
</p>

Chat with Codex using direct context from your courses, lecture slides, and assignments, then continue the same thread in Codex CLI or the ChatGPT desktop app.

<p align="center">
  <img src="assets/studio-chat.png" alt="Codex AI Workspace" width="860" style="border-radius: 8px;">
</p>

---

## License

MIT
